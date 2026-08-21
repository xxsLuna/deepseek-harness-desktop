// @ts-check
/**
 * @dsh-desktop/market — what a downloaded tree actually is.
 *
 * A catalog lists two kinds of plugin, and this is the only thing that decides
 * which one is in front of us. The catalog's own `metadata.kind` is a hint the
 * tab shows before a download; this reads the files.
 *
 * Its own module, rather than a closure inside the installer, for one reason:
 * the marketplace repository's CI gate has to apply exactly these rules to a
 * submitted plugin, and a gate holding a second copy of them can only drift
 * toward passing — it would accept a package the installer refuses (a listing
 * that fails at the user) or, worse, accept one it treats differently. So the
 * rule lives here, the installer calls it, and the gate imports the same file.
 *
 * Runs inside the harness sidecar (plain Node, no Electron).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where a Claude-format plugin declares itself. */
export const CLAUDE_MANIFEST = ['.claude-plugin', 'plugin.json']

/**
 * What a catalog row claimed, as far as this decision needs it.
 * @typedef {object} Claimed
 * @property {string} name - the install key the row was listed under.
 * @property {string} [version] - the row's version, used when the tree has none.
 */

/**
 * What the tree turned out to be.
 * @typedef {object} PluginKind
 * @property {'claude' | 'dsh'} kind - which format it is.
 * @property {string} version - the tree's own version, or the row's.
 */

/**
 * Read one JSON file out of a plugin tree.
 * @param {string} root - the plugin root.
 * @param {string[]} segments - path segments under it.
 * @returns {any} the parsed document, or undefined when absent.
 * @throws when present and unparsable — a truncated download reads as absent
 * otherwise, and would be reported as the wrong problem entirely.
 */
function readJson(root, segments) {
  const path = join(root, ...segments)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${segments.join('/')} is not valid JSON: ${String(error)}`)
  }
}

/**
 * Decide what a plugin tree is, and refuse it if it is neither kind.
 *
 * The two markers are unambiguous and mutually exclusive, so the catalog does
 * not have to declare a kind and cannot declare one that disagrees with the
 * bytes. Every clause below closes a real hole: a `dsh` package with no
 * `dsh.bundle.patch` makes `loadProfile` throw and the app stop booting;
 * runtime `dependencies` cannot be satisfied with no package manager, so a
 * package declaring one resolves to nothing at load; and a name that disagrees
 * with the catalog means the bytes are not what was approved.
 * @param {string} root - the plugin root, as downloaded.
 * @param {Claimed} claimed - the catalog row that claimed it.
 * @returns {PluginKind} what it is.
 * @throws when it is neither, or fails its kind's gate.
 */
export function classifyPlugin(root, claimed) {
  const claude = readJson(root, CLAUDE_MANIFEST)
  const pkg = readJson(root, ['package.json'])

  if (claude !== undefined) {
    // Only when it declares one: the marketplace entry's name is the install
    // key, and a plugin need not repeat it. When it does, it must agree.
    if (typeof claude.name === 'string' && claude.name !== claimed.name) {
      throw new Error(`the plugin calls itself ${claude.name}, not ${claimed.name} as the catalog said`)
    }
    return {
      kind: 'claude',
      version: typeof claude.version === 'string' ? claude.version : claimed.version ?? '',
    }
  }

  if (pkg !== undefined && typeof pkg.dsh?.bundle?.patch === 'string') {
    if (pkg.name !== claimed.name) {
      throw new Error(`the package is ${String(pkg.name)}, not ${claimed.name} as the catalog said`)
    }
    // Resolved the same way `loadProfile` will: relative to the package root.
    const declared = pkg.dsh.bundle.patch.replace(/^\.\//, '')
    if (!existsSync(join(root, declared))) {
      throw new Error(`its declared patch file ${pkg.dsh.bundle.patch} is not in the package`)
    }
    if (typeof pkg.dependencies === 'object' && pkg.dependencies !== null && Object.keys(pkg.dependencies).length > 0) {
      throw new Error('the package declares runtime dependencies, which this app cannot install')
    }
    return {
      kind: 'dsh',
      version: typeof pkg.version === 'string' ? pkg.version : claimed.version ?? '',
    }
  }

  throw new Error(
    'this is neither kind of plugin: a Claude plugin declares .claude-plugin/plugin.json, '
    + 'and a harness plugin declares dsh.bundle.patch in its package.json',
  )
}
