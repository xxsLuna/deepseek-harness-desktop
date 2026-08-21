/**
 * The marketplace catalog document (`.claude-plugin/marketplace.json`).
 *
 * This is a file a stranger publishes and this app reads without a human in
 * between, so the assertions here are the adversarial half plus the boring half
 * that keeps the boring half honest: a source type we cannot install from is
 * refused BY NAME rather than skipped, a pin that only looks like a pin takes
 * its row down, a link that would become an href is https or gone, and one bad
 * row never hides the good rows above and below it.
 *
 * Two of these fail silently if the rule is wrong, which is why they are here
 * rather than left to the install path: a `command` source quietly ignored
 * looks exactly like a publisher's typo, and a `sha` accepted without checking
 * its shape looks exactly like a pinned install right up until it is not one.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import { MARKETPLACE_FILE, SUPPORTED_SOURCES, parseCatalog } from '../../packages/market/lib/catalog.js'

type Dropped = { index: number; name: string | undefined; reason: string }
type Plugin = { name: string; displayName: string; source: Record<string, unknown> }

/** A minimal valid envelope around whatever rows a test needs. */
function catalogText(plugins: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'example-marketplace',
    owner: { name: 'Someone', email: 's@example.com' },
    plugins,
    ...extra,
  })
}

/** Run something expected to be refused and return the refusal's shape. */
function refusal(fn: () => unknown): { name: string; code: string; message: string } {
  try {
    fn()
  } catch (error) {
    const thrown = error as { name: string; code: string; message: string }
    return { name: thrown.name, code: thrown.code, message: thrown.message }
  }
  throw new Error('expected a refusal, got none')
}

/** The reason codes a parse produced, in order. */
function reasons(text: string): string[] {
  return (parseCatalog(text).dropped as Dropped[]).map((row) => row.reason)
}

/** A row that validates, so a test can vary exactly one thing about it. */
const ROW = {
  name: 'swagger',
  source: { source: 'url', url: 'https://git.example/plugins/swagger.git', ref: 'main' },
} as const

/**
 * The real document this format was designed against, verbatim in shape: a
 * `url` source with a `.git` URL, a `displayName` distinct from the install
 * key, keywords, and a rename tombstone.
 */
const REAL_WORLD = {
  name: 'example-marketplace',
  owner: { name: 'Someone', email: 's@example.com' },
  plugins: [
    {
      name: 'swagger',
      displayName: 'Swagger Local Test',
      description: 'Boots the local swagger container',
      version: '0.1.0',
      author: { name: 'Team', email: 't@example.com' },
      homepage: 'https://git.example/plugins/swagger',
      repository: 'https://git.example/plugins/swagger.git',
      keywords: ['swagger', 'openapi'],
      source: { source: 'url', url: 'https://git.example/plugins/swagger.git', ref: 'main' },
    },
  ],
  renames: { 'old-name': null },
}

describe('the marketplace document', () => {
  it('names the well-known file and the source types it can install', () => {
    expect(MARKETPLACE_FILE).toBe('.claude-plugin/marketplace.json')
    expect(SUPPORTED_SOURCES).toEqual(['github', 'url', 'archive', 'git-subdir'])
  })

  it('parses a real-world catalog whole', () => {
    const parsed = parseCatalog(JSON.stringify(REAL_WORLD))
    expect(parsed.name).toBe('example-marketplace')
    expect(parsed.owner).toEqual({ name: 'Someone', email: 's@example.com' })
    expect(parsed.dropped).toEqual([])
    expect(parsed.plugins).toEqual([
      {
        name: 'swagger',
        displayName: 'Swagger Local Test',
        description: 'Boots the local swagger container',
        version: '0.1.0',
        author: { name: 'Team', email: 't@example.com' },
        homepage: 'https://git.example/plugins/swagger',
        repository: 'https://git.example/plugins/swagger.git',
        keywords: ['swagger', 'openapi'],
        source: { source: 'url', url: 'https://git.example/plugins/swagger.git', ref: 'main' },
      },
    ])
  })

  it('carries the optional envelope fields through', () => {
    const parsed = parseCatalog(catalogText([ROW], {
      description: 'plugins for the desktop shell',
      version: '1.5.0+g6927fc3',
      metadata: { pluginRoot: './plugins', anything: { at: 'all' } },
      allowCrossMarketplaceDependenciesOn: ['other-marketplace', 'other-marketplace', 7],
    }))
    expect(parsed.description).toBe('plugins for the desktop shell')
    // A version string is the MARKETPLACE's own label. Git-describe build
    // metadata is a real value and must survive; nothing here parses it.
    expect(parsed.version).toBe('1.5.0+g6927fc3')
    expect(parsed.metadata).toEqual({ pluginRoot: './plugins', anything: { at: 'all' } })
    expect(parsed.allowCrossMarketplaceDependenciesOn).toEqual(['other-marketplace'])
  })

  it('defaults metadata and the cross-marketplace list rather than leaving them absent', () => {
    const parsed = parseCatalog(catalogText([ROW]))
    expect(parsed.metadata).toEqual({})
    expect(parsed.allowCrossMarketplaceDependenciesOn).toEqual([])
    expect(parsed.renames).toEqual({})
    expect(parsed.description).toBeUndefined()
    expect(parsed.version).toBeUndefined()
  })
})

describe('the envelope, which is fatal', () => {
  it('refuses a body it cannot claim to understand', () => {
    for (const text of [
      'not json at all',
      'null',
      '[]',
      '"a string"',
      // No plugins array: an index that indexes nothing is not this document.
      JSON.stringify({ name: 'm', owner: { name: 'o' } }),
      JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins: {} }),
    ]) {
      expect(refusal(() => parseCatalog(text)).code).toBe('ERR_MARKET_CATALOG')
    }
    expect(refusal(() => parseCatalog(undefined)).code).toBe('ERR_MARKET_CATALOG')
    expect(refusal(() => parseCatalog(null)).name).toBe('MarketError')
  })

  it('refuses a version it does not understand, and names the retired format', () => {
    // The format this replaced used `version` as its FORMAT discriminant. A
    // numeric version is therefore an old index.json, whose rows would every
    // one of them drop for having no `source` — a silent empty marketplace.
    const numeric = refusal(() => parseCatalog(JSON.stringify({
      version: 1,
      plugins: [{ id: 'notes', name: '@acme/notes' }],
    })))
    expect(numeric.code).toBe('ERR_MARKET_CATALOG')
    expect(numeric.message).toContain('index.json')

    for (const version of [2, {}, [], true, '']) {
      expect(refusal(() => parseCatalog(catalogText([ROW], { version }))).code).toBe('ERR_MARKET_CATALOG')
    }
  })

  it('requires a name and an owner that names somebody', () => {
    expect(refusal(() => parseCatalog(JSON.stringify({
      owner: { name: 'Someone' },
      plugins: [],
    }))).message).toContain('no name')

    for (const owner of [undefined, {}, { email: 's@example.com' }, '', null, ['Someone']]) {
      const refused = refusal(() => parseCatalog(JSON.stringify({ name: 'm', owner, plugins: [] })))
      expect(refused.code).toBe('ERR_MARKET_CATALOG')
      expect(refused.message).toContain('no owner')
    }
  })

  it('takes an owner spelled as a bare string', () => {
    // Both spellings are in the wild and neither is ambiguous. Refusing one
    // would throw away a whole catalog over a stylistic choice.
    expect(parseCatalog(JSON.stringify({ name: 'm', owner: 'Someone', plugins: [] })).owner)
      .toEqual({ name: 'Someone' })
  })
})

describe('the source, which is the whole point of a row', () => {
  it('accepts every supported type, normalising each', () => {
    const parsed = parseCatalog(catalogText([
      { name: 'from-github', source: { source: 'github', repo: 'owner/repo', ref: 'v2.0.0' } },
      { name: 'from-url', source: { source: 'url', url: 'https://gitlab.example/team/p.git', ref: 'main' } },
      {
        name: 'from-archive',
        source: { source: 'archive', url: 'https://host/p.zip', sha256: 'A'.repeat(64) },
      },
      {
        name: 'from-subdir',
        source: { source: 'git-subdir', repo: 'owner/many', path: 'plugins/one', ref: 'main' },
      },
      {
        name: 'from-subdir-url',
        source: { source: 'git-subdir', url: 'https://gitlab.example/team/many.git', path: 'p' },
      },
    ]))
    expect(parsed.dropped).toEqual([])
    expect((parsed.plugins as Plugin[]).map((row) => row.source)).toEqual([
      { source: 'github', repo: 'owner/repo', ref: 'v2.0.0' },
      { source: 'url', url: 'https://gitlab.example/team/p.git', ref: 'main' },
      // Hex digests are recorded lowercase so two spellings of one digest are
      // one string by the time anything compares them.
      { source: 'archive', url: 'https://host/p.zip', sha256: 'a'.repeat(64) },
      { source: 'git-subdir', repo: 'owner/many', path: 'plugins/one', ref: 'main' },
      { source: 'git-subdir', url: 'https://gitlab.example/team/many.git', path: 'p' },
    ])
  })

  it('refuses a subdirectory that could name something outside the plugin', () => {
    // Built rather than written: a literal backslash in a TS string is an
    // escape, and one that silently ate itself would leave this case untested.
    const BACKSLASH = String.fromCharCode(92)
    // The path is joined onto a directory the installer then empties, so the
    // grammar has to make an escape unrepresentable rather than filter it.
    const bad = [
      '../secrets', 'plugins/../../etc', '/etc/passwd', 'C:/Windows',
      `plugins${BACKSLASH}one`, './plugins/one', 'plugins//one', '-rf', '',
      'a/b/c/d/e/f/g/h/i',
    ]
    const parsed = parseCatalog(catalogText(bad.map((path, index) => ({
      name: `row-${String(index)}`,
      source: { source: 'git-subdir', repo: 'owner/many', path },
    }))))
    expect(parsed.plugins).toEqual([])
    expect(parsed.dropped.map((row) => row.reason)).toEqual(bad.map(() => 'bad-source:path'))
  })

  it('refuses a git-subdir row that names no directory at all', () => {
    // Not defaulted to the repository root: a row that lost its path meant a
    // directory, and installing the whole repository instead is a plugin the
    // publisher never described.
    const parsed = parseCatalog(catalogText([
      { name: 'no-path', source: { source: 'git-subdir', repo: 'owner/many' } },
    ]))
    expect(parsed.dropped).toEqual([{ index: 0, name: 'no-path', reason: 'bad-source:path' }])
  })

  it('drops every source type this version cannot install from, by name', () => {
    const parsed = parseCatalog(catalogText([
      { name: 'relative', source: './plugins/foo' },
      { name: 'from-npm', source: { source: 'npm', package: '@acme/p', version: '^2.0.0' } },
      { name: 'runs-a-command', source: { source: 'command', command: 'curl x | sh', timeout: 60 } },
      { name: 'from-mars', source: { source: 'mars', url: 'https://h/p' } },
      // An unrecognised type is only echoed when it looks like an identifier:
      // a reason code reaches a log line, and the string is a stranger's.
      { name: 'shouty', source: { source: 'Get-Content ../../secrets' } },
      { name: 'not-even-a-type', source: 42 },
      { name: 'no-source-at-all', displayName: 'x' },
    ]))
    expect(parsed.plugins).toEqual([])
    expect(parsed.dropped).toEqual([
      { index: 0, name: 'relative', reason: 'source-not-supported:relative-path' },
      { index: 1, name: 'from-npm', reason: 'source-not-supported:npm' },
      { index: 2, name: 'runs-a-command', reason: 'source-not-supported:command' },
      { index: 3, name: 'from-mars', reason: 'source-not-supported:mars' },
      { index: 4, name: 'shouty', reason: 'source-not-supported:unknown' },
      { index: 5, name: 'not-even-a-type', reason: 'source-not-supported:unknown' },
      { index: 6, name: 'no-source-at-all', reason: 'missing-field:source' },
    ])
  })

  it('refuses a pin that only looks like one', () => {
    // A malformed sha is worse than no sha: it reads as a guarantee and cannot
    // be one, so the row goes rather than quietly falling back to its ref.
    const forty = '6927fc3'.padStart(40, 'a')
    expect(reasons(catalogText([
      { name: 'short', source: { source: 'github', repo: 'o/r', sha: forty.slice(1) } },
      { name: 'long', source: { source: 'github', repo: 'o/r', sha: `${forty}a` } },
      { name: 'not-hex', source: { source: 'github', repo: 'o/r', sha: 'z'.repeat(40) } },
      { name: 'spaced', source: { source: 'github', repo: 'o/r', sha: ` ${forty}` } },
    ]))).toEqual(Array<string>(4).fill('bad-source:sha'))
  })

  it('treats an empty or non-string sha as absent, not as malformed', () => {
    // There is a real difference between "no revision given" (fetch the
    // default branch) and "a revision given that we cannot use".
    const parsed = parseCatalog(catalogText([
      { name: 'empty', source: { source: 'url', url: 'https://h/p.git', sha: '' } },
      { name: 'numeric', source: { source: 'url', url: 'https://h/p.git', sha: 1234 } },
      { name: 'malformed', source: { source: 'url', url: 'https://h/p.git', sha: 'nope' } },
    ]))
    expect((parsed.plugins as Plugin[]).map((row) => row.source)).toEqual([
      { source: 'url', url: 'https://h/p.git' },
      { source: 'url', url: 'https://h/p.git' },
    ])
    expect(parsed.dropped).toEqual([{ index: 2, name: 'malformed', reason: 'bad-source:sha' }])
  })

  it('lets a sha override the ref, dropping the ref outright', () => {
    const sha = 'a1b2C3d4'.repeat(5)
    const parsed = parseCatalog(catalogText([
      { name: 'pinned', source: { source: 'github', repo: 'owner/repo', ref: 'main', sha } },
    ]))
    // The ref is not carried alongside: a branch can be moved by the publisher
    // after the row was reviewed, so a row holding both must not leave a
    // consumer a choice about which one to check out.
    expect((parsed.plugins as Plugin[])[0]?.source).toEqual({
      source: 'github',
      repo: 'owner/repo',
      sha: sha.toLowerCase(),
    })
  })

  it('refuses a ref that would be read as something other than a name', () => {
    expect(reasons(catalogText([
      { name: 'flagged', source: { source: 'github', repo: 'o/r', ref: '--upload-pack=sh' } },
      { name: 'ranged', source: { source: 'github', repo: 'o/r', ref: 'main..evil' } },
      { name: 'spaced', source: { source: 'github', repo: 'o/r', ref: 'main --force' } },
      { name: 'newline', source: { source: 'github', repo: 'o/r', ref: 'main\nevil' } },
    ]))).toEqual(['bad-source:ref', 'bad-source:ref', 'bad-source:ref', 'bad-source:ref'])
  })

  it('requires a github repo shaped owner/name and nothing that climbs out', () => {
    expect(reasons(catalogText([
      { name: 'no-owner', source: { source: 'github', repo: 'repo' } },
      { name: 'traversal', source: { source: 'github', repo: '../../etc' } },
      { name: 'dotted', source: { source: 'github', repo: 'owner/..' } },
      { name: 'three', source: { source: 'github', repo: 'owner/repo/extra' } },
      { name: 'missing', source: { source: 'github' } },
      { name: 'a-url', source: { source: 'github', repo: 'https://github.com/o/r' } },
    ]))).toEqual(Array<string>(6).fill('bad-source:repo'))
  })

  it('requires https everywhere a source is fetched from', () => {
    expect(reasons(catalogText([
      { name: 'plain', source: { source: 'url', url: 'http://h/p.git' } },
      { name: 'file', source: { source: 'url', url: 'file:///etc/p.git' } },
      // `good.example@evil.example` — the part that looks like a host is a
      // username, so credentials are refused rather than stripped.
      { name: 'creds', source: { source: 'url', url: 'https://good.example@evil.example/p.git' } },
      { name: 'nonsense', source: { source: 'url', url: 'not a url' } },
      { name: 'archive-plain', source: { source: 'archive', url: 'http://h/p.zip', sha256: 'a'.repeat(64) } },
    ]))).toEqual(Array<string>(5).fill('bad-source:url'))
  })

  it('requires a url source to be a clone URL, not a page or a tarball', () => {
    expect(reasons(catalogText([
      { name: 'a-page', source: { source: 'url', url: 'https://git.example/plugins/swagger' } },
      { name: 'a-tarball', source: { source: 'url', url: 'https://h/p.tar.gz' } },
    ]))).toEqual(['bad-source:not-git-url', 'bad-source:not-git-url'])
  })

  it('requires an archive to carry the digest that is its only pin', () => {
    expect(reasons(catalogText([
      { name: 'no-digest', source: { source: 'archive', url: 'https://h/p.zip' } },
      { name: 'short', source: { source: 'archive', url: 'https://h/p.zip', sha256: 'a'.repeat(63) } },
      { name: 'not-hex', source: { source: 'archive', url: 'https://h/p.zip', sha256: 'z'.repeat(64) } },
      // SRI is the spelling `fetch.js` reads; this format writes bare hex, and
      // taking both would mean two digest grammars for one field.
      { name: 'sri', source: { source: 'archive', url: 'https://h/p.zip', sha256: `sha256-${'a'.repeat(43)}=` } },
    ]))).toEqual(Array<string>(4).fill('bad-source:sha256'))
  })
})

describe('the row', () => {
  it('falls displayName back to name, so nothing renders blank', () => {
    const parsed = parseCatalog(catalogText([
      ROW,
      { ...ROW, name: 'blank', displayName: '' },
      { ...ROW, name: 'absent', displayName: undefined },
      { ...ROW, name: 'wrong-type', displayName: 42 },
      { ...ROW, name: 'labelled', displayName: 'A Real Label' },
    ]))
    expect((parsed.plugins as Plugin[]).map((row) => [row.name, row.displayName])).toEqual([
      ['swagger', 'swagger'],
      ['blank', 'blank'],
      ['absent', 'absent'],
      ['wrong-type', 'wrong-type'],
      ['labelled', 'A Real Label'],
    ])
  })

  it('holds the install key to the grammar registry.js already owns', () => {
    // Not a second regex: this name becomes the key `addInstalled` writes and
    // the directory Node's resolution joins. Two rules would drift, and the one
    // that drifts is the one that lets `..` through.
    const parsed = parseCatalog(catalogText([
      { ...ROW, name: '../../etc/passwd' },
      { ...ROW, name: 'node_modules' },
      { ...ROW, name: 'Upper-Case' },
      { ...ROW, name: 'with space' },
      { ...ROW, name: 'a\\b' },
      { ...ROW, name: '@acme/plugin' },
    ]))
    expect((parsed.plugins as Plugin[]).map((row) => row.name)).toEqual(['@acme/plugin'])
    // The refused name is not echoed back: putting it in the output is exactly
    // what refusing it was for.
    expect(parsed.dropped).toEqual([
      { index: 0, name: undefined, reason: 'unsafe-name' },
      { index: 1, name: undefined, reason: 'unsafe-name' },
      { index: 2, name: undefined, reason: 'unsafe-name' },
      { index: 3, name: undefined, reason: 'unsafe-name' },
      { index: 4, name: undefined, reason: 'unsafe-name' },
    ])
  })

  it('keeps the version label exactly as published', () => {
    // Not semver-only. `1.5.0+g6927fc3` is a real entry, and so is anything
    // else a publisher decides to call a version — this string is displayed,
    // never resolved, so parsing it could only lose rows.
    const versions = ['1.5.0+g6927fc3', '2024.11', 'v3', 'nightly', '^2.0.0']
    const parsed = parseCatalog(catalogText(
      versions.map((version, index) => ({ ...ROW, name: `p${index}`, version })),
    ))
    expect((parsed.plugins as { version: string }[]).map((row) => row.version)).toEqual(versions)
    expect(parsed.dropped).toEqual([])
  })

  it('keeps a link only when it could not become a script', () => {
    const parsed = parseCatalog(catalogText([
      {
        ...ROW,
        homepage: 'javascript:alert(1)',
        repository: 'https://git.example/plugins/swagger.git',
        author: { name: 'Team', url: 'data:text/html,<script>' },
      },
    ]))
    const row = (parsed.plugins as { homepage?: string; repository?: string; author?: object }[])[0]
    // The row survives — a broken homepage says nothing about whether the
    // plugin is installable — but the field the UI would turn into an href
    // does not.
    expect(row?.homepage).toBeUndefined()
    expect(row?.repository).toBe('https://git.example/plugins/swagger.git')
    expect(row?.author).toEqual({ name: 'Team' })
  })

  it('deduplicates keywords and tags and omits them when empty', () => {
    const parsed = parseCatalog(catalogText([
      { ...ROW, keywords: ['a', 'a', '', 'b', 7], tags: [] },
    ]))
    expect(parsed.plugins[0]).toEqual({
      name: 'swagger',
      displayName: 'swagger',
      keywords: ['a', 'b'],
      source: { source: 'url', url: 'https://git.example/plugins/swagger.git', ref: 'main' },
    })
  })

  it('drops and reports one bad row without losing the good ones', () => {
    const parsed = parseCatalog(catalogText([
      { name: 'runs-a-command', source: { source: 'command', command: 'rm -rf /' } },
      ROW,
      'not even an object',
      { source: { source: 'github', repo: 'o/r' } },
      { name: 'notes', source: { source: 'github', repo: 'acme/notes', sha: 'a1b2c3' } },
      { ...ROW, displayName: 'A second swagger' },
      { name: 'notes', source: { source: 'github', repo: 'acme/notes' } },
    ]))
    expect((parsed.plugins as Plugin[]).map((row) => row.name)).toEqual(['swagger', 'notes'])
    expect(parsed.dropped).toEqual([
      { index: 0, name: 'runs-a-command', reason: 'source-not-supported:command' },
      { index: 2, name: undefined, reason: 'not-an-object' },
      { index: 3, name: undefined, reason: 'missing-field:name' },
      { index: 4, name: 'notes', reason: 'bad-source:sha' },
      // A repeat of an accepted name would shadow it — first row wins.
      { index: 5, name: 'swagger', reason: 'duplicate-name' },
    ])
  })
})

describe('renames', () => {
  it('passes a rename map and a tombstone through', () => {
    const parsed = parseCatalog(catalogText([ROW], {
      renames: { 'old-name': null, 'former-swagger': 'swagger', '@acme/old': '@acme/new' },
    }))
    expect(parsed.renames).toEqual({
      'old-name': null,
      'former-swagger': 'swagger',
      '@acme/old': '@acme/new',
    })
    expect(parsed.dropped).toEqual([])
  })

  it('drops a rename it could not follow, and says so without throwing', () => {
    const parsed = parseCatalog(catalogText([ROW], {
      renames: { 'good-one': 'swagger', '../../etc': 'swagger', 'bad-target': '../../etc', trailing: 42 },
    }))
    // The rows are untouched: nothing is installed from a rename map, so a bad
    // entry costs a redirect that will not be followed, not a wrong package.
    expect((parsed.plugins as Plugin[]).map((row) => row.name)).toEqual(['swagger'])
    expect(parsed.renames).toEqual({ 'good-one': 'swagger' })
    expect(parsed.dropped).toEqual([
      // -1: a rename has no position in `plugins`, and every drop keeps one shape.
      { index: -1, name: undefined, reason: 'bad-rename' },
      { index: -1, name: 'bad-target', reason: 'bad-rename' },
      { index: -1, name: 'trailing', reason: 'bad-rename' },
    ])
  })

  it('reports a renames field that is not a map at all', () => {
    for (const renames of [[], 'old-name', 7]) {
      const parsed = parseCatalog(catalogText([ROW], { renames }))
      expect(parsed.renames).toEqual({})
      expect(parsed.dropped).toEqual([{ index: -1, name: undefined, reason: 'bad-renames' }])
      expect(parsed.plugins).toHaveLength(1)
    }
  })

  it('reports row drops before rename drops, so row indices read in order', () => {
    const parsed = parseCatalog(catalogText(
      [{ name: 'from-npm', source: { source: 'npm', package: 'p' } }, ROW],
      { renames: { '../../etc': null } },
    ))
    expect((parsed.dropped as Dropped[]).map((row) => row.index)).toEqual([0, -1])
  })
})
