/*
 * Tail of the injected desktop-chrome block — inline page script, never a
 * module. Builds the band: the drag strip, the controls inside it, and the two
 * readings only the page can take.
 *
 * The strip must be a DOM element (an app-region rect cannot come from a
 * stylesheet alone), and this app ships no preload, so everything here is
 * created by hand. For the same reason the controls do not act themselves:
 * a native menu popup, the window's navigation history and the colour of
 * caption buttons are the launcher's, so each control posts to the route the
 * launcher answers ahead of the sidecar.
 */
;(() => {
  const root = document.documentElement

  /**
   * Ask the launcher to do something the page cannot.
   * @param {string} action - route name under the launcher's prefix.
   * @param {object} [payload] - JSON body.
   */
  const ask = (action, payload) => {
    void fetch(`/__desktop-host/chrome/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }).catch(() => { /* the band is decoration; a failed ask must not throw */ })
  }

  /**
   * One band control.
   * @param {string} id - element id the stylesheet targets.
   * @param {string} label - accessible name and tooltip.
   * @param {string} path - SVG path data, drawn in currentColor.
   * @param {() => void} onClick - what the control asks for.
   * @returns {HTMLButtonElement} the control.
   */
  const control = (id, label, path, onClick) => {
    const button = document.createElement('button')
    button.id = id
    button.type = 'button'
    button.title = label
    button.setAttribute('aria-label', label)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.5')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    shape.setAttribute('d', path)
    svg.append(shape)
    button.append(svg)
    button.addEventListener('click', onClick)
    return button
  }

  if (document.getElementById('dsh-drag-strip') === null) {
    const strip = document.createElement('div')
    strip.id = 'dsh-drag-strip'

    const controls = document.createElement('div')
    controls.id = 'dsh-title-controls'
    const menu = control('dsh-menu-button', 'Menu', 'M2 4h12M2 8h12M2 12h12', () => {
      // Anchored to the button's own box so the popup hangs off the control.
      const box = menu.getBoundingClientRect()
      ask('menu', { x: Math.round(box.left), y: Math.round(box.bottom) })
    })
    controls.append(menu)

    // Its own group, because it is anchored to the content rather than the
    // left edge (see the stylesheet).
    const nav = document.createElement('div')
    nav.id = 'dsh-title-nav'
    nav.append(
      control('dsh-nav-back', 'Back', 'M10 3 5 8l5 5', () => { ask('back') }),
      control('dsh-nav-forward', 'Forward', 'M6 3l5 5-5 5', () => { ask('forward') }),
    )

    strip.append(controls, nav)
    document.body.append(strip)

    /**
     * Park the navigation controls just past the sidebar. Collapsed, the
     * sidebar is a rail narrower than these two buttons, so a fixed left
     * anchor leaves them lying across its edge.
     */
    const placeNav = () => {
      const sidebar = document.querySelector('[class*="_sidebarCol"]')
      const edge = sidebar === null ? 0 : sidebar.getBoundingClientRect().right
      // Never over what is already at the left of the band, whatever the
      // sidebar is doing. The floor is the CONTROLS box, not the menu button:
      // where the platform draws its own window controls the button is
      // display:none — its rect reads 0 — while the box still spans the `lead`
      // reserved for them. Measured: with a collapsed rail those buttons
      // otherwise land at x=62, inside macOS's traffic lights.
      const floor = controls.getBoundingClientRect().right
      root.style.setProperty('--dsh-title-nav-x', `${String(Math.round(Math.max(edge, floor)))}px`)
    }

    // The sidebar resizing IS the collapse, so one observer covers the rail
    // toggle and a dragged divider alike. It is attached once the column
    // exists: this script runs before the UI has rendered anything.
    const sizes = new ResizeObserver(placeNav)
    const attach = () => {
      const sidebar = document.querySelector('[class*="_sidebarCol"]')
      if (sidebar === null) return false
      sizes.observe(sidebar)
      placeNav()
      return true
    }
    if (!attach()) {
      const appearing = new MutationObserver(() => {
        if (attach()) appearing.disconnect()
      })
      appearing.observe(document.body, { childList: true, subtree: true })
    }
    addEventListener('resize', placeNav)
  }

  /**
   * The colour actually painted where the caption buttons sit.
   *
   * Hit-tested rather than read off <body>: the columns paint their own fills
   * over it and reach the window top, so body's background is not what the
   * glyphs have to survive. Sampled at the trailing end of the band, which is
   * where the buttons are, skipping the band's own elements.
   * @returns {number[] | null} an RGB triple, or null if nothing opaque was hit.
   */
  const bandPaint = () => {
    const height = parseFloat(getComputedStyle(root).getPropertyValue('--dsh-title-band')) || 0
    if (height <= 0) return null
    const y = Math.min(Math.max(height / 2, 1), height - 1)
    for (const el of document.elementsFromPoint(Math.max(window.innerWidth - 20, 1), y)) {
      if (el.id === 'dsh-drag-strip' || el.closest('#dsh-drag-strip') !== null) continue
      const parts = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)
      if (parts === null || parts.length < 3) continue
      // See-through: whatever is behind it is what shows, so keep looking.
      if (parts.length > 3 && Number(parts[3]) < 0.5) continue
      return parts.map(Number)
    }
    return null
  }

  /**
   * Tell the launcher whether the band is sitting on a light or a dark
   * background, so it can repaint the caption-button glyphs it owns. Measured
   * rather than read off an attribute: the UI states its theme however it
   * likes, and only the painted colour decides whether a glyph is visible.
   */
  let scheme
  const publishScheme = () => {
    const paint = bandPaint()
    if (paint === null) return
    const [r, g, b] = paint
    // Rec. 601 luma is enough to pick between two glyph colours.
    const next = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? 'light' : 'dark'
    if (next === scheme) return
    scheme = next
    ask('scheme', { scheme: next })
  }
  publishScheme()
  // The theme changes from the UI's own settings and, on "system", from the OS;
  // the element under the band changes when the window is resized.
  new MutationObserver(publishScheme).observe(root, { attributes: true })
  new MutationObserver(publishScheme).observe(document.body, { attributes: true })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', publishScheme)
  addEventListener('resize', publishScheme)

  // Only a platform that actually draws a Window Controls Overlay reports
  // visible:true. macOS hiddenInset reports false, and zeroing the band there
  // would delete it — so a false reading defers to the stylesheet, which owns
  // both the default height and the fullscreen collapse. The readings land in
  // separate properties the stylesheet reads through var(), so these inline
  // writes cannot outrank that collapse.
  const overlay = navigator.windowControlsOverlay
  if (overlay === undefined) return
  const apply = () => {
    if (overlay.visible) {
      const rect = overlay.getTitlebarAreaRect()
      root.style.setProperty('--dsh-title-band-wco', `${String(rect.height)}px`)
      root.style.setProperty('--dsh-titlebar-area-x', `${String(rect.x)}px`)
      root.style.setProperty('--dsh-titlebar-area-width', `${String(rect.width)}px`)
    } else {
      // Reported invisible while the page is hidden as well as in fullscreen.
      // Dropping the readings puts the strip back across the whole window,
      // which is the safe answer: a band with no measurement is still a band.
      root.style.removeProperty('--dsh-title-band-wco')
      root.style.removeProperty('--dsh-titlebar-area-x')
      root.style.removeProperty('--dsh-titlebar-area-width')
    }
  }
  apply()
  overlay.addEventListener('geometrychange', apply)
})()
