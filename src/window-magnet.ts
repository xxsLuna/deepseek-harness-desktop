/**
 * Window edge magnetism: the Electron half.
 *
 * The rule itself is pure and lives in window-snap.ts. Everything here is the
 * part that cannot be — which event a platform delivers during a drag, whether
 * that event can be cancelled, and when the OS is already arranging the window
 * and should be left alone.
 *
 * **A release-time snap is always registered, and the live one is extra.** That
 * is deliberate belt-and-braces rather than indecision. `will-move` is the only
 * event carrying the proposed rectangle with a documented `preventDefault()`
 * (electron.d.ts annotates the cancel as win32), so on Windows it can snap
 * mid-drag, which is what makes a magnet feel like one. But this app's title bar
 * is a CSS `-webkit-app-region: drag` strip rather than a native caption, and
 * nothing in the typings says whether `will-move` is delivered for that kind of
 * drag. If it is not, a Windows-only live path would leave the feature doing
 * nothing at all, with no error — the exact silent failure this project keeps
 * pinning in tests.
 *
 * So the window is also placed once the drag stops. When `will-move` works the
 * release-time pass finds the window already flush and returns without touching
 * it, which is safe precisely because {@link ../window-snap.js snapBounds} is
 * idempotent — asserted in its unit test for this reason.
 *
 * Measured on Windows 11 with the shipping Electron, because it is the fact
 * that makes the pair safe and it is not in the typings: **a programmatic
 * `setBounds` raises neither `will-move` nor `moved`.** Both handlers reposition
 * the window, so if either event followed a programmatic move the two would
 * feed each other. They do not, and the snap is a single hop.
 *
 * - **Windows.** `will-move` for the live pull, `moved` as the backstop.
 * - **macOS.** `will-move` fires but cancelling it is not documented, so only
 *   the `moved` pass runs.
 * - **Linux/X11.** Neither `will-move` nor `moved` exists; `move` plus a short
 *   quiet timer stands in for "the drag stopped", the same debounce shape
 *   main.ts already uses to save window state.
 *
 * And one platform where it is refused outright: **Wayland**. `setPosition` is
 * documented as unsupported there and `getBounds` returns the origin, so a
 * magnet would not nudge the window — it would fling it to the top-left corner
 * on the first drag. Not registering is the only honest behaviour.
 */
import { screen, type BrowserWindow } from 'electron'
import { sameBounds, snapToDisplays, SNAP_THRESHOLD } from './window-snap.js'

/** How long after the last `move` a drag counts as finished, on the X11 path. */
const SETTLE_MS = 140

/**
 * Whether this process can position its own window at all.
 *
 * Wayland clients do not get to place themselves; the compositor does. Electron
 * reflects that by making `setPosition` a no-op and `getBounds` report the
 * origin, which turns "snap to the nearest edge" into "jump to 0,0".
 * @param platform - process.platform.
 * @param sessionType - XDG_SESSION_TYPE, as the session sets it.
 * @returns true when the launcher may move its own window.
 */
export function canPositionWindow(platform: string, sessionType: string | undefined): boolean {
  return !(platform === 'linux' && sessionType?.toLowerCase() === 'wayland')
}

/**
 * Install edge magnetism on a window.
 *
 * `enabled` is read per event rather than captured, so the Desktop Settings
 * switch takes effect on the next drag instead of at the next launch — the same
 * posture `closeAction` takes in main.ts.
 * @param win - the window to snap.
 * @param enabled - reads the snap-to-edges preference.
 * @returns a disposer removing every listener it added.
 */
export function installWindowMagnet(win: BrowserWindow, enabled: () => boolean): () => void {
  if (!canPositionWindow(process.platform, process.env.XDG_SESSION_TYPE)) {
    console.log('[magnet] not registering: this session cannot position its own window')
    return () => {}
  }

  const workAreas = (): { x: number, y: number, width: number, height: number }[] =>
    screen.getAllDisplays().map((display) => display.workArea)

  /**
   * Whether the window is in a state the user is not dragging.
   *
   * A maximized or full-screen window has no free position to pull, and on
   * Windows one the OS has already snapped is being arranged by Aero Snap —
   * pulling it would be two magnets fighting over the same rectangle.
   * @returns true when this window should be left where it is.
   */
  const arranged = (): boolean => {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return true
    // isSnapped is win32-only and absent elsewhere; guard rather than branch on
    // platform, so a future Electron adding it on another OS is picked up.
    const isSnapped = (win as Partial<{ isSnapped: () => boolean }>).isSnapped
    return typeof isSnapped === 'function' && isSnapped.call(win)
  }

  const disposers: (() => void)[] = []

  /** Snap where the window currently is; a no-op when it is already flush. */
  const place = (): void => {
    if (!enabled() || arranged()) return
    const current = win.getBounds()
    const snapped = snapToDisplays(current, workAreas(), SNAP_THRESHOLD)
    if (sameBounds(snapped, current)) return
    win.setBounds(snapped)
  }

  if (process.platform === 'win32') {
    /**
     * @param event - the cancelable move, carrying the proposed rectangle.
     * @param newBounds - where the drag wants the window.
     */
    const onWillMove = (event: Electron.Event, newBounds: Electron.Rectangle): void => {
      if (!enabled() || arranged()) return
      const snapped = snapToDisplays(newBounds, workAreas(), SNAP_THRESHOLD)
      // Most steps of a drag are nowhere near an edge. Cancelling those and
      // re-applying identical bounds is a visible stutter for no gain, so the
      // handler only intervenes when the rule actually moved something.
      if (sameBounds(snapped, newBounds)) return
      event.preventDefault()
      win.setBounds(snapped)
    }
    win.on('will-move', onWillMove)
    disposers.push(() => win.off('will-move', onWillMove))
  }

  if (process.platform === 'win32' || process.platform === 'darwin') {
    const onMoved = (): void => { place() }
    win.on('moved', onMoved)
    disposers.push(() => win.off('moved', onMoved))
  } else {
    // 'moved' does not exist on X11, so a quiet timer after 'move' is the only
    // signal that the drag has stopped.
    let settle: NodeJS.Timeout | undefined
    const onMove = (): void => {
      clearTimeout(settle)
      settle = setTimeout(place, SETTLE_MS)
    }
    win.on('move', onMove)
    disposers.push(() => {
      clearTimeout(settle)
      win.off('move', onMove)
    })
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}
