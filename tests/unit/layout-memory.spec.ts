/**
 * The sidebar-memory decision rules.
 *
 * The DOM reading and the toggle cannot be unit-tested without standing up
 * upstream's layout, so what is asserted here is the part with a rule in it:
 * what a stored value means, and when a toggle is warranted. Both are places a
 * wrong answer is invisible — the sidebar simply opens wrong, or opens right
 * and then flips itself.
 *
 * The facts these rules sit on were measured against the running app, not read
 * off the source: `data-sidebar-collapsed` is present only while collapsed
 * (probed at `false` expanded, `true` after clicking "Collapse sidebar"), and
 * the frame carries no attribute of its own while expanded.
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAPSED_ATTRIBUTE,
  parseStored,
  shouldToggle,
  STORAGE_KEY,
} from '../../packages/layout-memory/src/client.js'

describe('parseStored', () => {
  it('reads the two values it writes', () => {
    expect(parseStored('true')).toBe(true)
    expect(parseStored('false')).toBe(false)
  })

  it('treats nothing stored as no preference, not as expanded', () => {
    // The difference matters on first launch: `false` would be a preference
    // and would make this plugin assert upstream's default rather than defer
    // to it. Only `undefined` leaves the layout alone.
    expect(parseStored(null)).toBeUndefined()
  })

  it('treats anything unrecognised as no preference', () => {
    // A value written by some other version of this key must not be guessed
    // at — a wrong guess collapses a sidebar the user never collapsed.
    for (const raw of ['', '1', 'TRUE', 'collapsed', '{}']) {
      expect(parseStored(raw), raw).toBeUndefined()
    }
  })
})

describe('shouldToggle', () => {
  it('toggles only when the remembered state differs', () => {
    expect(shouldToggle(true, false)).toBe(true)
    expect(shouldToggle(false, true)).toBe(true)
  })

  it('leaves a matching state alone, so launch does not flicker', () => {
    expect(shouldToggle(true, true)).toBe(false)
    expect(shouldToggle(false, false)).toBe(false)
  })

  it('never toggles without a preference', () => {
    // First launch, or storage that refused to answer: upstream's default is
    // the right answer and touching it would be a regression for every user
    // who never collapsed anything.
    expect(shouldToggle(undefined, false)).toBe(false)
    expect(shouldToggle(undefined, true)).toBe(false)
  })
})

describe('the constants', () => {
  it('names the attribute upstream actually renders', () => {
    // Upstream spells it on the frame div as `data-sidebar-collapsed`. A rename
    // there makes this plugin read "always expanded" and persist that over the
    // user's real preference, with no error anywhere — so the string is pinned
    // here and the contract test boots the real thing.
    expect(COLLAPSED_ATTRIBUTE).toBe('data-sidebar-collapsed')
  })

  it('keeps the storage key stable', () => {
    // Changing it silently forgets everyone's preference once.
    expect(STORAGE_KEY).toBe('dsh-desktop.sidebar-collapsed')
  })
})
