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
  sameTokens,
  splitSpan,
  TOKEN_FIELDS,
  usageView,
  type UsageRecord,
  type UsageTokens,
  type UsageView,
} from './usage.js'

/**
 * The newest usage report seen for one session, and where it was filed.
 *
 * The bucket is remembered along with the numbers because a replacement has to
 * be taken out of the hour the first sample went into, which is not necessarily
 * the hour the replacement arrives in.
 */
interface LastSample {
  turn: number
  step: number
  tokens: UsageTokens
  day: string
  hour: number
}

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
  /** Newest usage report per session, for the replace-not-add rule below. */
  private readonly lastSample = new Map<string, LastSample>()

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

  /**
   * Record the tokens one model call reported.
   *
   * A step reports its usage TWICE: once as a streaming chunk, which survives a
   * later failure, and again on the finished assistant message. Upstream's own
   * fold treats the second as a REPLACEMENT for the first rather than a second
   * charge, and so must this -- adding both would double every step's tokens.
   *
   * Upstream can keep one slot because reports for a turn/step are adjacent in
   * a legal log; this keeps one per session for the same reason, since the
   * launcher watches every session at once on a shared stream.
   *
   * The replacement is subtracted from the bucket the first sample went into,
   * not the current one. A step that starts streaming at 10:59 and finishes at
   * 11:00 would otherwise leave its early sample stranded in the earlier hour
   * and charge the whole call again in the later one.
   * @param sessionId - which session reported.
   * @param at - the event's own timestamp, epoch ms.
   * @param turn - the turn the report belongs to.
   * @param step - the step within it.
   * @param tokens - the four counts.
   */
  recordTokens(sessionId: string, at: number, turn: number, step: number, tokens: UsageTokens): void {
    const previous = this.lastSample.get(sessionId)
    const sameStep = previous !== undefined && previous.turn === turn && previous.step === step
    if (sameStep && sameTokens(previous.tokens, tokens)) return
    if (sameStep) this.addTokens(previous.day, previous.hour, previous.tokens, -1)

    const day = dayKey(at)
    const hour = hourOf(at)
    this.addTokens(day, hour, tokens, 1)
    this.lastSample.set(sessionId, { turn, step, tokens, day, hour })
    this.touch(at)
  }

  /**
   * Add or subtract one report from a bucket.
   * @param day - local date key.
   * @param hour - local hour.
   * @param tokens - the counts.
   * @param sign - 1 to add, -1 to take a superseded sample back out.
   */
  private addTokens(day: string, hour: number, tokens: UsageTokens, sign: 1 | -1): void {
    this.record.days[day] ??= emptyDay()
    const bucket = this.record.days[day]?.[hour]
    if (bucket === undefined) return
    for (const field of TOKEN_FIELDS) {
      // Clamped, because a reset between the two samples of one step leaves
      // nothing to subtract and a negative count would render as an empty cell
      // that is somehow also the busiest.
      bucket[field] = Math.max(0, bucket[field] + sign * tokens[field])
    }
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
    // Or the next report for a step already counted would subtract from a
    // record that no longer holds it.
    this.lastSample.clear()
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
