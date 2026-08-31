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

  it('covers the narrow layout with the same attribute', () => {
    // Wide collapses by width (`panels.sidebar === 0`), narrow by a separate
    // flag. Both must land on one attribute or the plugin remembers only one
    // of the two layouts.
    expect(source()).toMatch(/narrow\s*\?\s*!\w+\.narrowExpanded\s*:\s*\w+\.sidebar === 0/)
  })
})
