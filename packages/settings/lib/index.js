// @ts-check
/**
 * @dsh-desktop/settings node half — deliberately empty.
 *
 * Everything this plugin does happens in the browser: it registers one
 * `settings.section` entry and talks to the LAUNCHER, not the sidecar, because
 * every preference it shows is a window/tray/updater fact the harness process
 * cannot read or change. The row exists so the client module system serves
 * `./client`, and so the section is part of the composition rather than
 * something the shell special-cases.
 */

/** Stable Cordis plugin name. */
export const name = 'desktop-settings'

/** No host services are touched. */
export const inject = []

/** Mount nothing; the browser half is the plugin. */
export function apply() {}
