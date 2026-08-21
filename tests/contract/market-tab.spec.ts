/**
 * The seam the Marketplace tab hangs off.
 *
 * @dsh-desktop/market contributes its tab with
 * `ctx.slots.inject('settings.plugins.tab', …)`. That slot is declared by
 * upstream's Plugins settings section, and `inject` WAITS for the declaration
 * rather than failing without it — which is the right runtime behaviour and the
 * worst possible failure mode for a rename. If upstream renames the slot, drops
 * the section, or moves the declaration, the tab simply never appears: no build
 * error, no type error, no runtime error, nothing in the log. A user opens
 * Settings ▸ Plugins and the marketplace is not there.
 *
 * These are the assertions that turn that into a named failure on an upstream
 * bump. Same shape as settings-nav.spec.ts, for the same reason.
 *
 * Requires a staged harness (npm run stage).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const harnessRoot = join(root, 'build', 'harness')

/** The upstream package that declares the tab slot and owns the Plugins page. */
const SECTION_OWNER = '@deepseek-ai/dsh-client-ui-settings-plugins'
/** The slot name our tab registers into. */
const TAB_SLOT = 'settings.plugins.tab'

const sectionBundle = join(harnessRoot, 'node_modules', ...SECTION_OWNER.split('/'), 'lib', 'client.js')
const ourBundle = join(root, 'packages', 'market', 'lib', 'client.js')

describe.skipIf(!existsSync(harnessRoot))('marketplace tab seam', () => {
  it('still ships the upstream package that owns the Plugins section', () => {
    expect(existsSync(sectionBundle), `${SECTION_OWNER} should ship lib/client.js`).toBe(true)
  })

  it('still declares the slot the Marketplace tab registers into', () => {
    // The section declares this at runtime, so the name only exists as a string
    // in its bundle. Nothing types it, and `slots.inject` is patient by design —
    // a renamed slot is indistinguishable from one that has not mounted yet.
    const bundle = readFileSync(sectionBundle, 'utf8')
    expect(
      bundle,
      `upstream no longer declares '${TAB_SLOT}'; the Marketplace tab will never appear. `
      + 'Find the new slot name in the Plugins section and update packages/market/src/client.tsx.',
    ).toContain(TAB_SLOT)
  })

  it('still composes the Plugins section at all', () => {
    // The tab has nowhere to go if the section itself stops being composed. This
    // reads the row list rather than the bundle: the package could ship and
    // simply not be mounted.
    const webAppPatch = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml')
    expect(readFileSync(webAppPatch, 'utf8')).toContain(SECTION_OWNER)
  })

  it.skipIf(!existsSync(ourBundle))('registers our tab into that slot', () => {
    // Guards the other direction: a refactor of our own client half that stopped
    // naming the slot, or renamed the tab id the styling and ordering assume.
    const bundle = readFileSync(ourBundle, 'utf8')
    expect(bundle).toContain(TAB_SLOT)
    expect(bundle).toContain('marketplace')
  })
})
