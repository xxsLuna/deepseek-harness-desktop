// @ts-check
/**
 * @dsh-desktop/market — the marketplace's network and policy edge: which
 * catalog sources may be fetched at all, what a catalog row has to look like to
 * be offered, and whether downloaded bytes are the bytes the catalog named.
 *
 * The app ships one string (`DEFAULT_CATALOG`) and nothing else: no catalog
 * content, no plugin code. Everything installable therefore arrives over the
 * network from a separate repository, which makes this module the place a
 * compromise would have to land. That is why the three decisions with rules in
 * them — source policy, catalog shape, byte integrity — are pure functions kept
 * apart from the I/O, and why the I/O takes an injectable `fetchImpl`: the
 * policy is unit-testable without a socket, and no test needs the network.
 *
 * Runs inside the harness sidecar (plain Node, no Electron).
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/** The one catalog the app ships knowledge of. Content lives in its own repo. */
export const DEFAULT_CATALOG = 'https://xxsluna.github.io/DeepSeek-Harness-Desktop-Marketplace/index.json'

/**
 * Cap on a catalog body. A catalog is an index, not content — a few hundred
 * bytes a row — so this is thousands of rows and still small enough that a
 * hostile or broken source cannot exhaust the sidecar before the cap trips.
 */
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024

/** Cap on one plugin tarball. Generous for a plugin, bounded for a sidecar. */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024

/**
 * Hops a single retrieval may take. GitHub Release assets legitimately need
 * one (github.com -> objects.githubusercontent.com), sometimes two; anything
 * past a handful is a loop or a redirect chain being used to walk us somewhere.
 */
export const MAX_REDIRECTS = 5

/** Digest algorithms accepted, with the byte length each must decode to. */
const DIGEST_BYTES = { sha256: 32, sha512: 64 }

/** Statuses treated as a redirect. 303 is included; every hop is a GET anyway. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** Standard base64 with optional padding — npm/SRI emit exactly this. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * A plugin id may become a directory name in the installer, so `..` and path
 * separators must never survive shape validation. One optional `@scope/`
 * segment is allowed because plugin ids are package-shaped; both segments must
 * start alphanumeric, which is what makes a bare `..` unrepresentable.
 */
const SAFE_ID = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Every string field a catalog row must carry. */
const REQUIRED_FIELDS = ['id', 'name', 'version', 'publisher', 'description', 'tarball', 'integrity']

/** Anything this module refuses, carrying a stable `code` for callers. */
export class MarketError extends Error {
  /**
   * @param {string} message - human-readable refusal.
   * @param {string} code - stable identifier for callers and tests.
   */
  constructor(message, code) {
    super(message)
    this.name = 'MarketError'
    this.code = code
  }
}

/** Bytes did not match the digest the catalog named, or the digest was unusable. */
export class IntegrityError extends MarketError {
  /**
   * @param {string} message - human-readable refusal.
   * @param {string} code - `ERR_MARKET_INTEGRITY` or `ERR_MARKET_INTEGRITY_FORMAT`.
   */
  constructor(message, code) {
    super(message, code)
    this.name = 'IntegrityError'
  }
}

/**
 * @typedef {object} CatalogEntry
 * @property {string} id - stable plugin id, safe as a path segment.
 * @property {string} name - the npm PACKAGE name. Not a label: the installer
 * resolves it, writes `node_modules/<name>`, records it in the profile manifest
 * and refuses a tarball whose own manifest disagrees with it.
 * @property {string} title - human-readable label, falling back to `name` when a
 * catalog does not supply one. Optional in the document, always present here,
 * so the settings list can show something a person would recognise without the
 * resolution key having to double as a label.
 * @property {string} version - the plugin's own version string, unparsed.
 * @property {string} publisher - who publishes it.
 * @property {string} description - one-line summary for the settings list.
 * @property {string} tarball - https URL of the tarball asset.
 * @property {string} integrity - SRI digest, `sha512-<base64>`.
 */

/**
 * @typedef {object} DroppedEntry
 * @property {number} index - position in the source `plugins` array.
 * @property {string | undefined} id - the row's id, when it had a usable one.
 * @property {string} reason - short, stable reason code.
 */

/**
 * @typedef {object} Catalog
 * @property {1} version - catalog format version.
 * @property {CatalogEntry[]} plugins - the rows that validated.
 * @property {DroppedEntry[]} dropped - the rows that did not, and why.
 */

/**
 * @typedef {(input: string, init?: object) => Promise<any>} FetchImpl
 */

/**
 * Reduce a source URL to the string two sources may be compared on, or null
 * when it is not a fetchable source at all.
 *
 * Comparison happens on this normal form and only by equality — never by
 * prefix. Prefix matching would accept `https://evil.com/?x=https://good.com/`,
 * which contains an allowed source without being one.
 * @param {unknown} value - a candidate or configured source.
 * @returns {string | null} the normal form, or null if not usable.
 */
function normaliseSource(value) {
  if (typeof value !== 'string' || value === '') return null
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  // https only, with no exception for localhost: the catalog is a remote index
  // and a plaintext hop is a hop an on-path attacker rewrites. A dev pointing
  // at a local file server is not a case worth a scheme hole.
  if (parsed.protocol !== 'https:') return null
  // Credentials in a source are either a leak into logs or the
  // `good.com@evil.com` trick, where the part that looks like the host is
  // really a username and the real host is what follows the `@`.
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.hostname === '') return null
  // `origin` lowercases the host and drops the default port, so case and `:443`
  // cannot be used to smuggle a second spelling of an allowed source past the
  // comparison. `pathname` keeps a trailing slash, which is deliberate: `/x/`
  // is a different resource from `/x`, so it must not match one.
  // The fragment is dropped — it never reaches the server, so it cannot
  // distinguish two sources.
  return `${parsed.origin}${parsed.pathname}${parsed.search}`
}

/**
 * Whether this source URL may be fetched at all.
 *
 * Never throws: a malformed candidate, and a malformed row in `extraSources`,
 * are both simply not matches — a bad configured source must not widen policy,
 * and must not take the whole marketplace down either.
 * @param {unknown} url - the source about to be fetched.
 * @param {unknown} [extraSources] - additional sources the operator configured.
 * @returns {boolean} whether this source URL may be fetched.
 */
export function isAllowedSource(url, extraSources) {
  const candidate = normaliseSource(url)
  if (candidate === null) return false
  const configured = Array.isArray(extraSources) ? extraSources : []
  for (const source of [DEFAULT_CATALOG, ...configured]) {
    const allowed = normaliseSource(source)
    if (allowed !== null && allowed === candidate) return true
  }
  return false
}

/**
 * Parse a URL that must be https, throwing rather than returning a flag —
 * used on every redirect hop, where a soft failure would mean continuing.
 * @param {unknown} value - the URL to check.
 * @param {string} what - what this URL is, for the message.
 * @returns {URL} the parsed URL.
 */
function requireHttps(value, what) {
  if (typeof value !== 'string' || value === '') {
    throw new MarketError(`market: ${what} is not a URL`, 'ERR_MARKET_SCHEME')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new MarketError(`market: ${what} is not a URL: ${value}`, 'ERR_MARKET_SCHEME')
  }
  if (parsed.protocol !== 'https:') {
    throw new MarketError(`market: ${what} is ${parsed.protocol} not https: ${value}`, 'ERR_MARKET_SCHEME')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new MarketError(`market: ${what} carries credentials: ${parsed.origin}`, 'ERR_MARKET_SCHEME')
  }
  return parsed
}

/**
 * Split an SRI string into algorithm and expected digest bytes.
 *
 * Every failure here throws. A missing, empty or unparsable integrity must
 * never be read as "no check needed" — that is the one bug in this file that
 * would make the whole verification theatre, so the absence of a digest is a
 * refusal, not a default.
 *
 * One hash only: SRI permits a whitespace-separated list, which immediately
 * raises the question of how many entries have to match. The answer that
 * closes the threat is "the one we chose", so the format admits exactly one.
 * @param {unknown} integrity - the SRI string, e.g. `sha512-<base64>`.
 * @returns {{ algorithm: 'sha256' | 'sha512', digest: Buffer }} parsed digest.
 */
export function parseIntegrity(integrity) {
  if (typeof integrity !== 'string' || integrity === '') {
    throw new IntegrityError('market: integrity is missing', 'ERR_MARKET_INTEGRITY_FORMAT')
  }
  const dash = integrity.indexOf('-')
  if (dash <= 0) {
    throw new IntegrityError(
      `market: integrity is not <algorithm>-<base64>: ${integrity}`,
      'ERR_MARKET_INTEGRITY_FORMAT',
    )
  }
  const algorithm = integrity.slice(0, dash)
  const encoded = integrity.slice(dash + 1)
  // Named refusal: an operator reading the log needs to know the row was
  // rejected for being sha1, not for being unparsable.
  if (algorithm !== 'sha256' && algorithm !== 'sha512') {
    throw new IntegrityError(
      `market: integrity algorithm ${algorithm} is not accepted (sha256, sha512)`,
      'ERR_MARKET_INTEGRITY_FORMAT',
    )
  }
  const expected = DIGEST_BYTES[algorithm]
  // Charset first: `Buffer.from(…, 'base64')` silently skips characters it does
  // not recognise, so a garbage digest decodes to a short buffer and would
  // otherwise reach the comparison as if it were a real one.
  if (!BASE64.test(encoded)) {
    throw new IntegrityError(
      `market: integrity digest is not base64: ${integrity}`,
      'ERR_MARKET_INTEGRITY_FORMAT',
    )
  }
  const digest = Buffer.from(encoded, 'base64')
  if (digest.length !== expected) {
    throw new IntegrityError(
      `market: ${algorithm} digest is ${digest.length} bytes, expected ${expected}: ${integrity}`,
      'ERR_MARKET_INTEGRITY_FORMAT',
    )
  }
  return { algorithm, digest }
}

/**
 * Verify bytes against an SRI digest, throwing when they do not match.
 * @param {unknown} bytes - the bytes as downloaded.
 * @param {unknown} integrity - the SRI string the catalog named.
 * @returns {void} nothing; throws an IntegrityError on any mismatch.
 */
export function verifyIntegrity(bytes, integrity) {
  const { algorithm, digest } = parseIntegrity(integrity)
  if (!(bytes instanceof Uint8Array)) {
    throw new IntegrityError('market: integrity check needs bytes', 'ERR_MARKET_INTEGRITY')
  }
  const actual = createHash(algorithm).update(bytes).digest()
  // Both sides are exactly DIGEST_BYTES[algorithm] long — parseIntegrity
  // guaranteed it for the expected side — so timingSafeEqual, which throws on
  // a length mismatch, cannot throw here.
  if (!timingSafeEqual(actual, digest)) {
    throw new IntegrityError(
      `market: ${algorithm} mismatch: got ${actual.toString('base64')}, expected ${digest.toString('base64')}`,
      'ERR_MARKET_INTEGRITY',
    )
  }
}

/**
 * Validate one catalog row. Returns the row, or the reason it cannot be offered.
 * @param {unknown} row - one element of the catalog's `plugins`.
 * @returns {{ entry: CatalogEntry } | { reason: string, id?: string }} outcome.
 */
function validateEntry(row) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return { reason: 'not-an-object' }
  const record = /** @type {Record<string, unknown>} */ (row)
  for (const field of REQUIRED_FIELDS) {
    const value = record[field]
    if (typeof value !== 'string' || value === '') return { reason: `missing-field:${field}` }
  }
  const id = /** @type {string} */ (record.id)
  if (!SAFE_ID.test(id)) return { reason: 'unsafe-id' }
  // The tarball URL is attacker-controlled input from a remote file, so it gets
  // the same scheme rule as the catalog itself rather than being trusted for
  // having arrived inside one.
  try {
    requireHttps(record.tarball, `tarball for ${id}`)
  } catch {
    return { reason: 'tarball-not-https', id }
  }
  // Reject an unusable digest at parse time: a row that could only ever fail at
  // install is a row worth reporting now, and it keeps the never-silently-pass
  // rule from depending on the install path remembering to check.
  try {
    parseIntegrity(record.integrity)
  } catch {
    return { reason: 'bad-integrity', id }
  }
  return {
    entry: {
      id,
      name: /** @type {string} */ (record.name),
      // Optional in the document. Defaulted rather than required so an existing
      // catalog stays valid, and so a row can never render as blank.
      title: typeof record.title === 'string' && record.title !== '' ? record.title : /** @type {string} */ (record.name),
      version: /** @type {string} */ (record.version),
      publisher: /** @type {string} */ (record.publisher),
      description: /** @type {string} */ (record.description),
      tarball: /** @type {string} */ (record.tarball),
      integrity: /** @type {string} */ (record.integrity),
    },
  }
}

/**
 * Parse and validate catalog text. Pure, so the whole shape rule is testable
 * without a fetch.
 *
 * A malformed row is dropped and reported rather than thrown: one bad row in a
 * catalog someone else publishes must not hide every good row behind it. The
 * envelope is different — unparsable JSON or an unknown `version` means we are
 * not reading what we think we are reading, and guessing there is worse than
 * failing.
 * @param {unknown} text - the catalog body as text.
 * @returns {Catalog} the validated catalog, with the dropped rows reported.
 */
export function parseCatalog(text) {
  if (typeof text !== 'string') throw new MarketError('market: catalog is not text', 'ERR_MARKET_CATALOG')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new MarketError(`market: catalog is not JSON: ${String(error)}`, 'ERR_MARKET_CATALOG')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MarketError('market: catalog is not an object', 'ERR_MARKET_CATALOG')
  }
  const envelope = /** @type {Record<string, unknown>} */ (parsed)
  if (envelope.version !== 1) {
    throw new MarketError(
      `market: catalog version ${JSON.stringify(envelope.version)} is not supported`,
      'ERR_MARKET_CATALOG',
    )
  }
  if (!Array.isArray(envelope.plugins)) {
    throw new MarketError('market: catalog has no plugins array', 'ERR_MARKET_CATALOG')
  }
  /** @type {CatalogEntry[]} */
  const plugins = []
  /** @type {DroppedEntry[]} */
  const dropped = []
  const seen = new Set()
  envelope.plugins.forEach((row, index) => {
    const outcome = validateEntry(row)
    if (!('entry' in outcome)) {
      dropped.push({ index, id: outcome.id, reason: outcome.reason })
      return
    }
    // A repeated id would let a later row shadow an earlier one, which is a
    // cheap way to substitute a plugin. First row wins; the rest are reported.
    if (seen.has(outcome.entry.id)) {
      dropped.push({ index, id: outcome.entry.id, reason: 'duplicate-id' })
      return
    }
    seen.add(outcome.entry.id)
    plugins.push(outcome.entry)
  })
  return { version: 1, plugins, dropped }
}

/**
 * Read a response body, counting bytes and stopping at the cap.
 *
 * `content-length` is a header the server chooses, so it is only ever allowed
 * to short-circuit — never to satisfy the cap. The bytes are counted as they
 * arrive, which is what makes a lying (or absent) length harmless.
 * @param {any} res - the response.
 * @param {string} url - the URL it came from, for the message.
 * @param {number} maxBytes - the cap.
 * @returns {Promise<Uint8Array>} the body bytes.
 */
async function readCapped(res, url, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MarketError(
      `market: ${url} declares ${declared} bytes, over the ${maxBytes} cap`,
      'ERR_MARKET_TOO_LARGE',
    )
  }
  const body = res.body
  // No body is a refusal, not an empty download: every retrieval here has a
  // body to read, so nothing to read means something upstream is wrong, and an
  // empty buffer would be handed on as if it were content.
  if (body === null || body === undefined) {
    throw new MarketError(`market: ${url} carried no body`, 'ERR_MARKET_BODY')
  }
  /** @type {Uint8Array[]} */
  const chunks = []
  let size = 0
  /** @param {Uint8Array} chunk - one arrived chunk. */
  const take = (chunk) => {
    size += chunk.byteLength
    if (size > maxBytes) {
      throw new MarketError(`market: ${url} exceeds the ${maxBytes} byte cap`, 'ERR_MARKET_TOO_LARGE')
    }
    chunks.push(chunk)
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) take(value)
      }
    } finally {
      // Stop the transfer on the way out: on the cap path there is more body
      // coming and nothing is going to read it.
      await reader.cancel().catch(() => {})
    }
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) take(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
  } else {
    throw new MarketError(`market: ${url} body is not readable`, 'ERR_MARKET_BODY')
  }
  return Buffer.concat(chunks)
}

/**
 * Retrieve one https URL, following redirects by hand.
 *
 * Redirects are followed manually (`redirect: 'manual'`) because the automatic
 * follow re-checks nothing: a GitHub Release asset legitimately redirects to
 * `objects.githubusercontent.com`, and the same mechanism would just as
 * happily carry us to `http://` — turning a verified-transport download into a
 * plaintext one an on-path attacker rewrites. Every hop is re-checked here
 * instead, and the hop count is capped so a redirect loop terminates.
 * @param {string} url - the URL to retrieve.
 * @param {{ fetchImpl?: FetchImpl, maxBytes: number, accept: string }} options - retrieval options.
 * @returns {Promise<Uint8Array>} the body bytes.
 */
async function retrieve(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new MarketError('market: no fetch implementation available', 'ERR_MARKET_BODY')
  }
  let current = requireHttps(url, 'url').href
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: options.accept },
    })
    const status = Number(res?.status)
    if (REDIRECT_STATUS.has(status)) {
      const location = res.headers?.get?.('location')
      if (typeof location !== 'string' || location === '') {
        throw new MarketError(`market: ${current} returned ${status} with no location`, 'ERR_MARKET_REDIRECT')
      }
      // Resolve against the hop it came from — Location may be relative — then
      // apply the full scheme and credentials check to the result.
      let next
      try {
        next = new URL(location, current).href
      } catch {
        throw new MarketError(`market: ${current} redirected to an unparsable location`, 'ERR_MARKET_REDIRECT')
      }
      current = requireHttps(next, `redirect from ${current}`).href
      continue
    }
    if (status < 200 || status >= 300) {
      throw new MarketError(`market: ${current} responded ${String(res?.status)}`, 'ERR_MARKET_STATUS')
    }
    return readCapped(res, current, options.maxBytes)
  }
  throw new MarketError(`market: more than ${MAX_REDIRECTS} redirects from ${url}`, 'ERR_MARKET_REDIRECT')
}

/**
 * Fetch and validate a catalog.
 * @param {string} url - the catalog source.
 * @param {{ extraSources?: unknown, fetchImpl?: FetchImpl, maxBytes?: number }} [options] - retrieval options.
 * @returns {Promise<Catalog>} the validated catalog.
 */
export async function fetchCatalog(url, options = {}) {
  // Policy before I/O: an unallowed source must not produce a request at all,
  // so a source planted in configuration cannot even be used as a beacon.
  if (!isAllowedSource(url, options.extraSources)) {
    throw new MarketError(`market: ${String(url)} is not an allowed catalog source`, 'ERR_MARKET_SOURCE')
  }
  const bytes = await retrieve(url, {
    fetchImpl: options.fetchImpl,
    maxBytes: options.maxBytes ?? MAX_CATALOG_BYTES,
    accept: 'application/json',
  })
  return parseCatalog(Buffer.from(bytes).toString('utf8'))
}

/**
 * Fetch one plugin tarball and verify it against the digest the catalog named.
 *
 * The URL is only required to be https, not allowlisted: it came out of a
 * catalog whose own source was allowlisted, and what binds these bytes to that
 * catalog is the digest, not the host they arrived from. Release assets are
 * served from a CDN host nobody would want to keep a list of.
 * @param {string} url - the tarball URL from the catalog.
 * @param {string} integrity - the SRI digest from the same row.
 * @param {{ fetchImpl?: FetchImpl, maxBytes?: number }} [options] - retrieval options.
 * @returns {Promise<Uint8Array>} the verified tarball bytes.
 */
export async function fetchTarball(url, integrity, options = {}) {
  // Parse the digest first: downloading megabytes against an integrity string
  // that can never verify is wasted work, and failing here says exactly why.
  parseIntegrity(integrity)
  const bytes = await retrieve(url, {
    fetchImpl: options.fetchImpl,
    maxBytes: options.maxBytes ?? MAX_TARBALL_BYTES,
    accept: 'application/octet-stream',
  })
  // Bytes are returned only after they verify, so no caller can hold
  // unverified bytes and therefore no caller can forget to check.
  verifyIntegrity(bytes, integrity)
  return bytes
}
