// @ts-check
/**
 * The band the plugin injects: the shipped stylesheet, the drag strip element
 * and its controls, inserted at the end of `<body>`.
 *
 * Split from the plugin entry and kept free of workspace imports, so unit
 * tests can import it from the repo root — the harness `@deepseek-ai/*`
 * packages only resolve inside the staged tree. Pure: everything it needs is
 * an argument, so a test states a band instead of staging an environment.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Read one shipped chrome asset. A `</style` or `</script` sequence inside it
 * would break out of its element, so a bad asset fails loudly at load rather
 * than serving a broken document.
 * @param {string} file - asset filename beside this module.
 * @returns {string} the asset text.
 */
function readAsset(file) {
  const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
  if (/<\/(?:style|script)/i.test(text)) {
    throw new Error(`desktop-chrome: ${file} contains a closing style/script tag`)
  }
  return text
}

/**
 * @typedef {object} TitleBand
 * @property {number} height - band height in CSS pixels; anything not above
 *   zero keeps the platform's own title bar and insets nothing.
 * @property {number} lead - leading space the platform's own controls occupy.
 * @property {boolean} menuButton - whether the band draws the menu button.
 */

/**
 * Read a band description down to values the stylesheet can carry. A field
 * that is not a usable number falls back to nothing rather than emitting
 * `NaNpx`, which would take the whole declaration with it.
 * @param {Partial<TitleBand>} band - the band as configured.
 * @returns {TitleBand} the same band, normalised.
 */
function normalise(band) {
  const px = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return { height: px(band.height), lead: px(band.lead), menuButton: band.menuButton === true }
}

/**
 * Build the chrome block appended to the served index document.
 * @param {Partial<TitleBand>} band - the band the launcher freed.
 * @returns {string} the `<style>` + `<script>` block.
 */
export function chromeBlock(band) {
  const { height, lead, menuButton } = normalise(band)
  // The served height is the fallback, not the value: a platform that draws a
  // real Window Controls Overlay reports its own geometry and the page script
  // publishes it as `--dsh-title-band-wco`. Going through a second property
  // keeps that inline write from outranking the fullscreen collapse, which is
  // a stylesheet rule and would lose to an inline style on the same element.
  const root = ':root{'
    + `--dsh-title-band:var(--dsh-title-band-wco,${String(height)}px);`
    + `--dsh-title-band-lead:${String(lead)}px;`
    // A platform whose menu bar is always on screen gets no menu button; the
    // rule is baked rather than published so it never appears and then blinks
    // out on a load.
    + `--dsh-title-menu-display:${menuButton ? 'inline-flex' : 'none'}`
    + '}'
  // Only a platform that floats its own window controls over the band reports
  // a `lead`, and only there does the sidebar's separator run up between them
  // — so the corrective sheet ships with that platform's band and nowhere
  // else, leaving every other border upstream's.
  const separator = lead > 0 ? readAsset('sidebar-separator.css') : ''
  return `<style data-dsh-desktop-chrome>${root}${readAsset('desktop-chrome.css')}${separator}</style>`
    + `<script data-dsh-desktop-chrome>${readAsset('desktop-chrome.js')}</script>`
}

/**
 * Append a built chrome block at the end of `<body>`.
 *
 * The body anchor is required: client plugin CSS is appended to `document.head`
 * at module materialization and would otherwise win the cascade at equal
 * specificity on document position.
 * @param {string} html - the served index document.
 * @param {string} block - the block from chromeBlock().
 * @returns {string} the document with the chrome block appended.
 */
export function injectDesktopChrome(html, block) {
  const close = html.lastIndexOf('</body>')
  if (close === -1) return `${html}${block}`
  return `${html.slice(0, close)}${block}${html.slice(close)}`
}
