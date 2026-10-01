/**
 * Which ways the window's history can move, from its position in that history.
 *
 * Its own module, with nothing imported, and that is not tidiness. The rule
 * belongs beside the route that uses it in `desktop-host.ts` — but that file
 * reaches `electron` through `./menu.js`, so a unit spec importing it loads the
 * Electron module and triggers its install check. Two specs doing that at once
 * raced the binary download on CI and failed with
 * `failed to create directory 'electron/dist/Electron.app': File exists`, which
 * reads like a broken test and is really two processes unpacking one archive.
 *
 * A pure rule with no imports can be tested without any of that.
 */

/**
 * Which ways a history of `length` entries, sitting at `index`, can move.
 *
 * Derived from the position rather than asked of Electron, and that is a fix
 * rather than a preference. **`navigationHistory.canGoBack()` answers false at
 * every index on Electron 44**, measured against the real binary with the rest
 * of the same object correct beside it:
 *
 *     entries=3 index=2 back=false forward=false
 *     entries=3 index=1 back=false forward=true
 *     entries=3 index=0 back=false forward=true
 *
 * `length()`, `getActiveIndex()` and `canGoForward()` all track exactly; only
 * `canGoBack()` does not see same-document entries. Since this app's history is
 * ENTIRELY same-document — upstream's UI is one page and
 * `@dsh-desktop/session-history` records session moves with `pushState` — that
 * one wrong answer kept the back control dimmed and inert for every history
 * this window will ever have.
 * @param index - the active entry's index, from `getActiveIndex()`.
 * @param length - the number of entries, from `length()`.
 * @returns the space-separated ways, as the band's CSS reads them.
 */
export function navigationWays(index: number, length: number): string {
  return [index > 0 ? 'back' : '', index < length - 1 ? 'forward' : ''].join(' ').trim()
}
