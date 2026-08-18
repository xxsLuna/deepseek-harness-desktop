/*
 * Tail of the injected desktop-chrome block — inline page script, never a
 * module. Creates the drag strip and tracks the real band height.
 *
 * The strip must be a DOM element (an app-region rect cannot come from a
 * stylesheet alone), and this app ships no preload, so the element is created
 * here. In macOS fullscreen the traffic lights are gone and a fixed band would
 * leave a dead strip, so the height follows the platform's own Window Controls
 * Overlay geometry when it reports one; the CSS default covers platforms that
 * do not.
 */
;(() => {
  if (document.getElementById('dsh-drag-strip') === null) {
    const strip = document.createElement('div')
    strip.id = 'dsh-drag-strip'
    document.body.append(strip)
  }
  // Only a platform that actually draws a Window Controls Overlay reports
  // visible:true. macOS hiddenInset reports false, and zeroing the band there
  // would delete it — so a false reading defers to the stylesheet, which owns
  // both the default height and the fullscreen collapse.
  const overlay = navigator.windowControlsOverlay
  if (overlay === undefined) return
  const apply = () => {
    if (overlay.visible) {
      document.documentElement.style.setProperty('--dsh-title-band', `${String(overlay.getTitlebarAreaRect().height)}px`)
    } else {
      document.documentElement.style.removeProperty('--dsh-title-band')
    }
  }
  apply()
  overlay.addEventListener('geometrychange', apply)
})()
