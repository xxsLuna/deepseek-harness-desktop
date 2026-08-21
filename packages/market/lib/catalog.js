// @ts-check
/**
 * @dsh-desktop/market — the catalog document.
 *
 * The marketplace used to be indexed by a shape this project invented: an
 * `index.json` with one flat row per plugin, understood by nobody but us. This
 * module reads the standard agent-plugin marketplace document instead —
 * `.claude-plugin/marketplace.json` — so a catalog written for the wider
 * ecosystem works here unchanged, and so publishing for this app stops meaning
 * "learn a format with one consumer".
 *
 * The split from `fetch.js` is the same split that file already makes and for
 * the same reason: everything here is pure, so the whole shape rule is testable
 * without a socket, and the network edge keeps only the network. Nothing in
 * this file does I/O.
 *
 * Two rules are carried over verbatim from `fetch.js`, because a catalog is a
 * document this project does not write:
 *
 * - **The envelope throws; a row drops.** Unparsable JSON, or a header we
 *   cannot claim to understand, means we are not reading what we think we are
 *   reading, and guessing there is worse than failing. One malformed row is a
 *   different thing entirely: a stranger's typo in row 4 must not hide rows 1
 *   to 3 behind it.
 * - **A drop is reported, never silent.** Every refusal lands in `dropped`
 *   with a stable reason code, so "my plugin is not in the list" has an answer
 *   in a log line instead of in a bug report. That matters most for the source
 *   types this version cannot install from yet: those rows are perfectly valid
 *   documents, and a publisher needs to be able to tell "not supported" from
 *   "your JSON is wrong".
 *
 * Runs inside the harness sidecar (plain Node, no Electron).
 */
import { MarketError, requireHttps } from './fetch.js'
import { isPluginName } from './registry.js'

/**
 * Where the document lives inside a marketplace repository. A well-known path,
 * not a choice of ours — exported so the network edge names it once.
 */
export const MARKETPLACE_FILE = '.claude-plugin/marketplace.json'

/**
 * The source types this version can actually install from.
 *
 * `github`, `url` and `git-subdir` are fetched at a revision and `archive` at a
 * digest, so every one of them can be pinned to bytes chosen in advance. That
 * is the line the unsupported three fall on the wrong side of, not an
 * arbitrary subset.
 *
 * `git-subdir` is here because it is how one repository carries several
 * plugins, which is what a marketplace repository looks like in practice —
 * without it, publishing a plugin means publishing a repository per plugin.
 */
export const SUPPORTED_SOURCES = Object.freeze(['github', 'url', 'archive', 'git-subdir'])

/**
 * `owner/name`, and nothing that could climb out of either segment.
 *
 * A repo string is pasted into a URL and, once cloned, into a path. Requiring
 * each segment to start alphanumeric is what makes a bare `..` unrepresentable
 * — the same construction `fetch.js` uses on an id and `registry.js` on a
 * package name.
 */
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/** A git object id: 40 hex. Accepted in either case; recorded lowercase. */
const COMMIT_SHA = /^[0-9a-f]{40}$/i

/** An archive digest as this format spells it: 64 hex, not SRI base64. */
const ARCHIVE_SHA256 = /^[0-9a-f]{64}$/i

/**
 * A branch or tag name conservative enough to hand to a git command.
 *
 * Anything a real branch needs is in here; the characters left out are the ones
 * that change what a checkout means rather than which ref it names.
 */
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/

/**
 * A `git-subdir` path: slash-separated segments, each starting alphanumeric.
 *
 * Written so `..`, an absolute path and a leading dash are unrepresentable
 * rather than filtered out afterwards — the transport applies the same rule
 * again on its own side, because this one governs what may be LISTED and that
 * one governs what may be fetched.
 */
const SUBDIR_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}$/

/**
 * The shape a source type must have before it is quoted back in a reason code.
 *
 * A reason code reaches a log line and a settings tooltip, and the source type
 * comes out of a remote document — so an unrecognised one is only echoed when
 * it looks like an identifier. Otherwise the row is dropped as `unknown` and
 * the publisher's chosen string stays out of our output entirely.
 */
const REASON_TOKEN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * @typedef {object} Person
 * @property {string} name - who they are.
 * @property {string} [email] - contact address, exactly as published.
 * @property {string} [url] - https link, when the document carried a usable one.
 */

/**
 * @typedef {object} GithubSource
 * @property {'github'} source - the discriminant.
 * @property {string} repo - `owner/name`.
 * @property {string} [ref] - branch or tag; absent when a `sha` pinned the row.
 * @property {string} [sha] - 40-hex commit, lowercased. Overrides `ref`.
 */

/**
 * @typedef {object} UrlSource
 * @property {'url'} source - the discriminant.
 * @property {string} url - https clone URL, ending `.git`.
 * @property {string} [ref] - branch or tag; absent when a `sha` pinned the row.
 * @property {string} [sha] - 40-hex commit, lowercased. Overrides `ref`.
 */

/**
 * @typedef {object} ArchiveSource
 * @property {'archive'} source - the discriminant.
 * @property {string} url - https URL of the archive.
 * @property {string} sha256 - 64-hex digest of the bytes, lowercased.
 */

/**
 * @typedef {object} GitSubdirSource
 * @property {'git-subdir'} source - the discriminant.
 * @property {string} [repo] - `owner/name`, when the row spells it that way.
 * @property {string} [url] - https clone URL, for any other forge.
 * @property {string} path - the plugin's directory inside the repository.
 * @property {string} [ref] - branch or tag; absent when a `sha` pinned the row.
 * @property {string} [sha] - 40-hex commit, lowercased. Overrides `ref`.
 */

/** @typedef {GithubSource | UrlSource | ArchiveSource | GitSubdirSource} PluginSource */

/**
 * @typedef {object} CatalogPlugin
 * @property {string} name - the install key: the name written into the profile
 * manifest and resolved as a directory, so it is held to `registry.js`'s
 * package-name grammar.
 * @property {string} displayName - human-readable label, falling back to
 * `name`. Optional in the document, always present here, so a settings row can
 * never render blank.
 * @property {PluginSource} source - where the plugin is fetched from.
 * @property {string} [description] - one-line summary for the settings list.
 * @property {string} [version] - the publisher's version LABEL, verbatim.
 * @property {Person} [author] - who wrote the plugin, as opposed to who lists it.
 * @property {string} [homepage] - https link.
 * @property {string} [repository] - https link.
 * @property {string} [license] - SPDX-ish identifier, as published.
 * @property {string} [category] - the publisher's own grouping.
 * @property {string[]} [keywords] - search terms, deduplicated.
 * @property {string[]} [tags] - the publisher's own labels, deduplicated.
 * @property {Record<string, unknown>} [metadata] - free-form, passed through.
 * `metadata.kind` (`'claude'` or `'dsh'`) is a hint this app reads; the
 * installer verifies it against the fetched bytes rather than trusting it.
 */

/**
 * @typedef {object} DroppedRow
 * @property {number} index - position in the source `plugins` array, or -1 for
 * a drop that is not a row at all (a `renames` entry). Every drop keeps one
 * shape so a caller never has to test which kind it is holding.
 * @property {string | undefined} name - the row's name, when it had a usable
 * one. Absent when the name itself is what failed: echoing a name we just
 * refused as unsafe would put it back in the output it was refused from.
 * @property {string} reason - short, stable reason code.
 */

/**
 * @typedef {object} Catalog
 * @property {string} name - the marketplace's name.
 * @property {Person} owner - who is offering this code. Required.
 * @property {string | undefined} description - the marketplace's blurb.
 * @property {string | undefined} version - the marketplace document's own
 * version string. Not a format discriminant — see {@link parseCatalog}.
 * @property {Record<string, unknown>} metadata - free-form, passed through.
 * @property {string[]} allowCrossMarketplaceDependenciesOn - marketplaces this
 * one declares its plugins may depend on.
 * @property {CatalogPlugin[]} plugins - the rows that validated.
 * @property {Record<string, string | null>} renames - former name -> current
 * name, or null for a tombstone.
 * @property {DroppedRow[]} dropped - what did not validate, and why.
 */

/**
 * A value as a plain JSON record; anything else reads as an empty one.
 *
 * `registry.js` keeps a private copy of this for the same reason: the input is
 * `unknown` (it came out of a JSON file), property access on `unknown` is not a
 * thing, and collapsing absent, null, a string and an array into one empty
 * record makes each read a single expression with no shape left to test for.
 * @param {unknown} value - the candidate record.
 * @returns {Record<string, unknown>} the record, or an empty one.
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * A non-empty string, or undefined. Every optional text field is read this way.
 *
 * An empty string is treated as absent rather than as a value: a row carrying
 * `"description": ""` means the publisher left it blank, and passing it on
 * would render an empty element where the fallback would have rendered
 * something.
 * @param {unknown} value - the candidate.
 * @returns {string | undefined} the string, or undefined.
 */
function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse an https URL, or undefined when it is not one.
 *
 * Delegates to `fetch.js`'s `requireHttps` so there is exactly one spelling of
 * the scheme rule — https only, no embedded credentials. The only difference
 * here is the outcome: a bad URL drops one catalog row, where the network edge
 * has to abort. Restating the rule instead would leave two copies to keep in
 * step, and only one of them would get the next fix.
 * @param {unknown} value - the candidate URL.
 * @returns {URL | undefined} the parsed URL, or undefined.
 */
function httpsUrl(value) {
  try {
    const parsed = requireHttps(value, 'catalog url')
    // requireHttps does not reject an empty host; a URL with none cannot be
    // fetched and must not reach a row.
    return parsed.hostname === '' ? undefined : parsed
  } catch {
    return undefined
  }
}

/**
 * A link the settings UI may render, or undefined.
 *
 * Held to the same https rule as a source, and for a sharper reason: a
 * `javascript:` or `data:` value in a field the UI turns into an href is script
 * injection wearing a publisher's name. Losing a link costs a click; the row
 * itself is not dropped over one, because a broken homepage says nothing about
 * whether the plugin is installable.
 * @param {unknown} value - the candidate link.
 * @returns {string | undefined} the normalised URL, or undefined.
 */
function displayLink(value) {
  return httpsUrl(value)?.href
}

/**
 * Read an owner/author record.
 *
 * A bare string is accepted as well as `{name, …}` because both spellings are
 * in the wild and neither is ambiguous. The email is not shape-checked: it is
 * displayed and never contacted from here, so a validator could only reject
 * valid exotic addresses.
 * @param {unknown} value - the candidate person.
 * @returns {Person | undefined} the person, or undefined when unnamed.
 */
function person(value) {
  if (typeof value === 'string') {
    const bare = nonEmpty(value)
    return bare === undefined ? undefined : { name: bare }
  }
  const record = asRecord(value)
  const name = nonEmpty(record.name)
  if (name === undefined) return undefined
  /** @type {Person} */
  const out = { name }
  const email = nonEmpty(record.email)
  if (email !== undefined) out.email = email
  const url = displayLink(record.url)
  if (url !== undefined) out.url = url
  return out
}

/**
 * A deduplicated list of non-empty strings, or undefined when there are none.
 *
 * Duplicates are dropped rather than reported: a repeated keyword is a typo
 * with no consequence, unlike a repeated plugin name, which shadows a row.
 * @param {unknown} value - the candidate array.
 * @returns {string[] | undefined} the list, or undefined.
 */
function stringList(value) {
  if (!Array.isArray(value)) return undefined
  /** @type {string[]} */
  const out = []
  for (const item of value) {
    const entry = nonEmpty(item)
    if (entry !== undefined && !out.includes(entry)) out.push(entry)
  }
  return out.length === 0 ? undefined : out
}

/**
 * Attach the revision a git source is fetched at.
 *
 * **`sha` overrides `ref`, and the override is applied here** rather than left
 * to whoever consumes the row. A `sha` names an immutable commit; a `ref` names
 * a branch or tag the publisher can move under us after the row was reviewed.
 * A row carrying both is a pinned row, so the ref is dropped instead of being
 * carried alongside for someone downstream to prefer by accident — the same
 * shape of guarantee as `fetchTarball` returning bytes only after they verify.
 * @param {GithubSource | UrlSource | GitSubdirSource} source - the source built so far.
 * @param {Record<string, unknown>} record - the raw source object.
 * @returns {{ source: PluginSource } | { reason: string }} outcome.
 */
function withRevision(source, record) {
  const sha = nonEmpty(record.sha)
  if (sha !== undefined) {
    // A malformed pin is worse than no pin: it looks like a guarantee and
    // cannot be one, so the row goes rather than quietly falling back to `ref`.
    if (!COMMIT_SHA.test(sha)) return { reason: 'bad-source:sha' }
    return { source: { ...source, sha: sha.toLowerCase() } }
  }
  const ref = nonEmpty(record.ref)
  if (ref === undefined) return { source }
  // A ref reaches a git command as an argument. A leading `-` becomes a flag,
  // `..` turns the name into a range, and whitespace splits it into two
  // arguments — none of which a branch name needs, and each of which changes
  // what gets checked out rather than merely naming something that is missing.
  if (!GIT_REF.test(ref) || ref.includes('..')) return { reason: 'bad-source:ref' }
  return { source: { ...source, ref } }
}

/**
 * Normalise one plugin's `source`, or say why it cannot be offered.
 * @param {unknown} value - the row's `source` field.
 * @returns {{ source: PluginSource } | { reason: string }} outcome.
 */
function parseSource(value) {
  if (typeof value === 'string') {
    // The format's relative-path form: a directory inside the marketplace
    // repository, resolved against `metadata.pluginRoot`. This app fetches one
    // document over https and never clones the repository around it, so there
    // is nothing for the path to be relative TO. Named rather than skipped,
    // because the row is valid and simply needs a capability we have not built.
    return { reason: 'source-not-supported:relative-path' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { reason: 'source-not-supported:unknown' }
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const kind = record.source
  switch (kind) {
    case 'github': {
      const repo = nonEmpty(record.repo)
      if (repo === undefined || !GITHUB_REPO.test(repo)) return { reason: 'bad-source:repo' }
      return withRevision({ source: 'github', repo }, record)
    }
    case 'url': {
      const url = httpsUrl(record.url)
      if (url === undefined) return { reason: 'bad-source:url' }
      // A `url` source is CLONED. Requiring the `.git` suffix is what stops it
      // being handed a tarball or a web page — a confusion that would only
      // surface at install time, long after the row was offered, and that the
      // `archive` type exists to carry properly. The cost is a clone URL
      // published without the suffix; the reason code names that case exactly
      // so a publisher can see what to add.
      if (!url.pathname.endsWith('.git')) return { reason: 'bad-source:not-git-url' }
      return withRevision({ source: 'url', url: url.href }, record)
    }
    case 'archive': {
      const url = httpsUrl(record.url)
      if (url === undefined) return { reason: 'bad-source:url' }
      const sha256 = nonEmpty(record.sha256)
      // An archive has no commit to pin, so the digest IS the pin: without it
      // the bytes are whatever the host serves today. Absent is exactly as bad
      // as wrong, which is why both land on one reason code.
      //
      // This is hex, not SRI, so `fetch.js`'s `parseIntegrity` does not apply —
      // it reads `sha256-<base64>` and would refuse every well-formed value
      // here. Converting one spelling into the other to reuse a length check
      // would hide the format from the next reader for no safety gained.
      if (sha256 === undefined || !ARCHIVE_SHA256.test(sha256)) return { reason: 'bad-source:sha256' }
      return { source: { source: 'archive', url: url.href, sha256: sha256.toLowerCase() } }
    }
    case 'git-subdir': {
      // Either spelling of the repository, because the format carries both and
      // a publisher on another forge has only the URL.
      const repo = nonEmpty(record.repo)
      const url = repo === undefined ? httpsUrl(record.url) : undefined
      if (repo === undefined ? url === undefined : !GITHUB_REPO.test(repo)) {
        return { reason: repo === undefined ? 'bad-source:url' : 'bad-source:repo' }
      }
      if (url !== undefined && !url.pathname.endsWith('.git')) return { reason: 'bad-source:not-git-url' }
      const path = nonEmpty(record.path)
      // Absent is a refusal, not a default of the repository root: a row
      // omitting it is a publisher who meant a directory and lost it, and
      // installing the whole repository in its place is the wrong recovery.
      if (path === undefined || !SUBDIR_PATH.test(path)) return { reason: 'bad-source:path' }
      return withRevision(
        repo === undefined
          ? { source: 'git-subdir', url: /** @type {URL} */ (url).href, path }
          : { source: 'git-subdir', repo, path },
        record,
      )
    }
    case 'npm':
      // Would install from a package registry, where what arrives is whatever
      // the registry serves for a range — the one thing none of the supported
      // three allow.
      return { reason: 'source-not-supported:npm' }
    case 'command':
      // Not "not yet". This asks the sidecar to run a command string chosen by
      // whoever published the catalog. Nothing about a document fetched over
      // the network earns that, so it is refused on purpose rather than
      // pending.
      return { reason: 'source-not-supported:command' }
    default: {
      const named = typeof kind === 'string' && REASON_TOKEN.test(kind) ? kind : 'unknown'
      return { reason: `source-not-supported:${named}` }
    }
  }
}

/**
 * Validate one catalog row. Returns the row, or the reason it cannot be offered.
 * @param {unknown} row - one element of the catalog's `plugins`.
 * @returns {{ entry: CatalogPlugin } | { reason: string, name?: string }} outcome.
 */
function validateRow(row) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return { reason: 'not-an-object' }
  const record = /** @type {Record<string, unknown>} */ (row)
  const name = nonEmpty(record.name)
  if (name === undefined) return { reason: 'missing-field:name' }
  // One grammar for install keys, and it lives in `registry.js`. This name
  // becomes the key `addInstalled` writes and the directory Node's resolution
  // joins, so a second regex here would mean two rules to keep in step — and
  // the one that drifts is the one that lets `..` through.
  if (!isPluginName(name)) return { reason: 'unsafe-name' }
  if (record.source === undefined || record.source === null || record.source === '') {
    return { reason: 'missing-field:source', name }
  }
  const outcome = parseSource(record.source)
  if (!('source' in outcome)) return { reason: outcome.reason, name }
  /** @type {CatalogPlugin} */
  const entry = {
    name,
    // Optional in the document, always present here, so a settings row can
    // never render blank. The same fallback `fetch.js` applies to `title`: the
    // resolution key doubles as a label only when there is no label, rather
    // than the label being required of every publisher.
    displayName: nonEmpty(record.displayName) ?? name,
    source: outcome.source,
  }
  const description = nonEmpty(record.description)
  if (description !== undefined) entry.description = description
  // The version is a LABEL here, kept exactly as published and checked against
  // nothing. In particular it is NOT run through `registry.js`'s
  // `isPluginVersion`: that function guards what we WRITE into a profile
  // manifest, where an unresolvable specifier costs the next install, whereas
  // this string is displayed and nothing else — a `github` or `url` row is
  // fetched at its ref or sha and never consults it at all. Dropping a plugin
  // over the shape of its label would hide something perfectly installable.
  //
  // For the record, since it is the obvious thing to reach for: `isPluginVersion`
  // does accept the git-describe form (`1.5.0+g6927fc3`) — its pattern carries a
  // build-metadata branch. It is unused here because of what it is FOR, not
  // because it would reject real catalog values.
  const version = nonEmpty(record.version)
  if (version !== undefined) entry.version = version
  const author = person(record.author)
  if (author !== undefined) entry.author = author
  const homepage = displayLink(record.homepage)
  if (homepage !== undefined) entry.homepage = homepage
  const repository = displayLink(record.repository)
  if (repository !== undefined) entry.repository = repository
  const license = nonEmpty(record.license)
  if (license !== undefined) entry.license = license
  const category = nonEmpty(record.category)
  if (category !== undefined) entry.category = category
  const keywords = stringList(record.keywords)
  if (keywords !== undefined) entry.keywords = keywords
  const tags = stringList(record.tags)
  if (tags !== undefined) entry.tags = tags
  // Free-form, passed through untouched. The standard says a consumer ignores
  // what it does not understand, which makes this the right place for a field
  // only this app knows — `metadata.kind` lets the settings tab say what a
  // plugin IS before anything is downloaded, so the install confirmation can
  // warn correctly (a dsh plugin runs code; a Claude plugin enters a prompt).
  // It stays a HINT: the installer decides the kind from the bytes it fetched
  // and refuses a package that disagrees with what was advertised.
  const metadata = asRecord(record.metadata)
  if (Object.keys(metadata).length > 0) entry.metadata = metadata
  return { entry }
}

/**
 * Normalise the former-name map.
 *
 * A rename is how a caller follows an install whose plugin was renamed
 * upstream, and `null` is a tombstone — the plugin is gone, not moved. Both
 * sides are held to the same grammar as a row's `name`, because the key is
 * compared against an install key and the value is used as one.
 *
 * Malformed entries are reported rather than thrown, even though `renames` is
 * envelope-level: nothing is installed from this map, so a bad entry costs a
 * redirect that will not be followed, not a wrong package on disk. That is the
 * row rule, not the envelope rule, so it gets the row treatment.
 * @param {unknown} value - the envelope's `renames` field.
 * @param {DroppedRow[]} dropped - collector for what is refused.
 * @returns {Record<string, string | null>} the usable renames.
 */
function parseRenames(value, dropped) {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    dropped.push({ index: -1, name: undefined, reason: 'bad-renames' })
    return {}
  }
  /** @type {Record<string, string | null>} */
  const out = {}
  for (const [from, to] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (!isPluginName(from) || !(to === null || isPluginName(to))) {
      dropped.push({ index: -1, name: isPluginName(from) ? from : undefined, reason: 'bad-rename' })
      continue
    }
    out[from] = /** @type {string | null} */ (to)
  }
  return out
}

/**
 * Parse and validate a marketplace document. Pure, so the whole shape rule is
 * testable without a fetch.
 *
 * The envelope is fatal where a row is not. An unknown header means the bytes
 * are not the document we think they are, and every row read out of them would
 * be a guess about a format we do not know.
 *
 * One header check deserves its own note. `version` here is the MARKETPLACE's
 * own version string, not a format number — and that is precisely the trap,
 * because the format this replaced used the same key as its format
 * discriminant (`"version": 1`). A numeric `version` is therefore an old
 * `index.json`, whose rows carry `id`/`tarball`/`integrity` and mean something
 * else entirely; reading one as this format would not fail, it would silently
 * drop every row for having no `source`. So it is refused by name.
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
  if (envelope.version !== undefined) {
    if (typeof envelope.version === 'number') {
      throw new MarketError(
        `market: catalog version ${envelope.version} is the retired index.json format, not ${MARKETPLACE_FILE}`,
        'ERR_MARKET_CATALOG',
      )
    }
    if (typeof envelope.version !== 'string' || envelope.version === '') {
      throw new MarketError(
        `market: catalog version ${JSON.stringify(envelope.version)} is not supported`,
        'ERR_MARKET_CATALOG',
      )
    }
  }
  const name = nonEmpty(envelope.name)
  if (name === undefined) throw new MarketError('market: catalog has no name', 'ERR_MARKET_CATALOG')
  // Required, and required to be usable. `owner` is the only field that says
  // who is offering this code, and every row under it is code that will run
  // in-process with the harness's own privileges. A document that will not name
  // a publisher is not one to read rows out of.
  const owner = person(envelope.owner)
  if (owner === undefined) throw new MarketError('market: catalog has no owner', 'ERR_MARKET_CATALOG')
  if (!Array.isArray(envelope.plugins)) {
    throw new MarketError('market: catalog has no plugins array', 'ERR_MARKET_CATALOG')
  }
  /** @type {CatalogPlugin[]} */
  const plugins = []
  /** @type {DroppedRow[]} */
  const dropped = []
  const seen = new Set()
  envelope.plugins.forEach((row, index) => {
    const outcome = validateRow(row)
    if (!('entry' in outcome)) {
      dropped.push({ index, name: outcome.name, reason: outcome.reason })
      return
    }
    // A repeated name would let a later row shadow an earlier one, which is a
    // cheap way to substitute a plugin. First row wins; the rest are reported.
    if (seen.has(outcome.entry.name)) {
      dropped.push({ index, name: outcome.entry.name, reason: 'duplicate-name' })
      return
    }
    seen.add(outcome.entry.name)
    plugins.push(outcome.entry)
  })
  return {
    name,
    owner,
    description: nonEmpty(envelope.description),
    version: nonEmpty(envelope.version),
    // Free-form by design, so it is carried through rather than modelled.
    // `metadata.pluginRoot` is the base directory for relative sources, which
    // this version refuses — carried anyway so that when relative sources land,
    // the base is already here instead of needing to be plumbed through then.
    metadata: asRecord(envelope.metadata),
    allowCrossMarketplaceDependenciesOn: stringList(envelope.allowCrossMarketplaceDependenciesOn) ?? [],
    plugins,
    // Parsed after the rows on purpose: row drops then read in index order, and
    // the index-less rename drops sit together at the end.
    renames: parseRenames(envelope.renames, dropped),
    dropped,
  }
}
