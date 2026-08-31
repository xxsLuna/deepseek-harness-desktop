/**
 * Every desktop package has to be reachable from `@dsh-desktop/bundle`.
 *
 * `stage-harness.mjs` discovers `packages/*` by reading the directory, so a new
 * package reaches the staged tree on its own — and that is not enough. Upstream
 * builds `$DSH_HOME/profiles/node_modules` as one symlink per package in a BFS
 * over the anchor manifest's `dependencies` and `peerDependencies`
 * (`healProfilesModuleFallback`), and `packages/bundle/lib/boot.js` passes its
 * OWN manifest as the second anchor. A package missing from that list is
 * therefore never linked, and since `ctx.baseUrl` is the profile directory,
 * Node's parent walk never reaches the staged tree either.
 *
 * Adding `layout-memory` walked into exactly that: staged, composed as a row,
 * and the boot died with `Cannot find package '@dsh-desktop/layout-memory'`.
 * It fails loudly, which is the good case — but it fails at app launch, and
 * this moves it to `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const packagesDir = join(root, 'packages')

/** The name each directory under `packages/` publishes. */
const localPackages = new Map<string, string>(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8'),
      ) as { name: string }
      return [entry.name, manifest.name]
    }),
)

const bundle = JSON.parse(
  readFileSync(join(packagesDir, 'bundle', 'package.json'), 'utf8'),
) as { name: string, peerDependencies?: Record<string, string> }

const peers = Object.keys(bundle.peerDependencies ?? {})

describe('@dsh-desktop/bundle peerDependencies', () => {
  it('names every other package in this repo', () => {
    const expected = [...localPackages.values()].filter((name) => name !== bundle.name).sort()
    const declared = peers.filter((name) => name.startsWith('@dsh-desktop/')).sort()
    expect(declared).toEqual(expected)
  })

  it('does not name a package that no longer exists', () => {
    // A dangling name is invisible to resolution rather than an error, so it
    // would sit there looking like coverage it is not providing.
    const names = new Set(localPackages.values())
    for (const peer of peers.filter((name) => name.startsWith('@dsh-desktop/'))) {
      expect(names, peer).toContain(peer)
    }
  })

  it('does not list itself, which the BFS gets from the anchor', () => {
    expect(peers).not.toContain(bundle.name)
  })
})

describe('the composed rows', () => {
  const patch = readFileSync(join(packagesDir, 'bundle', 'cordis.patch.yml'), 'utf8')

  it('composes a row for every package the bundle depends on', () => {
    // The other half of the same mistake: a package that is linked and staged
    // but never composed does nothing at all, and nothing says so.
    for (const name of localPackages.values()) {
      if (name === bundle.name) continue
      expect(patch, name).toContain(`name: '${name}'`)
    }
  })
})
