import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the chrome package
import { chromeBlock, injectDesktopChrome } from '../../packages/chrome/lib/block.js'

/** The band a merged-title-bar platform serves. */
const WINDOWS_BAND = { height: 38, lead: 0, menuButton: true }

describe('injectDesktopChrome', () => {
  it('appends the chrome block at the end of body, after head-injected sheets', () => {
    const html = '<html><head><style>a{}</style></head><body><div id="root"></div></body></html>'
    const out: string = injectDesktopChrome(html, chromeBlock(WINDOWS_BAND))
    // Position matters: client plugin CSS lands in <head> at runtime and would
    // otherwise win the cascade at equal specificity.
    expect(out.indexOf('data-dsh-desktop-chrome')).toBeGreaterThan(out.indexOf('<div id="root">'))
    expect(out.endsWith('</body></html>')).toBe(true)
  })

  it('appends to a document with no body element', () => {
    expect(injectDesktopChrome('<div id="root"></div>', chromeBlock(WINDOWS_BAND))).toContain('data-dsh-desktop-chrome')
  })

  it('carries the column inset, the drag strip, and the fullscreen collapse', () => {
    const block: string = chromeBlock(WINDOWS_BAND)
    for (const needle of [
      '_sidebarCol',
      '_centerCol',
      '_detailsCol',
      'padding-top: var(--dsh-title-band)',
      'box-sizing: border-box',
      '-webkit-app-region: drag',
      "data-dsh-fullscreen='true'",
      "id = 'dsh-drag-strip'",
      '--dsh-title-band',
      // The strip stops where a window-controls overlay starts, so it never
      // claims a drag region under native caption buttons.
      '--dsh-titlebar-area-width',
      // The band's own controls.
      "id = 'dsh-title-controls'",
      "'dsh-menu-button'",
      "'dsh-nav-back'",
      "'dsh-nav-forward'",
      '/__desktop-host/chrome/',
    ]) {
      expect(block).toContain(needle)
    }
  })

  it('bakes the band it was configured with, not a runtime attribute', () => {
    // Publishing this at runtime would flash an unbanded layout on every load;
    // a platform keeping its native title bar must get no inset at all.
    const windows: string = chromeBlock(WINDOWS_BAND)
    expect(windows).toContain('--dsh-title-band:var(--dsh-title-band-wco,38px)')
    expect(windows).toContain('--dsh-title-band-lead:0px')
    expect(windows).toContain('--dsh-title-menu-display:inline-flex')

    // macOS keeps its own always-on menu bar and floats the traffic lights
    // over the left of the band, so: no menu button, and a leading inset.
    const mac: string = chromeBlock({ height: 38, lead: 78, menuButton: false })
    expect(mac).toContain('--dsh-title-band-lead:78px')
    expect(mac).toContain('--dsh-title-menu-display:none')
  })

  it('emits a length, never NaN, for a field it cannot use', () => {
    // A `NaNpx` takes its whole declaration with it, so the band would inset
    // by nothing while still claiming to exist.
    for (const band of [{}, { height: 0 }, { height: -1 }, { height: '38' }, { height: Number.NaN }]) {
      expect(chromeBlock(band), JSON.stringify(band)).toContain('--dsh-title-band:var(--dsh-title-band-wco,0px)')
    }
    expect(chromeBlock({ height: 38, lead: Number.NaN })).toContain('--dsh-title-band-lead:0px')
    expect(chromeBlock({ height: 38 })).not.toContain('NaN')
  })

  it('keeps the overlay reading off the property the fullscreen collapse owns', () => {
    // A Window Controls Overlay reports its real geometry, and the page script
    // writes it as an INLINE style. Writing --dsh-title-band itself would
    // outrank the fullscreen rule, which is a stylesheet rule on the same
    // element — leaving a 38px band with no window controls in it.
    const block: string = chromeBlock(WINDOWS_BAND)
    expect(block).toContain("setProperty('--dsh-title-band-wco'")
    expect(block).not.toContain("setProperty('--dsh-title-band'")
  })

  it('never uses a top margin for the inset', () => {
    // A top margin collapses through #root and body, pushing body down and
    // adding a viewport scrollbar — the defect this replaced.
    expect(chromeBlock(WINDOWS_BAND)).not.toMatch(/margin-top\s*:/)
  })
})
