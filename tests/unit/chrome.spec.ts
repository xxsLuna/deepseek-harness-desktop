import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the bundle package
import { chromeBlock, injectDesktopChrome } from '../../packages/bundle/lib/chrome.js'

describe('injectDesktopChrome', () => {
  it('appends the chrome block at the end of body, after head-injected sheets', () => {
    const html = '<html><head><style>a{}</style></head><body><div id="root"></div></body></html>'
    const out = injectDesktopChrome(html)
    // Position matters: client plugin CSS lands in <head> at runtime and would
    // otherwise win the cascade at equal specificity.
    expect(out.indexOf('data-dsh-desktop-chrome')).toBeGreaterThan(out.indexOf('<div id="root">'))
    expect(out.endsWith('</body></html>')).toBe(true)
  })

  it('appends to a document with no body element', () => {
    expect(injectDesktopChrome('<div id="root"></div>')).toContain('data-dsh-desktop-chrome')
  })

  it('carries the column inset, the drag strip, and the fullscreen collapse', () => {
    const block: string = chromeBlock()
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
    ]) {
      expect(block).toContain(needle)
    }
  })

  it('bakes the band height from the launcher decision, not a runtime attribute', () => {
    // Publishing the height at runtime would flash an unbanded layout on every
    // load; a platform keeping its native title bar must get no inset at all.
    process.env.DSH_DESKTOP_TITLE_BAND = 'merged'
    expect(chromeBlock()).toContain('--dsh-title-band:38px')
    process.env.DSH_DESKTOP_TITLE_BAND = 'native'
    expect(chromeBlock()).toContain('--dsh-title-band:0px')
    delete process.env.DSH_DESKTOP_TITLE_BAND
    expect(chromeBlock()).toContain('--dsh-title-band:0px')
  })

  it('never uses a top margin for the inset', () => {
    // A top margin collapses through #root and body, pushing body down and
    // adding a viewport scrollbar — the defect this replaced.
    expect(chromeBlock()).not.toMatch(/margin-top\s*:/)
  })
})
