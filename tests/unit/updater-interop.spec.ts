/**
 * That the launcher still loads `electron-updater` the only way that works.
 *
 * The bug this guards shipped in every release: `updater.ts` did
 * `const { autoUpdater } = await import('electron-updater')`, which binds
 * undefined under Node's native ESM interop, and threw `Cannot set properties
 * of undefined (setting 'autoDownload')` on the next line. Auto-update
 * therefore never worked — neither the four-hourly check nor "Check now" — and
 * nothing said so, because TypeScript accepts the destructure: the .d.ts
 * declares an export the runtime does not provide.
 *
 * The runtime half of this cannot be asserted here. Vitest loads CJS through
 * Vite's interop, which DOES surface the getter as a named export, so an
 * `expect(...).not.toContain('autoUpdater')` in this file passes for a reason
 * that has nothing to do with the app — it would print green over the very bug
 * it claims to cover. That assertion lives in
 * `tests/contract/updater-interop.spec.ts`, which spawns the real binary.
 *
 * What is environment-independent, and so belongs here: the shape of the CJS
 * exports object, and what our own source does with it.
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

/**
 * Source with comments removed.
 *
 * Needed because the doc comment on `autoUpdaterOnce` quotes the broken form
 * in order to explain it — the first version of this test matched its own
 * explanation and failed.
 * @param source - TypeScript source text.
 * @returns the source with block and line comments blanked out.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('electron-updater exports', () => {
  it('defines autoUpdater as a getter on module.exports', () => {
    // The reason the named export is missing under Node: cjs-module-lexer
    // cannot see a getter. Reading the descriptor asks without invoking it —
    // the getter constructs a real NsisUpdater and needs the Electron app API.
    const cjs = require('electron-updater') as object
    const descriptor = Object.getOwnPropertyDescriptor(cjs, 'autoUpdater')
    expect(descriptor).toBeDefined()
    expect(descriptor?.get).toBeTypeOf('function')
  })

  it('exposes its classes as plain properties, so the miss is specific to the getter', () => {
    // Rules out "the package failed to load" as an explanation.
    const cjs = require('electron-updater') as Record<string, unknown>
    expect(Object.keys(cjs)).toContain('NsisUpdater')
  })
})

describe('updater.ts', () => {
  const source = withoutComments(
    readFileSync(new URL('../../src/updater.ts', import.meta.url), 'utf8'),
  )

  it('reaches electron-updater through require', () => {
    expect(source).toContain("require('electron-updater')")
  })

  it('does not load it through a dynamic import', () => {
    // The regression this exists for. Both forms typecheck; only one works.
    // Narrowed to `await import(...)` on purpose: `typeof import(...)` is a
    // type position, it is how AutoUpdater is declared here, and it never
    // reaches the runtime.
    expect(source).not.toMatch(/await\s+import\(\s*'electron-updater'\s*\)/)
  })
})
