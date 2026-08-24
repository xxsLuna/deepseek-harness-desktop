/**
 * The settings-nav group heading.
 *
 * A stylesheet cannot be unit-tested for appearance, so what is asserted here is
 * the part that silently rots: WHICH selectors it reaches upstream with, and
 * whether the count it uses still matches the sections actually registered.
 */
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SECTIONS,
  GROUP_LABEL,
  LOCALS_OWNER,
  MATCHED_LOCALS,
  SCOPING_SLOT,
  navGroupCss,
} from '../../packages/settings/src/nav-group.js'

/** The rule's selector lines: the ones naming a nav cell. */
const selectorLines = navGroupCss.split('\n').filter((line) => line.includes('navCell'))

describe('navGroupCss', () => {
  it('matches the CSS-module local by name, never by its hashed class', () => {
    // The literal class is `VOzbGW_navCell`, and that prefix is a content hash
    // that moves whenever upstream edits the stylesheet. Baking one in would
    // work until the next upstream release and then fail with no error at all.
    expect(navGroupCss).not.toMatch(/[A-Za-z0-9]{6}_nav/)
    for (const local of MATCHED_LOCALS) {
      expect(navGroupCss).toContain(`[class*='${local}']`)
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

  it('counts back from the end by exactly the number of sections registered', () => {
    // The one assertion that catches the likely mistake: adding a fourth
    // desktop section and leaving the heading pinned above the second of them.
    // Counting from the END also means upstream adding a section of its own
    // shifts nothing, where counting from the front would move the heading onto
    // an upstream row.
    expect(DESKTOP_SECTIONS.length).toBeGreaterThan(0)
    expect(navGroupCss).toContain(`:nth-last-child(${DESKTOP_SECTIONS.length})`)
    expect(navGroupCss).not.toMatch(/:nth-child\(/)
    // Direct children of the nav list, so a navCell-ish class nested deeper
    // cannot pick the rule up.
    expect(navGroupCss).toMatch(/\[class\*='navList'\]\s*>\s*\[class\*='navCell'\]/)
  })

  it('registers its sections above every upstream order, so they stay last', () => {
    // Upstream registers at 0 (General), 10 (Models), 15 (Plugins) and 20
    // (Agent presets). :nth-last-child only names our rows while ours sort
    // after all of those.
    for (const section of DESKTOP_SECTIONS) expect(section.order).toBeGreaterThan(20)
    const orders = DESKTOP_SECTIONS.map((section) => section.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    expect(new Set(orders).size).toBe(orders.length)
    expect(new Set(DESKTOP_SECTIONS.map((s) => s.id)).size).toBe(DESKTOP_SECTIONS.length)
  })

  it('draws the heading in the gap, not on the button', () => {
    // The buttons are 12px-rounded and fill on hover and when active, so text
    // of their own would sit inside that fill and highlight with the row.
    expect(navGroupCss).toContain('::before')
    expect(navGroupCss).toContain(`content: '${GROUP_LABEL}' / ''`)
    expect(navGroupCss).toContain('pointer-events: none')
    // Room made above, and the label placed in it.
    expect(navGroupCss).toContain('margin-top: 26px')
    expect(navGroupCss).toContain('inset: -20px 0 auto')
  })

  it('gives the heading empty alternative text, so it is not read as part of the row', () => {
    // Generated content counts toward the accessible name. Without the `/ ''`
    // the first row announces as "Desktop Desktop Settings".
    expect(navGroupCss).toMatch(/content:\s*'[^']+'\s*\/\s*''/)
  })

  it('names no colour, so it follows both themes', () => {
    // The app ships a light theme and a dark one, and the section's own group
    // titles use this same treatment, so the nav heading reads as one with them.
    expect(navGroupCss).toContain('color-mix(in srgb, currentColor 55%, transparent)')
    expect(navGroupCss).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i)
  })

  it('records the upstream seams the contract suite has to pin', () => {
    expect(LOCALS_OWNER).toBe('@deepseek-ai/dsh-client-ui-settings-general')
    expect([...MATCHED_LOCALS]).toEqual(['navList', 'navCell'])
    expect(SCOPING_SLOT).toBe('sidebar.settings')
  })
})
