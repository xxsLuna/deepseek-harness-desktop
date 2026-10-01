/**
 * Which ways the band's controls may move, from the history's position.
 *
 * This exists because the obvious implementation was wrong in a way nothing
 * reported. `navigationHistory.canGoBack()` answers **false at every index** on
 * Electron 44 — measured against the real binary, with the rest of the same
 * object correct beside it:
 *
 *     entries=3 index=2 back=false forward=false
 *     entries=3 index=1 back=false forward=true
 *     entries=3 index=0 back=false forward=true
 *
 * The back control was therefore dimmed and inert for every history this window
 * can have, because this app's history is entirely same-document. No error, no
 * log line — just a button that never lit. Deriving from `getActiveIndex()` and
 * `length()`, which do track, is the fix, and a pure function is the only place
 * that fix can be held.
 */
import { describe, expect, it } from 'vitest'
import { navigationWays } from '../../src/desktop-host.js'

describe('navigationWays', () => {
  it('offers nothing for a history of one', () => {
    // A freshly opened window, before any session has been moved to.
    expect(navigationWays(0, 1)).toBe('')
  })

  it('offers back from the newest entry', () => {
    // The case the bug swallowed: standing at the end of a trail the user just
    // walked, with somewhere to go back to and no way to click it.
    expect(navigationWays(1, 2)).toBe('back')
    expect(navigationWays(2, 3)).toBe('back')
  })

  it('offers forward from the oldest entry', () => {
    expect(navigationWays(0, 2)).toBe('forward')
    expect(navigationWays(0, 3)).toBe('forward')
  })

  it('offers both from the middle', () => {
    // Order matters only in that the CSS matches with `~=`, which is
    // whitespace-separated; this keeps the attribute readable in a dump.
    expect(navigationWays(1, 3)).toBe('back forward')
  })

  it('offers nothing for an empty history', () => {
    // `getActiveIndex()` reports -1 before the first commit. Neither arm may
    // claim a way to move from a history that has no entries.
    expect(navigationWays(-1, 0)).toBe('')
  })
})
