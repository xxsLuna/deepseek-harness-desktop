/**
 * The rule that decides how the harness stage installs.
 *
 * `harness.json` pins `@deepseek-ai/dsh` and nothing else, and upstream declares
 * its closure with caret ranges — so staging without a lockfile resolved ~500
 * packages afresh every run, and what shipped was whatever the registry meant
 * that hour.
 *
 * That is not a hypothetical. Measured on 2026-09-10, the pin said
 * `0.1.5-alpha.1` while every transitive `@deepseek-ai/*` resolved to
 * `0.1.5-rc.1`; four releases went out that way. **A relock the next morning,
 * same pin, resolved `0.1.5-rc.2`** — the closure moved inside a day with
 * nothing in the repo changing. Any question of the form "is the build I tested
 * the build that ships" had no answer at all.
 *
 * So the lock is the answer, and this is the rule around it. The case that
 * matters most is `stale`: a pin bump that edits `harness.json` and stops there
 * used to install a closure nobody had chosen, silently. It now fails by name.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockedPin, stageMode } from '../../scripts/harness-lock.mjs'

const root = join(import.meta.dirname, '..', '..')

describe('lockedPin', () => {
  it('reads the resolved entry, not the range that asked for it', () => {
    // The range is the question and the entry is the answer, and the drift this
    // guards lives exactly in the gap between them.
    const lock = {
      packages: {
        '': { dependencies: { '@deepseek-ai/dsh': '^0.1.5-alpha.1' } },
        'node_modules/@deepseek-ai/dsh': { version: '0.1.5-alpha.1' },
      },
    }
    expect(lockedPin(lock)).toBe('0.1.5-alpha.1')
  })

  it.each([undefined, null, 42, {}, { packages: {} }, { packages: { 'node_modules/@deepseek-ai/dsh': {} } }])(
    'answers undefined for %s rather than throwing',
    (lock) => {
      // A malformed lock has to reach the `bootstrap` branch, not take the
      // staging script down with a TypeError.
      expect(lockedPin(lock)).toBeUndefined()
    },
  )
})

describe('stageMode', () => {
  it('installs from the lock when it matches the pin', () => {
    expect(stageMode({ pin: '0.1.5-alpha.1', lockPin: '0.1.5-alpha.1', relock: false }))
      .toEqual({ mode: 'ci' })
  })

  it('refuses when the pin moved and the lock did not', () => {
    const decision = stageMode({ pin: '0.1.5-alpha.2', lockPin: '0.1.5-alpha.1', relock: false })
    expect(decision.mode).toBe('stale')
    // The message has to name both versions and the command, because the whole
    // point is that this used to be silent.
    expect(decision.message).toContain('0.1.5-alpha.2')
    expect(decision.message).toContain('0.1.5-alpha.1')
    expect(decision.message).toContain('npm run stage:relock')
  })

  it('re-resolves when asked, whatever the lock says', () => {
    expect(stageMode({ pin: '0.1.5-alpha.2', lockPin: '0.1.5-alpha.1', relock: true }))
      .toEqual({ mode: 'relock' })
    expect(stageMode({ pin: '0.1.5-alpha.1', lockPin: '0.1.5-alpha.1', relock: true }))
      .toEqual({ mode: 'relock' })
  })

  it('bootstraps when there is no lock to install from', () => {
    // Only reachable by deleting the committed file; a fresh checkout has one.
    expect(stageMode({ pin: '0.1.5-alpha.1', lockPin: undefined, relock: false }))
      .toEqual({ mode: 'bootstrap' })
  })
})

describe('the committed lock', () => {
  const lockPath = join(root, 'harness-lock.json')

  it('exists, because `npm run stage` installs from it', () => {
    expect(existsSync(lockPath), 'harness-lock.json is missing — run `npm run stage:relock`').toBe(true)
  })

  it('resolves the version harness.json pins', () => {
    // The same comparison the staging script makes, asserted here so it fails in
    // `npm test` rather than at the front of a five-target build.
    const pin = JSON.parse(readFileSync(join(root, 'harness.json'), 'utf8')) as { harness: string }
    const lock: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    expect(lockedPin(lock)).toBe(pin.harness)
  })

  it('locks the whole closure, not just the pinned package', () => {
    // ~500 packages is the point: pinning one of them is what let the other 499
    // move. A lock that had collapsed to a handful would mean the resolve is
    // happening somewhere else.
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { packages?: Record<string, unknown> }
    expect(Object.keys(lock.packages ?? {}).length).toBeGreaterThan(400)
  })
})
