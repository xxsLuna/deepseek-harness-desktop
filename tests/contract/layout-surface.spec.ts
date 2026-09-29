/**
 * The two upstream details `@dsh-desktop/layout-memory` is built on.
 *
 * Both are internals of `dsh-client-ui-layout`, and both fail in silence. The
 * attribute is how the plugin reads whether the sidebar is collapsed — rename
 * it and the plugin reads "always expanded", then persists that over whatever
 * the user actually chose. `toggleSidebar` is the only lever it has; take it
 * off the cross-plugin face and the fiber fails to inject, safe mode disables
 * the row, and the window opens looking perfectly healthy.
 *
 * Asserted against the staged tree rather than a running app because that is
 * what a version bump changes, and because the plugin's own DOM reading was
 * already verified against the real window: probed `false` with the sidebar
 * expanded and `true` after clicking "Collapse sidebar".
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COLLAPSED_ATTRIBUTE } from '../../packages/layout-memory/src/client.js'

const root = join(import.meta.dirname, '..', '..')
const layoutClient = join(
  root, 'build', 'harness', 'node_modules',
  '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js',
)

describe.skipIf(!existsSync(layoutClient))('upstream layout surface', () => {
  const source = (): string => readFileSync(layoutClient, 'utf8')

  it('renders the collapsed state as the attribute the plugin reads', () => {
    expect(source()).toContain(`"${COLLAPSED_ATTRIBUTE}"`)
  })

  it('renders it only while collapsed, which is what makes presence the state', () => {
    // `sidebarCollapsed || void 0` is the form that omits the attribute when
    // expanded. If upstream ever renders `false` instead, presence stops
    // meaning collapsed and the plugin would read every launch as collapsed.
    expect(source()).toMatch(
      new RegExp(`"${COLLAPSED_ATTRIBUTE}":\\s*\\w+\\s*\\|\\|\\s*void 0`),
    )
  })

  it('still exposes toggleSidebar on the cross-plugin panel face', () => {
    // The plugin injects `layout` and calls this; there is no width setter and
    // no getter, so losing it leaves no route at all.
    expect(source()).toMatch(/toggleSidebar\(\)\s*\{/)
  })

  it('still routes the toggle by viewport width, which is what a restore must survive', () => {
    // EXISTENCE was never the fragile part. This assertion is here because the
    // three above passed while the feature was broken: 0.1.5 kept the attribute
    // and the method and changed WHEN and WHERE the toggle lands.
    //
    // The axis depends on a width that is not settled when a plugin first runs,
    // so an early toggle can flip `narrowExpanded` instead of the width. The
    // restore is a reconcile loop because of this line; if upstream ever makes
    // the toggle unconditional, the loop is doing needless work and the reason
    // written in `packages/layout-memory/src/client.ts` has gone stale.
    expect(source()).toMatch(/viewportWidth < 1024\)\s*\w+\.layoutInfo\.narrowExpanded = !/)
  })

  it('still clears narrowExpanded when the width crosses the boundary', () => {
    // The other half, and the one that actually erased the restore: a toggle
    // that landed on `narrowExpanded` is wiped by the first real resize. Losing
    // this line would not break the plugin, but it would mean the settle window
    // it waits out is no longer buying anything.
    expect(source()).toMatch(/!==\s*\w+\s*<\s*1024\)\s*\w+\.layoutInfo\.narrowExpanded = false/)
  })

  it('does not throw the readiness error the restore used to depend on', () => {
    // The restore was built on `panel actions not wired (root entry not
    // mounted)` being thrown until the layout root had rendered — a throw the
    // loop treated as "not yet". 0.1.5 removed the guard and the retry silently
    // stopped running. Asserted as an ABSENCE so that if upstream brings it
    // back, whoever reads this knows the loop could be simplified again.
    expect(source()).not.toContain('panel actions not wired')
  })

  it('covers the narrow layout with the same attribute', () => {
    // Wide collapses by width (`panels.sidebar === 0`), narrow by a separate
    // flag. Both must land on one attribute or the plugin remembers only one
    // of the two layouts.
    expect(source()).toMatch(/narrow\s*\?\s*!\w+\.narrowExpanded\s*:\s*\w+\.sidebar === 0/)
  })
})
