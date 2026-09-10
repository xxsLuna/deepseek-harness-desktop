/**
 * A slot has to be declared before anything registers into it.
 *
 * `0.1.5` made the slot registry declarative: a slot exists only once a parent
 * entry's `children` table declares it, and `slots.register` on an undeclared
 * name **throws**. `slots.inject(name, mount)` is the wait — it runs the mount
 * once the declaration arrives. Upstream's own settings sections are all
 * written that way.
 *
 * `@dsh-desktop/settings` was not, and `0.1.5-desktop-alpha0.1.1` shipped it:
 *
 *   failed to apply loader entry ... (@dsh-desktop/settings):
 *   slot "settings.section" is not declared (a parent entry's children table
 *   must declare it)
 *
 * The throw comes out of `apply`, so the whole plugin dies — the three Desktop
 * settings pages are simply absent, and the app reports a failed plugin load.
 *
 * Nothing caught it, and the reason is the interesting part: `@dsh-desktop/market`
 * had already been refitted to `slots.inject`, and its bundle test ran against a
 * stub whose `register` accepted anything. A stub more permissive than the real
 * host cannot fail the way the host does, so it certified the pattern that was
 * about to break rather than the one that works. `settings` had no such test at
 * all.
 *
 * So this stub enforces the real rule, and it runs over EVERY bundle that asks
 * for the `slots` service rather than over one named package — self-selecting,
 * so the next client plugin is covered by existing.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const packagesDir = join(root, 'packages')

interface Registration {
  name: string
  id?: string
  registrant?: string
  component: unknown
}

interface BundleRun {
  id: string
  injected: string[]
  registrations: Registration[]
  /** Slot names opened through `slots.inject`, in call order. */
  awaited: string[]
}

/**
 * Execute one built bundle under a module host and a slot registry that
 * enforces the declaration rule.
 * @param dir - package directory under `packages/`.
 * @returns what the bundle registered and which slots it waited for.
 */
function runBundle(dir: string): BundleRun {
  const bundlePath = join(packagesDir, dir, 'lib', 'client.js')

  // Only what the real host guarantees. React is external in the build, so it
  // arrives through this require; nothing is rendered here, so a jsx factory
  // and inert hooks are enough to evaluate the module.
  const require = (name: string): unknown => {
    if (name === 'react/jsx-runtime' || name === 'react') {
      return {
        jsx: () => null,
        jsxs: () => null,
        Fragment: null,
        useState: () => [],
        useEffect: () => {},
        useCallback: (f: unknown) => f,
        useMemo: (f: () => unknown) => f(),
        useRef: () => ({ current: undefined }),
      }
    }
    throw new Error(`the bundle required '${name}', which the module host does not supply`)
  }

  let loaded: { id: string, factory: (r: (name: string) => unknown) => unknown } | undefined
  const host = { load: (arg: typeof loaded) => { loaded = arg } }
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(bundlePath, 'utf8'))({ __ModuleLoader__: host })
  if (loaded === undefined) throw new Error(`${dir}: the bundle did not call window.__ModuleLoader__.load`)

  const exported = loaded.factory(require) as {
    inject?: string[]
    apply?: (ctx: unknown) => void
  }
  const injected = Array.isArray(exported.inject) ? [...exported.inject] : []

  const registrations: Registration[] = []
  const awaited: string[] = []
  const declared = new Set<string>()

  const slots = {
    // The real registry throws on an undeclared name. Reproducing that is the
    // entire point: a stub that accepts anything certifies nothing.
    register: (options: Registration, component: unknown) => {
      if (!declared.has(options.name)) {
        throw new Error(
          `slot "${options.name}" is not declared (a parent entry's children table must declare it)`,
        )
      }
      registrations.push({ ...options, component })
      return () => {}
    },
    // Standing in for "the declaration has arrived": mount runs immediately,
    // which is what the real inject does once the slot exists.
    inject: (name: string, mount: () => unknown) => {
      awaited.push(name)
      declared.add(name)
      const out = mount()
      declared.delete(name)
      return out
    },
  }

  // Effects are recorded, not run: the real ones touch `document`, and what is
  // under test here is registration rather than what a mounted effect does.
  const effect = (_execute: () => () => void, _label?: string): void => {}

  exported.apply?.({ slots, effect })
  return { id: loaded.id, injected, registrations, awaited }
}

/** Packages with a built client bundle whose module asks for the slot registry. */
const slotBundles = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((dir) => existsSync(join(packagesDir, dir, 'lib', 'client.js')))
  .flatMap((dir) => {
    // Reading the export rather than a list here: a bundle that does not take
    // `slots` gets a ctx this stub cannot honestly supply, so it is not run.
    try {
      const run = runBundle(dir)
      return run.injected.includes('slots') ? [[dir, run] as const] : []
    } catch (error) {
      // A throw during collection is the failure this file exists to catch, so
      // it is carried into a test rather than taking the whole suite down.
      return [[dir, error as Error] as const]
    }
  })

describe.skipIf(slotBundles.length === 0)('client bundles that register into slots', () => {
  it.each(slotBundles.map(([dir]) => dir))('%s registers only into slots it waited for', (dir) => {
    const run = slotBundles.find(([name]) => name === dir)?.[1]
    if (run instanceof Error) throw run
    expect(run, dir).toBeDefined()
    // Every registration got here through `slots.inject`, or `register` above
    // would have thrown the way the real registry does.
    expect(run!.registrations.length, `${dir} registered nothing`).toBeGreaterThan(0)
    for (const registration of run!.registrations) {
      expect(run!.awaited, `${dir} registered ${registration.name} without waiting for it`)
        .toContain(registration.name)
    }
  })

  it('covers the settings sections, which is where this broke', () => {
    const run = slotBundles.find(([dir]) => dir === 'settings')?.[1]
    expect(run, 'no built @dsh-desktop/settings bundle to check').toBeDefined()
    if (run instanceof Error) throw run
    const sections = run!.registrations.filter((r) => r.name === 'settings.section')
    expect(sections.map((s) => s.id).sort()).toEqual(['desktop', 'desktop-shortcuts', 'desktop-usage'])
    for (const section of sections) {
      expect(section.registrant).toBe('@dsh-desktop/settings')
      expect(typeof section.component).toBe('function')
    }
  })
})
