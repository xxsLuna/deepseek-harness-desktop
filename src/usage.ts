/**
 * Desktop usage record: how much the agent was used, by local day and hour.
 *
 * The harness does not keep this. `sessionStats` is a whole-log total per
 * session — turns, steps, wall times — with no timestamps in it, and
 * `session.list` gives one `updatedAt` per session. Neither can draw a
 * calendar. So the launcher counts, from the streams it is already subscribed
 * to for notifications, and this file is the rule for turning those moments
 * into buckets.
 *
 * That has one consequence worth stating in the UI rather than hiding: the
 * record starts the day the feature ships. There is no back-fill, because the
 * only place the history exists is inside every session's durable event log,
 * and walking all of them on page open would couple this to upstream's log
 * format for a graph.
 *
 * Buckets are LOCAL date and hour, because a person reading a contribution
 * graph reads their own midnight, not UTC's.
 */

/** One hour of one local day. Counts only; totals are sums over these. */
export interface UsageBucket {
  /** Turns you started. */
  turns: number
  /** Turns a subagent started, kept apart so the graph can exclude them. */
  subagentTurns: number
  /** Wall time the agent spent running, ms, split across the hours it spanned. */
  activeMs: number
}

/** The whole record: local date key -> 24 hourly buckets. */
export interface UsageRecord {
  /** Epoch ms of the first thing ever counted, or when the record was reset. */
  since: number
  /** `YYYY-MM-DD` (local) -> exactly 24 buckets, hour 0 first. */
  days: Record<string, UsageBucket[]>
}

/** How many days of history to keep. */
export const RETENTION_DAYS = 400

/** An empty bucket; every field must be present so a sum never sees undefined. */
export const EMPTY_BUCKET: UsageBucket = { turns: 0, subagentTurns: 0, activeMs: 0 }

/**
 * The local date key for an instant.
 *
 * Built from the local calendar fields rather than `toISOString`, which is UTC
 * and would file an evening in Seoul under the next day.
 * @param at - epoch ms.
 * @returns `YYYY-MM-DD` in the machine's current zone.
 */
export function dayKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** @returns the local hour, 0-23, of an instant. */
export function hourOf(at: number): number {
  return new Date(at).getHours()
}

/** @returns 24 empty buckets. */
export function emptyDay(): UsageBucket[] {
  return Array.from({ length: 24 }, () => ({ ...EMPTY_BUCKET }))
}

/** One (day, hour) slot and how much time falls in it. */
export interface SpanSlice {
  day: string
  hour: number
  ms: number
}

/**
 * Split a wall-clock span across the local hours it covers.
 *
 * A duration is not a point, so unlike a turn count it cannot simply be filed
 * under the hour it started: a run from 23:40 to 00:20 belongs half to
 * yesterday's last hour and half to today's first. Splitting is what keeps the
 * hourly graph readable as "when is this machine busy".
 *
 * The walk steps by real hour boundaries recomputed from the local calendar,
 * not by adding 3,600,000ms, so a DST transition is handled by construction:
 * on the day an hour repeats, both instances land in the same bucket and their
 * time adds; on the day an hour is skipped, no slice is ever produced for it.
 * @param startMs - span start, epoch ms.
 * @param endMs - span end, epoch ms; an end at or before the start yields none.
 * @returns one slice per hour touched, in order.
 */
export function splitSpan(startMs: number, endMs: number): SpanSlice[] {
  if (!(endMs > startMs)) return []
  const slices: SpanSlice[] = []
  let cursor = startMs
  // Bounded so a bad clock (a span reading as years long) cannot spin here.
  // 48 hours is far longer than any turn and still cheap to walk.
  const limit = Math.min(endMs, startMs + 48 * 60 * 60 * 1000)
  while (cursor < limit) {
    const at = new Date(cursor)
    const nextHour = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() + 1, 0, 0, 0).getTime()
    const until = Math.min(nextHour, limit)
    slices.push({ day: dayKey(cursor), hour: at.getHours(), ms: until - cursor })
    cursor = until
  }
  return slices
}

/**
 * Parse a stored record; anything malformed falls back to empty.
 *
 * Total and pure, like parseDesktopSettings: a half-written file must not stop
 * the page rendering, and a single bad day must not discard the rest.
 * @param raw - the file content, or undefined when absent.
 * @returns a structurally valid record.
 */
export function parseUsage(raw: string | undefined): UsageRecord {
  const empty: UsageRecord = { since: 0, days: {} }
  if (raw === undefined) return empty
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
    record = parsed as Record<string, unknown>
  } catch {
    return empty
  }
  const since = typeof record.since === 'number' && Number.isFinite(record.since) ? record.since : 0
  const days: Record<string, UsageBucket[]> = {}
  const stored = record.days
  if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Array.isArray(value)) continue
      const day = emptyDay()
      for (let hour = 0; hour < 24; hour += 1) {
        const cell = value[hour]
        if (typeof cell !== 'object' || cell === null) continue
        const source = cell as Record<string, unknown>
        const count = (field: keyof UsageBucket): number =>
          typeof source[field] === 'number' && Number.isFinite(source[field]) && source[field] >= 0
            ? source[field]
            : 0
        day[hour] = { turns: count('turns'), subagentTurns: count('subagentTurns'), activeMs: count('activeMs') }
      }
      days[key] = day
    }
  }
  return { since, days }
}

/**
 * Drop days older than the retention window.
 *
 * String comparison, not date arithmetic: `YYYY-MM-DD` sorts chronologically as
 * text, so the cutoff is one comparison per key and no zone is involved.
 * @param record - the record to prune.
 * @param now - epoch ms of "today".
 * @returns a record holding only days inside the window.
 */
export function pruneUsage(record: UsageRecord, now: number): UsageRecord {
  const cutoff = dayKey(now - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const days: Record<string, UsageBucket[]> = {}
  for (const [key, value] of Object.entries(record.days)) {
    if (key >= cutoff) days[key] = value
  }
  return { since: record.since, days }
}

/** What the Usage page renders. */
export interface UsageView {
  /** Epoch ms the record began, 0 when nothing has been counted. */
  since: number
  /** Local date key -> total turns that day, subagent turns excluded. */
  daily: Record<string, number>
  /** Local date key -> subagent turns that day. */
  dailySubagent: Record<string, number>
  /** 24 entries: turns by hour of day, summed over every day held. */
  hourly: number[]
  /** 24 entries: subagent turns by hour of day. */
  hourlySubagent: number[]
  /** Totals across the whole record. */
  totals: { turns: number, subagentTurns: number, activeMs: number, days: number }
}

/**
 * Project the record into the two graphs and their summary.
 *
 * Both graphs read the SAME buckets — the daily one sums a day's 24 hours, the
 * hourly one sums one hour across every day — so they cannot disagree about a
 * total, which is the reason the record is stored by hour rather than as two
 * separate tallies.
 * @param record - the stored record.
 * @returns the view.
 */
export function usageView(record: UsageRecord): UsageView {
  const daily: Record<string, number> = {}
  const dailySubagent: Record<string, number> = {}
  const hourly = Array.from({ length: 24 }, () => 0)
  const hourlySubagent = Array.from({ length: 24 }, () => 0)
  let turns = 0
  let subagentTurns = 0
  let activeMs = 0

  for (const [key, buckets] of Object.entries(record.days)) {
    let dayTurns = 0
    let daySub = 0
    for (let hour = 0; hour < 24; hour += 1) {
      const bucket = buckets[hour] ?? EMPTY_BUCKET
      dayTurns += bucket.turns
      daySub += bucket.subagentTurns
      hourly[hour] = (hourly[hour] ?? 0) + bucket.turns
      hourlySubagent[hour] = (hourlySubagent[hour] ?? 0) + bucket.subagentTurns
      activeMs += bucket.activeMs
    }
    daily[key] = dayTurns
    dailySubagent[key] = daySub
    turns += dayTurns
    subagentTurns += daySub
  }

  return {
    since: record.since,
    daily,
    dailySubagent,
    hourly,
    hourlySubagent,
    totals: { turns, subagentTurns, activeMs, days: Object.keys(record.days).length },
  }
}
