/**
 * The rule that sets this plugin's settings-nav entry apart from upstream's.
 *
 * Its own module, with no React import, so a unit test can assert the selectors
 * without resolving the staged harness's react.
 *
 * Why CSS at all, rather than something the slot system offers: the slot
 * contract has no separator or group concept — SlotRegistry in
 * @deepseek-ai/dsh-client-runtime takes name/id/order/label and nothing about
 * drawing — and the nav buttons carry no data attribute to hook.
 *
 * Why not render it from the section component: the shell mounts only the
 * ACTIVE panel, so a <style> in our component would exist only while our own
 * tab is selected, which is exactly when the divider above it matters least.
 * `apply` runs once at boot instead, and the rule is in the document before the
 * settings dialog is ever opened.
 *
 * The selector has an authored half and a hashed half, deliberately in that
 * order. `[data-slot='sidebar.settings']` is the slot renderer's own outlet
 * anchor — a real attribute, not a build artefact, and `display: contents` so it
 * affects nothing but matching. It scopes the rule to the settings shell, so a
 * `navList`-ish class anywhere else in the app cannot pick it up.
 *
 * `[class*=…]` rather than the literal class, because those are CSS-module
 * locals (`VOzbGW_navCell` in @deepseek-ai/dsh-client-ui-settings-general) whose
 * prefix is a content hash that moves whenever upstream edits that stylesheet.
 * Matching the local NAME survives a rehash; a rename still breaks it silently,
 * which is why tests/contract asserts both locals still exist. This is the same
 * technique — and the same pinning — @dsh-desktop/chrome already uses for
 * `[class*='_detailsCol']`.
 *
 * `:last-child` is this section: upstream's own sections register at order 0
 * (General), 10 (Models), 15 (Plugins) and 20 (Agent presets) while this one
 * registers at 100, so the line falls between Agent presets and Desktop
 * Settings — the seam it is meant to draw. The nav is not a slot outlet; the
 * shell maps its own projected rows, and that projection keeps only id, order
 * and label. `registrant` never reaches the DOM and neither does `id`, so there
 * is nothing on the button that says "desktop" to match instead.
 *
 * Rejected alternative, since it looks more precise than it is: the Agent
 * presets glyph emits an authored `<mask id='mask0_agent_preset_16'>`, so
 * `button:has(#mask0_agent_preset_16) + button` would name the entry BELOW Agent
 * presets semantically rather than positionally. But that id is an icon-export
 * artefact — the numeric suffix is exactly what a re-export renumbers — so it
 * trades a documented, test-guarded assumption for an undocumented one that is
 * likelier to move.
 *
 * The line is a pseudo-element in the gap rather than a border on the button.
 * The buttons are 12px-rounded and paint a background on hover and when active,
 * so a border of their own would round with them and slide under that fill.
 * Geometry: the nav is a flex column with a 4px gap, and 8px of margin makes
 * that 12px, so -6px puts the line on the centre line between the two entries.
 * The colour is the same `currentColor` mix the section's own rows use, so it
 * reads as one treatment and follows either theme without naming a colour.
 */
export const navDividerCss = `
[data-slot='sidebar.settings'] [class*='navList'] > [class*='navCell']:last-child {
  position: relative;
  margin-top: 8px;
}
[data-slot='sidebar.settings'] [class*='navList'] > [class*='navCell']:last-child::before {
  content: '';
  position: absolute;
  inset: -6px 0 auto;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
`

/** The upstream CSS-module locals this rule matches on; asserted by the contract suite. */
export const MATCHED_LOCALS = ['navList', 'navCell'] as const

/** The slot whose outlet anchor scopes the rule; also asserted by the contract suite. */
export const SCOPING_SLOT = 'sidebar.settings'

/** The upstream package whose stylesheet owns {@link MATCHED_LOCALS}. */
export const LOCALS_OWNER = '@deepseek-ai/dsh-client-ui-settings-general'
