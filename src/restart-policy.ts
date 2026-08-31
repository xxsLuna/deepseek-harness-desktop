/**
 * When to stop restarting the sidecar, and how hard to retry a failed page
 * load. Both are rules, so both are pure and tested rather than inlined into
 * the launcher's event handlers.
 *
 * The case that produced them: a `.credentials.yaml` written by a newer pin
 * made every boot throw, so the sidecar exited ~2.6s after each spawn and the
 * crash handler spawned another, forever. Nothing bounded it and nothing
 * surfaced it — the window sat on a white page or a hanging spinner while the
 * reason went to a stdout a packaged GUI app cannot print. An unbounded retry
 * is indistinguishable from a hang; a bounded one becomes a message.
 */

export interface RestartPolicy {
  /** Exits inside the window that mean the next restart is not worth trying. */
  readonly limit: number
  /** How far back an exit still counts against the budget. */
  readonly windowMs: number
}

/**
 * Five exits in a minute.
 *
 * A boot that fails on its own state fails in seconds and every time, so the
 * budget is spent inside ~15s and the user gets an answer while they are still
 * looking at the window. A genuine one-off crash — an OOM, a killed process —
 * costs one entry and ages out, so recovery still behaves as it always did.
 */
export const DEFAULT_RESTART_POLICY: RestartPolicy = { limit: 5, windowMs: 60_000 }

/**
 * The exits still inside the policy window.
 * @param exits - exit timestamps in ms, oldest first.
 * @param now - the current time in ms.
 * @param policy - the budget to measure against.
 * @returns the timestamps still counting, oldest first.
 */
export function recentExits(
  exits: readonly number[],
  now: number,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): number[] {
  return exits.filter((at) => now - at < policy.windowMs)
}

/**
 * Whether another restart is worth attempting.
 *
 * Called with the exit just recorded already in `exits`, so the comparison is
 * "have we now seen enough", not "would one more be too many".
 * @param exits - exit timestamps in ms, oldest first, including the newest.
 * @param now - the current time in ms.
 * @param policy - the budget to measure against.
 * @returns true to restart, false to give up and report.
 */
export function shouldRestart(
  exits: readonly number[],
  now: number,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): boolean {
  return recentExits(exits, now, policy).length < policy.limit
}

/** Delays for successive page-load retries, in ms. */
const RELOAD_BACKOFF = [250, 1_000, 3_000] as const

/**
 * Page-load retries are budgeted over time, for the reason below. `limit` is
 * how many retries are granted, so the budget is spent by the failure AFTER
 * the last one.
 */
export const RELOAD_POLICY: RestartPolicy = { limit: RELOAD_BACKOFF.length, windowMs: 30_000 }

/**
 * How long to wait before retrying a failed page load, or undefined once the
 * budget is spent.
 *
 * Counted over a window rather than with an attempt counter, because the first
 * version used a counter reset on `did-finish-load` and that reset fired on
 * the failure page's own successful load. Measured: nine retries, every one of
 * them at the shortest delay, with the budget never advancing — an unbounded
 * reload wearing the costume of a bounded one. A window cannot be reset by
 * anything the page does; it only ages out.
 * @param failures - load-failure timestamps in ms, oldest first, including the newest.
 * @param now - the current time in ms.
 * @param policy - the budget to measure against.
 * @returns the delay in ms, or undefined to stop retrying.
 */
export function reloadDelayMs(
  failures: readonly number[],
  now: number,
  policy: RestartPolicy = RELOAD_POLICY,
): number | undefined {
  return RELOAD_BACKOFF[recentExits(failures, now, policy).length - 1]
}
