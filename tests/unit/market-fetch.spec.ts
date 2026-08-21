/**
 * The marketplace's network and policy edge.
 *
 * Everything installable arrives from a repository this app does not control,
 * so what is asserted here is the adversarial half: an http redirect hop, an
 * oversized body behind a lying content-length, a wrong digest, a malformed
 * integrity string, and a source URL that merely looks like an allowed one.
 * Each of those fails silently if the rule is wrong — a plaintext hop still
 * downloads, and an unparsable integrity read as "no check" still installs.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import {
  DEFAULT_CATALOG,
  IntegrityError,
  MAX_REDIRECTS,
  fetchCatalog,
  fetchTarball,
  isAllowedSource,
  parseCatalog,
  verifyIntegrity,
} from '../../packages/market/lib/fetch.js'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

/** The digest a catalog row would carry for these bytes. */
function sri(algorithm: 'sha256' | 'sha512', bytes: Uint8Array): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
}

/** A response whose body arrives in pieces, as a real one does. */
function streamed(chunks: Uint8Array[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, init)
}

/** A fetch stand-in that records every call, so hops can be asserted. */
function recordingFetch(handler: (url: string, hop: number) => unknown) {
  const calls: { url: string; init: { redirect?: string; method?: string } }[] = []
  const impl = async (url: string, init: { redirect?: string; method?: string }) => {
    calls.push({ url, init })
    return handler(url, calls.length - 1)
  }
  return { impl, calls }
}

/** Run something expected to be refused and return the refusal's shape. */
async function refusal(fn: () => unknown): Promise<{ name: string; code: string; message: string }> {
  try {
    await fn()
  } catch (error) {
    const thrown = error as { name: string; code: string; message: string }
    return { name: thrown.name, code: thrown.code, message: thrown.message }
  }
  throw new Error('expected a refusal, got none')
}

describe('isAllowedSource', () => {
  it('allows the shipped default catalog and nothing else by default', () => {
    expect(isAllowedSource(DEFAULT_CATALOG)).toBe(true)
    expect(isAllowedSource('https://example.com/index.json')).toBe(false)
  })

  it('rejects every scheme but https, localhost included', () => {
    for (const url of [
      'http://xxsluna.github.io/DeepSeek-Harness-Desktop-Marketplace/index.json',
      'file:///C:/catalog/index.json',
      'data:application/json,{"version":1}',
      'ftp://example.com/index.json',
      'http://localhost:8080/index.json',
      'http://127.0.0.1/index.json',
    ]) {
      // Configuring it explicitly must not buy an exception either.
      expect(isAllowedSource(url, [url])).toBe(false)
    }
  })

  it('takes additional sources from the caller', () => {
    const mirror = 'https://mirror.example.com/harness/index.json'
    expect(isAllowedSource(mirror, [mirror])).toBe(true)
    expect(isAllowedSource(mirror, [])).toBe(false)
    // Configuring a mirror does not displace the default.
    expect(isAllowedSource(DEFAULT_CATALOG, [mirror])).toBe(true)
  })

  it('does not match on prefix, so a lookalike carrying an allowed URL fails', () => {
    // The whole reason the comparison is equality on a normal form: each of
    // these contains or resembles the allowed source without being it.
    expect(isAllowedSource(`https://evil.com/?x=${DEFAULT_CATALOG}`)).toBe(false)
    expect(isAllowedSource(`https://evil.com/#${DEFAULT_CATALOG}`)).toBe(false)
    expect(isAllowedSource('https://xxsluna.github.io.evil.com/DeepSeek-Harness-Desktop-Marketplace/index.json')).toBe(false)
    // Here the part that looks like the host is a username; the host is evil.com.
    expect(isAllowedSource('https://xxsluna.github.io@evil.com/DeepSeek-Harness-Desktop-Marketplace/index.json')).toBe(false)
  })

  it('rejects credentials even on an otherwise allowed source', () => {
    const withCreds = DEFAULT_CATALOG.replace('https://', 'https://user:pass@')
    expect(isAllowedSource(withCreds)).toBe(false)
    expect(isAllowedSource(withCreds, [withCreds])).toBe(false)
  })

  it('rejects a source differing only by a trailing slash', () => {
    // `/index.json/` is a different resource, so it must not inherit the
    // allowance; the comparison keeps the path exactly as the URL spec has it.
    expect(isAllowedSource(`${DEFAULT_CATALOG}/`)).toBe(false)
  })

  it('matches an allowed source through host case, the default port and dot segments', () => {
    expect(isAllowedSource(DEFAULT_CATALOG.replace('xxsluna.github.io', 'XXSLuna.GitHub.IO'))).toBe(true)
    expect(isAllowedSource(DEFAULT_CATALOG.replace('github.io/', 'github.io:443/'))).toBe(true)
    expect(isAllowedSource(DEFAULT_CATALOG.replace('/index.json', '/./index.json'))).toBe(true)
  })

  it('never throws, whatever it is handed', () => {
    for (const value of ['', 'not a url', 'https://', undefined, null, 42, {}, []]) {
      expect(isAllowedSource(value as never)).toBe(false)
    }
    // A broken configured row must not widen policy, and must not take the
    // rest of the list down with it.
    expect(isAllowedSource(DEFAULT_CATALOG, ['nonsense', null, 'http://evil.com/'])).toBe(true)
    expect(isAllowedSource('https://mirror.example.com/i.json', 'https://mirror.example.com/i.json' as never)).toBe(false)
  })
})

const TARBALL = utf8('a tarball, near enough')

describe('verifyIntegrity', () => {
  it('accepts sha512 and sha256 digests of the same bytes', () => {
    expect(() => verifyIntegrity(TARBALL, sri('sha512', TARBALL))).not.toThrow()
    expect(() => verifyIntegrity(TARBALL, sri('sha256', TARBALL))).not.toThrow()
  })

  it('rejects bytes whose digest does not match', async () => {
    const refused = await refusal(() => verifyIntegrity(TARBALL, sri('sha512', utf8('a different tarball'))))
    expect(refused.name).toBe('IntegrityError')
    expect(refused.code).toBe('ERR_MARKET_INTEGRITY')
    expect(() => verifyIntegrity(TARBALL, sri('sha512', utf8('a different tarball')))).toThrow(IntegrityError)
  })

  it('rejects a single truncated byte', () => {
    expect(() => verifyIntegrity(TARBALL.slice(0, -1), sri('sha512', TARBALL))).toThrow(/mismatch/)
  })

  it('names a weaker or unknown algorithm instead of shrugging', async () => {
    // The digest bodies are well-formed base64: the refusal has to be about the
    // algorithm, and it has to say which one it refused.
    const sha1 = await refusal(() => verifyIntegrity(TARBALL, 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk='))
    expect(sha1.message).toContain('sha1 is not accepted')
    expect(sha1.code).toBe('ERR_MARKET_INTEGRITY_FORMAT')
    const md5 = await refusal(() => verifyIntegrity(TARBALL, 'md5-1B2M2Y8AsgTpgAmY7PhCfg=='))
    expect(md5.message).toContain('md5 is not accepted')
  })

  it('never treats a missing or malformed integrity as "no check needed"', async () => {
    const sha512 = sri('sha512', TARBALL)
    for (const integrity of [
      undefined,
      null,
      '',
      'sha512',
      'sha512-',
      '-2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
      'sha512-not base64!',
      // Right algorithm label, a sha256-length digest under it.
      `sha512-${createHash('sha256').update(TARBALL).digest('base64')}`,
      // Right algorithm, truncated digest — decodes short and must not pass.
      sha512.slice(0, -8),
      // Two hashes: SRI allows a list, this module deliberately does not.
      `${sha512} ${sri('sha256', TARBALL)}`,
    ]) {
      const refused = await refusal(() => verifyIntegrity(TARBALL, integrity as never))
      expect(refused.code).toBe('ERR_MARKET_INTEGRITY_FORMAT')
    }
  })

  it('rejects anything that is not bytes', () => {
    expect(() => verifyIntegrity('a tarball, near enough' as never, sri('sha512', TARBALL))).toThrow(IntegrityError)
  })
})

/** A row that validates, to vary one field at a time from. */
const ROW = {
  id: 'notes',
  name: 'Notes',
  version: '1.2.0',
  publisher: 'someone',
  description: 'Keeps notes.',
  tarball: 'https://github.com/someone/notes/releases/download/v1.2.0/notes.tgz',
  integrity: sri('sha512', utf8('notes tarball')),
}

const catalogText = (plugins: unknown[], version: unknown = 1): string => JSON.stringify({ version, plugins })

describe('parseCatalog', () => {
  it('returns the rows that validate', () => {
    const parsed = parseCatalog(catalogText([ROW, { ...ROW, id: '@dsh-desktop/extra' }]))
    expect(parsed.version).toBe(1)
    expect(parsed.plugins.map((entry: { id: string }) => entry.id)).toEqual(['notes', '@dsh-desktop/extra'])
    expect(parsed.dropped).toEqual([])
  })

  it('refuses an envelope it cannot claim to understand', async () => {
    for (const text of [
      catalogText([ROW], 2),
      catalogText([ROW], '1'),
      // No version at all: an index that does not say what it is.
      JSON.stringify({ plugins: [ROW] }),
      '{"version":1}',
      '{"version":1,"plugins":{}}',
      '[]',
      'null',
      'not json at all',
    ]) {
      const refused = await refusal(() => parseCatalog(text))
      expect(refused.code).toBe('ERR_MARKET_CATALOG')
    }
  })

  it('drops and reports one bad row without losing the good ones', () => {
    const parsed = parseCatalog(catalogText([
      { ...ROW, id: 'plain-http', tarball: 'http://github.com/x/y/releases/download/v1/x.tgz' },
      ROW,
      { ...ROW, id: 'no-publisher', publisher: '' },
      { ...ROW, id: '../../etc/passwd' },
      { ...ROW, id: 'weak', integrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=' },
      'not even an object',
      ROW,
    ]))
    expect(parsed.plugins.map((entry: { id: string }) => entry.id)).toEqual(['notes'])
    expect(parsed.dropped).toEqual([
      { index: 0, id: 'plain-http', reason: 'tarball-not-https' },
      { index: 2, id: undefined, reason: 'missing-field:publisher' },
      { index: 3, id: undefined, reason: 'unsafe-id' },
      { index: 4, id: 'weak', reason: 'bad-integrity' },
      { index: 5, id: undefined, reason: 'not-an-object' },
      // A repeat of an accepted id would shadow it — first row wins.
      { index: 6, id: 'notes', reason: 'duplicate-id' },
    ])
  })

  it('requires every field a row is offered on', () => {
    for (const field of ['id', 'name', 'version', 'publisher', 'description', 'tarball', 'integrity']) {
      const row: Record<string, unknown> = { ...ROW }
      delete row[field]
      const parsed = parseCatalog(catalogText([row]))
      expect(parsed.plugins).toEqual([])
      expect(parsed.dropped[0].reason).toBe(`missing-field:${field}`)
    }
  })
})

const CATALOG_TEXT = catalogText([ROW])

describe('fetchCatalog', () => {
  it('follows an https redirect and asks for manual redirects on every hop', async () => {
    const asset = 'https://assets.example.com/index.json'
    const { impl, calls } = recordingFetch((url) => (url === asset
      ? new Response(CATALOG_TEXT, { status: 200 })
      : new Response(null, { status: 302, headers: { location: asset } })))

    const parsed = await fetchCatalog(DEFAULT_CATALOG, { fetchImpl: impl })

    expect(parsed.plugins).toHaveLength(1)
    expect(calls.map((call) => call.url)).toEqual([DEFAULT_CATALOG, asset])
    // The manual follow is the whole point — the automatic one re-checks nothing.
    for (const call of calls) expect(call.init.redirect).toBe('manual')
  })

  it('refuses a redirect hop that leaves https', async () => {
    const { impl, calls } = recordingFetch(() => new Response(null, {
      status: 302,
      headers: { location: 'http://assets.example.com/index.json' },
    }))

    const refused = await refusal(() => fetchCatalog(DEFAULT_CATALOG, { fetchImpl: impl }))
    expect(refused.code).toBe('ERR_MARKET_SCHEME')
    expect(refused.message).toContain('http:')
    // Refused at the hop, so the plaintext request is never made.
    expect(calls).toHaveLength(1)
  })

  it('refuses a redirect hop carrying credentials', async () => {
    const { impl } = recordingFetch(() => new Response(null, {
      status: 302,
      headers: { location: 'https://user:pass@assets.example.com/index.json' },
    }))
    expect((await refusal(() => fetchCatalog(DEFAULT_CATALOG, { fetchImpl: impl }))).code).toBe('ERR_MARKET_SCHEME')
  })

  it('resolves a relative location against the hop it came from', async () => {
    const { impl, calls } = recordingFetch((url, hop) => (hop === 0
      ? new Response(null, { status: 307, headers: { location: '/moved/index.json' } })
      : new Response(CATALOG_TEXT, { status: 200 })))

    await fetchCatalog(DEFAULT_CATALOG, { fetchImpl: impl })
    expect(calls[1].url).toBe('https://xxsluna.github.io/moved/index.json')
  })

  it('caps the redirect chain instead of walking a loop', async () => {
    const { impl, calls } = recordingFetch((url, hop) => new Response(null, {
      status: 302,
      headers: { location: `https://assets.example.com/hop-${hop + 1}.json` },
    }))

    const refused = await refusal(() => fetchCatalog(DEFAULT_CATALOG, { fetchImpl: impl }))
    expect(refused.code).toBe('ERR_MARKET_REDIRECT')
    expect(calls).toHaveLength(MAX_REDIRECTS + 1)
  })

  it('refuses a redirect with no location', async () => {
    const { impl } = recordingFetch(() => new Response(null, { status: 302 }))
    expect((await refusal(() => fetchCatalog(DEFAULT_CATALOG, { fetchImpl: impl }))).code).toBe('ERR_MARKET_REDIRECT')
  })

  it('counts the bytes as they arrive, so a lying content-length buys nothing', async () => {
    const chunk = new Uint8Array(64).fill(0x7b)
    const { impl } = recordingFetch(() => streamed(Array.from({ length: 40 }, () => chunk), {
      status: 200,
      // Declares 10 bytes, sends 2560.
      headers: { 'content-length': '10' },
    }))

    const refused = await refusal(() => fetchCatalog(DEFAULT_CATALOG, { fetchImpl: impl, maxBytes: 1024 }))
    expect(refused.code).toBe('ERR_MARKET_TOO_LARGE')
  })

  it('short-circuits on a declared length over the cap without reading a body', async () => {
    const { impl } = recordingFetch(() => ({
      status: 200,
      headers: new Headers({ 'content-length': '9000000000' }),
      // Unreadable on purpose: reaching it at all would be a different refusal.
      body: {},
    }))

    const refused = await refusal(() => fetchCatalog(DEFAULT_CATALOG, { fetchImpl: impl, maxBytes: 1024 }))
    expect(refused.code).toBe('ERR_MARKET_TOO_LARGE')
  })

  it('refuses a non-2xx status and a bodiless response', async () => {
    const notFound = recordingFetch(() => new Response('nope', { status: 404 }))
    expect((await refusal(() => fetchCatalog(DEFAULT_CATALOG, { fetchImpl: notFound.impl }))).code).toBe('ERR_MARKET_STATUS')

    const empty = recordingFetch(() => new Response(null, { status: 200 }))
    expect((await refusal(() => fetchCatalog(DEFAULT_CATALOG, { fetchImpl: empty.impl }))).code).toBe('ERR_MARKET_BODY')
  })

  it('never requests a source policy refuses', async () => {
    const { impl, calls } = recordingFetch(() => new Response(CATALOG_TEXT, { status: 200 }))
    for (const url of ['http://localhost:8080/index.json', 'https://evil.com/index.json', `${DEFAULT_CATALOG}/`]) {
      expect((await refusal(() => fetchCatalog(url, { fetchImpl: impl }))).code).toBe('ERR_MARKET_SOURCE')
    }
    expect(calls).toHaveLength(0)
  })

  it('fetches an operator-configured extra source', async () => {
    const mirror = 'https://mirror.example.com/harness/index.json'
    const { impl, calls } = recordingFetch(() => new Response(CATALOG_TEXT, { status: 200 }))
    const parsed = await fetchCatalog(mirror, { fetchImpl: impl, extraSources: [mirror] })
    expect(parsed.plugins).toHaveLength(1)
    expect(calls.map((call) => call.url)).toEqual([mirror])
  })
})

describe('fetchTarball', () => {
  const BYTES = utf8('a plugin tarball, longer than a hash')
  const INTEGRITY = sri('sha512', BYTES)
  /** The redirect a real Release asset takes. */
  const CDN = 'https://objects.githubusercontent.com/notes.tgz?token=x'

  it('follows the Release asset redirect and returns verified bytes', async () => {
    const { impl, calls } = recordingFetch((url) => (url === CDN
      ? streamed([BYTES.slice(0, 8), BYTES.slice(8)], { status: 200 })
      : new Response(null, { status: 302, headers: { location: CDN } })))

    const bytes = await fetchTarball(ROW.tarball, INTEGRITY, { fetchImpl: impl })

    expect(Buffer.from(bytes).toString('utf8')).toBe('a plugin tarball, longer than a hash')
    expect(calls.map((call) => call.url)).toEqual([ROW.tarball, CDN])
  })

  it('refuses bytes that do not match the digest', async () => {
    const { impl } = recordingFetch(() => streamed([utf8('a substituted tarball')], { status: 200 }))
    const refused = await refusal(() => fetchTarball(ROW.tarball, INTEGRITY, { fetchImpl: impl }))
    expect(refused.name).toBe('IntegrityError')
    expect(refused.code).toBe('ERR_MARKET_INTEGRITY')
  })

  it('refuses before spending a download when the integrity string is unusable', async () => {
    const { impl, calls } = recordingFetch(() => streamed([BYTES], { status: 200 }))
    for (const integrity of ['', 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=', 'sha512-nope!', undefined]) {
      const refused = await refusal(() => fetchTarball(ROW.tarball, integrity as never, { fetchImpl: impl }))
      expect(refused.code).toBe('ERR_MARKET_INTEGRITY_FORMAT')
    }
    expect(calls).toHaveLength(0)
  })

  it('refuses a plaintext tarball URL without requesting it', async () => {
    const { impl, calls } = recordingFetch(() => streamed([BYTES], { status: 200 }))
    const refused = await refusal(() => fetchTarball(ROW.tarball.replace('https:', 'http:'), INTEGRITY, { fetchImpl: impl }))
    expect(refused.code).toBe('ERR_MARKET_SCHEME')
    expect(calls).toHaveLength(0)
  })

  it('caps the tarball body', async () => {
    const chunk = new Uint8Array(512)
    const { impl } = recordingFetch(() => streamed(Array.from({ length: 8 }, () => chunk), { status: 200 }))
    const refused = await refusal(() => fetchTarball(ROW.tarball, INTEGRITY, { fetchImpl: impl, maxBytes: 1024 }))
    expect(refused.code).toBe('ERR_MARKET_TOO_LARGE')
  })
})

describe('parseCatalog title', () => {
  /**
   * `name` is the npm package name: the installer resolves it, writes
   * `node_modules/<name>` and refuses a tarball whose manifest disagrees. It was
   * also the only thing the settings list could show, so a plugin could not have
   * a readable name. `title` separates the two — optional in the document so an
   * existing catalog stays valid, and always present on the parsed row so a
   * label can never render blank.
   */
  const row = {
    id: 'x', name: 'dsh-plugin-x', version: '1.0.0', publisher: 'p', description: 'd',
    tarball: 'https://example.com/x.tgz',
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  }

  it('keeps a supplied title', () => {
    const parsed = parseCatalog(JSON.stringify({ version: 1, plugins: [{ ...row, title: 'Plugin X' }] }))
    expect(parsed.dropped).toEqual([])
    expect(parsed.plugins[0]!.title).toBe('Plugin X')
    expect(parsed.plugins[0]!.name).toBe('dsh-plugin-x')
  })

  it('falls back to the package name, and never to blank', () => {
    for (const title of [undefined, '', 42, null]) {
      const parsed = parseCatalog(JSON.stringify({ version: 1, plugins: [{ ...row, title }] }))
      expect(parsed.dropped, `title=${JSON.stringify(title)} should not drop the row`).toEqual([])
      expect(parsed.plugins[0]!.title).toBe('dsh-plugin-x')
    }
  })
})
