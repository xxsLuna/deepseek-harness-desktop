/**
 * The prune contract: what `scripts/prune-payload.mjs` removes from the staged
 * tree must never be something the harness can load.
 *
 * This is the guard that lets the prune rules stay blanket globs. The harness
 * resolves plugins by NAME at runtime (`import(name)` in
 * @deepseek-ai/cordis-plugin-loader), so a deleted file produces no build
 * error and no type error — only a plugin that fails to mount when a user
 * happens to reach it. These assertions run against the real stage and name
 * the broken seam instead.
 *
 * Runs as a dry run, so it is safe before or after an actual prune, and it
 * asserts the same rules the packaging step applies.
 *
 * Requires a staged harness (npm run stage).
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a build script, deliberately outside the typed src/ rootDir
import { prune } from '../../scripts/prune-payload.mjs'

const root = join(import.meta.dirname, '..', '..')
const harnessRoot = join(root, 'build', 'harness')
const target = { platform: process.platform, arch: process.arch }

/** Resolution anchored inside the staged tree, exactly as the harness resolves. */
const requireFromHarness = createRequire(join(harnessRoot, 'anchor.cjs'))

interface Removal { path: string, reason: string }

/** The dry-run removal records, keyed by forward-slashed stage-relative path. */
function removals(): Map<string, string> {
  const records = prune(harnessRoot, target, { dryRun: true }).removals as Removal[]
  return new Map(records.map((record) => [record.path, record.reason]))
}

/** Every file under one stage-relative directory, forward-slashed. */
function filesUnder(relDir: string): string[] {
  const absolute = join(harnessRoot, relDir)
  if (!existsSync(absolute)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(harnessRoot, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`)
      else if (entry.isFile()) found.push(`${dir}/${entry.name}`)
    }
  }
  walk(relDir)
  return found
}

/**
 * What the shipped tree holds once the rule has been applied — the files
 * present now, minus the ones the rule would still take.
 *
 * Every assertion below is written against this rather than against the
 * removal list, which is what makes them order-independent: CI prunes before
 * this suite runs (so the boot tests exercise the shipped tree) while a local
 * run usually starts from a full stage, and prune is idempotent.
 * @param relDir - the stage-relative directory to inspect.
 * @returns the surviving files, forward-slashed and stage-relative.
 */
function survivors(relDir: string): string[] {
  const gone = removals()
  return filesUnder(relDir).filter((path) => !gone.has(path))
}

/** node-pty prebuild directory names that survive the rule. */
function survivingPrebuildDirs(): string[] {
  const prebuilds = 'node_modules/node-pty/prebuilds'
  const dirs = new Set(survivors(prebuilds).map((path) => path.slice(prebuilds.length + 1).split('/')[0] ?? ''))
  return [...dirs].sort()
}

/**
 * Every plugin name composed into a profile tree, gathered from the patch
 * layers upstream ships plus this repo's own overlay.
 *
 * Read from the YAML rather than booted: the point is coverage of the whole
 * roster, including rows a desktop boot never reaches.
 * @returns the plugin package names named by any staged patch layer.
 */
function rosterPluginNames(): string[] {
  const names = new Set<string>()
  const scan = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && depth > 0) scan(join(dir, entry.name), depth - 1)
      else if (entry.isFile() && entry.name === 'cordis.patch.yml') {
        for (const line of readFileSync(join(dir, entry.name), 'utf8').split('\n')) {
          // `name: '@scope/pkg'` rows, however quoted. Local `./` rows are not
          // package names and resolve through a different path.
          const match = /^\s*(?:-\s*)?name:\s*['"]?(@?[\w./-]+)['"]?\s*$/.exec(line)
          if (match?.[1] !== undefined && !match[1].startsWith('.')) names.add(match[1])
        }
      }
    }
  }
  scan(join(harnessRoot, 'node_modules'), 3)
  return [...names]
}

describe.skipIf(!existsSync(harnessRoot))('pruned payload', () => {
  it('ships no sourcemaps or type declarations', () => {
    // The two biggest items by file count — 6,633 maps and 10,176 declarations
    // on 0.1.0-rc.6 — and the count is what matters: NSIS writes files one at a
    // time and Defender scans each, which is the dominant install cost.
    const dead = survivors('node_modules').filter((path) => /\.map$|\.d\.[cm]?ts$/.test(path))
    expect(dead).toEqual([])
  })

  it('still finds substantial dead weight to remove, or has already removed it', () => {
    // A rule that silently stops matching — an upstream layout change, a regex
    // typo — would otherwise show up as a quietly re-inflated installer.
    //
    // Two legitimate states, an order of magnitude apart: a full stage matches
    // ~20,000 files, and an already-pruned one matches a handful. Not zero,
    // because `npm run build` re-runs `stage-harness --local-only` and copies
    // this repo's own packages back in — `@dsh-desktop/connection/src/client.ts`
    // is the build input for its `lib/client.js` bundle and reappears with it.
    // CI prunes after building, so the shipped tree never carries them.
    // The pruned state is covered by the sourcemap/declaration assertion above;
    // this one gates the full state, so the two together cover both orders.
    const result = prune(harnessRoot, target, { dryRun: true }) as { files: number, bytes: number }
    if (result.files < 50) return
    expect(result.files, `dry run matched ${result.files} files`).toBeGreaterThan(10_000)
    expect(result.bytes).toBeGreaterThan(60 * 1_024 * 1_024)
  })

  it('keeps every plugin in the composed roster resolvable', () => {
    // The motto guard. Pruning must leave a real, resolvable npm tree: this is
    // the property that bundling the tree would have destroyed.
    const gone = removals()
    const names = rosterPluginNames()
    expect(names.length).toBeGreaterThan(50)
    const broken = names.filter((name) => {
      let resolved: string
      try {
        resolved = requireFromHarness.resolve(name)
      } catch {
        // Not resolvable even before pruning — a row for a plugin this profile
        // does not install. Not this rule's business.
        return false
      }
      return gone.has(resolved.replaceAll('\\', '/').slice(harnessRoot.replaceAll('\\', '/').length + 1))
    })
    expect(broken).toEqual([])
  })

  it('keeps the entry points the launcher and the payload check depend on', () => {
    const gone = removals()
    for (const entry of [
      'node_modules/@deepseek-ai/dsh/lib/bin.js',
      'node_modules/@dsh-desktop/bundle/lib/boot.js',
      'node_modules/@dsh-desktop/connection/lib/client.js',
      'node_modules/@dsh-desktop/chrome/lib/desktop-chrome.css',
      'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
    ]) {
      expect(existsSync(join(harnessRoot, entry)), `${entry} must be staged`).toBe(true)
      expect(gone.has(entry), `${entry} must survive the prune`).toBe(false)
    }
  })

  it('keeps a package whose main resolves into src/', () => {
    // node-fetch's main is `src/index.js` and ecdsa-sig-formatter's is
    // `src/ecdsa-sig-formatter.js`. They are why the rules do NOT sweep src/
    // wholesale, and why the manifest-derived guard exists at all.
    const gone = removals()
    for (const name of ['node-fetch', 'ecdsa-sig-formatter']) {
      let resolved: string
      try {
        resolved = requireFromHarness.resolve(name)
      } catch {
        continue
      }
      const rel = resolved.replaceAll('\\', '/').slice(harnessRoot.replaceAll('\\', '/').length + 1)
      expect(rel, `${name} should still resolve into src/`).toContain('/src/')
      expect(gone.has(rel), `${name} entry must survive the prune`).toBe(false)
    }
  })

  it('never removes a package.json or a licence', () => {
    // package.json is how every name resolves, and the licences must ship.
    const offenders = [...removals().keys()].filter((path) => {
      const basename = path.split('/').at(-1) ?? ''
      return basename === 'package.json' || /^(licen[cs]e|notice|copying)/i.test(basename)
    })
    expect(offenders).toEqual([])
  })

  it('removes a native binary only as a foreign-platform prebuild', () => {
    // A deleted .node/.dll/.exe is a tool that fails only when a user reaches
    // it — no build error, no type error. Foreign prebuilds are the one reason
    // that may take one, plus sharp's wasm fallback (verified unreachable
    // whenever the native binary for this target is staged). Any other reason
    // reaching a binary means a glob has grown teeth it should not have.
    const wrong = [...removals()]
      .filter(([path]) => /\.(node|dll|dylib|so|exe|wasm)$/.test(path))
      .filter(([path, reason]) => !reason.startsWith('prebuild for') && !path.startsWith('node_modules/@img/sharp-wasm32/'))
    expect(wrong).toEqual([])
  })

  it('keeps this platform prebuild and no other', () => {
    // node-pty carries all six prebuilds as tarball files — npm cannot narrow
    // them the way it does optionalDependencies — so this rule is the only
    // thing that does, and node-pty is what every bash and terminal tool needs.
    expect(survivingPrebuildDirs()).toEqual([`${target.platform}-${target.arch}`])
  })
}, 120_000)
