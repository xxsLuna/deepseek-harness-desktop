/**
 * The pure rules inside the Desktop Settings pages.
 *
 * Only the functions with a rule in them — a chord captured from a keydown, and
 * the two that decide what a heatmap cell is. The components themselves need a
 * DOM and the staged harness's react, which is what the contract suite is for.
 */
import { describe, expect, it } from 'vitest'
import {
  acceleratorFrom,
  grassDays,
  grassLevel,
  grassThresholds,
  prettyAccelerator,
} from '../../packages/settings/src/client.js'

/** A keydown, with no modifiers unless named. */
const key = (code: string, held: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  ctrlKey: held.ctrlKey ?? false,
  metaKey: held.metaKey ?? false,
  altKey: held.altKey ?? false,
  shiftKey: held.shiftKey ?? false,
})

describe('acceleratorFrom', () => {
  it('reads the physical key, not what the modifiers produced', () => {
    // Shift+2 arrives as key "@" and Alt+D on macOS as "∂"; Electron registers
    // neither. `code` is the same string whatever the layout did with it.
    expect(acceleratorFrom(key('KeyD', { altKey: true, ctrlKey: true }))).toBe('CommandOrControl+Alt+D')
    expect(acceleratorFrom(key('Digit2', { shiftKey: true, ctrlKey: true }))).toBe('CommandOrControl+Shift+2')
  })

  it('folds Ctrl and Cmd into one stored chord', () => {
    // One preference has to mean Cmd on macOS and Ctrl elsewhere, or the file
    // stops being portable between machines.
    expect(acceleratorFrom(key('KeyK', { metaKey: true }))).toBe('CommandOrControl+K')
    expect(acceleratorFrom(key('KeyK', { ctrlKey: true }))).toBe('CommandOrControl+K')
  })

  it('orders the modifiers the same way every time', () => {
    expect(acceleratorFrom(key('KeyJ', { shiftKey: true, altKey: true, ctrlKey: true })))
      .toBe('CommandOrControl+Alt+Shift+J')
  })

  it('refuses a bare letter, which would swallow that key machine-wide', () => {
    expect(acceleratorFrom(key('KeyD'))).toBeUndefined()
    expect(acceleratorFrom(key('Digit4'))).toBeUndefined()
  })

  it('allows a bare function key, which is the exception people reach for', () => {
    expect(acceleratorFrom(key('F9'))).toBe('F9')
    expect(acceleratorFrom(key('F12', { shiftKey: true }))).toBe('Shift+F12')
  })

  it('yields nothing while only modifiers are held', () => {
    expect(acceleratorFrom(key('ShiftLeft', { shiftKey: true }))).toBeUndefined()
    expect(acceleratorFrom(key('ControlLeft', { ctrlKey: true }))).toBeUndefined()
  })

  it('names the keys Electron names, not the browser ones', () => {
    expect(acceleratorFrom(key('Enter', { ctrlKey: true }))).toBe('CommandOrControl+Return')
    expect(acceleratorFrom(key('Space', { altKey: true }))).toBe('Alt+Space')
    expect(acceleratorFrom(key('ArrowUp', { ctrlKey: true }))).toBe('CommandOrControl+Up')
  })
})

describe('prettyAccelerator', () => {
  it('shows the platform its own glyphs', () => {
    expect(prettyAccelerator('CommandOrControl+Alt+D', true)).toBe('⌘⌥D')
    expect(prettyAccelerator('CommandOrControl+Alt+D', false)).toBe('Ctrl+Alt+D')
  })

  it('says the empty chord is off rather than showing nothing', () => {
    expect(prettyAccelerator('', false)).toBe('Off')
    expect(prettyAccelerator('', true)).toBe('Off')
  })

  it('leaves a key it does not translate alone', () => {
    expect(prettyAccelerator('Shift+F12', false)).toBe('Shift+F12')
  })
})

describe('grassThresholds', () => {
  it('ranks the non-zero values rather than slicing the peak', () => {
    // This is the bug it exists to fix, seen on the first run with real data:
    // usage clusters, so a week of 20-26 turns a day is entirely above 75% of
    // the peak and the whole calendar comes out one flat maximum.
    const clustered = [0, 0, 20, 21, 22, 23, 24, 25, 26]
    const cuts = grassThresholds(clustered)
    const levels = clustered.filter((v) => v > 0).map((v) => grassLevel(v, cuts))
    expect(new Set(levels).size).toBeGreaterThan(2)
  })

  it('excludes empty days before ranking', () => {
    // Empty days are most of any calendar; counting them would push every real
    // value into the top band, which is the same washout by the other route.
    const sparse = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]
    const cuts = grassThresholds(sparse)
    expect(grassLevel(1, cuts)).toBe(1)
    expect(grassLevel(4, cuts)).toBe(4)
  })

  it('returns zeros for a chart with nothing in it', () => {
    expect(grassThresholds([])).toEqual([0, 0, 0])
    expect(grassThresholds([0, 0, 0])).toEqual([0, 0, 0])
  })

  it('ascends, so the bands cannot cross', () => {
    const cuts = grassThresholds([3, 9, 1, 40, 7, 12, 0, 5])
    expect(cuts[0]).toBeLessThanOrEqual(cuts[1])
    expect(cuts[1]).toBeLessThanOrEqual(cuts[2])
  })
})

describe('grassLevel', () => {
  const cuts = grassThresholds([1, 2, 3, 4, 5, 6, 7, 8])

  it('spreads values across the shades', () => {
    expect(grassLevel(1, cuts)).toBe(1)
    expect(grassLevel(8, cuts)).toBe(4)
    const levels = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => grassLevel(v, cuts))
    expect(new Set(levels)).toEqual(new Set([1, 2, 3, 4]))
  })

  it('gives any nonzero count at least the first shade', () => {
    // A day with one turn must not render as an empty day.
    expect(grassLevel(1, grassThresholds([1, 500, 1000]))).toBe(1)
  })

  it('is 0 for nothing, and for a chart with no values', () => {
    expect(grassLevel(0, cuts)).toBe(0)
    expect(grassLevel(-1, cuts)).toBe(0)
    expect(grassLevel(0, [0, 0, 0])).toBe(0)
  })

  it('puts everything above the top cut in the last band', () => {
    expect(grassLevel(9999, cuts)).toBe(4)
  })

  it('still works when every value is identical', () => {
    // All three cuts land on the same number; the bands merge and every day is
    // level 1 rather than the function producing something out of range. There
    // is no variation to show, so showing none is the honest answer.
    const flat = grassThresholds([5, 5, 5, 5])
    expect(grassLevel(5, flat)).toBe(1)
  })

  it('always gives the busiest bucket the darkest shade', () => {
    // The one cell a reader looks for. Indexing the quantiles across `length`
    // rather than `length - 1` put the maximum ON the top cut, and an inclusive
    // comparison then left it a shade short.
    for (const values of [[1, 2, 3, 4], [3, 9, 1, 40, 7], [2, 2, 5], [1, 1, 1, 9]]) {
      const cuts = grassThresholds(values)
      expect(grassLevel(Math.max(...values), cuts), JSON.stringify(values)).toBe(4)
    }
  })
})

describe('grassDays', () => {
  it('returns whole weeks, ending on today', () => {
    const days = grassDays(new Date(2026, 7, 24), 27)
    expect(days).toHaveLength(27 * 7)
    expect(days[days.length - 1]).toBe('2026-08-24')
  })

  it('walks the calendar rather than adding 86,400,000ms', () => {
    // Adding a fixed day would shift every column after a DST change by an
    // hour and eventually repeat a key. Every key here must be distinct and
    // consecutive.
    const days = grassDays(new Date(2026, 2, 30), 10)
    expect(new Set(days).size).toBe(days.length)
    for (let index = 1; index < days.length; index += 1) {
      expect(days[index]! > days[index - 1]!, `${days[index - 1]} -> ${days[index]}`).toBe(true)
    }
  })

  it('crosses a year boundary without breaking the keys', () => {
    const days = grassDays(new Date(2026, 0, 3), 2)
    expect(days[0]).toBe('2025-12-21')
    expect(days[days.length - 1]).toBe('2026-01-03')
  })
})
