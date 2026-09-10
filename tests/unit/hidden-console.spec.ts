/**
 * The rule that decides whether the sidecar still needs `windowsHide`.
 *
 * This is one boolean with a real consequence on each side, which is why it is
 * a function rather than an inline `outcome === 'allocated'`. Get it wrong one
 * way and the console flash comes back for every command; get it wrong the
 * other and a dev running the app from a terminal has every harness subprocess
 * appear in it — or, worse, the sidecar is handed a console the launcher never
 * hid and the window it was meant to suppress is simply shown.
 *
 * The trace that motivated the whole change is in `src/hidden-console.ts`.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  acquireHiddenConsole,
  consoleHelperPath,
  windowsHideFor,
  type ConsoleOutcome,
} from '../../src/hidden-console.js'

describe('windowsHideFor', () => {
  it('drops the flag only for a console this launcher allocated and hid', () => {
    expect(windowsHideFor('allocated')).toBe(false)
  })

  it.each<ConsoleOutcome>(['present', 'attached', 'failed', 'unsupported'])(
    'keeps the flag for %s',
    (outcome) => {
      expect(windowsHideFor(outcome)).toBe(true)
    },
  )

  it('keeps the flag for a console someone is reading', () => {
    // `present` is the dev-from-a-terminal case and it is NOT ours to hand
    // out: inheriting it would put every shell the harness spawns into the
    // user's own terminal. Called out separately from the table above because
    // it is the one that looks safe to include and is not.
    expect(windowsHideFor('present')).toBe(true)
  })
})

describe('consoleHelperPath', () => {
  it('points at the helper the sidecar preloads, inside the staged tree', () => {
    // The same module `boot.js` imports and puts on NODE_OPTIONS. Naming a
    // different file would give the launcher a second implementation of the
    // console rule, which is the thing this design exists to avoid.
    expect(consoleHelperPath('/root')).toBe(
      join('/root', 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'hide-console.mjs'),
    )
  })
})

describe('acquireHiddenConsole', () => {
  it('does nothing off Windows', async () => {
    let loaded = false
    const outcome = await acquireHiddenConsole('/root', async () => {
      loaded = true
      return {}
    }, 'darwin')
    expect(outcome).toBe('unsupported')
    expect(loaded, 'the helper was imported on a platform that has no consoles').toBe(false)
  })

  it('answers with what the helper reports', async () => {
    const outcome = await acquireHiddenConsole('/root', async () => ({
      allocateHiddenConsole: () => 'allocated' as const,
    }), 'win32')
    expect(outcome).toBe('allocated')
  })

  it('loads the helper as a file URL, not a bare path', async () => {
    // A Windows path is not a valid ESM specifier — `import('C:\\…')` throws
    // ERR_UNSUPPORTED_ESM_URL_SCHEME, and the catch below would turn that into
    // a silent `failed` and the flash staying exactly as it was.
    let seen = ''
    await acquireHiddenConsole('C:\\app\\harness', async (specifier) => {
      seen = specifier
      return { allocateHiddenConsole: () => 'allocated' as const }
    }, 'win32')
    expect(seen.startsWith('file:///')).toBe(true)
    expect(seen).toContain('hide-console.mjs')
  })

  it('reports failure when the helper cannot be loaded', async () => {
    const outcome = await acquireHiddenConsole('/root', () => {
      throw new Error('no such module')
    }, 'win32')
    expect(outcome).toBe('failed')
  })

  it('reports failure when the module is there but exports nothing usable', async () => {
    // The shape is a coupling to another package's module: it can drift
    // without anything failing to resolve, and the launcher must keep
    // `windowsHide` rather than proceed on an undefined.
    const outcome = await acquireHiddenConsole('/root', async () => ({}), 'win32')
    expect(outcome).toBe('failed')
  })

  it('never throws out to the caller', async () => {
    // The launcher calls this before the window exists. A throw here would be
    // an app that does not start, in exchange for a cosmetic fix.
    await expect(acquireHiddenConsole('/root', async () => ({
      allocateHiddenConsole: () => { throw new Error('koffi exploded') },
    }), 'win32')).resolves.toBe('failed')
  })
})
