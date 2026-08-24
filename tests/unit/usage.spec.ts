/**
 * The usage record's rules. All local-time arithmetic, so these run against
 * whatever zone the machine is in rather than pinning one — the assertions are
 * written to hold in any zone, and the DST cases construct their own instants
 * from the local calendar for the same reason.
 */
import { describe, expect, it } from 'vitest'
import {
  dayKey,
  emptyDay,
  hourOf,
  parseUsage,
  pruneUsage,
  RETENTION_DAYS,
  splitSpan,
  usageView,
  type UsageRecord,
} from '../../src/usage.js'

/** Epoch ms for a local wall-clock time, so tests never depend on the zone. */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime()

describe('dayKey', () => {
  it('files an instant under its LOCAL date', () => {
    // toISOString would file a Seoul evening under the next day; this must not.
    expect(dayKey(at(2026, 8, 24, 23, 59))).toBe('2026-08-24')
    expect(dayKey(at(2026, 8, 25, 0, 1))).toBe('2026-08-25')
  })

  it('pads, so the keys sort chronologically as text', () => {
    expect(dayKey(at(2026, 1, 5))).toBe('2026-01-05')
    expect(dayKey(at(2026, 1, 5)) < dayKey(at(2026, 10, 5))).toBe(true)
  })
})

describe('hourOf', () => {
  it('reads the local hour', () => {
    expect(hourOf(at(2026, 8, 24, 0))).toBe(0)
    expect(hourOf(at(2026, 8, 24, 23))).toBe(23)
  })
})

describe('splitSpan', () => {
  it('keeps a span inside one hour whole', () => {
    expect(splitSpan(at(2026, 8, 24, 10, 5), at(2026, 8, 24, 10, 35)))
      .toEqual([{ day: '2026-08-24', hour: 10, ms: 30 * 60_000 }])
  })

  it('splits across an hour boundary', () => {
    const slices = splitSpan(at(2026, 8, 24, 10, 50), at(2026, 8, 24, 11, 20))
    expect(slices).toEqual([
      { day: '2026-08-24', hour: 10, ms: 10 * 60_000 },
      { day: '2026-08-24', hour: 11, ms: 20 * 60_000 },
    ])
  })

  it('splits across midnight, into two days', () => {
    // The whole reason a duration cannot be filed under its start hour the way
    // a turn count is: half of this belongs to a day the user already ended.
    const slices = splitSpan(at(2026, 8, 24, 23, 40), at(2026, 8, 25, 0, 20))
    expect(slices).toEqual([
      { day: '2026-08-24', hour: 23, ms: 20 * 60_000 },
      { day: '2026-08-25', hour: 0, ms: 20 * 60_000 },
    ])
  })

  it('conserves the total duration it was given', () => {
    const start = at(2026, 8, 24, 22, 13)
    const end = at(2026, 8, 25, 3, 47)
    const total = splitSpan(start, end).reduce((sum, slice) => sum + slice.ms, 0)
    expect(total).toBe(end - start)
  })

  it('yields nothing for an empty or reversed span', () => {
    const now = at(2026, 8, 24, 10)
    expect(splitSpan(now, now)).toEqual([])
    expect(splitSpan(now, now - 1000)).toEqual([])
  })

  it('is bounded, so a clock jump cannot make it walk forever', () => {
    // A span reading as a year long means the clock moved, not that a turn ran
    // for a year. Capped at 48 hours, which is far past any real turn.
    const start = at(2026, 8, 24, 0)
    const slices = splitSpan(start, start + 365 * 24 * 60 * 60 * 1000)
    expect(slices.length).toBeLessThanOrEqual(49)
    const total = slices.reduce((sum, slice) => sum + slice.ms, 0)
    expect(total).toBe(48 * 60 * 60 * 1000)
  })

  it('walks real local hour boundaries, not fixed 3,600,000ms steps', () => {
    // This is what makes DST free: every step is recomputed from the local
    // calendar, so a repeated hour lands in the same bucket twice and a skipped
    // one is never produced. Asserted structurally, since the machine running
    // the suite may be in a zone with no DST at all.
    const start = at(2026, 3, 29, 0, 30)
    const slices = splitSpan(start, start + 5 * 60 * 60 * 1000)
    const total = slices.reduce((sum, slice) => sum + slice.ms, 0)
    expect(total).toBe(5 * 60 * 60 * 1000)
    for (const slice of slices) {
      expect(slice.hour).toBeGreaterThanOrEqual(0)
      expect(slice.hour).toBeLessThanOrEqual(23)
      expect(slice.ms).toBeGreaterThan(0)
    }
  })
})

describe('parseUsage', () => {
  it('survives anything the file could contain', () => {
    for (const raw of [undefined, '', '{', 'null', '[]', '42', '"x"']) {
      expect(parseUsage(raw), String(raw)).toEqual({ since: 0, days: {} })
    }
  })

  it('keeps the readable days and drops the rest', () => {
    const parsed = parseUsage(JSON.stringify({
      since: 111,
      days: {
        '2026-08-24': [{ turns: 3, subagentTurns: 1, activeMs: 50 }],
        'not-a-date': [{ turns: 9 }],
        '2026-08-25': 'nope',
      },
    }))
    expect(parsed.since).toBe(111)
    expect(Object.keys(parsed.days)).toEqual(['2026-08-24'])
    expect(parsed.days['2026-08-24']?.[0]).toEqual({ turns: 3, subagentTurns: 1, activeMs: 50 })
  })

  it('pads every day to 24 buckets, so a sum never meets undefined', () => {
    const parsed = parseUsage(JSON.stringify({ since: 1, days: { '2026-08-24': [{ turns: 1 }] } }))
    expect(parsed.days['2026-08-24']).toHaveLength(24)
    expect(parsed.days['2026-08-24']?.[23]).toEqual({ turns: 0, subagentTurns: 0, activeMs: 0 })
  })

  it('rejects negative and non-finite counts rather than storing them', () => {
    const parsed = parseUsage(JSON.stringify({
      since: 1,
      days: { '2026-08-24': [{ turns: -5, subagentTurns: Number.NaN, activeMs: 'lots' }] },
    }))
    expect(parsed.days['2026-08-24']?.[0]).toEqual({ turns: 0, subagentTurns: 0, activeMs: 0 })
  })
})

describe('pruneUsage', () => {
  it('drops days past the retention window and keeps the rest', () => {
    const now = at(2026, 8, 24, 12)
    const old = dayKey(now - (RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000)
    const recent = dayKey(now - 3 * 24 * 60 * 60 * 1000)
    const record: UsageRecord = { since: 1, days: { [old]: emptyDay(), [recent]: emptyDay() } }
    const pruned = pruneUsage(record, now)
    expect(Object.keys(pruned.days)).toEqual([recent])
    expect(pruned.since).toBe(1)
  })
})

describe('usageView', () => {
  it('draws both graphs from the same buckets, so they cannot disagree', () => {
    const day = emptyDay()
    day[9] = { turns: 2, subagentTurns: 5, activeMs: 1000 }
    day[14] = { turns: 3, subagentTurns: 0, activeMs: 2000 }
    const other = emptyDay()
    other[9] = { turns: 1, subagentTurns: 0, activeMs: 500 }

    const view = usageView({ since: 42, days: { '2026-08-24': day, '2026-08-25': other } })

    expect(view.daily).toEqual({ '2026-08-24': 5, '2026-08-25': 1 })
    expect(view.hourly[9]).toBe(3)
    expect(view.hourly[14]).toBe(3)
    // The daily graph sums a day's hours; the hourly one sums an hour's days.
    // Both totals are the same number, by construction.
    const dailyTotal = Object.values(view.daily).reduce((a, b) => a + b, 0)
    expect(view.hourly.reduce((a, b) => a + b, 0)).toBe(dailyTotal)
    expect(view.totals.turns).toBe(dailyTotal)
  })

  it('keeps subagent turns apart, so the graph can exclude them', () => {
    const day = emptyDay()
    day[9] = { turns: 2, subagentTurns: 5, activeMs: 0 }
    const view = usageView({ since: 1, days: { '2026-08-24': day } })
    expect(view.daily['2026-08-24']).toBe(2)
    expect(view.dailySubagent['2026-08-24']).toBe(5)
    expect(view.hourlySubagent[9]).toBe(5)
    expect(view.totals.subagentTurns).toBe(5)
  })

  it('reports an empty record as empty rather than as a zero day', () => {
    const view = usageView({ since: 0, days: {} })
    expect(view.totals).toEqual({ turns: 0, subagentTurns: 0, activeMs: 0, days: 0 })
    expect(view.hourly).toHaveLength(24)
    expect(view.since).toBe(0)
  })
})
