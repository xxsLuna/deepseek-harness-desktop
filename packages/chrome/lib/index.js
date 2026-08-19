// @ts-check
/**
 * @dsh-desktop/chrome — the merged title band, as a plugin row of its own.
 *
 * The launcher can hide a window's native title bar, but only the served
 * document can fill the space it freed: the band is drawn by the UI, so the
 * columns run to the window top and the platform's own window controls float
 * over the page. That injection is this plugin, and nothing else.
 *
 * Every number here is a launcher decision — it is the process that hid, or
 * kept, the title bar, and on Windows it sizes the window-controls overlay
 * from the same values — so they arrive as config through the patch layer
 * rather than being read out of the environment here.
 */
import z from '@deepseek-ai/schemastery'
import { chromeBlock, injectDesktopChrome } from './block.js'

/** Stable Cordis plugin name. */
export const name = 'desktop-chrome'

export const inject = ['webServer']

/** @typedef {{ height: number, lead: number, menuButton: boolean }} Config */
export const Config = z.object({
  /** Band height in CSS pixels. Zero draws no band and insets nothing. */
  height: z.number().default(0),
  /** Leading space the platform's own window controls already occupy. */
  lead: z.number().default(0),
  /** Whether the band draws the menu button (where no native menu bar shows). */
  menuButton: z.boolean().default(false),
})

/**
 * Tap the served index with the band, when there is a band to serve.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Config} config - the band the launcher freed.
 */
export function apply(ctx, config) {
  // A platform that kept its title bar composes this row all the same; it just
  // has nothing to inject, and injecting an empty band would still cost every
  // index response a rewrite.
  if (!(config.height > 0)) return

  // Served with the document so the band is present before the renderer parses
  // anything — no flash — and it survives every reload, because the fallback
  // owner re-runs its taps per index response.
  const block = chromeBlock(config)
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => injectDesktopChrome(html, block)),
    'desktop-chrome: index tap',
  )
}
