/**
 * The settings-nav seam the divider rule reaches through.
 *
 * @dsh-desktop/settings draws a line between upstream's last section and its
 * own by matching two CSS-module locals in upstream's settings shell. Nothing
 * about that is typed or exported — it is a stylesheet's internal naming — so an
 * upstream rename produces no build error, no type error and no runtime error.
 * The divider simply stops being drawn, on a settings page nobody opens during a
 * release check. This is the assertion that turns that into a named failure.
 *
 * Requires a staged harness (npm run stage).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCALS_OWNER, MATCHED_LOCALS, SCOPING_SLOT } from '../../packages/settings/src/nav-group.js'

const root = join(import.meta.dirname, '..', '..')
const harnessRoot = join(root, 'build', 'harness')
const ownerBundle = join(harnessRoot, 'node_modules', ...LOCALS_OWNER.split('/'), 'lib', 'client.js')

describe.skipIf(!existsSync(harnessRoot))('settings nav divider seam', () => {
  it('still finds the upstream package that owns the settings nav', () => {
    expect(existsSync(ownerBundle), `${LOCALS_OWNER} should ship lib/client.js`).toBe(true)
  })

  it('still finds the CSS-module locals the divider matches on', () => {
    // Matched as `[class*='navCell']`, so a rehash of the prefix is fine and a
    // rename is not. If this fails, the divider rule in
    // packages/settings/src/nav-divider.ts needs the new local names.
    const bundle = readFileSync(ownerBundle, 'utf8')
    for (const local of MATCHED_LOCALS) {
      expect(bundle, `upstream renamed the '${local}' local; the nav divider no longer matches`).toContain(local)
    }
  })

  it('still declares the slot whose anchor scopes the rule', () => {
    // The rule leads with [data-slot='sidebar.settings']. That anchor is emitted
    // by the renderer for whichever slot the settings shell occupies, so if the
    // shell moves to a different slot name the rule stops matching entirely —
    // silently, since the page still renders fine without a divider.
    const bundle = readFileSync(ownerBundle, 'utf8')
    expect(bundle, `the settings shell no longer occupies '${SCOPING_SLOT}'`).toContain(SCOPING_SLOT)
  })

  it('still registers the section this divider assumes it sits below', () => {
    // The rule uses :last-child, which is only this plugin while upstream's own
    // sections all order below 100. Agent presets is the highest of them, so a
    // new upstream section ordering above 100 would move the line onto the wrong
    // entry — this catches the package disappearing or being renamed, which is
    // the version of that change a bump is most likely to bring.
    const presets = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-agent-preset', 'lib', 'client.js')
    expect(existsSync(presets), 'the Agent presets section this divider separates from is gone').toBe(true)
    const orders = [...readFileSync(presets, 'utf8').matchAll(/order:\s*(\d+)/g)].map((m) => Number(m[1]))
    expect(orders.length, 'no slot orders found in the agent-preset bundle').toBeGreaterThan(0)
    expect(Math.max(...orders), 'an upstream section now orders at or above this plugin (100)').toBeLessThan(100)
  })
})
