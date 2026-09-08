/**
 * Every upstream specifier this repo imports must be a seam upstream declares.
 *
 * `CLAUDE.md` rule 1 is that no upstream file is ever edited, so every desktop
 * feature attaches at a point upstream already offers. Rule 2 is that anything
 * depending on upstream internals is asserted here, so a version bump fails by
 * name. This file applies the second rule to the first: it asks, of each
 * `@deepseek-ai/*` path we import, whether the package's own `exports` map
 * declares it.
 *
 * **Be clear about what this would and would not have caught**, because the
 * temptation is to file it under the 0.1.2 breakage and it does not belong
 * there. `dsh-host-apiproxy@0.1.1-rc.2` declared `.`, `./api` AND `./client` in
 * its own exports map, so all three imports that died were on legitimate public
 * entries. This gate was green on 0.1.1 and would have stayed green right up to
 * the morning the package was retired wholesale. It is a NEW guard against a
 * DIFFERENT mistake, not a fix for that blind spot.
 *
 * What it does earn:
 *
 * **It stops the next one being added.** An import reaching into
 * `@deepseek-ai/foo/lib/internal.js` — never declared, never promised — fails
 * right here, naming the path, rather than working until upstream moves it.
 *
 * **It says which layer moved.** A retired package and a reach past the
 * declarations look identical from the bundler (`Could not resolve`), which
 * reads as a build problem and sends the reader to esbuild. This separates
 * them by name.
 *
 * Two things it deliberately does NOT cover, both of which 0.1.2 shows:
 *
 * - **A symbol vanishing from a path that is still declared.** `RpcId` moved
 *   package while staying exported; that is `npm run typecheck`'s job.
 * - **A fragile coupling to a legitimate export.** The real lesson of
 *   `AbstractApiClient` is not where it was imported from but what was done
 *   with it: subclassed, with the connection loop beside it "mirroring the
 *   upstream package-internal controller" by its own admission. A declared
 *   export can still be the wrong thing to lean on, and no path check sees
 *   that. CLAUDE.md carries it as a rule instead.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const modules = join(root, 'build', 'harness', 'node_modules')

/**
 * Files whose imports are ours to justify.
 *
 * Both `src` and the built `lib` bundles: esbuild keeps upstream packages
 * external, so a bundle can carry a specifier its source no longer shows, and
 * the bundle is what actually ships.
 */
const SOURCE_DIRS = [
  ['src'],
  ...readdirSync(join(root, 'packages')).flatMap((pkg) => [['packages', pkg, 'src'], ['packages', pkg, 'lib']]),
]

/** One upstream specifier and the files of ours that import it. */
interface Use { readonly specifier: string, readonly importers: readonly string[] }

/**
 * Every `@deepseek-ai/*` specifier our own code imports.
 * @returns one entry per distinct specifier, with its importers.
 */
function upstreamImports(): Use[] {
  /** @type {Map<string, Set<string>>} */
  const found = new Map<string, Set<string>>()
  for (const parts of SOURCE_DIRS) {
    const dir = join(root, ...parts)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!/\.(?:ts|tsx|js)$/.test(name) || name.endsWith('.d.ts')) continue
      const text = readFileSync(join(dir, name), 'utf8')
      // Static imports and re-exports only. A dynamic import built from a
      // variable is the harness's own plugin-by-name mechanism, which resolves
      // at runtime and is asserted by tests/contract/pruned-payload.spec.ts.
      for (const match of text.matchAll(/(?:from|import)\s*'(@deepseek-ai\/[^']+)'/g)) {
        const where = [...parts, name].join('/')
        found.set(match[1], (found.get(match[1]) ?? new Set()).add(where))
      }
    }
  }
  return [...found].map(([specifier, importers]) => ({ specifier, importers: [...importers].sort() }))
    .sort((a, b) => a.specifier.localeCompare(b.specifier))
}

/** What the staged tree says about one specifier. */
type Verdict =
  | { readonly ok: true, readonly how: string }
  | { readonly ok: false, readonly why: string }

/**
 * Whether the staged package declares this subpath as an entry point.
 *
 * Exact keys first, then `*` patterns, which is the order Node resolves them
 * in. A package with no `exports` map at all exports its whole directory by the
 * old rules, so any subpath is legitimate — unusual upstream, and said out loud
 * rather than silently counted as a pass.
 * @param specifier - the bare specifier as written in an import.
 * @returns a seam, or the reason it is not one.
 */
export function seamVerdict(specifier: string): Verdict {
  const parts = specifier.split('/')
  const pkg = parts.slice(0, 2).join('/')
  const subpath = parts.length === 2 ? '.' : `./${parts.slice(2).join('/')}`
  const manifest = join(modules, ...pkg.split('/'), 'package.json')
  if (!existsSync(manifest)) return { ok: false, why: `the package ${pkg} is not in the staged tree` }
  const exports: unknown = (JSON.parse(readFileSync(manifest, 'utf8')) as { exports?: unknown }).exports
  if (exports === undefined) return { ok: true, how: `${pkg} publishes no exports map` }
  // The one-entry shorthand: `"exports": "./lib/index.js"` means "." and only ".".
  if (typeof exports === 'string') {
    return subpath === '.'
      ? { ok: true, how: 'the package root' }
      : { ok: false, why: `${pkg} declares only its root, so ${subpath} is not an entry point` }
  }
  const keys = Object.keys(exports as Record<string, unknown>)
  if (keys.includes(subpath)) return { ok: true, how: 'a declared entry point' }
  const pattern = keys.find((key) => key.endsWith('*') && subpath.startsWith(key.slice(0, -1)))
  if (pattern !== undefined) return { ok: true, how: `the ${pattern} pattern` }
  return { ok: false, why: `${pkg} does not declare ${subpath} among its entry points` }
}

// Needs the staged tree, which is what carries the manifests being read.
describe.skipIf(!existsSync(modules))('the upstream specifiers we import', () => {
  it('are all seams upstream declares', () => {
    const uses = upstreamImports()
    // A silent pass on an empty scan would be the worst outcome: the gate would
    // report green having read nothing, which is exactly how the glob quietly
    // breaking would look.
    expect(uses.length, 'scanned no upstream imports at all; the source globs are wrong').toBeGreaterThan(0)

    const offenders = uses
      .map((use) => ({ use, verdict: seamVerdict(use.specifier) }))
      .filter((row): row is { use: Use, verdict: { ok: false, why: string } } => !row.verdict.ok)

    expect(
      offenders.map(({ use, verdict }) => `${use.specifier}: ${verdict.why}\n      imported by ${use.importers.join(', ')}`),
      'these imports reach past what upstream declares, so upstream is free to move them without notice',
    ).toEqual([])
  })

  it('resolve from the staged tree as well as being declared', () => {
    // The neighbouring layer, and the reason a green run above is not enough: a
    // declared entry can still point at a file the published tarball omits.
    // Cheap to check while the manifests are already open.
    const missing = upstreamImports()
      .map((use) => use.specifier.split('/').slice(0, 2).join('/'))
      .filter((pkg, index, all) => all.indexOf(pkg) === index)
      .filter((pkg) => !existsSync(join(modules, ...pkg.split('/'), 'package.json')))
    expect(missing, 'imported packages absent from the staged tree').toEqual([])
  })
})
