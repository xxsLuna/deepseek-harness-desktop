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

  it('keeps the sidebar fill out of the band only where the controls overhang it', () => {
    // macOS puts the traffic lights at x=14..66 over the band. Collapsed, the
    // sidebar is a 56px rail, so the boundary between its fill and the content
    // runs up between the yellow light and the green one; expanded, they sit
    // well inside it and the column must be left as upstream draws it.
    const mac: string = chromeBlock({ height: 38, lead: 78, menuButton: false })
    expect(mac).toContain('[data-dsh-rail-under-controls]')
    // A background layer, never a mask: a mask takes the column's CONTENT with
    // it and the rail's first icon comes out faded.
    expect(mac).toContain('background-image')
    expect(mac).not.toContain('mask-image')
    // The cover is the colour the band is actually painted, hit-tested by the
    // script rather than stated here, so it follows the theme.
    expect(mac).toContain('var(--dsh-band-fill')
    expect(mac).toContain('--dsh-band-fill\', `rgb(')
    // Fading out a band below the band, not stopping at its edge: a hard stop
    // only trades the vertical boundary for a horizontal one.
    expect(mac).toContain('calc(var(--dsh-title-band) * 2)')
    // The collapse state is measured, not baked — it is not a platform fact —
    // so the script has to publish what the sheet keys off.
    expect(mac).toContain('data-dsh-rail-under-controls')
    // The default padding-box would land the hairline a pixel inside the
    // border box the transparent border still reserves.
    expect(mac).toContain('background-origin: border-box')
    // A theme swap is not atomic, and a colour that is painted cannot latch a
    // mid-change reading the way a glyph choice could: the sample is repeated
    // once the change has settled.
    expect(mac).toContain('requestAnimationFrame(publishScheme)')
    expect(mac).toContain('setTimeout(publishScheme, 300)')
    // Only a fully opaque surface counts: the modal scrim is rgba(0,0,0,0.5)
    // and covers the sample point, and it stands exactly while the theme is
    // being changed.
    expect(mac).toContain('Number(parts[3]) < 1')

    // Windows draws its caption buttons on the trailing edge and reports no
    // lead, so nothing overhangs the sidebar and the sheet never ships.
    expect(chromeBlock(WINDOWS_BAND)).not.toContain('[data-dsh-rail-under-controls]')
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
