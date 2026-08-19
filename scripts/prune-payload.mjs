// Remove from the staged harness what the packaged app never loads: source
// maps, type declarations, TypeScript sources, debug symbols, docs, test
// fixtures, and the prebuilds of platforms this build does not target.
//
// Why prune rather than bundle: the harness resolves every plugin by NAME at
// runtime — `import(name)` in @deepseek-ai/cordis-plugin-loader, where `name`
// is a string read from a patch YAML. A bundler cannot see those edges, so
// bundling would mean enumerating the roster, and it would break
// `dsh plugin add` — pnpm-installed profile plugins resolve their peers upward
// through this very node_modules tree. Pruning removes only files nothing
// imports, so the tree stays a real, resolvable npm tree and every plugin seam
// keeps working.
//
// Measured on 0.1.0-rc.6 / win32-x64: the tree goes from 221MB in 32,796 files
// to 109MB in 12,903, and the whole win-unpacked payload from 729MB to 530MB.
// The file COUNT is the point — NSIS writes them one at a time and Windows
// Defender scans each, which is what makes installation slow.
//
// Usage: node scripts/prune-payload.mjs [--platform win32] [--arch x64] [--dry-run]
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Path segments whose whole subtree is test-only. */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'fixtures', '__fixtures__'])

/** Files that must survive every rule below: legal text, and the resolver's own metadata. */
const KEEP_BASENAMES = /^(licen[cs]e|notice|copying|package\.json)/i

/** Documentation basenames. Matched by prefix so README.zh.md and README.i18n.yaml both go. */
const DOC_BASENAMES = /^(readme|changelog|changes|history|contributing|authors|code[-_]of[-_]conduct|security|governance|maintainers)/i

// Every `prebuilds/<platform>-<arch>` directory a package tarball carries,
// whether or not this build can load it. node-pty ships all six; npm cannot
// strip them because they are files in the tarball, not optionalDependencies.
const PREBUILD_SEGMENT = /^(darwin|linux|linuxmusl|win32|android|freebsd)-(x64|arm64|arm|ia32|ppc64|riscv64|s390x)$/
const CONPTY_SEGMENT = /^win10-(x64|arm64|arm)$/

/**
 * Decide whether one staged file is dead weight for a given target.
 *
 * Pure so the rule itself is unit-testable: the walker only supplies paths.
 * Paths arrive relative to the stage root, forward-slashed.
 * @param relPath - the file's path under the stage root, forward-slashed.
 * @param target - the platform and arch this build ships to, plus
 *   `nativeSharp` when the stage holds a native sharp binary for it.
 * @returns a short reason string when the file should go, else undefined.
 */
export function pruneReason(relPath, target) {
  const segments = relPath.split('/')
  const basename = segments.at(-1) ?? ''

  // Legal text and package.json outrank every rule below: package.json is how
  // the resolver finds anything at all, and the licences must ship.
  if (KEEP_BASENAMES.test(basename)) return undefined

  // sharp's wasm build is the last link in its loader's fallback chain
  // (dist/sharp.cjs tries `@img/sharp-wasm32/sharp.node` only after the native
  // binary fails). Verified by hiding the package and re-running a real encode
  // and metadata read on win32-x64: identical result, simd still on. Only
  // dropped when the native binary for this target is actually staged, so a
  // future target without one keeps its fallback.
  if (target.nativeSharp === true && relPath.startsWith('node_modules/@img/sharp-wasm32/')) return 'wasm fallback'

  for (const segment of segments.slice(0, -1)) {
    // A foreign prebuild directory: keep only the one this build targets.
    // Matched on directory segments so `prebuilds/win32-arm64/conpty/conpty.dll`
    // goes with its parent rather than surviving as an orphan.
    const prebuild = PREBUILD_SEGMENT.exec(segment)
    if (prebuild !== null) {
      const [, platform, arch] = prebuild
      // linuxmusl and linux are the same target platform; only the arch decides.
      const platformMatches = platform === target.platform || (platform === 'linuxmusl' && target.platform === 'linux')
      if (!platformMatches || arch !== target.arch) return `prebuild for ${segment}`
    }
    const conpty = CONPTY_SEGMENT.exec(segment)
    if (conpty !== null && (target.platform !== 'win32' || conpty[1] !== target.arch)) return `prebuild for ${segment}`
    if (TEST_DIRS.has(segment)) return 'test tree'
  }

  if (DOC_BASENAMES.test(basename)) return 'docs'
  if (basename.endsWith('.md') || basename.endsWith('.markdown')) return 'docs'
  if (basename.endsWith('.map')) return 'sourcemap'
  if (/\.d\.[cm]?ts$/.test(basename)) return 'type declaration'
  if (/\.[cm]?ts$/.test(basename)) return 'typescript source'
  if (basename.endsWith('.pdb')) return 'debug symbols'
  return undefined
}

/**
 * Reasons that outrank a wildcard subtree protection.
 *
 * A package whose exports map says `"./*": "./*"` (or `"./lib/*"`) nominally
 * exposes every file under that prefix, but no consumer can meaningfully
 * import a sourcemap, a declaration, a PDB, or a README through it. Letting
 * those wildcards win kept half the sourcemaps in the tree. An EXACT entry
 * path still outranks everything — that is what protects `node-fetch`'s
 * `src/index.js` and the `.mts` in `eventsource`'s exports map.
 */
export const NEVER_RUNTIME = new Set(['sourcemap', 'type declaration', 'debug symbols', 'docs'])

/**
 * Collect every path a package can be entered through, so no rule above can
 * delete a live entry point.
 *
 * This is the guard that makes the blanket rules safe. `node-fetch` resolves
 * its main to `src/index.js`, `ecdsa-sig-formatter` to `src/*.js`, and
 * `eventsource` names a `.mts` in its exports map — each would otherwise be a
 * plausible prune target. Reading the manifests means a new such package in a
 * future upstream bump is protected by construction, rather than by an
 * allowlist someone has to remember to update.
 * @param stageDir - the stage root holding node_modules.
 * @returns `exact` paths that must never be pruned, and wildcard `subtrees`
 *   (each ending in `/`) that protect everything under them except the
 *   {@link NEVER_RUNTIME} reasons.
 */
export function entryPointPaths(stageDir) {
  const exact = new Set()
  const subtrees = new Set()
  /** Add one manifest field value, normalizing `./x` and treating `*` as a subtree. */
  const keep = (dir, value) => {
    if (typeof value !== 'string' || value === '') return
    const path = `${dir}/${value.replace(/^\.\//, '')}`.replace(/\/{2,}/g, '/')
    // A wildcard target cannot be resolved to one file, so protect its prefix.
    if (path.includes('*')) subtrees.add(path.split('*')[0])
    else exact.add(path)
  }
  /** Walk an exports subtree, skipping `types` conditions — declarations are not runtime entries. */
  const walkExports = (node, dir) => {
    if (typeof node === 'string') return keep(dir, node)
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'types') continue
      walkExports(value, dir)
    }
  }
  const visit = (dir, depth) => {
    const manifestPath = join(stageDir, dir, 'package.json')
    if (existsSync(manifestPath)) {
      let manifest
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        // A malformed manifest is upstream's problem, not a reason to stop
        // pruning; the file itself is kept by KEEP_BASENAMES either way.
        manifest = undefined
      }
      if (manifest !== undefined) {
        keep(dir, manifest.main)
        keep(dir, manifest.module)
        keep(dir, manifest.browser)
        if (typeof manifest.bin === 'string') keep(dir, manifest.bin)
        else for (const command of Object.values(manifest.bin ?? {})) keep(dir, command)
        walkExports(manifest.exports, dir)
      }
    }
    if (depth === 0) return
    for (const entry of readdirSync(join(stageDir, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) visit(`${dir}/${entry.name}`, depth - 1)
    }
  }
  // node_modules/@scope/name is three levels; the extra depth covers the
  // nested node_modules npm creates for version conflicts.
  if (existsSync(join(stageDir, 'node_modules'))) visit('node_modules', 5)
  return { exact, subtrees }
}

/**
 * Walk the stage and apply the rule, returning what was (or would be) removed.
 * @param stageDir - the stage root.
 * @param target - the platform and arch this build ships to.
 * @param options - `dryRun` reports without deleting.
 * @returns totals, the per-reason breakdown, and `removals` as
 *   `{ path, reason }` records.
 */
export function prune(stageDir, target, options = {}) {
  const { dryRun = false } = options
  const { exact, subtrees } = entryPointPaths(stageDir)
  // Resolved once here rather than per file: whether this target has a native
  // sharp binary decides if its wasm fallback is dead weight.
  const resolved = {
    ...target,
    nativeSharp: existsSync(join(stageDir, 'node_modules', '@img', `sharp-${target.platform}-${target.arch}`)),
  }
  /**
   * Whether this file is shielded from a given rule. An exact entry path is
   * absolute; a wildcard subtree yields to the never-runtime reasons.
   */
  const isProtected = (relPath, reason) => {
    if (exact.has(relPath)) return true
    if (NEVER_RUNTIME.has(reason)) return false
    for (const prefix of subtrees) if (relPath.startsWith(prefix)) return true
    return false
  }
  const byReason = new Map()
  const removals = []
  let bytes = 0
  let kept = 0

  const walk = (dir) => {
    for (const entry of readdirSync(join(stageDir, dir), { withFileTypes: true })) {
      const relPath = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(relPath)
        continue
      }
      if (!entry.isFile()) continue
      const reason = pruneReason(relPath, resolved)
      if (reason === undefined || isProtected(relPath, reason)) {
        kept += 1
        continue
      }
      // Foreign prebuilds are tallied under one heading; the per-directory
      // reason is still useful in the removals list.
      const heading = reason.startsWith('prebuild for') ? 'foreign-platform prebuilds' : reason
      const size = statSync(join(stageDir, relPath)).size
      const tally = byReason.get(heading) ?? { files: 0, bytes: 0 }
      tally.files += 1
      tally.bytes += size
      byReason.set(heading, tally)
      bytes += size
      // The reason travels with the path: the prune contract test asserts that
      // a native binary is only ever removed BY the foreign-platform rule, and
      // that distinction is invisible in a bare path list.
      removals.push({ path: relPath, reason })
      if (!dryRun) rmSync(join(stageDir, relPath))
    }
  }
  walk('node_modules')

  // Directories the walk emptied are pure install-time cost — NSIS creates
  // each one, and Defender walks it. Sweep bottom-up so a parent sees its
  // children already gone.
  let directories = 0
  const sweep = (dir) => {
    for (const entry of readdirSync(join(stageDir, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) sweep(`${dir}/${entry.name}`)
    }
    if (readdirSync(join(stageDir, dir)).length === 0) {
      rmSync(join(stageDir, dir), { recursive: true })
      directories += 1
    }
  }
  if (!dryRun) sweep('node_modules')

  return { bytes, files: removals.length, kept, directories, byReason, removals }
}

// --- CLI ---------------------------------------------------------------------

// pathToFileURL, not a hand-built `file://` string: on Windows the drive letter
// in `C:\...` parses as the URL host and the comparison silently goes false,
// which would turn this whole CLI into a no-op import.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const argOf = (name, fallback) => {
    const at = args.indexOf(name)
    return at !== -1 ? args[at + 1] : fallback
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const stageDir = join(root, 'build', 'harness')
  const target = { platform: argOf('--platform', process.platform), arch: argOf('--arch', process.arch) }
  const dryRun = args.includes('--dry-run')

  if (!existsSync(join(stageDir, 'node_modules', '@deepseek-ai', 'dsh'))) {
    throw new Error('prune-payload: no staged harness; run npm run stage first')
  }

  const mb = (value) => `${(value / 1_048_576).toFixed(1)}MB`
  console.log(`pruning build/harness for ${target.platform}-${target.arch}${dryRun ? ' (dry run)' : ''}`)
  const result = prune(stageDir, target, { dryRun })
  for (const [reason, tally] of [...result.byReason].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${mb(tally.bytes).padStart(8)}  ${String(tally.files).padStart(6)} files  ${reason}`)
  }
  console.log(`  ${mb(result.bytes).padStart(8)}  ${String(result.files).padStart(6)} files removed, ${result.directories} empty directories swept`)
  console.log(`  ${result.kept} files kept`)
  if (!dryRun) {
    // Said out loud because the alternative failure is baffling: packages/
    // connection and packages/settings typecheck against the staged tree's
    // declarations, and without them tsc reports a wall of implicit-any rather
    // than anything that points here. Packaging is the last step for a reason.
    console.log('\n  note: `npm run typecheck` needs the declarations this removed — run `npm run stage` first.')
  }
}
