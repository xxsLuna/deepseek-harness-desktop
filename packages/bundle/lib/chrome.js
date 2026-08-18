// @ts-check
/**
 * The desktop-chrome index tap: the shipped title-band stylesheet, the drag
 * strip element, and the band-height wiring, inserted at the end of `<body>`.
 *
 * Kept free of workspace imports so unit tests can import it from the repo
 * root — the harness `@deepseek-ai/*` packages only resolve inside the staged
 * tree.
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
 * The band height this launch serves. The launcher owns the decision (it is the
 * process that hid, or kept, the native title bar) and passes it in the
 * sidecar's environment; anything other than `merged` means the platform draws
 * its own title bar, so the UI must not be inset.
 * @returns {string} a CSS length.
 */
function bandHeight() {
  return process.env.DSH_DESKTOP_TITLE_BAND === 'merged' ? '38px' : '0px'
}

/**
 * Build the chrome block appended to the served index document.
 * @returns {string} the `<style>` + `<script>` block.
 */
export function chromeBlock() {
  const root = `:root{--dsh-title-band:${bandHeight()}}`
  return `<style data-dsh-desktop-chrome>${root}${readAsset('desktop-chrome.css')}</style>`
    + `<script data-dsh-desktop-chrome>${readAsset('desktop-chrome.js')}</script>`
}

/**
 * Append the chrome block at the end of `<body>`.
 *
 * The body anchor is required: client plugin CSS is appended to `document.head`
 * at module materialization and would otherwise win the cascade at equal
 * specificity on document position.
 * @param {string} html - the served index document.
 * @returns {string} the document with the chrome block appended.
 */
export function injectDesktopChrome(html) {
  const block = chromeBlock()
  const close = html.lastIndexOf('</body>')
  if (close === -1) return `${html}${block}`
  return `${html.slice(0, close)}${block}${html.slice(close)}`
}
