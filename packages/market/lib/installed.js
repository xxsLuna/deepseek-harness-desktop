// @ts-check
/**
 * The record of installed **Claude plugins**: what a row in
 * `$DSH_HOME/claude-plugins/installed.json` means, and the rules for reading
 * and editing that document.
 *
 * This is a different plugin kind from the one `registry.js` records, and the
 * two must not be confused. A harness plugin is an npm package that the
 * sidecar `import()`s in-process, so its record is the profile `package.json`
 * upstream already owns. A Claude plugin is content — commands, agents,
 * skills, an MCP server declaration — that nothing in this process imports. It
 * has no package manager, no resolution and no upstream format, so it gets a
 * directory of our own:
 *
 *     $DSH_HOME/claude-plugins/<source>/<name>/    the tree
 *     $DSH_HOME/claude-plugins/installed.json                this document
 *
 * The version is a path segment rather than an overwrite target on purpose:
 * an upgrade lands beside the version already there, so the write never has to
 * delete a tree that something may still be reading, and a failed upgrade
 * leaves the working copy intact. `addInstalled` then repoints the record, and
 * the old directory is garbage the caller can collect afterwards.
 *
 * Everything here is pure — no `fs`, no `process`. The caller reads the file,
 * hands the parsed JSON in, and writes what comes back. That is CLAUDE.md's
 * convention for anything with a rule in it, and it is what lets the whole of
 * this be tested without a `$DSH_HOME`.
 *
 * **Reads are total and writes are loud**, the same discipline `registry.js`
 * documents and for the same reason. The document is hand-editable and can be
 * half-written, so no read may throw: the plugins tab has to show *something*
 * from whatever is on disk. A write, by contrast, is our own code recording a
 * tree it just unpacked, so a name we will not record is a bug or a hostile
 * catalog row — and failing quietly would leave a directory on disk with
 * nothing pointing at it.
 *
 * One consequence worth stating outright: `parseInstalled` reports a row's
 * `path` **verbatim**, junk included, so a hand-edited `"path": "../../.."` is
 * reported rather than hidden. That string is a record, never an instruction.
 * A caller resolving a directory — above all one about to delete it — must
 * recompute it with {@link installPath} from the three validated segments, and
 * must never join the recorded string onto `$DSH_HOME`.
 */
import { isPluginName } from './registry.js'

/** The directory under `$DSH_HOME` that holds every Claude plugin tree. */
export const CLAUDE_PLUGINS_DIR = 'claude-plugins'

/** The record's filename, inside {@link CLAUDE_PLUGINS_DIR}. */
export const INSTALLED_FILE = 'installed.json'

/** What a row describes when it does not say. */
export const DEFAULT_KIND = 'plugin'

/**
 * One installed Claude plugin.
 *
 * Five fields, and each earns its place by answering a question nothing else
 * in the system can answer once the install has finished:
 *
 * - `name` — the identity. It is also the key: {@link removeInstalled} takes a
 *   name, and {@link addInstalled} replaces by name, because two rows with one
 *   name would be two directories both claiming to be that plugin.
 * - `version` — which build is live. Not derivable from the tree: the
 *   directory is named after it, but reading the directory means I/O, and this
 *   document is what the plugins tab renders before any I/O happens.
 * - `source` — which catalog it came from. Needed to offer an upgrade (you
 *   have to know which catalog to re-read) and to disambiguate two catalogs
 *   publishing the same name, which is exactly why the source is a directory
 *   level rather than a flat namespace.
 * - `kind` — what was installed. A `.claude-plugin` marketplace lists more
 *   than plugins, and a reader that has to open the tree to find out what a
 *   row is has lost the point of having a record. Defaults to
 *   {@link DEFAULT_KIND}.
 * - `path` — where it landed, relative to `$DSH_HOME`, POSIX-separated. Today
 *   it is exactly {@link installPath}'s output; it is recorded anyway so a
 *   future change to the layout can still find what an older build wrote, and
 *   so a person reading the file can see where to look. Never resolve it —
 *   see the module note.
 *
 * Unknown keys are preserved through every function here, so a caller is free
 * to record more (an install timestamp, the catalog's integrity string, a
 * title) without this module having to know about it.
 * @typedef {object} InstalledEntry
 * @property {string} name - the plugin's name, and the row's identity.
 * @property {string} version - the installed version.
 * @property {string} source - the id of the catalog it came from.
 * @property {string} kind - what was installed; `plugin` unless stated.
 * @property {string} path - where it landed, relative to `$DSH_HOME`, POSIX.
 * @property {boolean} [disabled] - present and true while the plugin is kept
 * but not published. The directory is renamed dot-prefixed so the skill walk
 * skips it; this flag is what lets the tab still list it and offer it back.
 */

/**
 * @typedef {object} InstalledView
 * @property {InstalledEntry[]} entries - the rows that could be read, deduped.
 * @property {number} total - how many rows the document actually held.
 *   `entries.length < total` means the file carries rows we could not read;
 *   the tab can say so instead of silently under-reporting what is on disk.
 */

/** The document as JSON: our two fields plus whatever else it carries. */
/** @typedef {Record<string, unknown>} InstalledDoc */

/**
 * A value as a plain JSON record; anything else reads as an empty one.
 *
 * Same helper, same reasoning as `registry.js`: the input is `unknown` because
 * it is whatever a JSON file held, and collapsing absent, null, a string and
 * an array into one empty record makes each read a single expression.
 * @param {unknown} value - the candidate record.
 * @returns {Record<string, unknown>} the record, or an empty one.
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * A string field read verbatim, or a fallback when it is not a string.
 * @param {Record<string, unknown>} row - the row being read.
 * @param {string} key - the field name.
 * @param {string} fallback - what to report when the field is unusable.
 * @returns {string} the field, or the fallback.
 */
function text(row, key, fallback) {
  const value = row[key]
  return typeof value === 'string' ? value : fallback
}

/**
 * Whether a value may be **written** into the record as a path segment.
 *
 * The three recorded segments are joined onto `$DSH_HOME` to make a directory,
 * so `..`, a separator and an absolute form are traversal primitives, not
 * typos — the identical threat `registry.js` reasons about for the package
 * name it records. Rather than invent a second rule, this is that rule:
 * `isPluginName`, whose "first character of every segment must be
 * alphanumeric" is what kills `..`, `.` and every dotted relative form, and
 * whose charset admits no `\` at all.
 *
 * Two things are tightened on top of it, both because these values name a
 * directory rather than a package:
 *
 * - **One segment.** `isPluginName` permits an npm scope, and `@acme/tool`
 *   joined into a path is two levels, not one. The layout is exactly three
 *   levels deep and code that walks the directory to enumerate installs relies
 *   on that, so a `/` is refused here even though it cannot escape anything.
 * - **Not `installed.json`.** A source id spelled like the record's own
 *   filename would need a directory where the record file already is. Same
 *   class of collision as the `node_modules` `registry.js` reserves, and the
 *   same answer.
 *
 * Exported because {@link parseInstalled} reports what the file holds verbatim:
 * a caller about to turn a parsed value back into a path must check it first.
 * @param {unknown} value - the candidate segment.
 * @returns {boolean} true when it is safe to record and to join.
 */
export function isSafeSegment(value) {
  return typeof value === 'string'
    && !value.includes('/')
    && value !== INSTALLED_FILE
    && isPluginName(value)
}

/**
 * Whether a value can be recorded as a version.
 *
 * Looser than {@link isSafeSegment} on purpose, and the looseness is the point:
 * a version stopped being a path level, so the rule that guards paths has
 * nothing to say about it. `1.5.0+g6927fc3` is an ordinary SemVer string —
 * build metadata after a `+` — and refusing it over a `+` would make a
 * perfectly installable plugin uninstallable for a character that never
 * reaches the filesystem.
 *
 * What it still guards is display: this string is rendered in the plugins tab
 * and written into JSON, so a control character or a newline in it is a row
 * that breaks the list around it.
 * @param {unknown} value - the candidate version.
 * @returns {boolean} whether it can be recorded.
 */
export function isRecordableVersion(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Where a plugin's tree lives, as path segments relative to `$DSH_HOME`.
 *
 * Segments rather than a joined string, so the caller joins them with its own
 * platform's separator and no `/` vs `\` question ever arises — and so nothing
 * can hand this result somewhere as a single opaque path without having
 * noticed it is a list.
 *
 * **The version is deliberately NOT a path level.** It lives only in the
 * record. A version directory would keep an upgrade from touching the tree a
 * reader might be walking, but it also drags semver's charset into a path
 * segment — `1.0.0+g6927fc3` is a perfectly ordinary version and `+` has no
 * business being adjudicated by a path rule. The upgrade window is closed in
 * the installer instead, by renaming the old tree aside before renaming the new
 * one in, so there is never a moment with nothing there.
 *
 * Throws on anything it will not join. This is the loud half of the discipline:
 * every path the installer writes to comes from here, so a refusal here is a
 * refusal to write outside the tree, and returning a flag would let a caller
 * carry on with a path it never checked.
 * @param {unknown} sourceId - the catalog the plugin came from.
 * @param {unknown} name - the plugin's name.
 * @returns {string[]} the path segments, relative to `$DSH_HOME`.
 * @throws when any segment is not one this module will join.
 */
export function installPath(sourceId, name) {
  for (const [what, value] of [['source', sourceId], ['name', name]]) {
    if (!isSafeSegment(value)) {
      throw new Error(`market: refusing ${JSON.stringify(value)} as an install ${String(what)}: not a safe path segment`)
    }
  }
  return [CLAUDE_PLUGINS_DIR, /** @type {string} */ (sourceId), /** @type {string} */ (name)]
}

/**
 * Read the record. Never throws.
 *
 * Total by construction: a missing file (`undefined`), a document that is not
 * an object, a `plugins` that is not an array, rows that are not objects, rows
 * with no usable name — each yields the shortest true answer. This document is
 * local state the app has to start from, not remote content it may refuse; the
 * catalog parser in `fetch.js` throws on a bad envelope for the opposite
 * reason, and the difference is deliberate. That is also why the envelope's
 * `version` is not gated on here: refusing to read a user's installs because
 * of a number in the file would strand every one of them.
 *
 * A row's fields are reported **verbatim** when they are strings, so a value
 * this module would refuse to write still shows up when a hand-edit put it
 * there. Hiding it would make the tab claim nothing is installed while a
 * directory sits on disk; check {@link isSafeSegment} before resolving one.
 *
 * A name is required because it is the row's identity — a row nothing can
 * name is a row nothing can remove, so it is counted in `total` and dropped.
 * A repeat is dropped for the same reason a repeat is dropped everywhere else
 * here: two rows with one name are two directories claiming one plugin, and
 * the first one wins.
 * @param {unknown} doc - the parsed `installed.json`, of any shape.
 * @returns {InstalledView} the rows that could be read, and how many there were.
 */
export function parseInstalled(doc) {
  const rows = asRecord(doc).plugins
  if (!Array.isArray(rows)) return { entries: [], total: 0 }
  /** @type {InstalledEntry[]} */
  const entries = []
  const seen = new Set()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const record = /** @type {Record<string, unknown>} */ (row)
    const name = record.name
    if (typeof name !== 'string' || name === '' || seen.has(name)) continue
    seen.add(name)
    entries.push({
      // Spread first so keys this module knows nothing about survive the read
      // and can be written back out unchanged.
      .../** @type {any} */ (record),
      name,
      version: text(record, 'version', ''),
      source: text(record, 'source', ''),
      kind: text(record, 'kind', DEFAULT_KIND),
      path: text(record, 'path', ''),
    })
  }
  return { entries, total: rows.length }
}

/**
 * Record a plugin as installed, returning a new document.
 *
 * Replaces by name, **in place in the array**: re-installing at a new version
 * rewrites the row where it already sits rather than moving it to the end, so
 * the order a user sees in the tab does not shuffle every time something
 * upgrades. Appending is only for a name that is not there yet.
 *
 * The edit is made against the document's **raw** rows, not against
 * {@link parseInstalled}'s normalised view. Recording one install must not
 * quietly rewrite every other row into this module's idea of the shape, and a
 * row we could not read is not a row we may drop on the user's behalf. The one
 * exception is a `plugins` that cannot hold rows at all — a non-array holds
 * nothing to keep, so it is replaced with a real list.
 *
 * `path` is computed here rather than taken from the caller. It is the only
 * way the record and the directory cannot disagree, and it means a caller
 * cannot smuggle a path in past {@link installPath}'s checks.
 * @param {unknown} doc - the record to write into, of any shape.
 * @param {unknown} entry - the plugin being recorded; at least `name`,
 *   `version` and `source`, optionally `kind`, plus any keys of its own.
 * @returns {InstalledDoc} a new document; the input is not touched.
 * @throws when a field is not one we will record — see the module note on
 *   total reads and loud writes.
 */
export function addInstalled(doc, entry) {
  const incoming = asRecord(entry)
  const { name, version, source } = incoming
  // installPath does the segment checking, and doing it by calling installPath
  // rather than by repeating its rule is what keeps the recorded path and the
  // written directory answerable to one check. The version is not among those
  // segments any more, so it gets its own, looser rule.
  const segments = installPath(source, name)
  if (!isRecordableVersion(version)) {
    throw new Error(`market: refusing ${JSON.stringify(version)} as an install version`)
  }
  const kind = incoming.kind === undefined ? DEFAULT_KIND : incoming.kind
  // Not a path segment, but the discriminator a reader switches on. Held to the
  // same rule so a row cannot carry a newline or markup into the tab.
  if (!isSafeSegment(kind)) {
    throw new Error(`market: refusing ${JSON.stringify(kind)} as an install kind: not a safe segment`)
  }
  /** @type {InstalledEntry} */
  const row = {
    // Spread first, so a key the caller brought keeps its position and any
    // extra it recorded (a timestamp, an integrity string) is carried through.
    .../** @type {any} */ (incoming),
    name: /** @type {string} */ (name),
    version: /** @type {string} */ (version),
    source: /** @type {string} */ (source),
    kind: /** @type {string} */ (kind),
    // POSIX-joined: the record is a document, and one that spelled the
    // separator the way the installing machine happens to write it would be
    // unreadable on the other platform.
    path: segments.join('/'),
  }
  const record = asRecord(doc)
  const rows = Array.isArray(record.plugins) ? [...record.plugins] : []
  const at = rows.findIndex((existing) => asRecord(existing).name === name)
  if (at === -1) rows.push(row)
  else rows[at] = row
  return {
    ...record,
    // Stamped, not defaulted. This module has just rewritten the whole
    // document, so leaving a foreign shape claim on it would be a lie about
    // what is in the file. Reading does not gate on this field (see
    // parseInstalled) — it is here for a future reader, not for this one.
    version: 1,
    plugins: rows,
  }
}

/**
 * Record a plugin as no longer installed, returning a new document.
 *
 * No name validation, deliberately: a row a hand-edit put in the file is
 * exactly the one a user needs to be able to take back out. Validation guards
 * what we write, not what we retract — `registry.js`'s rule, and the same
 * sentence applies here.
 *
 * A name that is not recorded is a no-op, and a no-op invents nothing: a
 * document with no `plugins` does not grow an empty array, and one with no
 * envelope version does not grow one, just because a removal was attempted.
 * @param {unknown} doc - the record to write into, of any shape.
 * @param {string} name - the plugin name to drop.
 * @returns {InstalledDoc} a new document; the input is not touched.
 */
export function removeInstalled(doc, name) {
  const record = asRecord(doc)
  if (!Array.isArray(record.plugins)) return { ...record }
  const rows = record.plugins.filter((row) => asRecord(row).name !== name)
  if (rows.length === record.plugins.length) return { ...record }
  return { ...record, plugins: rows }
}
