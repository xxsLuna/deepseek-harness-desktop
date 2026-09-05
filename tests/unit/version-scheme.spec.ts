/**
 * The release version scheme, and the ordering it has to keep.
 *
 * A version that is not newer than the one a client is running is never
 * offered — silently, because the client compares against ITS version and both
 * this app's gate and electron-updater's semver agree. So the scheme is not a
 * naming preference; it is the thing that decides whether an update ships at
 * all. These assertions are what stop a bump from writing a version nobody can
 * reach.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// electron-updater's own semver, so the channel this reads is the one
// GitHubProvider reads when it decides whether to offer a tag.
import { prerelease } from 'semver'
import { isNewerVersion } from '../../src/update-gate.js'

/** The version this working tree would ship, straight from the manifest. */
const shipping = (JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string }).version

/**
 * Releases from before the scheme changed, newest last.
 *
 * These are deliberately NOT reachable from the current scheme and that is not
 * a bug to fix. They were named `0.1.0-rc.<n>[-<build>]`, so semver reads their
 * first pre-release identifier as `rc` — and `desktop-v0` sorts below `rc`
 * because `d` precedes `r`. Every install on one of them needs one manual
 * download; after that it is inside the scheme below and updates normally.
 *
 * Kept here rather than deleted because the asymmetry is surprising enough that
 * someone will eventually try to "fix" it by renaming back into the rc line.
 */
const PRE_SCHEME = ['0.1.0-rc.6', '0.1.0-rc.6-2', '0.1.0-rc.6-3', '0.1.0-rc.7-1']

/**
 * Releases published under the current scheme, newest last.
 *
 * The upstream bump appends to this in the same commit that writes the version
 * (`scripts/release-version.mjs`), so the list never lags a release behind. That
 * is only possible because the assertions read the shipping version from
 * package.json and skip its own entry — adding the current version used to fail
 * the reachability check, since nothing is newer than itself.
 */
const PUBLISHED: readonly string[] = ['0.1.0-desktop-v0.8.0', '0.1.0-desktop-v0.8.1', '0.1.1-desktop-v0.2.0', '0.1.1-desktop-v0.2.1', '0.1.1-desktop-v0.2.2', '0.1.1-desktop-v0.2.3', '0.1.1-desktop-v0.2.4']

/**
 * The same, per channel, and separate on purpose.
 *
 * The reachability assertion below requires the shipping version to outrank
 * every entry, and that is FALSE across channels by design: `desktop-alpha0`
 * sorts below `desktop-v0`, so a correct stable release does not outrank a
 * correct alpha one and never should. Merging these lists would turn a correct
 * release into a failing test, and the fix someone would reach for is deleting
 * the assertion that catches an unreachable version.
 *
 * `scripts/release-version.mjs` writes into whichever list matches the channel
 * it was given.
 */
const PUBLISHED_DEV: readonly string[] = ['0.1.1-desktop-dev0.2.0', '0.1.1-desktop-dev0.2.1']
const PUBLISHED_ALPHA: readonly string[] = []

/** Every channel's list, by the identifier its versions carry. */
const PUBLISHED_BY_CHANNEL: Record<string, readonly string[]> = {
  'desktop-v0': PUBLISHED,
  'desktop-dev0': PUBLISHED_DEV,
  'desktop-alpha0': PUBLISHED_ALPHA,
}

/** `0.1.0-desktop-v<ours>.<upstream rc>.<our build>` */
const version = (ours: number, upstream: number, build: number): string =>
  `0.1.0-desktop-v${ours}.${upstream}.${build}`

describe('the shipping version', () => {
  it('is the shape the scheme describes', () => {
    // The number in front is upstream's own, so it MOVES when upstream's does
    // — it is never ours to invent, and it is not frozen. This read `0.1.0`
    // literally while upstream stayed there, which held until upstream shipped
    // 0.1.1.
    //
    // Moving it is not cosmetic. The second pre-release field is upstream's rc
    // number, and 0.1.1 restarted that count at 1: keeping `0.1.0` in front
    // would have made `0.1.0-desktop-v0.2.0` compare OLDER than the shipped
    // `0.1.0-desktop-v0.8.1` (2 < 8) and reached nobody. The leading number is
    // what carries the ordering across an upstream minor bump.
    expect(shipping).toMatch(/^\d+\.\d+\.\d+-desktop-(?:v|dev|alpha)\d+\.\d+\.\d+$/)
    // The channel is the first pre-release identifier and must not drift:
    // electron-updater offers a tag only to installs on the same channel. It
    // may now be any of the three, but it must be one this repo publishes to —
    // a typo here is a build that reports itself up to date forever.
    expect(Object.keys(PUBLISHED_BY_CHANNEL)).toContain(prerelease(shipping)?.[0])
  })

  it('is reachable from every earlier release on ITS OWN channel', () => {
    // Its own, not all of them: across channels the comparison is backwards by
    // design, and asserting it would fail a correct release.
    const own = PUBLISHED_BY_CHANNEL[String(prerelease(shipping)?.[0])] ?? []
    const earlier = own.filter((published) => published !== shipping)
    for (const published of earlier) {
      expect(isNewerVersion(shipping, published), `${shipping} must be newer than ${published}`).toBe(true)
    }
  })

  it('is listed in PUBLISHED', () => {
    // The list is the guard for the NEXT bump, and it is only useful if cutting
    // a release actually appends to it. The automated bump does. Asserting it
    // here is what still catches a cut made by hand — and an automated one whose
    // rewrite of that line matched nothing and moved on.
    const channel = String(prerelease(shipping)?.[0])
    const own = PUBLISHED_BY_CHANNEL[channel] ?? []
    expect(own, `add '${shipping}' to the ${channel} list; scripts/release-version.mjs does this for an automated bump`).toContain(shipping)
  })

  it('records each channel only in its own list', () => {
    // A version filed under the wrong channel would be compared against
    // versions it is not ordered against, and the failure would look like a
    // scheme bug rather than a filing mistake.
    for (const [channel, list] of Object.entries(PUBLISHED_BY_CHANNEL)) {
      for (const published of list) {
        expect(prerelease(published)?.[0], published).toBe(channel)
      }
    }
  })

  it('is fenced from the pre-scheme releases by the CHANNEL, not by the comparator', () => {
    // This assertion used to read "not reachable", and it held for an
    // incidental reason: while the leading number stayed 0.1.0, `desktop-v0`
    // sorted below `rc` and the comparator said no. Upstream's move to 0.1.1
    // ends that — 0.1.1 beats 0.1.0 before the pre-release part is even read.
    //
    // What actually strands those installs is the channel, which is the first
    // pre-release identifier: electron-updater's GitHubProvider selects a tag
    // only when its channel equals the running build's, so an `rc` install
    // never sees a `desktop-v0` tag however semver ranks it. That was always
    // the real fence; the comparator agreeing was a coincidence of the
    // numbers, and pinning a coincidence is how a test starts lying.
    //
    // The remaining effect is on the macOS notify path, which is the only
    // thing isNewerVersion drives: an unsigned macOS build still on an `rc`
    // release is now TOLD a newer version exists. That is true, and pointing
    // it at the releases page is better than silence.
    for (const old of PRE_SCHEME) {
      expect(prerelease(old)?.[0], `${old} is not on the retired rc channel`).toBe('rc')
      expect(prerelease(shipping)?.[0]).not.toBe(prerelease(old)?.[0])
    }
  })
})

describe('version scheme ordering', () => {
  it('compares the upstream number numerically, not as text', () => {
    // The whole reason for the dots. In the old scheme the upstream number sat
    // inside a hyphenated identifier, which semver compares as TEXT — so
    // `rc.10-1` sorted BELOW `rc.9-1` ('1' < '9') and a release after rc.9
    // would have reached nobody. Its own dotted field is compared as a number.
    expect(isNewerVersion(version(0, 10, 0), version(0, 9, 0))).toBe(true)
    expect(isNewerVersion(version(0, 20, 0), version(0, 9, 0))).toBe(true)
    expect(isNewerVersion(version(0, 100, 0), version(0, 99, 0))).toBe(true)
  })

  it('compares our own build number numerically too', () => {
    expect(isNewerVersion(version(0, 8, 1), version(0, 8, 0))).toBe(true)
    expect(isNewerVersion(version(0, 8, 10), version(0, 8, 9))).toBe(true)
  })

  it('lets the leading desktop number override everything after it, up to 9', () => {
    // The escape hatch, if the scheme itself ever needs to change again.
    expect(isNewerVersion(version(1, 0, 0), version(0, 99, 99))).toBe(true)
    expect(isNewerVersion(version(9, 0, 0), version(8, 99, 99))).toBe(true)
  })

  it('is honest that the leading number is NOT a third numeric axis', () => {
    // It is fused into the text field — semver reads the pre-release of
    // 0.1.0-desktop-v0.8.0 as ['desktop-v0', 8, 0], so the leading number is
    // compared character by character with the word, not as a number. The other
    // two escaped that by being dot-separated; this one did not.
    //
    // Asserted rather than left to be discovered, because the sweep below
    // deliberately stops at 1 and would otherwise read as full coverage. The
    // field is an escape hatch meant to move roughly never; if it ever has to
    // reach 10, the scheme needs a different shape and this test will say so.
    expect(isNewerVersion(version(10, 0, 0), version(9, 0, 0))).toBe(false)
  })

  it('never inverts across a wide sweep', () => {
    // The old scheme looked fine on the cases anyone thought to try and broke on
    // the first two-digit number. This checks every ordered pair instead —
    // across two-digit upstream numbers and two-digit build numbers, which are
    // the two fields that actually move. `ours` stays single-digit on purpose;
    // its limit is asserted above rather than swept here.
    const sweep: string[] = []
    for (const ours of [0, 1]) {
      for (const upstream of [7, 8, 9, 10, 11, 19, 20, 99]) {
        for (const build of [0, 1, 2, 9, 10, 11, 99]) sweep.push(version(ours, upstream, build))
      }
    }
    const inversions: string[] = []
    for (let later = 0; later < sweep.length; later += 1) {
      for (let earlier = 0; earlier < later; earlier += 1) {
        if (!isNewerVersion(sweep[later]!, sweep[earlier]!)) inversions.push(`${sweep[later]!} !> ${sweep[earlier]!}`)
        if (isNewerVersion(sweep[earlier]!, sweep[later]!)) inversions.push(`${sweep[earlier]!} > ${sweep[later]!}`)
      }
    }
    expect(inversions).toEqual([])
  })

  it('stays valid semver, so electron-updater reads it the same way', () => {
    // Our comparator only drives the macOS notify path; Windows and Linux go
    // through electron-updater's own semver. A version it cannot parse would
    // strand exactly the platforms that auto-update.
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/
    expect(shipping).toMatch(semver)
    for (const candidate of [version(0, 8, 0), version(0, 10, 3), version(1, 0, 0)]) {
      expect(candidate, candidate).toMatch(semver)
    }
  })
})
