/**
 * The Marketplace tab's built bundle, executed.
 *
 * Everything else about the client half is checked statically: the contract
 * suite greps the served bundle for the slot name, and typecheck covers the
 * source. Neither answers the question that actually matters — does the bundle
 * RUN? It is emitted as a classic script wrapped in the module-host factory
 * form, and a mistake in that wrapper (a bad `id`, a top-level `require` of
 * something the host cannot supply, a syntax error esbuild happily emitted) is
 * invisible until a window opens.
 *
 * On Windows that window cannot be observed from a script — Electron is a GUI
 * subsystem binary, so `npm run smoke`'s RESULT lines never reach a piped
 * stdout. This runs the bundle under a stub host instead, which is cheaper and
 * catches the same class.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundlePath = join(import.meta.dirname, '..', '..', 'packages', 'market', 'lib', 'client.js')

/** One registration the bundle made. */
interface Registration {
  options: { name?: string, id?: string, order?: number, label?: string, registrant?: string }
  component: unknown
}

/** What executing the bundle revealed. */
interface BundleRun {
  /** The id it registered itself under; must equal the package name. */
  id: string
  /** Its exported cordis service gate. */
  injected: string[]
  /** Everything it registered into a slot. */
  registrations: Registration[]
  /** Every specifier it asked the module host for. */
  required: string[]
}

/**
 * Execute the bundle against a stub module host.
 * @returns what the module registered, and what it asked the host to require.
 */
function runBundle(): BundleRun {
  const required: string[] = []
  const injected: string[] = []
  const registrations: Registration[] = []

  // Only what the real host guarantees. React is external in the build (a second
  // copy of React is a different runtime than the page's), so it arrives through
  // this require — a jsx factory is enough to load the module, since the
  // component itself is not rendered here.
  const require = (name: string): unknown => {
    required.push(name)
    if (name === 'react/jsx-runtime' || name === 'react') {
      return { jsx: () => null, jsxs: () => null, Fragment: null, useState: () => [], useEffect: () => {}, useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f() }
    }
    throw new Error(`the bundle required '${name}', which the module host does not supply`)
  }

  let loaded: { id: string, factory: (r: (name: string) => unknown) => unknown } | undefined
  const host = { load: (arg: { id: string, factory: (r: (name: string) => unknown) => unknown }) => { loaded = arg } }

  // The bundle is a classic script that assigns nothing and returns nothing; it
  // calls window.__ModuleLoader__.load at top level. Run it with `window` bound.
  const source = readFileSync(bundlePath, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', source)({ __ModuleLoader__: host })

  if (loaded === undefined) throw new Error('the bundle did not call window.__ModuleLoader__.load')
  const exported = loaded.factory(require) as {
    inject?: string[]
    apply?: (ctx: unknown) => void
  }
  if (Array.isArray(exported.inject)) injected.push(...exported.inject)

  const slots = {
    register: (options: Registration['options'], component: unknown) => {
      registrations.push({ options, component })
      return () => {}
    },
    // The real `inject` waits for the slot to be declared; running the mount
    // straight away is the same thing once it has been.
    inject: (_name: string, mount: () => unknown) => mount(),
  }
  exported.apply?.({ slots })

  return { id: loaded.id, injected, registrations, required }
}

describe.skipIf(!existsSync(bundlePath))('market client bundle', () => {
  it('loads under the module host and registers the tab', () => {
    const result = runBundle()

    // The id must equal the package name: it is the loader entry name, and the
    // host's own arrival check throws on anything else.
    expect(result.id).toBe('@dsh-desktop/market')
    expect(result.injected).toContain('slots')

    const tab = result.registrations.find((r) => r.options.name === 'settings.plugins.tab')
    expect(tab, 'the bundle registered no settings.plugins.tab entry').toBeDefined()
    expect(tab?.options.id).toBe('marketplace')
    expect(tab?.options.registrant).toBe('@dsh-desktop/market')
    expect(typeof tab?.component).toBe('function')
  })

  it('requires nothing the module host cannot supply', () => {
    // A top-level require of an upstream client package that is not in
    // dsh.client.inject resolves to undefined at runtime and fails later, in the
    // renderer, with no useful stack. Keeping the set to React is the simplest
    // way to be sure — and if this ever needs to grow, the package's
    // dsh.client.inject must grow with it.
    const result = runBundle()
    for (const name of result.required) {
      expect(['react', 'react-dom', 'react/jsx-runtime']).toContain(name)
    }
  })
})
