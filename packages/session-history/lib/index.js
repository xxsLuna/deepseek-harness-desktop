// @ts-check
/**
 * @dsh-desktop/session-history node half — deliberately empty.
 *
 * The whole plugin is the browser half. Which session the user is looking at is
 * a fact about the page, and the history it should leave behind is the
 * renderer's own session history — neither is reachable from the harness
 * process.
 *
 * Not the launcher either, though the launcher is what USES the result: it
 * already listens for `did-navigate-in-page` and drives the band's buttons from
 * `webContents.navigationHistory` (src/window.ts, src/desktop-host.ts). That
 * half was complete and correct before this package existed. What was missing
 * is that nothing in the page ever created an entry for it to walk, and only a
 * client plugin can fix that.
 */

/** Stable Cordis plugin name. */
export const name = 'desktop-session-history'

/** No host services are touched. */
export const inject = []

/** Mount nothing; the browser half is the plugin. */
export function apply() {}
