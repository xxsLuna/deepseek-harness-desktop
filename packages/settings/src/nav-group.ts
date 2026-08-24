/**
 * The rule that groups this plugin's settings-nav entries under one heading.
 *
 * Its own module, with no React import, so a unit test can assert the selectors
 * without resolving the staged harness's react.
 *
 * It began as a single divider line above one entry. There are three entries
 * now — Desktop Settings, Shortcuts, Usage — and a line above the first of them
 * says only "something changes here"; a heading says what the three have in
 * common, which is that they are the launcher's rather than the harness's.
 *
 * Why CSS at all, rather than something the slot system offers: the slot
 * contract has no separator or group concept — SlotRegistry in
 * @deepseek-ai/dsh-client-runtime takes name/id/order/label and nothing about
 * drawing — and the nav buttons carry no data attribute to hook.
 *
 * Why not render it from the section component: the shell mounts only the
 * ACTIVE panel, so a <style> in our component would exist only while one of our
 * own tabs is selected, which is exactly when the heading above it matters
 * least. `apply` runs once at boot instead, and the rule is in the document
 * before the settings dialog is ever opened.
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
 * `:nth-last-child(N)` counts from the END, which is what makes this robust to
 * the thing most likely to change. Upstream's own sections register at order 0
 * (General), 10 (Models), 15 (Plugins) and 20 (Agent presets) while these
 * register above 100, so ours are always the last {@link DESKTOP_SECTIONS}
 * entries — and upstream adding a fifth section of its own shifts nothing,
 * where counting from the front would have moved the heading onto its row. The
 * nav is not a slot outlet; the shell maps its own projected rows, and that
 * projection keeps only id, order and label. `registrant` never reaches the DOM
 * and neither does `id`, so there is nothing on the button that says "desktop"
 * to match instead.
 *
 * The heading is a pseudo-element in the gap above the first entry rather than
 * anything on the button itself. The buttons are 12px-rounded and paint a
 * background on hover and when active, so text of their own would sit inside
 * that fill and highlight along with the row.
 *
 * `content: 'Desktop' / ''` is the important half of that declaration. Generated
 * content counts toward an element's accessible name, so without the empty
 * alternative text the first row would announce as "Desktop Desktop Settings".
 * The slash form is CSS Generated Content alt text, supported in Chromium, and
 * this only ever runs in Electron.
 */

/**
 * The settings sections this plugin registers, in nav order.
 *
 * The single source of truth for both the slot registrations and the CSS: the
 * heading is placed by counting back from the end of the nav, so adding a
 * section without updating this list would leave the heading one row too low.
 * The unit test asserts the count in the selector matches this array's length.
 */
export const DESKTOP_SECTIONS = [
  { id: 'desktop', order: 100, label: 'Desktop Settings' },
  { id: 'desktop-shortcuts', order: 101, label: 'Shortcuts' },
  { id: 'desktop-usage', order: 102, label: 'Usage' },
] as const

/** The heading drawn above the first of them. */
export const GROUP_LABEL = 'Desktop'

/** The nav rule: a shaded group heading above this plugin's entries. */
export const navGroupCss = `
[data-slot='sidebar.settings'] [class*='navList'] > [class*='navCell']:nth-last-child(${DESKTOP_SECTIONS.length}) {
  position: relative;
  margin-top: 26px;
}
[data-slot='sidebar.settings'] [class*='navList'] > [class*='navCell']:nth-last-child(${DESKTOP_SECTIONS.length})::before {
  content: '${GROUP_LABEL}' / '';
  position: absolute;
  inset: -20px 0 auto;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: color-mix(in srgb, currentColor 55%, transparent);
  pointer-events: none;
}
`

/** The upstream CSS-module locals this rule matches on; asserted by the contract suite. */
export const MATCHED_LOCALS = ['navList', 'navCell'] as const

/** The slot whose outlet anchor scopes the rule; also asserted by the contract suite. */
export const SCOPING_SLOT = 'sidebar.settings'

/** The upstream package whose stylesheet owns {@link MATCHED_LOCALS}. */
export const LOCALS_OWNER = '@deepseek-ai/dsh-client-ui-settings-general'
