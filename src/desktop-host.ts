/**
 * The launcher's back channel: a route under the app origin that main answers
 * itself and never forwards to the sidecar.
 *
 * Three things reach it. The band is drawn by the page but its controls are
 * launcher business — a native menu popup, the window's navigation history,
 * the colour of caption buttons the page does not own. The Desktop Settings
 * section is a view onto preferences only this process can act on. And the
 * plugin marketplace needs the harness process restarted, which only the
 * process that spawned it can do. No preload ships, so there is no ipcRenderer
 * to call; the page posts here, and the protocol handler in main answers
 * before the socket proxy sees it.
 *
 * Nothing here escalates, but the claim is no longer "every action has a menu
 * equivalent" and should not be read that way. It held for the band and the
 * settings actions — each is reachable from the menu bar (Alt), the tray, or
 * the keyboard, and a native popup can only be activated by real user input.
 * `market/restart` is the exception, so it is bounded instead of equated: it
 * tears the harness down and brings it back on the SAME socket path, bearer
 * token and $DSH_HOME (see Sidecar.restart), which is what the crash
 * supervisor in main already does unprompted, then reloads the window, which
 * the View menu's Reload already does. The worst a page gets from it is
 * disruption of the user's own session — requests in flight fail and a running
 * turn is lost — never authority it did not have. The same-origin fence in
 * socket-proxy still runs first.
 */
import type { BrowserWindow } from 'electron'
import { popupAppMenu } from './menu.js'
import { desktopHostAction } from './socket-proxy.js'
import { desktopSettingsView, type DesktopSettingsStore, type DesktopSettingsViewInput } from './settings-host.js'
import type { UpdateCheckResult } from './updater.js'
import type { UsageView } from './usage.js'

/** A point in window coordinates, as the page measured it. */
interface Point {
  x: number
  y: number
}

/**
 * Read a finite window-coordinate pair from a request body.
 * @param body - the parsed JSON body, of unknown shape.
 * @returns the point, or undefined when the body is not one.
 */
function pointFrom(body: unknown): Point | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const { x, y } = body as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * Whether the page reported a light background behind the band.
 * @param body - the parsed JSON body, of unknown shape.
 * @returns true for light, false for dark or an unreadable body.
 */
function isLightScheme(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  return (body as Record<string, unknown>).scheme === 'light'
}

/** What the launcher's back channel needs to answer every action. */
export interface DesktopHostDeps extends Omit<DesktopSettingsViewInput, 'store'> {
  /** The current main window, if there is one. */
  getWindow: () => BrowserWindow | undefined
  /** The desktop preferences store. */
  settings: DesktopSettingsStore
  /**
   * Run an update check now and report what it found.
   *
   * Awaited rather than fired and forgotten: the route used to return 204 the
   * instant the check started, so the page had nothing to show for up to thirty
   * seconds and the button read as broken. Overlapping callers share one check.
   */
  checkForUpdates: () => Promise<UpdateCheckResult>
  /** The usage record the Usage page renders. */
  usage: () => UsageView
  /** Throw the usage record away and start counting again. */
  resetUsage: () => void
  /**
   * Restart the harness sidecar, resolving only once the new process answers
   * its socket. Coalesced by the supervisor, so overlapping callers share one
   * restart rather than racing two processes onto one $DSH_HOME.
   */
  restartSidecar: () => Promise<void>
}

/**
 * Build the handler for the launcher's back channel.
 *
 * The window is fetched per request rather than captured: the protocol handler
 * is registered before the window exists, and it outlives a window close.
 * @param deps - the launcher state the actions read and write.
 * @returns a handler for requests under the launcher prefix.
 */
export function createDesktopHost(deps: DesktopHostDeps) {
  const { getWindow, settings } = deps
  /** @returns the settings section's whole render input. */
  const view = (): Response => Response.json(desktopSettingsView({ ...deps, store: settings }))

  return async (request: Request, pathname: string): Promise<Response> => {
    const action = desktopHostAction(pathname)

    let body: unknown
    try {
      body = request.method === 'POST' ? await request.json() : undefined
    } catch {
      body = undefined
    }

    // The settings section must render whether or not a window is up (it is
    // asked for during load), so these are answered before the window check.
    switch (action) {
      case 'settings/read':
        return view()
      case 'settings/write':
        settings.write(body)
        return view()
      case 'settings/check-updates':
        return Response.json(await deps.checkForUpdates())
      case 'settings/usage':
        return Response.json(deps.usage())
      case 'settings/usage-reset':
        deps.resetUsage()
        return Response.json(deps.usage())
      default:
        break
    }

    const win = getWindow()
    if (win === undefined || win.isDestroyed()) return new Response('no window', { status: 409 })

    switch (action) {
      case 'chrome/menu': {
        // Anchored where the page measured its own button, so the popup hangs
        // off the control rather than the pointer.
        const at = pointFrom(body) ?? { x: 0, y: 0 }
        popupAppMenu(win, at.x, at.y)
        return new Response(null, { status: 204 })
      }
      case 'chrome/back': {
        if (win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack()
        return new Response(null, { status: 204 })
      }
      case 'chrome/forward': {
        if (win.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward()
        return new Response(null, { status: 204 })
      }
      case 'chrome/scheme': {
        applyOverlayScheme(win, isLightScheme(body))
        return new Response(null, { status: 204 })
      }
      case 'market/restart': {
        // Answered after the window check because the reload below is the
        // second half of the action: a restart nobody can see the result of is
        // just a dropped session.
        try {
          await deps.restartSidecar()
        } catch (error) {
          // The old process is already gone by the time this can fail, so
          // there is nothing to fall back to. Report it rather than reloading
          // the page onto a dead socket, where every request would 503 with no
          // hint of why.
          return new Response(`restart failed: ${String(error)}`, { status: 503 })
        }
        // Re-read the window: a restart takes seconds, and it can be closed or
        // the app quit inside that gap, which makes `win` above a stale handle.
        const live = getWindow()
        if (live === undefined || live.isDestroyed()) return new Response('no window', { status: 409 })
        // The served index.html bakes window.__DSH_BOOT__ in, so a newly
        // composed plugin row only exists for a page that is fetched again.
        live.webContents.reload()
        return new Response(null, { status: 204 })
      }
      default:
        return new Response('not found', { status: 404 })
    }
  }
}

/**
 * Repaint the caption-button glyphs for the page's current scheme.
 *
 * The overlay background stays fully transparent — the page paints the band —
 * so only the glyph colour has to follow the UI, or the buttons vanish into a
 * light theme. Windows draws this overlay; macOS tints its traffic lights
 * itself and has no such call.
 * @param win - the window whose overlay to repaint.
 * @param light - whether the page is showing a light background.
 */
export function applyOverlayScheme(win: BrowserWindow, light: boolean): void {
  if (process.platform !== 'win32') return
  win.setTitleBarOverlay({ color: '#00000000', symbolColor: light ? '#1f1f1f' : '#e6e6e6' })
}

/**
 * Publish which way the window can navigate, as a root attribute the band CSS
 * keys off. Written from main for the same reason the fullscreen state is:
 * only the launcher knows, and no preload ships.
 * @param win - the window to read and write.
 */
export function publishNavigation(win: BrowserWindow): void {
  const history = win.webContents.navigationHistory
  const ways = [history.canGoBack() ? 'back' : '', history.canGoForward() ? 'forward' : ''].join(' ').trim()
  void win.webContents.executeJavaScript(
    `document.documentElement.dataset.dshNav = ${JSON.stringify(ways)}`,
  ).catch(() => { /* renderer not ready yet; did-finish-load republishes */ })
}
