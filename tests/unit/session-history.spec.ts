/**
 * The rule that decides what moving between sessions leaves behind.
 *
 * Worth isolating because every way of getting it wrong is quiet. Too many
 * entries and "back" appears dead until the user has pressed it as many times
 * as the session happened to re-render; one too few and the first "back" walks
 * off the app's own first screen; one in the wrong direction and the history
 * grows as you walk it, so forward is never reachable.
 *
 * None of those throws, and none of them is visible in a screenshot — which is
 * why the decision lives in a pure function rather than inside the effect.
 */
import { describe, expect, it } from 'vitest'
import { historyAction, ownEntry, sessionIdOf } from '../../packages/session-history/src/client.js'

describe('historyAction', () => {
  it('replaces for the first session, because that is where the user already is', () => {
    // Pushing here would mean the window arrived somewhere it had navigated to.
    // It did not: this is the first thing it showed, and "back" from it should
    // have nowhere to go rather than a bare document.
    expect(historyAction({ shown: 'session-a', recorded: undefined })).toBe('replace')
  })

  it('pushes a different session, which is the whole feature', () => {
    expect(historyAction({ shown: 'session-b', recorded: 'session-a' })).toBe('push')
  })

  it('does nothing when the same session is reported again', () => {
    // The binding source fires on re-render, not only on change. Stacking a
    // duplicate entry per render is the failure that makes the button look
    // broken while working perfectly.
    expect(historyAction({ shown: 'session-a', recorded: 'session-a' })).toBe('none')
  })

  it('does nothing before any session is shown', () => {
    // The window opens before a session is chosen, and an entry naming nothing
    // is one the walk cannot act on.
    expect(historyAction({ shown: undefined, recorded: undefined })).toBe('none')
    expect(historyAction({ shown: undefined, recorded: 'session-a' })).toBe('none')
  })
})

describe('ownEntry', () => {
  it('accepts an entry this plugin wrote', () => {
    const state = { dshDesktopSessionHistory: true, sessionId: 'session-a' }
    expect(ownEntry(state)?.sessionId).toBe('session-a')
  })

  it('refuses a state that merely looks similar', () => {
    // The marker is checked rather than the shape, because the page is a
    // composition: another plugin pushing `{ sessionId }` for its own purpose
    // must not have this one hijack its entries.
    expect(ownEntry({ sessionId: 'session-a' })).toBeUndefined()
    expect(ownEntry({ dshDesktopSessionHistory: true })).toBeUndefined()
  })

  it('refuses the states a fresh document actually has', () => {
    // `history.state` is null until something writes it, and these are what the
    // walk sees on entries nobody claimed.
    expect(ownEntry(null)).toBeUndefined()
    expect(ownEntry(undefined)).toBeUndefined()
    expect(ownEntry('session-a')).toBeUndefined()
  })
})

describe('sessionIdOf', () => {
  it('reads `key`, which is where the materialized binding puts the id', () => {
    // `{ key: binding.sessionId, ctx, hooks, keyedHooks, props }` is the shape
    // upstream materializes. Reading `sessionId` alone found nothing, recorded
    // nothing, and threw nothing — the silence this package exists to end.
    expect(sessionIdOf({ key: 'session-a', ctx: {}, hooks: {}, props: {} })).toBe('session-a')
  })

  it('still reads `sessionId`, the name on the binding itself', () => {
    expect(sessionIdOf({ sessionId: 'session-a', title: 'anything else' })).toBe('session-a')
  })

  it('prefers `key` when a snapshot carries both', () => {
    // They name the same session in every shape seen so far. If they ever
    // disagree, `key` is the one the renderer keys by, so it is the one a
    // history entry should follow.
    expect(sessionIdOf({ key: 'session-a', sessionId: 'session-b' })).toBe('session-a')
  })

  it('treats a snapshot that names no session as naming none', () => {
    // Upstream's binding carries a whole session view and this needs one field.
    // A shape that loses that field should leave the history alone rather than
    // throw into the plugin tree, where one failed entry rejects the whole
    // composition.
    expect(sessionIdOf({})).toBeUndefined()
    expect(sessionIdOf({ sessionId: '' })).toBeUndefined()
    expect(sessionIdOf({ sessionId: 42 })).toBeUndefined()
    // The absent binding is a real state, not a corner case: `materializeAbsent`
    // returns `{ key: undefined, … }` before any session is chosen, and it is
    // what the plugin sees on its very first read.
    expect(sessionIdOf({ key: undefined, hooks: {}, props: {} })).toBeUndefined()
    expect(sessionIdOf(null)).toBeUndefined()
    expect(sessionIdOf(undefined)).toBeUndefined()
  })
})
