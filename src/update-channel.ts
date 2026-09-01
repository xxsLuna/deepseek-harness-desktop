/**
 * The release channel vocabulary, shared by the launcher, the settings UI and
 * the release tooling.
 *
 * The channel is not a mechanism this app builds — it is the first pre-release
 * identifier of the running version, and electron-updater matches it by exact
 * string equality (`GitHubProvider.js:83`, `hrefChannel === currentChannel`).
 * A tag on another channel is skipped rather than ranked lower, so an install
 * only ever sees its own channel's releases.
 *
 * ```
 * 0.1.1-desktop-v0.2.0
 *       └────────┘ the channel
 * ```
 *
 * Two facts that decide the identifiers, both verified in electron-updater
 * 6.8.9 rather than assumed:
 *
 * - `"alpha"` and `"beta"` are reserved. `GitHubProvider.js:74-75` special-cases
 *   a channel only by exact equality with those two, so `desktop-alpha` is an
 *   ordinary custom channel while a channel named plain `alpha` would opt into
 *   the alpha→beta promotion branch at line 77.
 * - They sort in stability order by accident of the alphabet:
 *   `desktop-alpha` < `desktop-dev` < `desktop-v`, on `a` < `d` < `v`. Moving
 *   toward stability is therefore a semver upgrade; moving away from it is a
 *   downgrade, which assigning `autoUpdater.channel` permits as a side effect
 *   (`AppUpdater.js:33-44` sets `allowDowngrade`).
 *
 * The scheme number that follows the identifier is carried from the running
 * version and never invented here — moving it is a channel change of its own,
 * and AGENTS.md ("Versioning") says what that costs.
 */

/** What an install follows. `auto` means "whatever this build was cut on". */
export type UpdateChannel = 'auto' | 'stable' | 'develop' | 'alpha'

/** The stored settings values a user can choose between. */
export const CHOOSABLE_CHANNELS: readonly Exclude<UpdateChannel, 'auto'>[] = [
  'stable',
  'develop',
  'alpha',
]

/** Identifier prefix per channel; the scheme number is appended to it. */
const PREFIX: Record<Exclude<UpdateChannel, 'auto'>, string> = {
  stable: 'desktop-v',
  develop: 'desktop-dev',
  alpha: 'desktop-alpha',
}

/**
 * Longest prefix first, so `desktop-dev0` is not read as `desktop-v`'s sibling
 * by a shorter match. `desktop-v` is a prefix of nothing else here, but the
 * ordering is what keeps that true when a fourth is added.
 */
const BY_LENGTH: readonly (readonly [Exclude<UpdateChannel, 'auto'>, string])[] =
  (Object.entries(PREFIX) as [Exclude<UpdateChannel, 'auto'>, string][])
    .sort(([, a], [, b]) => b.length - a.length)

/** `<core>-<identifier>.<upstream pre-release>.<build>` */
const SHIPPING = /^\d+\.\d+\.\d+-(desktop-(?:v|dev|alpha)\d+)\.\d+\.\d+$/

/**
 * The channel identifier a version carries.
 * @param version - a release version of this app.
 * @returns the first pre-release identifier, or undefined when the version is
 * not one this scheme produced.
 */
export function channelOf(version: string): string | undefined {
  return SHIPPING.exec(version)?.[1]
}

/**
 * The scheme number a version carries.
 *
 * Separate from the channel because it is the one field that must survive a
 * channel switch untouched: it is an escape hatch for the scheme itself, and
 * moving it strands the installed base.
 * @param version - a release version of this app.
 * @returns the trailing digits of the identifier, or undefined when the version
 * is off-scheme.
 */
export function schemeNumberOf(version: string): string | undefined {
  const identifier = channelOf(version)
  if (identifier === undefined) return undefined
  for (const [, prefix] of BY_LENGTH) {
    if (identifier.startsWith(prefix)) return identifier.slice(prefix.length)
  }
  /* v8 ignore next -- SHIPPING only matches the three prefixes above */
  return undefined
}

/**
 * Which channel a version belongs to.
 * @param version - a release version of this app.
 * @returns the channel, or undefined when the version is off-scheme.
 */
export function channelKindOf(version: string): Exclude<UpdateChannel, 'auto'> | undefined {
  const identifier = channelOf(version)
  if (identifier === undefined) return undefined
  for (const [kind, prefix] of BY_LENGTH) {
    if (identifier.startsWith(prefix)) return kind
  }
  /* v8 ignore next -- as above */
  return undefined
}

/**
 * The channel identifier to hand electron-updater.
 *
 * `'auto'` resolves to the running build's own channel, which is what makes the
 * setting safe to introduce: an install that was downloaded from a non-stable
 * channel keeps following it instead of being silently moved to stable on the
 * first launch after this ships. A literal `'stable'` default would strand
 * exactly the users the feature exists for.
 * @param setting - the stored preference.
 * @param runningVersion - `app.getVersion()`.
 * @returns the identifier, or undefined to leave electron-updater's own
 * derivation alone (an off-scheme version, which a dev run has).
 */
export function resolveUpdateChannel(
  setting: UpdateChannel,
  runningVersion: string,
): string | undefined {
  const scheme = schemeNumberOf(runningVersion)
  // Off-scheme: a dev build, or a version from before this scheme. Setting a
  // channel derived from a guessed scheme number would be worse than not
  // setting one, so let the updater derive what it can.
  if (scheme === undefined) return undefined
  if (setting === 'auto') return channelOf(runningVersion)
  return `${PREFIX[setting]}${scheme}`
}

/**
 * Whether switching to `target` from `runningVersion` moves away from stability.
 *
 * The caller needs this for what it tells the user, not for the updater —
 * assigning `autoUpdater.channel` already permits the downgrade. What it cannot
 * do is promise the way back, and that is the sentence a user deciding to try a
 * channel is owed.
 * @param target - the channel being switched to.
 * @param runningVersion - `app.getVersion()`.
 * @returns true when the target sorts below the running build's channel.
 */
export function isDowngradeSwitch(
  target: Exclude<UpdateChannel, 'auto'>,
  runningVersion: string,
): boolean {
  const current = channelOf(runningVersion)
  const next = resolveUpdateChannel(target, runningVersion)
  if (current === undefined || next === undefined) return false
  return next < current
}
