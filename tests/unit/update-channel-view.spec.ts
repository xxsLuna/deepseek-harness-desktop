/**
 * What the settings page is told about the channel.
 *
 * Resolved in the launcher so the rule has one implementation; asserted here
 * because every field is invisible when wrong. A wrong `effective` shows a
 * channel the install is not on, and a wrong `downgrades` either warns about a
 * safe switch or stays quiet about one that needs a manual download to undo.
 */
import { describe, expect, it } from 'vitest'
import { updateChannelView } from '../../src/settings-host.js'

const STABLE = '0.1.1-desktop-v0.2.3'
const ALPHA = '0.1.2-desktop-alpha0.3.0'

describe('updateChannelView', () => {
  it('shows an unchosen install the channel it is actually on', () => {
    // The reason 'auto' is the default: someone who downloaded an alpha build
    // and never opened this page is on alpha, and the page has to say alpha.
    expect(updateChannelView('auto', ALPHA).effective).toBe('alpha')
    expect(updateChannelView('auto', STABLE).effective).toBe('stable')
  })

  it('shows a chosen channel even before the switch has taken effect', () => {
    // Chosen on a stable build, the next check follows alpha while the running
    // version is still stable. The page must read as the choice, not the build.
    const view = updateChannelView('alpha', STABLE)
    expect(view.effective).toBe('alpha')
    expect(view.resolved).toBe('desktop-alpha0')
  })

  it('warns only about the switches that move away from stability', () => {
    expect(updateChannelView('auto', STABLE).downgrades).toEqual(['develop', 'alpha'])
    // From alpha there is nowhere further down, so nothing is warned about.
    expect(updateChannelView('auto', ALPHA).downgrades).toEqual([])
  })

  it('never warns about the channel you are already on', () => {
    for (const version of [STABLE, ALPHA]) {
      const view = updateChannelView('auto', version)
      expect(view.downgrades, version).not.toContain(view.effective)
    }
  })

  it('says nothing at all for a dev build', () => {
    // An off-scheme version has no channel, and the page hides the control
    // rather than offering a switch that would resolve to nothing.
    const view = updateChannelView('auto', '43.4.0')
    expect(view.effective).toBeUndefined()
    expect(view.resolved).toBeUndefined()
    expect(view.downgrades).toEqual([])
  })
})
