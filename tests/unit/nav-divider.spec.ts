/**
 * The settings-nav divider rule.
 *
 * A stylesheet cannot be unit-tested for appearance, so what is asserted here is
 * the part that silently rots: WHICH selectors it reaches upstream with. The rule
 * was verified against the running app once — the line lands between Agent
 * presets and Desktop Settings, and no other nav entry picks up a border — and
 * these assertions keep an edit from quietly undoing that.
 */
import { describe, expect, it } from 'vitest'
import { LOCALS_OWNER, MATCHED_LOCALS, SCOPING_SLOT, navDividerCss } from '../../packages/settings/src/nav-divider.js'

/** The rule's selector lines: the ones naming a nav cell. */
const selectorLines = navDividerCss.split('\n').filter((line) => line.includes('navCell'))

describe('navDividerCss', () => {
  it('matches the CSS-module local by name, never by its hashed class', () => {
    // The literal class is `VOzbGW_navCell`, and that prefix is a content hash
    // that moves whenever upstream edits the stylesheet. Baking one in would
    // work until the next upstream release and then fail with no error at all.
    expect(navDividerCss).not.toMatch(/[A-Za-z0-9]{6}_nav/)
    for (const local of MATCHED_LOCALS) {
      expect(navDividerCss).toContain(`[class*='${local}']`)
    }
  })

  it('anchors on an authored attribute before reaching for a hashed class', () => {
    // data-slot is emitted by the slot renderer itself, so it is a real
    // attribute rather than a build artefact. Every rule leads with it, and that
    // is what stops the hashed half matching outside the settings shell.
    expect(selectorLines.length).toBeGreaterThan(0)
    for (const line of selectorLines) {
      expect(line.trimStart().startsWith(`[data-slot='${SCOPING_SLOT}']`), line).toBe(true)
    }
  })

  it('draws on the last nav entry only, which is this plugin at order 100', () => {
    // Upstream registers its sections at 0 (General), 10 (Models), 15 (Plugins)
    // and 20 (Agent presets); this one at 100, so :last-child is the Desktop
    // Settings entry and the line falls above it.
    expect(navDividerCss).toContain(':last-child')
    // Direct children of the nav list, so a navCell-ish class nested deeper
    // cannot pick the rule up.
    expect(navDividerCss).toMatch(/\[class\*='navList'\]\s*>\s*\[class\*='navCell'\]/)
  })

  it('draws in the gap with a pseudo-element rather than a border on the button', () => {
    // The buttons are 12px-rounded and fill on hover and when active, so their
    // own border would round with them and slide under that fill.
    expect(navDividerCss).toContain('::before')
    expect(navDividerCss).toContain("content: ''")
    // The nav is a flex column with a 4px gap; 8px of margin makes that 12px,
    // and -6px is its centre line.
    expect(navDividerCss).toContain('margin-top: 8px')
    expect(navDividerCss).toContain('inset: -6px 0 auto')
  })

  it('names no colour, so it follows both themes', () => {
    // The app ships a light theme and a dark one. The section's own rows use
    // this exact mix, so the divider reads as the same treatment in either.
    expect(navDividerCss).toContain('color-mix(in srgb, currentColor 12%, transparent)')
    expect(navDividerCss).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i)
  })

  it('records the upstream seams the contract suite has to pin', () => {
    expect(LOCALS_OWNER).toBe('@deepseek-ai/dsh-client-ui-settings-general')
    expect([...MATCHED_LOCALS]).toEqual(['navList', 'navCell'])
    expect(SCOPING_SLOT).toBe('sidebar.settings')
  })
})
