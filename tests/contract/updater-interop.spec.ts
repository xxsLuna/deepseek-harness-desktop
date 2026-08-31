/**
 * How `electron-updater` resolves under the runtime the app actually ships.
 *
 * This has to spawn the real binary. Vitest loads CJS through Vite's interop,
 * which surfaces `autoUpdater` as a named export even though Node's native ESM
 * interop does not — so the same assertion made in a unit test passes for a
 * reason that has nothing to do with the app, and would have printed green
 * over this bug for the whole life of the project. It did print green over it:
 * `const { autoUpdater } = await import('electron-updater')` shipped in every
 * release, bound undefined, and made every update check fail with `Cannot set
 * properties of undefined (setting 'autoDownload')`.
 *
 * Same probe shape as native-tools.spec.ts, and for the same reason: the only
 * loader whose answer counts is the one in the binary we ship.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const nodeRequire = createRequire(import.meta.url)
const electronBinary = nodeRequire('electron') as string
const updaterInstalled = existsSync(join(root, 'node_modules', 'electron-updater'))

/**
 * Run one probe script under the app's own binary, from the repo root so that
 * `electron-updater` resolves exactly as it does for the launcher.
 * @param source - ESM source; its stdout must be a single JSON line.
 * @returns the parsed result.
 */
function probe(source: string): unknown {
  const out = execFileSync(electronBinary, ['--input-type=module', '-e', source], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    // Without this the binary boots an app window instead of running the script.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  return JSON.parse(out.trim().split('\n').at(-1) ?? 'null')
}

describe.skipIf(!updaterInstalled || !existsSync(electronBinary))('electron-updater under the shipped runtime', () => {
  const shape = (): { named: string[], hasDefault: boolean, requireHasGetter: boolean } => probe(`
    const { createRequire } = await import('node:module')
    const m = await import('electron-updater')
    const cjs = createRequire(process.cwd() + '/x.js')('electron-updater')
    console.log(JSON.stringify({
      named: Object.keys(m),
      hasDefault: m.default !== undefined,
      requireHasGetter: typeof Object.getOwnPropertyDescriptor(cjs, 'autoUpdater')?.get === 'function',
    }))
  `) as { named: string[], hasDefault: boolean, requireHasGetter: boolean }

  it('does not expose autoUpdater as an ESM named export', () => {
    // The fact that makes the destructured dynamic import silently wrong. If
    // this starts failing, cjs-module-lexer learned to read the getter (or
    // upstream stopped using one) and updater.ts could go back to `import` —
    // until then it must not.
    expect(shape().named).not.toContain('autoUpdater')
  })

  it('does expose the statically visible classes, so this is not a load failure', () => {
    expect(shape().named).toContain('NsisUpdater')
  })

  it('reaches autoUpdater through require, which is what updater.ts uses', () => {
    expect(shape().requireHasGetter).toBe(true)
  })
})
