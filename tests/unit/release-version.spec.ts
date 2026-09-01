/**
 * The derivation the automated upstream bump runs, and the record it leaves.
 *
 * `watch-upstream.yml` used to write upstream's bare version into
 * `package.json`, which `version-scheme.spec.ts` rejects on sight — so the daily
 * bump PR arrived red every time and the same two edits were made by hand before
 * its checks said anything about the harness. These assertions are what let that
 * be automatic: they pin the derivation, the ordering guard it makes without
 * `semver` (the workflow has no install step), and the coupling to the exact
 * line in the sibling spec that the bump rewrites.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// The authority on ordering, so ours is only ever allowed to agree with it.
import { gt } from 'semver'
import { describe, expect, it } from 'vitest'
import { appendPublished, deriveReleaseVersion } from '../../scripts/release-version.mjs'
import { isNewerVersion } from '../../src/update-gate.js'

const root = join(import.meta.dirname, '..', '..')
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

const pinned = (JSON.parse(read('harness.json')) as { harness: string }).harness
const shipping = (JSON.parse(read('package.json')) as { version: string }).version
const schemeSpec = read('tests', 'unit', 'version-scheme.spec.ts')

describe('the shipping version against the pin it was cut for', () => {
  it('carries upstream core and rc number unchanged', () => {
    // Both fields are upstream's, so a shipping version that disagrees with
    // harness.json means one of the two moved alone. Only the build counter is
    // this shell's to choose, which is why it is not compared here.
    const [, core, rc] = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/.exec(pinned) ?? []
    expect(core, `harness.json pins '${pinned}', which is not the shape upstream publishes`).toBeDefined()
    expect(shipping).toMatch(new RegExp(`^${core!.replace(/\./g, '\\.')}-desktop-v\\d+\\.${rc!}\\.\\d+$`))
  })
})

describe('deriveReleaseVersion', () => {
  it('reads the rc number out of upstream and the scheme number out of what ships', () => {
    expect(deriveReleaseVersion('0.1.1-rc.3', '0.1.1-desktop-v0.2.0')).toBe('0.1.1-desktop-v0.3.0')
  })

  it('never invents the scheme number', () => {
    // That identifier is electron-updater's channel: moving it strands the whole
    // installed base for one release, so it is a migration someone announces by
    // hand and never something a nightly job does on its way past.
    expect(deriveReleaseVersion('0.1.1-rc.3', '0.1.1-desktop-v1.2.0')).toBe('0.1.1-desktop-v1.3.0')
    expect(deriveReleaseVersion('0.1.1-rc.3', '0.1.1-desktop-v9.2.0')).toBe('0.1.1-desktop-v9.3.0')
  })

  it('never moves the scheme field, which is the whole reason its guard can count', () => {
    // The ordering guard inside the script compares fields numerically, and that
    // only agrees with semver while the scheme numbers are equal: semver reads
    // `desktop-v<scheme>` as text, so `desktop-v10` ranks BELOW `desktop-v9`.
    // Deriving can never reach that disagreement, and this is what says so.
    const scheme = (v: string) => /-desktop-v(\d+)\./.exec(v)?.[1]
    for (const previous of ['0.1.1-desktop-v0.2.0', '0.1.1-desktop-v9.2.0', '0.1.1-desktop-v10.2.0']) {
      expect(scheme(deriveReleaseVersion('0.1.1-rc.3', previous))).toBe(scheme(previous))
    }
  })

  it('starts the build counter over, because it belongs to one harness version', () => {
    expect(deriveReleaseVersion('0.1.1-rc.3', '0.1.1-desktop-v0.2.7')).toBe('0.1.1-desktop-v0.3.0')
  })

  it('moves upstream core when upstream does', () => {
    expect(deriveReleaseVersion('0.2.0-rc.1', '0.1.1-desktop-v0.2.0')).toBe('0.2.0-desktop-v0.1.0')
  })

  it('keeps two-digit rc numbers in their own field', () => {
    // The retired scheme broke on exactly this: give the rc number its own
    // all-digits field and 10 outranks 9, fuse it with anything and it does not.
    const derived = deriveReleaseVersion('0.1.1-rc.10', '0.1.1-desktop-v0.9.0')
    expect(derived).toBe('0.1.1-desktop-v0.10.0')
    expect(gt(derived, '0.1.1-desktop-v0.9.0')).toBe(true)
  })

  it('refuses a stable upstream release, rather than inventing an rc number', () => {
    expect(() => deriveReleaseVersion('0.2.0', '0.1.1-desktop-v0.2.0')).toThrow(/cannot read a pre-release number/)
  })

  it('refuses a shipping version that carries no scheme number', () => {
    // The state this whole change removes: the bare upstream version sitting in
    // package.json, with nothing to carry across.
    expect(() => deriveReleaseVersion('0.1.1-rc.3', '0.1.1-rc.2')).toThrow(/is not '<x\.y\.z>-desktop-<channel>/)
  })

  it('refuses to derive a version that does not outrank what ships', () => {
    // The watch only opens a PR when upstream leads the pin, so reaching this
    // means those two disagree — which is worth a red job, not a silent release
    // nobody can be offered.
    expect(() => deriveReleaseVersion('0.1.1-rc.2', '0.1.1-desktop-v0.2.0')).toThrow(/does not outrank/)
    expect(() => deriveReleaseVersion('0.1.1-rc.1', '0.1.1-desktop-v0.2.0')).toThrow(/does not outrank/)
  })

  it('orders its results the way semver and the update gate both do', () => {
    // The guard inside the script is hand-rolled, because watch-upstream.yml
    // runs it with no `npm install` and `semver` is a devDependency. This is the
    // only place that claim gets checked against the real comparators.
    const previous = '0.1.1-desktop-v0.2.0'
    const upstreams = ['0.1.1-rc.3', '0.1.1-rc.9', '0.1.1-rc.10', '0.1.1-rc.99', '0.1.2-rc.1', '0.2.0-rc.1', '1.0.0-rc.1']
    for (const upstream of upstreams) {
      const derived = deriveReleaseVersion(upstream, previous)
      expect(gt(derived, previous), `${derived} !> ${previous} per semver`).toBe(true)
      expect(isNewerVersion(derived, previous), `${derived} !> ${previous} per the update gate`).toBe(true)
    }
  })

  it('produces a reachable version of the right shape for whatever leads the pin', () => {
    // The upstreams are built off the live pin rather than written down, so this
    // keeps testing the real next bump instead of colliding with the shipping
    // version the last one wrote.
    const [, core, rc] = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/.exec(pinned) ?? []
    for (const ahead of [1, 2, 8]) {
      const derived = deriveReleaseVersion(`${core!}-rc.${Number(rc!) + ahead}`, shipping)
      expect(derived).toMatch(/^\d+\.\d+\.\d+-desktop-v\d+\.\d+\.\d+$/)
      expect(gt(derived, shipping), `${derived} !> ${shipping}`).toBe(true)
    }
  })
})

describe('appendPublished', () => {
  it('records a version in the real PUBLISHED array', () => {
    // Read against the actual file rather than a fixture: the bump rewrites this
    // exact line, so a reformat that breaks the rewrite has to fail here — in
    // the suite that runs on every PR — and not months later in a nightly job.
    const next = appendPublished(schemeSpec, '9.9.9-desktop-v0.1.0')
    expect(next).toContain(`, '9.9.9-desktop-v0.1.0']`)
    expect(next.split('\n').length).toBe(schemeSpec.split('\n').length)
  })

  it('leaves the file alone when the version is already recorded', () => {
    expect(appendPublished(schemeSpec, shipping)).toBe(schemeSpec)
  })

  it('refuses a file whose PUBLISHED array is not the one line it expects', () => {
    // A silent no-op here would ship a release the next bump is never compared
    // against, which is the hole `version-scheme.spec.ts` added its PUBLISHED
    // assertion to close.
    expect(() => appendPublished('const PUBLISHED = []', 'x')).toThrow(/found 0/)
    expect(() => appendPublished(`${schemeSpec}\n${schemeSpec}`, 'x')).toThrow(/found 2/)
  })
})
