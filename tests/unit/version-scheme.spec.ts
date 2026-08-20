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
 * Releases published under the current scheme, newest last. Append the outgoing
 * version when cutting a release; the assertions read the new one from
 * package.json, so whatever a bump writes there is checked automatically.
 */
const PUBLISHED: readonly string[] = []

/** `0.1.0-desktop-v<ours>.<upstream rc>.<our build>` */
const version = (ours: number, upstream: number, build: number): string =>
  `0.1.0-desktop-v${ours}.${upstream}.${build}`

describe('the shipping version', () => {
  it('is the shape the scheme describes', () => {
    // 0.1.0 is upstream's own version and stays put — the desktop build is
    // tracked entirely inside the pre-release part, so the number in front
    // still says which harness this is.
    expect(shipping).toMatch(/^0\.1\.0-desktop-v\d+\.\d+\.\d+$/)
  })

  it('is reachable from every release published under this scheme', () => {
    for (const published of PUBLISHED) {
      expect(isNewerVersion(shipping, published), `${shipping} must be newer than ${published}`).toBe(true)
    }
  })

  it('is not reachable from the pre-scheme releases, by design', () => {
    // Asserted rather than merely documented: if this ever starts passing, the
    // scheme has drifted back into the rc line and the ordering guarantees
    // below no longer describe what ships.
    for (const old of PRE_SCHEME) {
      expect(isNewerVersion(shipping, old), `${shipping} vs ${old}`).toBe(false)
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

  it('lets the leading desktop number override everything after it', () => {
    // The escape hatch, if the scheme itself ever needs to change again.
    expect(isNewerVersion(version(1, 0, 0), version(0, 99, 99))).toBe(true)
  })

  it('never inverts across a wide sweep', () => {
    // The old scheme looked fine on the cases anyone thought to try and broke on
    // the first two-digit number. This checks every ordered pair instead.
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
