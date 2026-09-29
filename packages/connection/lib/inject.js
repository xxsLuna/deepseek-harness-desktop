// @ts-check
/**
 * The transport block the plugin injects, and where in the document it goes.
 *
 * Split from the plugin entry and kept free of workspace imports, for the same
 * reason `@dsh-desktop/chrome` splits its own block builder: unit tests import
 * this from the repo root, where the harness `@deepseek-ai/*` packages do not
 * resolve. Pure apart from reading the built asset, so a test states a
 * document instead of staging an environment.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Attribute naming the injected element, so a served page can be read back. */
export const TRANSPORT_MARKER = 'data-dsh-desktop-transport'

/**
 * Read the built transport IIFE.
 *
 * A `</script` sequence inside it would break out of the element, so a bad
 * build fails loudly here rather than serving a document that parses into
 * something else. esbuild will not emit one from this source, which is the
 * point: the guard is against the day the source changes.
 * @returns {string} the script text.
 */
function readTransport() {
  const text = readFileSync(fileURLToPath(new URL('transport.js', import.meta.url)), 'utf8')
  if (/<\/script/i.test(text)) {
    throw new Error('desktop-connection: transport.js contains a closing script tag')
  }
  return text
}

/**
 * Build the block installing `globalThis.__DSH_TRANSPORT__`.
 * @returns {string} the `<script>` element to inject.
 */
export function transportBlock() {
  return `<script ${TRANSPORT_MARKER}>${readTransport()}</script>`
}

/**
 * Insert the transport block at the very top of `<head>`.
 *
 * **The position is the contract, not a preference.** Upstream's boot protocol
 * injects its own head rows — the `__ModuleLoader__` queue script, the
 * blocking bootstrap `<script src>` batch, and the `__DSH_BOOT__` graph — and
 * upstream states where a carrier override belongs: "installed on the page
 * global before plugin boot". Going in first satisfies that by position, which
 * is the whole reason this is a document injection rather than a client plugin
 * row. A row would have to win an evaluation-order argument instead, and the
 * previous shape of this package lost one.
 *
 * Head, specifically, rather than the end of `<body>` that `@dsh-desktop/chrome`
 * uses: that one is placed last on purpose so its stylesheet outranks plugin
 * CSS, and this one is placed first for the mirror-image reason.
 *
 * A document with no `<head>` gets the block prepended — no upstream row could
 * have run either way, and a served index without a head is a broken build,
 * not a case to serve differently.
 * @param {string} html - the served index document.
 * @param {string} block - the block from transportBlock().
 * @returns {string} the document with the transport installed first.
 */
export function injectTransport(html, block) {
  const open = /<head[^>]*>/i.exec(html)
  if (open === null) return `${block}${html}`
  const at = open.index + open[0].length
  return `${html.slice(0, at)}${block}${html.slice(at)}`
}
