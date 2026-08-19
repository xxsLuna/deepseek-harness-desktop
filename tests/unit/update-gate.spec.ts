import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isNewerVersion, updateMode } from '../../src/update-gate.js'

describe('updateMode', () => {
  it('disables updates in dev', () => {
    expect(updateMode({ platform: 'darwin', packaged: false, macUpdatesSigned: false })).toBe('disabled')
    expect(updateMode({ platform: 'win32', packaged: false, macUpdatesSigned: false })).toBe('disabled')
  })

  it('auto-updates Windows and Linux regardless of signing', () => {
    expect(updateMode({ platform: 'win32', packaged: true, macUpdatesSigned: false })).toBe('auto')
    expect(updateMode({ platform: 'linux', packaged: true, macUpdatesSigned: false })).toBe('auto')
  })

  it('falls back to notify-only on unsigned macOS', () => {
    expect(updateMode({ platform: 'darwin', packaged: true, macUpdatesSigned: false })).toBe('notify-only')
  })

  it('auto-updates macOS once the build is signed', () => {
    expect(updateMode({ platform: 'darwin', packaged: true, macUpdatesSigned: true })).toBe('auto')
  })
})

describe('isNewerVersion', () => {
  it('answers "is the feed ahead", not "does it differ"', () => {
    // The regression that found this: a re-release of the same harness bumps
    // the app to 0.1.0-rc.6-2, and the published feed is still 0.1.0-rc.6. A
    // "differs" test nags the newer build — and on the notify-only path that
    // is a modal dialog at startup with nothing newer behind it.
    expect(isNewerVersion('0.1.0-rc.6', '0.1.0-rc.6-2')).toBe(false)
    expect(isNewerVersion('0.1.0-rc.6-2', '0.1.0-rc.6')).toBe(true)
    expect(isNewerVersion('0.1.0-rc.6', '0.1.0-rc.6')).toBe(false)
  })

  it('compares the numeric core first', () => {
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false)
    expect(isNewerVersion('0.1.2', '0.1.2')).toBe(false)
  })

  it('ranks a release above any pre-release of the same core', () => {
    expect(isNewerVersion('0.1.0', '0.1.0-rc.1')).toBe(true)
    expect(isNewerVersion('0.1.0-rc.1', '0.1.0')).toBe(false)
  })

  it('compares pre-release identifiers per semver precedence', () => {
    expect(isNewerVersion('0.1.0-rc.7', '0.1.0-rc.6')).toBe(true)
    // Numeric, not lexical: 10 is above 9.
    expect(isNewerVersion('0.1.0-rc.10', '0.1.0-rc.9')).toBe(true)
    expect(isNewerVersion('0.1.0-beta', '0.1.0-alpha')).toBe(true)
    // More identifiers wins when everything before is equal.
    expect(isNewerVersion('0.1.0-rc.1.1', '0.1.0-rc.1')).toBe(true)
    expect(isNewerVersion('0.1.0-rc.1', '0.1.0-rc.1.1')).toBe(false)
  })

  it('never claims an unreadable feed is newer', () => {
    for (const remote of ['', '   ', 'latest', 'v', 'not.a.version']) {
      expect(isNewerVersion(remote, '0.1.0-rc.6'), remote).toBe(false)
    }
  })

  it('ignores a leading v and build metadata', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0+build.9', '0.1.0')).toBe(false)
  })
})

/**
 * Every version published BEFORE the one in package.json, oldest first.
 *
 * A release that is not newer than ALL of these is unreachable, because a client
 * compares the feed against the version IT is running — not against the highest
 * one ever shipped. Someone still on the oldest build has to be able to move.
 *
 * When bumping package.json for the next release, append the version being
 * superseded. That is the only manual step: the assertion below reads the new
 * version from the manifest, so it is checked against this list automatically —
 * which is the point, because the bump that caused all this was automated.
 */
const PUBLISHED = ['0.1.0-rc.6', '0.1.0-rc.6-2', '0.1.0-rc.6-3']

/** The version this working tree would ship, straight from the manifest. */
const shipping = (JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string }).version

describe('release version reachability', () => {
  it('refuses the version the build-counter convention would have produced next', () => {
    // The trap, and the reason this whole block exists. README's rule is that the
    // app version tracks upstream exactly, so upstream 0.1.0-rc.7 reads as app
    // version `0.1.0-rc.7`. That version can never reach a 0.1.0-rc.6-3 client.
    //
    // The build counter is appended with a HYPHEN, so `0.1.0-rc.6-3` splits its
    // pre-release on dots into ['rc', '6-3'] — and '6-3' is a NON-numeric
    // identifier, which semver ranks ABOVE the numeric '7' in ['rc', '7'].
    // electron-updater's own semver gate agrees, so this is not just our
    // comparator being strict: Windows and Linux would refuse it too.
    expect(isNewerVersion('0.1.0-rc.7', '0.1.0-rc.6-3')).toBe(false)
    // Same shape, same outcome, one identifier deeper — a dotted counter does
    // not rescue it either, because the numeric '7' still loses to '6-3'.
    expect(isNewerVersion('0.1.0-rc.7.1', '0.1.0-rc.6-3')).toBe(false)
  })

  it('ships a version every published build can reach', () => {
    // The guard that matters, and the one that catches the mistake above before it
    // reaches a user rather than after. Reads package.json rather than a literal,
    // so it covers whatever the next bump writes there — including an automated
    // one, which is exactly where the bare-upstream version came from.
    for (const published of PUBLISHED) {
      expect(isNewerVersion(shipping, published), `${shipping} must be newer than ${published}`).toBe(true)
    }
  })

  it('names the boundary where the counter convention runs out', () => {
    // Non-numeric identifiers compare as strings, so the counter survives single
    // digits and fails at the first double-digit upstream: '10-1' < '9-1'.
    expect(isNewerVersion('0.1.0-rc.8-1', '0.1.0-rc.7-1')).toBe(true)
    expect(isNewerVersion('0.1.0-rc.9-1', '0.1.0-rc.8-1')).toBe(true)
    expect(isNewerVersion('0.1.0-rc.10-1', '0.1.0-rc.9-1')).toBe(false)
    // The escape, for whoever reaches upstream rc.10: leave the pre-release line
    // entirely. A release outranks every pre-release of any core below it, so
    // this is reachable from everything above and has no ordering traps left.
    for (const published of [...PUBLISHED, '0.1.0-rc.7-1', '0.1.0-rc.9-1']) {
      expect(isNewerVersion('0.2.0', published), published).toBe(true)
    }
  })
})
