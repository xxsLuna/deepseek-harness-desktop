/**
 * The installed-plugin registry over a harness profile manifest.
 *
 * The manifest is upstream's format and a hand-editable file, so every test
 * here is one of three things: a broken file still yields an answer, a write is
 * the smallest edit that records the fact, or a field we do not own survives
 * being written through. The last group is the one that matters most — a
 * profile manifest carries keys (pnpm settings, `private`, a `dsh.bundle` of
 * its own) that this module knows nothing about, and clobbering them is data
 * loss the user only discovers on the next install.
 *
 * The final block round-trips through upstream's OWN `initProfile` /
 * `writeProfileManifest` / `readProfileManifest`, which is what catches an
 * upstream format change. It needs a staged harness; when there is none it
 * asserts the absence rather than skipping, so a staged tree whose app-boot has
 * moved fails here instead of quietly passing.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import {
  addInstalled,
  isPluginName,
  isPluginVersion,
  parseInstalled,
  removeInstalled,
} from '../../packages/market/lib/registry.js'

/** A profile manifest as upstream's `initProfile` writes one, plus one plugin. */
const PROFILE = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: { '@acme/dsh-notes': '1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@acme/dsh-notes'] } },
} as const

/** The manifest as JSON, for asserting the input came back untouched. */
const frozen = (value: unknown): string => JSON.stringify(value)

describe('parseInstalled', () => {
  it('reads the layer list in its stored order', () => {
    // Order IS the meaning: it is the patch application order, so the answer is
    // a sequence, not a set.
    expect(parseInstalled(PROFILE)).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@acme/dsh-notes',
    ])
  })

  it('survives anything the file could hold', () => {
    // A hand-edited or half-written manifest must not stop the app booting, so
    // every one of these is an empty list rather than a throw.
    const shapes: unknown[] = [
      undefined, null, 42, 'dsh', true, [], {},
      { dsh: null }, { dsh: 'base' }, { dsh: [] }, { dsh: {} },
      { dsh: { profile: null } }, { dsh: { profile: 'base' } }, { dsh: { profile: [] } }, { dsh: { profile: {} } },
      { dsh: { profile: { bundles: null } } },
      { dsh: { profile: { bundles: '@deepseek-ai/dsh-base' } } },
      { dsh: { profile: { bundles: { 0: '@deepseek-ai/dsh-base' } } } },
      { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    ]
    for (const manifest of shapes) {
      expect(parseInstalled(manifest), JSON.stringify(manifest)).toEqual([])
    }
  })

  it('drops entries that cannot name a layer, keeping the order of the rest', () => {
    // A repeat is dropped because two loader rows with one id make the loader
    // throw `duplicate loader entry id` — the app does not start at all.
    expect(parseInstalled({
      dsh: { profile: { bundles: ['@a/one', 42, null, '@a/two', '', ['@a/three'], '@a/one'] } },
    })).toEqual(['@a/one', '@a/two'])
  })

  it('reports an entry it would refuse to write', () => {
    // Deliberate: upstream's loadProfile fails on this by name, and hiding it
    // would make the marketplace claim nothing is installed while this entry is
    // exactly what is stopping the app from booting.
    const handEdited = { dsh: { profile: { bundles: ['@a/one', '../../evil'] } } }
    expect(parseInstalled(handEdited)).toEqual(['@a/one', '../../evil'])
    expect(isPluginName('../../evil')).toBe(false)
  })
})

describe('isPluginName', () => {
  it('accepts the shapes a registry really publishes', () => {
    for (const name of [
      'dsh-plugin', '@acme/dsh-plugin', '@deepseek-ai/dsh-base',
      'a', 'plugin.js', 'plugin_2', '@a-b.c/d_e.f', 'x'.repeat(214),
    ]) {
      expect(isPluginName(name), name).toBe(true)
    }
  })

  it('refuses every name that could steer resolution off the tree', () => {
    // The recorded name reaches `join(searchPath, packageName)` inside
    // upstream's resolution, so a separator or a dot-relative segment is a
    // traversal primitive, not a typo.
    for (const name of [
      '..', '.', '../evil', './evil', '/etc/passwd', 'C:\\evil', 'a\\b', 'a/b',
      '@scope/../evil', '@scope', '@/evil', '@scope/', '', '.hidden', '_hidden',
      'node_modules', 'favicon.ico', 'Upper', 'has space', 'has%2e%2e',
      'x'.repeat(215), 'http://evil/pkg',
    ]) {
      expect(isPluginName(name), name).toBe(false)
    }
    for (const value of [undefined, null, 42, {}, ['@a/one']]) {
      expect(isPluginName(value), String(value)).toBe(false)
    }
  })
})

describe('isPluginVersion', () => {
  it('accepts one concrete release, upstream\'s own shape included', () => {
    for (const version of ['1.4.2', '0.0.0', '0.1.0-rc.8', '1.0.0-alpha', '1.0.0+build.5', '1.0.0-rc.1+b']) {
      expect(isPluginVersion(version), version).toBe(true)
    }
  })

  it('refuses a range and every spec that points somewhere else', () => {
    // The value is read by the next `pnpm install` in the profile directory: a
    // path or git spec there is remote-code-from-anywhere, a range is drift.
    for (const version of [
      '^1.4.2', '~1.4.2', '>=1.0.0', '1.x', 'latest', '*', '',
      'file:../evil', 'link:../evil', 'git+https://evil/pkg.git', 'npm:other@1.0.0', '1.4',
    ]) {
      expect(isPluginVersion(version), version).toBe(false)
    }
    for (const value of [undefined, null, 142, {}]) {
      expect(isPluginVersion(value), String(value)).toBe(false)
    }
  })
})

describe('addInstalled', () => {
  it('records the version in dependencies and the name as the LAST layer', () => {
    const next = addInstalled(PROFILE, '@acme/dsh-charts', '2.1.0')
    // Appended, because the list is patch application order: a new layer goes
    // over the plugins already installed, never between them.
    expect(parseInstalled(next)).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@acme/dsh-notes', '@acme/dsh-charts',
    ])
    expect(next.dependencies).toEqual({ '@acme/dsh-notes': '1.0.0', '@acme/dsh-charts': '2.1.0' })
  })

  it('writes the version exactly, with no range prefix', () => {
    // An exact pin is the point: a bundle is third-party code running in-process
    // with the harness's privileges, so the next `pnpm install` must reproduce
    // the tree rather than resolve a newer one.
    expect(addInstalled({}, '@acme/dsh-charts', '2.1.0').dependencies).toEqual({ '@acme/dsh-charts': '2.1.0' })
  })

  it('is idempotent on the layer list and updates the version in place', () => {
    const once = addInstalled(PROFILE, '@acme/dsh-charts', '2.1.0')
    const twice = addInstalled(once, '@acme/dsh-charts', '2.2.0')
    // No duplicate: a repeated id makes the loader throw and the app not boot.
    expect(parseInstalled(twice)).toEqual(parseInstalled(once))
    expect(twice.dependencies).toEqual({ '@acme/dsh-notes': '1.0.0', '@acme/dsh-charts': '2.2.0' })
    // And the key keeps its position, so a re-install rewrites one value.
    expect(Object.keys(twice.dependencies as object)).toEqual(['@acme/dsh-notes', '@acme/dsh-charts'])
  })

  it('never mutates the manifest it was given', () => {
    const before = frozen(PROFILE)
    addInstalled(PROFILE, '@acme/dsh-charts', '2.1.0')
    expect(frozen(PROFILE)).toBe(before)
  })

  it('preserves every field it does not own', () => {
    const manifest = {
      name: 'dsh-profile-desktop',
      private: true,
      packageManager: 'pnpm@10.0.0',
      pnpm: { onlyBuiltDependencies: ['node-pty'] },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        profile: { bundles: ['@deepseek-ai/dsh-base'], someFutureKey: 7 },
        someFutureSection: { a: 1 },
      },
      someFutureTopKey: ['keep me'],
    }
    const next = addInstalled(manifest, '@acme/dsh-charts', '2.1.0') as typeof manifest
    expect(next.name).toBe('dsh-profile-desktop')
    expect(next.private).toBe(true)
    expect(next.packageManager).toBe('pnpm@10.0.0')
    expect(next.pnpm).toEqual({ onlyBuiltDependencies: ['node-pty'] })
    expect(next.someFutureTopKey).toEqual(['keep me'])
    // Including the neighbours inside the section we DO edit.
    expect(next.dsh.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(next.dsh.someFutureSection).toEqual({ a: 1 })
    expect(next.dsh.profile.someFutureKey).toBe(7)
  })

  it('builds the fields a manifest is missing', () => {
    expect(addInstalled({ name: 'dsh-profile-desktop' }, '@acme/dsh-charts', '2.1.0')).toEqual({
      name: 'dsh-profile-desktop',
      dependencies: { '@acme/dsh-charts': '2.1.0' },
      dsh: { profile: { bundles: ['@acme/dsh-charts'] } },
    })
  })

  it('replaces a bundles value that cannot hold a list, and normalises a broken one', () => {
    // A non-array `bundles` already crashes upstream's loadProfile, and it holds
    // no names to keep, so recording an install has to put a real list there.
    expect(parseInstalled(addInstalled({ dsh: { profile: { bundles: 'nope' } } }, '@a/one', '1.0.0')))
      .toEqual(['@a/one'])
    // Shape is normalised (junk entry, repeat) but a plausible-looking string a
    // user typed is never silently repaired away.
    const messy = { dsh: { profile: { bundles: ['@a/one', 42, '@a/one', '../evil'] } } }
    expect(parseInstalled(addInstalled(messy, '@a/two', '1.0.0')))
      .toEqual(['@a/one', '../evil', '@a/two'])
  })

  it('refuses a name that is not an npm package name', () => {
    // Loud, not silent: a name we will not record means a package is on disk
    // with nothing pointing at it, which is worse than a failed install.
    for (const name of ['../evil', '/etc/passwd', 'node_modules', '', '@scope']) {
      expect(() => addInstalled(PROFILE, name, '1.0.0'), name).toThrow(/not an npm package name/)
    }
    expect(frozen(PROFILE)).toBe(frozen(JSON.parse(frozen(PROFILE))))
  })

  it('refuses a version that is not one exact release', () => {
    for (const version of ['^1.0.0', 'latest', 'file:../evil', 'git+https://evil/pkg.git', '']) {
      expect(() => addInstalled(PROFILE, '@acme/dsh-charts', version), version).toThrow(/not one exact version/)
    }
  })

  it('records a non-bundle as a dependency only, and retires a stale layer entry', () => {
    // Upstream warns and installs a `dsh.bundle`-less package as a plain
    // dependency; listing it as a layer would make loadProfile THROW on the next
    // boot, so the same call must also drop an entry a previous version left.
    const plain = addInstalled(PROFILE, '@acme/plain-lib', '1.0.0', { bundle: false })
    expect(parseInstalled(plain)).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@acme/dsh-notes',
    ])
    expect((plain.dependencies as Record<string, string>)['@acme/plain-lib']).toBe('1.0.0')

    const demoted = addInstalled(PROFILE, '@acme/dsh-notes', '2.0.0', { bundle: false })
    expect(parseInstalled(demoted)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect((demoted.dependencies as Record<string, string>)['@acme/dsh-notes']).toBe('2.0.0')
  })
})

describe('removeInstalled', () => {
  it('drops the name from both places and keeps the order of the survivors', () => {
    const next = removeInstalled(PROFILE, '@deepseek-ai/dsh-web-app')
    // Relative order of the rest is untouched: it is the patch application
    // order, so a shuffle would change what the remaining plugins do.
    expect(parseInstalled(next)).toEqual(['@deepseek-ai/dsh-base', '@acme/dsh-notes'])
    const gone = removeInstalled(PROFILE, '@acme/dsh-notes')
    expect(parseInstalled(gone)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(gone.dependencies).toEqual({})
  })

  it('is a no-op for a name that is not installed', () => {
    expect(removeInstalled(PROFILE, '@acme/dsh-charts')).toEqual(JSON.parse(frozen(PROFILE)))
  })

  it('invents nothing it did not find', () => {
    // A removal attempt on a manifest that has neither field must not leave
    // empty ones behind for upstream to read.
    expect(removeInstalled({ name: 'dsh-profile-desktop' }, '@acme/dsh-charts'))
      .toEqual({ name: 'dsh-profile-desktop' })
    expect(removeInstalled({}, '@acme/dsh-charts')).toEqual({})
  })

  it('removes an entry no add would have written', () => {
    // Validation guards what we write, not what we retract: an entry a hand-edit
    // put in the file is exactly the one a user needs to be able to take out.
    const handEdited = { dsh: { profile: { bundles: ['@a/one', '../../evil'] } } }
    expect(parseInstalled(removeInstalled(handEdited, '../../evil'))).toEqual(['@a/one'])
  })

  it('never mutates the manifest it was given', () => {
    const before = frozen(PROFILE)
    removeInstalled(PROFILE, '@acme/dsh-notes')
    expect(frozen(PROFILE)).toBe(before)
  })

  it('leaves the neighbours of the fields it edits alone', () => {
    const manifest = {
      private: true,
      dependencies: { '@acme/dsh-notes': '1.0.0', 'other-lib': '3.0.0' },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        profile: { bundles: ['@acme/dsh-notes'], someFutureKey: 7 },
      },
      someFutureTopKey: 1,
    }
    const next = removeInstalled(manifest, '@acme/dsh-notes') as typeof manifest
    expect(next.dependencies).toEqual({ 'other-lib': '3.0.0' })
    expect(next.private).toBe(true)
    expect(next.someFutureTopKey).toBe(1)
    expect(next.dsh.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(next.dsh.profile.someFutureKey).toBe(7)
  })
})

describe('round trip', () => {
  const root = join(import.meta.dirname, '..', '..')
  const appBootDir = join(root, 'build', 'harness', 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  const temporary: string[] = []

  afterAll(() => {
    for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
  })

  /** A scratch directory to stand in for `$DSH_HOME/profiles/desktop`. */
  function scratchProfile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-market-registry-'))
    temporary.push(dir)
    return dir
  }

  /** The upstream profile API, resolved from the staged tree as the harness resolves it. */
  interface AppBoot {
    initProfile: (dir: string, bundles: readonly string[]) => void
    readProfileManifest: (binName: string, dir: string) => Record<string, unknown>
    writeProfileManifest: (dir: string, manifest: unknown) => void
  }

  /** Upstream's own profile module, or undefined when no harness is staged. */
  async function appBoot(): Promise<AppBoot | undefined> {
    if (!existsSync(appBootDir)) return undefined
    // Anchored inside the staged tree, because @deepseek-ai/* only resolves
    // there — the repo root has no such dependency.
    const requireFromHarness = createRequire(join(root, 'build', 'harness', 'anchor.cjs'))
    const entry = requireFromHarness.resolve('@deepseek-ai/dsh-app-boot')
    return await import(pathToFileURL(entry).href) as AppBoot
  }

  it('the documented manifest shape survives serialisation', () => {
    // upstream's writeProfileManifest is `JSON.stringify(manifest, undefined, 2)
    // + "\n"` and readProfileManifest is `JSON.parse`, so this is that pair
    // without needing a staged tree: nothing we return may be unserialisable,
    // and nothing may depend on object identity to survive.
    const added = addInstalled(PROFILE, '@acme/dsh-charts', '2.1.0')
    const text = `${JSON.stringify(added, undefined, 2)}\n`
    expect(text.endsWith('}\n')).toBe(true)
    const reread = JSON.parse(text) as Record<string, unknown>
    expect(parseInstalled(reread)).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@acme/dsh-notes', '@acme/dsh-charts',
    ])
    const removed = JSON.parse(`${JSON.stringify(removeInstalled(reread, '@acme/dsh-charts'), undefined, 2)}\n`)
    expect(removed).toEqual(JSON.parse(frozen(PROFILE)))
  })

  it('survives upstream\'s own initProfile, writer and reader', async () => {
    const boot = await appBoot()
    if (boot === undefined) {
      // Not a silent skip. This states the reason the real round trip did not
      // run, so a staged tree whose app-boot has moved or been pruned fails
      // here by name instead of passing quietly.
      expect(existsSync(appBootDir), `no staged harness at ${appBootDir}: run npm run stage`).toBe(false)
      return
    }
    const dir = scratchProfile()

    // Start from a profile upstream itself created, so our reader is tested
    // against the real writer rather than against our idea of the format.
    boot.initProfile(dir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const initial = boot.readProfileManifest('market', dir)
    expect(parseInstalled(initial)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

    boot.writeProfileManifest(dir, addInstalled(initial, '@acme/dsh-charts', '2.1.0'))
    const added = boot.readProfileManifest('market', dir)
    expect(parseInstalled(added)).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@acme/dsh-charts',
    ])
    expect(added.dependencies).toEqual({ '@acme/dsh-charts': '2.1.0' })
    // Fields initProfile writes that upstream's own ProfileManifest type does
    // not even name — the exact class of key a careless write would drop.
    expect(added.name).toBe(`dsh-profile-${join(dir).split(/[\\/]/).pop() ?? ''}`)
    expect(added.private).toBe(true)

    boot.writeProfileManifest(dir, removeInstalled(added, '@acme/dsh-charts'))
    const removed = boot.readProfileManifest('market', dir)
    expect(parseInstalled(removed)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(removed.dependencies).toEqual({})
    expect(removed.private).toBe(true)
  })
})
