// The rule deciding how the harness stage installs: from a committed lockfile,
// or by resolving the closure again.
//
// WHY THERE IS A LOCKFILE AT ALL. Two problems, one cause. Upstream declares a
// ~500-package closure with caret ranges, and staging without a lockfile makes
// npm resolve that search space on every run:
//
//   1. It is not reproducible. `harness.json` pins `@deepseek-ai/dsh` and
//      NOTHING else, so the pin names one package out of five hundred. Measured
//      on 2026-09-10: the pin said `0.1.5-alpha.1` and every transitive
//      `@deepseek-ai/*` resolved to `0.1.5-rc.1`. Four releases shipped that
//      way. A build could not be reproduced, and "does the thing I tested match
//      the thing that ships" had no answer.
//   2. It ran the macOS runners out of heap. `stage-harness.mjs` carries the
//      whole story; its own error message already named a lockfile as the fix,
//      ahead of raising `--max-old-space-size` again.
//
// WHAT IT COSTS. A pin bump is no longer three edited files: the lock has to be
// regenerated with it. That is real work, and it is work that was previously
// being done implicitly and differently on every machine. `npm run stage:relock`
// is the whole of it, and a pin that moves without it fails by name here rather
// than drifting.

/**
 * The `@deepseek-ai/dsh` version a lockfile resolves to.
 *
 * Read from the resolved entry rather than the root's dependency RANGE: the
 * range is what was asked for and the entry is what would be installed, and the
 * drift this guards is exactly the gap between those two.
 * @param {unknown} lock - a parsed package-lock.json.
 * @returns {string | undefined} the version, or undefined when the lock does
 * not describe the harness at all.
 */
export function lockedPin(lock) {
  if (typeof lock !== 'object' || lock === null) return undefined
  const packages = /** @type {Record<string, { version?: unknown }>} */ (
    /** @type {{ packages?: unknown }} */ (lock).packages ?? {}
  )
  const entry = packages['node_modules/@deepseek-ai/dsh']
  return typeof entry?.version === 'string' ? entry.version : undefined
}

/**
 * How the stage should install.
 *
 * `relock` resolves the closure and writes the lock back; `ci` installs exactly
 * what the lock says; `bootstrap` is the same as relock but for a tree that has
 * no lock yet, which is only a fresh checkout that deleted one.
 * @param {object} input - the decision's inputs.
 * @param {string} input.pin - `harness.json`'s harness version.
 * @param {string | undefined} input.lockPin - what the committed lock resolves to.
 * @param {boolean} input.relock - whether `--relock` was passed.
 * @returns {{ mode: 'ci' | 'relock' | 'bootstrap' } | { mode: 'stale', message: string }}
 */
export function stageMode({ pin, lockPin, relock }) {
  if (relock) return { mode: 'relock' }
  if (lockPin === undefined) return { mode: 'bootstrap' }
  if (lockPin === pin) return { mode: 'ci' }
  // The loud one. A bump that edits `harness.json` and stops there used to
  // produce a tree nobody had described; now it names itself and the fix.
  return {
    mode: 'stale',
    message: `stage-harness: harness.json pins ${pin} but harness-lock.json resolves ${lockPin}. `
      + 'Run `npm run stage:relock` and commit the updated harness-lock.json — a pin without its '
      + 'lock installs a closure nobody chose.',
  }
}
