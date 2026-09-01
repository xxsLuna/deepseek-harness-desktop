/**
 * The release channel vocabulary.
 *
 * Every rule here fails silently when wrong: a build resolves a channel nobody
 * publishes to and reports itself up to date forever, or resolves onto someone
 * else's channel and offers them a harness they did not ask for. Neither shows
 * an error, which is why the arithmetic is pinned rather than trusted.
 */
import { describe, expect, it } from 'vitest'
import {
  channelKindOf,
  channelOf,
  CHOOSABLE_CHANNELS,
  isDowngradeSwitch,
  resolveUpdateChannel,
  schemeNumberOf,
} from '../../src/update-channel.js'

const STABLE = '0.1.1-desktop-v0.2.3'
const DEVELOP = '0.1.1-desktop-dev0.2.0'
const ALPHA = '0.1.2-desktop-alpha0.3.0'

describe('channelOf', () => {
  it('reads the identifier off each channel', () => {
    expect(channelOf(STABLE)).toBe('desktop-v0')
    expect(channelOf(DEVELOP)).toBe('desktop-dev0')
    expect(channelOf(ALPHA)).toBe('desktop-alpha0')
  })

  it('refuses versions this scheme did not produce', () => {
    // Including the retired rc line, which must stay unreachable.
    for (const version of ['0.1.0-rc.7-1', '0.1.1', '0.1.1-desktop-v0', 'nonsense']) {
      expect(channelOf(version), version).toBeUndefined()
    }
  })
})

describe('channelKindOf', () => {
  it('maps each identifier back to its channel', () => {
    expect(channelKindOf(STABLE)).toBe('stable')
    expect(channelKindOf(DEVELOP)).toBe('develop')
    expect(channelKindOf(ALPHA)).toBe('alpha')
  })

  it('does not read desktop-dev as stable', () => {
    // The prefixes are not disjoint by accident of ordering alone — a shorter
    // match tried first would classify half the channels wrong, and the
    // symptom would be an install quietly following the wrong releases.
    expect(channelKindOf(DEVELOP)).not.toBe('stable')
  })
})

describe('schemeNumberOf', () => {
  it('carries the scheme number, never the channel', () => {
    expect(schemeNumberOf(STABLE)).toBe('0')
    expect(schemeNumberOf(DEVELOP)).toBe('0')
    expect(schemeNumberOf('0.1.1-desktop-alpha2.3.0')).toBe('2')
  })
})

describe('resolveUpdateChannel', () => {
  it('follows the running build when the setting is auto', () => {
    // The default, and the reason it is safe to ship this setting: a non-stable
    // install is not moved to stable on its first launch afterwards.
    expect(resolveUpdateChannel('auto', STABLE)).toBe('desktop-v0')
    expect(resolveUpdateChannel('auto', DEVELOP)).toBe('desktop-dev0')
    expect(resolveUpdateChannel('auto', ALPHA)).toBe('desktop-alpha0')
  })

  it('switches channel while carrying the scheme number across', () => {
    expect(resolveUpdateChannel('alpha', STABLE)).toBe('desktop-alpha0')
    expect(resolveUpdateChannel('stable', ALPHA)).toBe('desktop-v0')
    // The scheme number is the escape hatch, not a third axis: it comes from
    // the running version even when the channel changes.
    expect(resolveUpdateChannel('develop', '0.1.1-desktop-v7.2.0')).toBe('desktop-dev7')
  })

  it('leaves an off-scheme version to the updater', () => {
    // A dev run reports Electron's own version. Inventing a scheme number for
    // it would point the updater at a channel nobody publishes to, and the
    // symptom is an app that reports itself up to date forever.
    expect(resolveUpdateChannel('stable', '43.4.0')).toBeUndefined()
    expect(resolveUpdateChannel('auto', '43.4.0')).toBeUndefined()
  })

  it('resolves every choosable channel to a distinct identifier', () => {
    const resolved = CHOOSABLE_CHANNELS.map((c) => resolveUpdateChannel(c, STABLE))
    expect(new Set(resolved).size).toBe(CHOOSABLE_CHANNELS.length)
  })
})

describe('the identifiers themselves', () => {
  it('are not the names electron-updater reserves', () => {
    // GitHubProvider special-cases a channel by exact equality with "alpha" or
    // "beta". Naming ours plain `alpha` would opt into the alpha-to-beta
    // promotion branch instead of the custom-channel one.
    for (const channel of CHOOSABLE_CHANNELS) {
      const identifier = resolveUpdateChannel(channel, STABLE)
      expect(identifier, channel).toBeDefined()
      expect(['alpha', 'beta']).not.toContain(identifier)
    }
  })

  it('sort in stability order', () => {
    // Decides which switches are downgrades, and a wrong order would make the
    // stable channel look like a downgrade to everyone else.
    const alpha = resolveUpdateChannel('alpha', STABLE) ?? ''
    const develop = resolveUpdateChannel('develop', STABLE) ?? ''
    const stable = resolveUpdateChannel('stable', STABLE) ?? ''
    expect(alpha < develop).toBe(true)
    expect(develop < stable).toBe(true)
  })

  it('sort below the retired rc line, keeping those releases unreachable', () => {
    // AGENTS.md: releases before 0.1.0-desktop-v0.8.0 are deliberately
    // unreachable because `d` precedes `r`. `a` does too.
    for (const channel of CHOOSABLE_CHANNELS) {
      expect((resolveUpdateChannel(channel, STABLE) ?? '') < 'rc', channel).toBe(true)
    }
  })
})

describe('isDowngradeSwitch', () => {
  it('calls moving away from stability a downgrade', () => {
    expect(isDowngradeSwitch('develop', STABLE)).toBe(true)
    expect(isDowngradeSwitch('alpha', STABLE)).toBe(true)
    expect(isDowngradeSwitch('alpha', DEVELOP)).toBe(true)
  })

  it('does not call moving toward it one', () => {
    expect(isDowngradeSwitch('stable', ALPHA)).toBe(false)
    expect(isDowngradeSwitch('develop', ALPHA)).toBe(false)
    expect(isDowngradeSwitch('stable', STABLE)).toBe(false)
  })

  it('says no rather than guessing for an off-scheme build', () => {
    expect(isDowngradeSwitch('alpha', '43.4.0')).toBe(false)
  })
})
