/**
 * Persistence for the usage record: the launcher half of the Usage page.
 *
 * Kept apart from usage.ts so the rules there stay pure and testable without a
 * filesystem, the same split desktop-settings.ts and settings-host.ts already
 * use.
 *
 * Writes are debounced. The counters move on every turn and every finished run,
 * and the app is otherwise idle at exactly those moments — a synchronous write
 * per event would put disk I/O on the notification path for a graph nobody is
 * looking at. The record is also flushed on quit, so the cost of the debounce
 * is at most the last few seconds of a session that was killed outright.
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dayKey,
  emptyDay,
  hourOf,
  parseUsage,
  pruneUsage,
  splitSpan,
  usageView,
  type UsageRecord,
  type UsageView,
} from './usage.js'

/** How long changes may sit in memory before being written. */
const FLUSH_MS = 10_000

/**
 * Read, accumulate and persist the desktop usage record.
 *
 * Single-instance app, so nothing else writes this file while the store runs.
 */
export class UsageStore {
  private readonly path: string
  private record: UsageRecord
  private timer: NodeJS.Timeout | undefined
  private dirty = false

  constructor(userDataPath: string = app.getPath('userData')) {
    this.path = join(userDataPath, 'usage.json')
    let raw: string | undefined
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      raw = undefined
    }
    this.record = parseUsage(raw)
  }

  /**
   * The bucket for an instant, created on demand.
   * @param at - epoch ms.
   * @returns the day's 24 buckets and which hour to touch.
   */
  private slot(at: number): { day: ReturnType<typeof emptyDay>, hour: number } {
    const key = dayKey(at)
    this.record.days[key] ??= emptyDay()
    return { day: this.record.days[key], hour: hourOf(at) }
  }

  /** Mark the record changed and schedule a write. */
  private touch(at: number): void {
    if (this.record.since === 0) this.record.since = at
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, FLUSH_MS)
    // Node keeps the process alive for a pending timer; this one must not be
    // the reason a quit waits ten seconds, and before-quit flushes anyway.
    this.timer.unref?.()
  }

  /**
   * Count one turn.
   * @param at - epoch ms the turn started.
   * @param subagent - whether a subagent started it.
   */
  recordTurn(at: number, subagent: boolean): void {
    const { day, hour } = this.slot(at)
    const bucket = day[hour]
    if (bucket === undefined) return
    if (subagent) bucket.subagentTurns += 1
    else bucket.turns += 1
    this.touch(at)
  }

  /**
   * Add a run's wall time, split across the hours it covered.
   *
   * A subagent's span overlaps its parent's in real time, so both are added to
   * the same figure knowingly: `activeMs` is "time something was running", not
   * a sum that can be compared against the clock.
   * @param startMs - when the run started.
   * @param endMs - when it stopped.
   */
  recordSpan(startMs: number, endMs: number): void {
    const slices = splitSpan(startMs, endMs)
    if (slices.length === 0) return
    for (const slice of slices) {
      this.record.days[slice.day] ??= emptyDay()
      const bucket = this.record.days[slice.day]?.[slice.hour]
      if (bucket !== undefined) bucket.activeMs += slice.ms
    }
    this.touch(startMs)
  }

  /** @returns what the Usage page renders. */
  view(): UsageView {
    return usageView(this.record)
  }

  /**
   * Throw the record away and start counting again from now.
   *
   * An empty record is written rather than the file deleted, so a reset that
   * cannot be persisted fails here and now instead of silently coming back on
   * the next launch. `since` is left at 0 and set by the next thing counted,
   * which is what lets the page say "nothing recorded yet" rather than
   * "recording since just now, 0 turns" — a different and more confusing claim.
   */
  reset(): void {
    this.record = { since: 0, days: {} }
    this.dirty = true
    this.flush()
  }

  /** Write the record now, pruning anything past the retention window. */
  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return
    this.record = pruneUsage(this.record, Date.now())
    try {
      writeFileSync(this.path, JSON.stringify(this.record))
      this.dirty = false
    } catch (error) {
      // Best-effort, like window state: a graph that loses a day is a smaller
      // problem than an app that reports a disk error at the user.
      console.warn('[usage] could not persist usage.json:', error)
    }
  }
}
