/**
 * The crash-loop budget and the page-load retry budget.
 *
 * Both exist because the unbounded versions are indistinguishable from a hang.
 * The incident: a sidecar that threw on `~/.dsh/.credentials.yaml` exited about
 * 2.6s after every spawn, the crash handler spawned another every time, and
 * the window sat on a spinner for six days with the reason nowhere.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RESTART_POLICY,
  recentExits,
  reloadDelayMs,
  RELOAD_POLICY,
  shouldRestart,
} from '../../src/restart-policy.js'

/** The observed crash-loop period, in ms. */
const LOOP_PERIOD = 2_600

/** Exit timestamps for a sidecar looping every LOOP_PERIOD up to `now`. */
const loop = (count: number, now: number): number[] =>
  Array.from({ length: count }, (_, i) => now - (count - 1 - i) * LOOP_PERIOD)

describe('shouldRestart', () => {
  it('restarts a one-off crash', () => {
    expect(shouldRestart([1_000], 1_000)).toBe(true)
  })

  it('gives up on a crash loop, and does it in seconds', () => {
    const now = 100_000
    const exits = loop(DEFAULT_RESTART_POLICY.limit, now)
    expect(shouldRestart(exits, now)).toBe(false)
    // The budget has to be spent while the user is still looking at the
    // window: five exits at ~2.6s is about thirteen seconds, not a workday.
    expect(now - exits[0]).toBeLessThan(20_000)
  })

  it('still restarts one short of the limit', () => {
    const now = 100_000
    expect(shouldRestart(loop(DEFAULT_RESTART_POLICY.limit - 1, now), now)).toBe(true)
  })

  it('ages exits out, so a healthy app keeps its crash recovery forever', () => {
    // The regression this guards: counting every exit for the life of the
    // process would eventually refuse to restart an app that had crashed five
    // times over a month, which is not a loop — it is a long-running app.
    const now = 10_000_000
    const old = loop(DEFAULT_RESTART_POLICY.limit, now - DEFAULT_RESTART_POLICY.windowMs)
    expect(shouldRestart(old, now)).toBe(true)
    expect(recentExits(old, now)).toHaveLength(0)
  })

  it('counts an exit exactly at the window edge as expired', () => {
    const now = 100_000
    expect(recentExits([now - DEFAULT_RESTART_POLICY.windowMs], now)).toHaveLength(0)
    expect(recentExits([now - DEFAULT_RESTART_POLICY.windowMs + 1], now)).toHaveLength(1)
  })
})

describe('reloadDelayMs', () => {
  /** `count` load failures ending now, 300ms apart. */
  const failures = (count: number, now: number): number[] =>
    Array.from({ length: count }, (_, i) => now - (count - 1 - i) * 300)

  it('retries a few times, backing off', () => {
    const now = 100_000
    expect(reloadDelayMs(failures(1, now), now)).toBe(250)
    expect(reloadDelayMs(failures(2, now), now)).toBeGreaterThan(250)
    expect(reloadDelayMs(failures(3, now), now))
      .toBeGreaterThan(reloadDelayMs(failures(2, now), now) ?? 0)
  })

  it('runs out, rather than reloading forever', () => {
    // A page failing because the sidecar is gone would otherwise reload until
    // the app is quit — the same invisible hang, wearing a different costume.
    const now = 100_000
    expect(reloadDelayMs(failures(4, now), now)).toBeUndefined()
    expect(reloadDelayMs(failures(99, now), now)).toBeUndefined()
  })

  it('cannot be reset by anything the page does', () => {
    // The bug this replaced: an attempt counter reset on did-finish-load, and
    // the failure page's own successful load reset it. Measured against the
    // real launcher — nine retries, every one at the shortest delay, budget
    // never advancing. A window only ages out.
    const now = 100_000
    // `limit` is how many retries are granted, so the budget is spent by the
    // failure after the last one.
    const spent = failures(RELOAD_POLICY.limit + 1, now)
    expect(reloadDelayMs(spent, now)).toBeUndefined()
    // A successful load in between changes nothing: the timestamps stand.
    expect(reloadDelayMs(spent, now + 1_000)).toBeUndefined()
  })

  it('lets the budget age out, so a long-lived window keeps its retries', () => {
    const now = 100_000
    const old = failures(RELOAD_POLICY.limit, now - RELOAD_POLICY.windowMs)
    expect(reloadDelayMs([...old, now], now)).toBe(250)
  })

  it('spends its whole budget in a few seconds', () => {
    const now = 100_000
    let total = 0
    for (let i = 1; ; i += 1) {
      const delay = reloadDelayMs(failures(i, now), now)
      if (delay === undefined) break
      total += delay
    }
    expect(total).toBeLessThan(10_000)
  })
})
