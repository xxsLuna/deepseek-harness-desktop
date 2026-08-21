// @ts-check
/**
 * Walking the Claude-plugin install root, and parsing what is in it.
 *
 * The layout is the whole contract with `@dsh-desktop/market`:
 *
 * ```
 * $DSH_HOME/claude-plugins/<source>/<name>/
 *     .claude-plugin/plugin.json
 *     skills/<skill-name>/SKILL.md      (+ references/ scripts/ assets/ beside it)
 *     commands/*.md
 * ```
 *
 * Nothing here downloads or installs anything, and this package does not
 * import the marketplace (nor the marketplace this one). A plugin a user
 * unzipped into that directory by hand has to work exactly as well as one the
 * marketplace installed, and the only way to guarantee that is for discovery
 * to know nothing about how the bytes arrived.
 *
 * This module does the IO and the file-format work; every rule about what to
 * publish lives in `policy.js`. The split is what lets the rules be tested
 * without a filesystem and lets the walk be tested without a harness.
 *
 * The YAML parser is passed in rather than imported. `yaml` lives in the
 * staged tree (it is `@deepseek-ai/dsh-skill-filesystem`'s own dependency,
 * hoisted to the top level), so importing it here would make this module — and
 * therefore its unit tests — require a staged harness. `index.js` imports it
 * at module scope instead, where an unresolvable `yaml` fails the row loudly
 * at import time and names the missing module.
 *
 * @module @dsh-desktop/claude-plugins/discover
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** @typedef {import('./policy.js').FoundEntry} FoundEntry */
/** @typedef {import('./policy.js').PluginRef} PluginRef */

/**
 * How deep the `commands/` walk goes.
 *
 * Claude namespaces commands by subdirectory, so `commands/` is a tree rather
 * than a flat list, but a plugin nesting deeper than this is malformed and a
 * cap is what stops one from turning `list()` into an unbounded walk on every
 * catalog revision.
 */
const MAX_COMMAND_DEPTH = 4

/**
 * One thing that could not be read or parsed.
 * @typedef {object} DiscoveryError
 * @property {string} path - absolute path of the file or directory.
 * @property {string} message - why it was skipped, already renderable.
 */

/**
 * Everything one walk of the install root found.
 * @typedef {object} Discovery
 * @property {PluginRef[]} plugins - one per installed plugin.
 * @property {FoundEntry[]} entries - every parsed skill and command file.
 * @property {DiscoveryError[]} errors - files that were present but unusable.
 */

/**
 * Options for one walk.
 * @typedef {object} DiscoverOptions
 * @property {(text: string) => unknown} parseYaml - the YAML frontmatter parser.
 * @property {AbortSignal} [signal] - cancels the walk between filesystem calls.
 */

/**
 * Split a markdown file into its YAML frontmatter and its body.
 *
 * Deliberately the same algorithm as upstream's `parseFrontmatter`
 * (`@deepseek-ai/dsh-skill-filesystem`), down to the `\r` tolerance: a file
 * must open with a `---` line and close on the next line that is exactly
 * `---`. A SKILL.md that one provider reads and the other silently ignores
 * would be a maddening thing to debug, so the fences are read identically.
 * @param {string} raw - the file's full text.
 * @returns {{ yaml: string, body: string } | undefined} the two halves, or undefined when there is no frontmatter.
 */
export function splitFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return {
        yaml: raw.slice(start, lineStart),
        body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/**
 * Walk the install root and parse everything under it.
 *
 * Total by construction: a missing root, an unreadable directory and a
 * malformed file all reduce to an empty result or one `errors` entry. A user
 * who copied in one broken plugin must not lose the working ones, and the
 * harness must not lose the provider — a throw out of `list()` is caught by
 * the registry and logged as `skill provider "..." skipped`, which drops every
 * skill this provider found rather than the one file that was wrong.
 * @param {string} root - `$DSH_HOME/claude-plugins`, absolute.
 * @param {DiscoverOptions} options - the YAML parser, and an optional abort signal.
 * @returns {Promise<Discovery>} what the walk found.
 */
export async function discoverPlugins(root, options) {
  /** @type {Discovery} */
  const result = { plugins: [], entries: [], errors: [] }

  for (const source of await directories(root, result.errors, { quiet: true })) {
    options.signal?.throwIfAborted()
    const sourceDir = join(root, source)
    for (const name of await directories(sourceDir, result.errors)) {
      options.signal?.throwIfAborted()
      // No version level: a plugin's tree is its directory. The version is a
      // label the manifest carries, not a path component — see installPath in
      // @dsh-desktop/market for why it was kept out of the layout.
      const pluginRoot = join(sourceDir, name)
      const { title, version } = await readManifest(pluginRoot, result.errors)
      /** @type {PluginRef} */
      const plugin = {
        id: `${source}/${name}`,
        source,
        name,
        version: version ?? '',
        root: pluginRoot,
        ...title === undefined ? {} : { title },
      }
      result.plugins.push(plugin)
      await collectSkills(plugin, options, result)
      await collectCommands(plugin, options, result)
    }
  }

  return result
}

/**
 * Read `skills/<name>/SKILL.md` for one plugin.
 *
 * Directory bundles only. Claude's skill format puts the body at
 * `<root>/<name>/SKILL.md` with `references/`, `scripts/` and `assets/` beside
 * it, and it is that sibling layout — reachable because `resourceBase` points
 * at the directory — that makes a real Claude plugin work here unmodified.
 * @param {PluginRef} plugin - the plugin being read.
 * @param {DiscoverOptions} options - the YAML parser and abort signal.
 * @param {Discovery} result - accumulator, mutated in place.
 */
async function collectSkills(plugin, options, result) {
  const skillsDir = join(plugin.root, 'skills')
  for (const slug of await directories(skillsDir, result.errors, { quiet: true })) {
    options.signal?.throwIfAborted()
    const directory = join(skillsDir, slug)
    const path = join(directory, 'SKILL.md')
    const entry = await parseEntry({ kind: 'skill', plugin, slug, path, directory }, options, result.errors)
    if (entry !== undefined) result.entries.push(entry)
  }
}

/**
 * Read `commands/**\/*.md` for one plugin.
 *
 * The tree is walked rather than listed because Claude namespaces a command by
 * its subdirectory. That namespace cannot survive as one: upstream's name
 * grammar has no `:`, so the path segments are joined into the slug and
 * `policy.js` reduces the result to a legal name.
 *
 * Only real directories are descended into. A directory symlink reports
 * `isDirectory() === false` from `readdir({ withFileTypes: true })`, so
 * declining to follow them is also what makes a symlink loop impossible here.
 * @param {PluginRef} plugin - the plugin being read.
 * @param {DiscoverOptions} options - the YAML parser and abort signal.
 * @param {Discovery} result - accumulator, mutated in place.
 */
async function collectCommands(plugin, options, result) {
  const commandsDir = join(plugin.root, 'commands')
  /** @type {{ directory: string, segments: string[] }[]} */
  const pending = [{ directory: commandsDir, segments: [] }]
  while (pending.length > 0) {
    const level = pending.pop()
    if (level === undefined) continue
    options.signal?.throwIfAborted()
    const listing = await list(level.directory, result.errors, { quiet: level.segments.length === 0 })
    for (const item of listing) {
      if (item.isDirectory()) {
        if (level.segments.length + 1 > MAX_COMMAND_DEPTH) {
          result.errors.push({ path: join(level.directory, item.name), message: `nested deeper than ${MAX_COMMAND_DEPTH} levels under commands/` })
          continue
        }
        pending.push({ directory: join(level.directory, item.name), segments: [...level.segments, item.name] })
        continue
      }
      if (!item.isFile() || !item.name.endsWith('.md')) continue
      const slug = [...level.segments, item.name.slice(0, -'.md'.length)].join('/')
      const path = join(level.directory, item.name)
      const entry = await parseEntry({ kind: 'command', plugin, slug, path, directory: level.directory }, options, result.errors)
      if (entry !== undefined) result.entries.push(entry)
    }
  }
}

/**
 * Read and parse one markdown file into a `FoundEntry`.
 *
 * Exported because loading a skill body has to come back through it. The
 * registry hands `get()` a candidate that was listed from a snapshot which may
 * be seconds old, so the file must be re-read and re-judged against its
 * current bytes rather than trusted from the listing — re-walking the whole
 * install root to load one skill would be the alternative.
 *
 * A command with no frontmatter is accepted with an empty frontmatter object:
 * Claude's command format makes frontmatter optional, and `policy.js`
 * synthesizes the description the harness insists on from the body. A SKILL.md
 * with no frontmatter is an error, as it is upstream — without `name` and
 * `description` there is nothing to publish.
 * @param {{ kind: 'skill' | 'command', plugin: PluginRef, slug: string, path: string, directory: string }} located - where the file is.
 * @param {DiscoverOptions} options - the YAML parser and abort signal.
 * @returns {Promise<{ entry?: FoundEntry, errors: DiscoveryError[] }>} the parsed entry, or why there is none.
 */
export async function readEntry(located, options) {
  /** @type {DiscoveryError[]} */
  const errors = []
  let raw
  try {
    raw = await readFile(located.path, { encoding: 'utf8', signal: options.signal })
  } catch (error) {
    options.signal?.throwIfAborted()
    if (!isAbsent(error)) errors.push({ path: located.path, message: `could not be read: ${message(error)}` })
    else if (located.kind === 'skill') errors.push({ path: located.path, message: 'is missing, so its skill directory holds no skill' })
    return { errors }
  }

  const split = splitFrontmatter(raw)
  if (split === undefined) {
    if (located.kind === 'skill') {
      errors.push({ path: located.path, message: 'has no YAML frontmatter, so it declares no name or description' })
      return { errors }
    }
    return { entry: { ...located, frontmatter: {}, body: raw.trim() }, errors }
  }

  let parsed
  try {
    parsed = options.parseYaml(split.yaml)
  } catch (error) {
    errors.push({ path: located.path, message: `has invalid YAML frontmatter: ${message(error)}` })
    return { errors }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push({ path: located.path, message: 'has frontmatter that is not a mapping' })
    return { errors }
  }

  return {
    entry: { ...located, frontmatter: /** @type {Record<string, unknown>} */ (parsed), body: split.body.trim() },
    errors,
  }
}

/**
 * `readEntry`, accumulating into the walk's shared error list.
 * @param {{ kind: 'skill' | 'command', plugin: PluginRef, slug: string, path: string, directory: string }} located - where the file is.
 * @param {DiscoverOptions} options - the YAML parser and abort signal.
 * @param {DiscoveryError[]} errors - accumulator, mutated in place.
 * @returns {Promise<FoundEntry | undefined>} the parsed entry, or undefined when it was unusable.
 */
async function parseEntry(located, options, errors) {
  const read = await readEntry(located, options)
  errors.push(...read.errors)
  return read.entry
}

/**
 * The plugin's display name from `.claude-plugin/plugin.json`, if it has one.
 *
 * Optional on purpose. The directory layout is the contract, not the manifest:
 * a hand-copied plugin whose manifest is missing or malformed still yields
 * every skill under it, and the directory name stands in for the title.
 * @param {string} pluginRoot - the plugin's own directory.
 * @param {DiscoveryError[]} errors - accumulator, mutated in place.
 * @returns {Promise<{title?: string, version?: string}>} what the manifest
 * declares; an absent or unreadable manifest yields an empty record rather
 * than an error, because a plugin is its files and the manifest is a label.
 */
async function readManifest(pluginRoot, errors) {
  const path = join(pluginRoot, '.claude-plugin', 'plugin.json')
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (!isAbsent(error)) errors.push({ path, message: `could not be read: ${message(error)}` })
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    const record = typeof parsed === 'object' && parsed !== null ? parsed : {}
    /** @param {unknown} value - a manifest field. @returns {string | undefined} it, trimmed and non-empty. */
    const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
    // The version comes from the plugin's own manifest, not from a directory
    // name: the layout carries no version level, and the manifest is the
    // authority on what this build calls itself anyway.
    return { title: text(record.displayName) ?? text(record.name), version: text(record.version) }
  } catch (error) {
    errors.push({ path, message: `is not valid JSON: ${message(error)}` })
    return {}
  }
}

/**
 * Subdirectory names of one directory, sorted, dot-prefixed entries dropped.
 *
 * Dot-prefixed names are skipped at every layout level because that is where
 * an installer's half-written staging directory lives — `@dsh-desktop/market`
 * unpacks into a `mkdtemp`-named sibling and renames it into place, and
 * publishing skills out of one mid-write would be a race with no error.
 * @param {string} directory - the directory to read.
 * @param {DiscoveryError[]} errors - accumulator, mutated in place.
 * @param {{ quiet?: boolean }} [options] - `quiet` suppresses the absent-directory error.
 * @returns {Promise<string[]>} the subdirectory names.
 */
async function directories(directory, errors, options = {}) {
  const listing = await list(directory, errors, options)
  return listing.filter((item) => item.isDirectory() && !item.name.startsWith('.'))
    .map((item) => item.name)
    .sort()
}

/**
 * Read one directory, turning any failure into an error entry.
 * @param {string} directory - the directory to read.
 * @param {DiscoveryError[]} errors - accumulator, mutated in place.
 * @param {{ quiet?: boolean }} [options] - `quiet` treats absence as normal rather than an error.
 * @returns {Promise<import('node:fs').Dirent[]>} the entries, or an empty list.
 */
async function list(directory, errors, options = {}) {
  try {
    return await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    // An absent root, `skills/` or `commands/` is the normal case, not a
    // fault: most plugins ship one of the two, and a fresh profile has no
    // install root at all.
    if (!(isAbsent(error) && options.quiet === true)) {
      errors.push({ path: directory, message: `could not be listed: ${message(error)}` })
    }
    return []
  }
}

/**
 * Whether an error means "not there", across the several codes that mean it.
 * @param {unknown} error - the caught value.
 * @returns {boolean} whether the path was simply absent.
 */
function isAbsent(error) {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

/**
 * Render a caught value without letting coercion escape.
 * @param {unknown} error - the caught value.
 * @returns {string} a message.
 */
function message(error) {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}
