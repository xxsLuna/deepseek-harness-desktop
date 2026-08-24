/**
 * The usage store's accumulation rules, against a real temp directory.
 *
 * Only `app.getPath` is stubbed — the same shape `desktop-host.spec.ts` uses to
 * exercise `DesktopSettingsStore`. What is under test is the arithmetic, and
 * the token half of it has a failure mode no assertion elsewhere would catch:
 * a step reports its usage twice and adding both silently doubles every figure
 * the page shows.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const { UsageStore } = await import('../../src/usage-store.js')
const { dayKey, hourOf, totalTokens } = await import('../../src/usage.js')

/** A store on its own throwaway directory. */
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-'))
  return { dir, usage: new UsageStore(dir) }
}

/** Epoch ms for a local wall-clock time, so tests never depend on the zone. */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime()

const tokens = (input: number, output: number, read = 0, write = 0) =>
  ({ inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write })

describe('UsageStore.recordTurn', () => {
  it('files a turn under its local day and hour, and keeps subagents apart', () => {
    const { usage } = store()
    const when = at(2026, 8, 24, 14, 30)
    usage.recordTurn(when, false)
    usage.recordTurn(when, false)
    usage.recordTurn(when, true)

    const view = usage.view()
    expect(view.daily[dayKey(when)]).toBe(2)
    expect(view.dailySubagent[dayKey(when)]).toBe(1)
    expect(view.hourly[hourOf(when)]).toBe(2)
    expect(view.since).toBe(when)
  })
})

describe('UsageStore.recordSpan', () => {
  it('splits running time across the hours it covered', () => {
    const { usage } = store()
    usage.recordSpan(at(2026, 8, 24, 10, 50), at(2026, 8, 24, 11, 20))
    expect(usage.view().totals.activeMs).toBe(30 * 60_000)
  })
})

describe('UsageStore.recordTokens', () => {
  it('counts one report once', () => {
    const { usage } = store()
    usage.recordTokens('s1', at(2026, 8, 24, 10), 1, 1, tokens(100, 20, 5, 2))
    expect(usage.view().totals.tokens).toEqual(tokens(100, 20, 5, 2))
  })

  it('REPLACES a second report for the same step instead of adding it', () => {
    // The whole reason this method is not a one-liner. A step reports usage
    // twice: an early streaming chunk, then the finished assistant message.
    // Upstream's own fold replaces; adding would double every step.
    const { usage } = store()
    const when = at(2026, 8, 24, 10)
    usage.recordTokens('s1', when, 1, 1, tokens(100, 10))
    usage.recordTokens('s1', when, 1, 1, tokens(100, 45))
    expect(usage.view().totals.tokens).toEqual(tokens(100, 45))
  })

  it('adds a report for the NEXT step rather than replacing', () => {
    const { usage } = store()
    const when = at(2026, 8, 24, 10)
    usage.recordTokens('s1', when, 1, 1, tokens(100, 10))
    usage.recordTokens('s1', when, 1, 2, tokens(50, 7))
    expect(usage.view().totals.tokens).toEqual(tokens(150, 17))
  })

  it('keeps each session on its own slot', () => {
    // One shared stream carries every session, so a single `last` slot would
    // let two sessions interleaving their steps replace each other's numbers.
    const { usage } = store()
    const when = at(2026, 8, 24, 10)
    usage.recordTokens('s1', when, 1, 1, tokens(100, 10))
    usage.recordTokens('s2', when, 1, 1, tokens(200, 20))
    usage.recordTokens('s1', when, 1, 1, tokens(100, 40))
    usage.recordTokens('s2', when, 1, 1, tokens(200, 60))
    expect(usage.view().totals.tokens).toEqual(tokens(300, 100))
  })

  it('takes a superseded sample out of the hour it went into, not the new one', () => {
    // A step that starts streaming at 10:59 and finishes at 11:00. Subtracting
    // from the current bucket would strand the early sample in the earlier hour
    // and charge the whole call again in the later one.
    const { usage } = store()
    usage.recordTokens('s1', at(2026, 8, 24, 10, 59), 1, 1, tokens(100, 10))
    usage.recordTokens('s1', at(2026, 8, 24, 11, 0), 1, 1, tokens(100, 40))

    const view = usage.view()
    expect(view.hourlyTokens[10]).toBe(0)
    expect(view.hourlyTokens[11]).toBe(140)
    expect(totalTokens(view.totals.tokens)).toBe(140)
  })

  it('ignores a repeat that changed nothing', () => {
    const { usage } = store()
    const when = at(2026, 8, 24, 10)
    usage.recordTokens('s1', when, 1, 1, tokens(100, 10))
    usage.recordTokens('s1', when, 1, 1, tokens(100, 10))
    expect(usage.view().totals.tokens).toEqual(tokens(100, 10))
  })

  it('never lets a bucket go negative', () => {
    // A reset between the two samples of one step leaves nothing to subtract.
    // Unclamped, the bucket would go negative and render as an empty cell that
    // is somehow also the busiest in the chart.
    const { usage } = store()
    const when = at(2026, 8, 24, 10)
    usage.recordTokens('s1', when, 1, 1, tokens(100, 10))
    usage.reset()
    usage.recordTokens('s1', when, 1, 1, tokens(100, 40))
    const view = usage.view()
    expect(view.totals.tokens).toEqual(tokens(100, 40))
    expect(totalTokens(view.totals.tokens)).toBeGreaterThanOrEqual(0)
  })
})

describe('UsageStore.reset', () => {
  it('empties the record and writes it, rather than deleting the file', () => {
    // Written rather than deleted so a reset that cannot be persisted fails now
    // instead of silently coming back on the next launch.
    const { dir, usage } = store()
    usage.recordTurn(at(2026, 8, 24, 10), false)
    usage.reset()
    expect(usage.view().totals.turns).toBe(0)
    expect(usage.view().since).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'))).toEqual({ since: 0, days: {} })
  })
})

describe('UsageStore, across a restart', () => {
  it('reads back what it flushed', () => {
    const { dir, usage } = store()
    usage.recordTurn(at(2026, 8, 24, 10), false)
    usage.recordTokens('s1', at(2026, 8, 24, 10), 1, 1, tokens(100, 20))
    usage.flush()

    const reopened = new UsageStore(dir)
    expect(reopened.view().totals.turns).toBe(1)
    expect(reopened.view().totals.tokens).toEqual(tokens(100, 20))
  })
})
