// @ts-check
/**
 * @dsh-desktop/layout-memory node half — deliberately empty.
 *
 * The whole plugin is the browser half: whether the sidebar is collapsed is a
 * fact about the page's layout, read from the DOM and written to the renderer's
 * own storage, and the harness process can neither observe nor change it. The
 * row exists so the client module system serves `./client`, and so the
 * behaviour is part of the composition rather than something the shell patches
 * in.
 *
 * Not the launcher either, even though it owns the other remembered UI state
 * (`window-state.json`). Those are facts about the WINDOW — its bounds, whether
 * it is maximised. This is a fact about the page inside it, and CLAUDE.md's
 * ladder puts a plugin ahead of the launcher whenever a plugin can reach it.
 */

/** Stable Cordis plugin name. */
export const name = 'desktop-layout-memory'

/** No host services are touched. */
export const inject = []

/** Mount nothing; the browser half is the plugin. */
export function apply() {}
