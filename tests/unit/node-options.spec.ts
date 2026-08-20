/**
 * The NODE_OPTIONS rule that carries the hidden-console preload downward.
 *
 * This is the half of the Windows console fix that actually matters, and it had
 * no test at all. On Windows the shell is started by the ACL sandbox in a
 * separate runner process, so hiding the console in the sidecar alone changes
 * nothing — NODE_OPTIONS is how the preload reaches the process that spawns the
 * shell. A rule that silently stops appending, or appends twice, brings the
 * flashing window back with nothing failing.
 */
import { describe, expect, it } from 'vitest'
import { withPreload } from '../../packages/bundle/lib/node-options.mjs'

/** What the launcher actually passes: a percent-encoded file URL. */
const PRELOAD = 'file:///C:/Program%20Files/DeepSeek%20Harness%20Desktop/resources/harness/node_modules/@dsh-desktop/bundle/lib/hide-console.mjs'

describe('withPreload', () => {
  it('sets the flag when nothing is inherited', () => {
    expect(withPreload(undefined, PRELOAD)).toBe(`--import ${PRELOAD}`)
    expect(withPreload('', PRELOAD)).toBe(`--import ${PRELOAD}`)
  })

  it('appends to an existing value instead of replacing it', () => {
    // The staging install sets --max-old-space-size, and a user may set their
    // own; dropping theirs to add ours would be a different bug entirely.
    expect(withPreload('--max-old-space-size=4096', PRELOAD))
      .toBe(`--max-old-space-size=4096 --import ${PRELOAD}`)
  })

  it('is idempotent, so a process tree does not grow the value once per level', () => {
    // Every descendant inherits the variable and runs this same rule. Without
    // the guard the value gains one --import per generation, and NODE_OPTIONS
    // has a length limit that a deep tree would eventually hit.
    const once = withPreload(undefined, PRELOAD)
    expect(withPreload(once, PRELOAD)).toBe(once)
    expect(withPreload(withPreload(once, PRELOAD), PRELOAD)).toBe(once)
  })

  it('leaves an unrelated --import alone', () => {
    // The guard keys on the URL, not on the flag: something else may legitimately
    // preload, and matching the flag would skip our append and lose the fix.
    const theirs = '--import file:///opt/instrument.mjs'
    expect(withPreload(theirs, PRELOAD)).toBe(`${theirs} --import ${PRELOAD}`)
  })

  it('does not quote, and does not let a space reach the value', () => {
    // NODE_OPTIONS is split on whitespace and cannot be quoted. The installed
    // app lives under "DeepSeek Harness Desktop", so a raw path would arrive as
    // three arguments — which is why the caller passes a file URL and this rule
    // adds no quoting of its own.
    const value = withPreload(undefined, PRELOAD)
    expect(value).not.toContain('"')
    expect(value).not.toContain("'")
    expect(value.split(' ')).toEqual(['--import', PRELOAD])
  })

  it('normalises stray whitespace rather than emitting an empty argument', () => {
    // An inherited value with padding would otherwise produce a double space,
    // which Node reads as an empty argument and rejects outright.
    expect(withPreload('  --max-old-space-size=4096  ', PRELOAD))
      .toBe(`--max-old-space-size=4096 --import ${PRELOAD}`)
    expect(withPreload('   ', PRELOAD)).toBe(`--import ${PRELOAD}`)
  })
})
