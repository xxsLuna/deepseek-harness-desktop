/**
 * The app window: sandboxed renderer, no preload, and navigation pinned to
 * the app origin — external links open in the system browser. These guards
 * are the primary fence of the desktop authority model (the socket proxy's
 * marker check is the second layer).
 */
import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ORIGIN } from './socket-proxy.js'
import { publishNavigation } from './desktop-host.js'

/**
 * Whether this platform merges the title bar into the page. macOS and Windows
 * both do, by different routes: `hiddenInset` floats the traffic lights over
 * the content, and Windows hides the frame but keeps its caption buttons in a
 * Window Controls Overlay — so minimise/maximise/close, their hover states and
 * the Windows 11 snap-layouts flyout stay native instead of being redrawn.
 *
 * Linux keeps its frame. The overlay exists there too, but a tiling or
 * server-side-decorating WM draws its own title bar regardless, which would
 * leave the band as dead space above the UI.
 */
export const MERGED_TITLE_BAR_PLATFORM = process.platform === 'darwin' || process.platform === 'win32'

/**
 * Band height in DIP. One number for both sides of the seam: it sizes the
 * Windows overlay here, and the sidecar bakes the same value into the served
 * stylesheet's column inset (packages/bundle/lib/chrome.js), so the caption
 * buttons and the UI below them cannot drift apart.
 */
export const TITLE_BAND_HEIGHT = 38

/**
 * What the page needs to know to draw the band: the launcher owns every field,
 * because each one follows from a decision only it made.
 */
export interface TitleBand {
  /** Band height in CSS pixels; 0 where the platform kept its title bar. */
  readonly height: number
  /**
   * Leading space inside the band the platform's own controls already occupy,
   * so the page's controls start clear of them. macOS floats the traffic
   * lights at the left; Windows puts its caption buttons on the right, which
   * the drag strip handles separately.
   */
  readonly lead: number
  /**
   * Whether the page draws the menu button. Only where the native menu bar is
   * hidden: on macOS the menu bar is a system surface that is always present,
   * and a second copy of the same menus in the band is noise.
   */
  readonly menuButton: boolean
}

/** A platform that keeps its title bar, or a user who asked for it back. */
const NO_BAND: TitleBand = { height: 0, lead: 0, menuButton: false }

/**
 * The band this launch serves.
 * @param merged - the user's Desktop Settings preference; a platform that
 * cannot merge its title bar ignores it.
 * @returns the band description, zero-height when there is no band.
 */
export function titleBand(merged: boolean): TitleBand {
  if (!MERGED_TITLE_BAR_PLATFORM || !merged) return NO_BAND
  const isMac = process.platform === 'darwin'
  // Clear of the three traffic lights: x=14 plus three ~12px buttons at ~8px
  // apart, rounded up so the first page control is not crowded against them.
  return { height: TITLE_BAND_HEIGHT, lead: isMac ? 78 : 0, menuButton: !isMac }
}

/**
 * The window icon.
 *
 * Windows gets the multi-frame `.ico`, never the 1024px PNG. A window icon has
 * to BE 16x16 and 32x32 (SM_CXSMICON / SM_CXICON): handed one large bitmap for
 * both, Electron sets a 1024px HICON, the shell rejects it and falls back to
 * the window CLASS icon — which is the running executable's, so a dev run shows
 * Electron's atom on the taskbar however right the artwork is (measured, not
 * assumed). Setting it packaged as well costs nothing and keeps one code path.
 *
 * macOS is left alone: it reads the bundle icon, and there is no title bar to
 * draw one in anyway.
 * @returns the icon path, or undefined to let the platform decide.
 */
const WINDOW_ICON = (() => {
  if (process.platform === 'darwin') return undefined
  const assets = app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(fileURLToPath(new URL('..', import.meta.url)), 'assets')
  const icon = join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  return existsSync(icon) ? icon : undefined
})()

/**
 * Platform options that hide the native title bar. Split per platform: the two
 * take completely different keys, and only Windows needs the overlay colours.
 * @returns the constructor options to spread, empty where the frame stays.
 */
function mergedTitleBarOptions(band: TitleBand): Electron.BrowserWindowConstructorOptions {
  if (band.height <= 0) return {}
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        // Fully transparent: the band is whatever the page paints under it, so
        // the sidebar fill and its separator run up into it unbroken. Only the
        // glyphs are drawn, and they are sized for the dark app shell.
        color: '#00000000',
        symbolColor: '#e6e6e6',
        height: band.height,
      },
    }
  }
  return {}
}

/**
 * Create the (hidden) main window with navigation guards installed.
 * @param band - the band this launch serves; a zero height keeps the native
 * title bar, which is a construction-time decision and so a restart to change.
 * @returns the window; caller shows it on ready-to-show.
 */
export function createMainWindow(band: TitleBand): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#111111',
    icon: WINDOW_ICON,
    // Where the window draws a menu bar (Windows, Linux) it would sit inside
    // the client area, under the band and above the UI. Hidden until Alt: the
    // roles and their accelerators stay installed either way.
    autoHideMenuBar: process.platform !== 'darwin',
    // Merge the title bar into the top of the UI; the band itself is drawn by
    // the page (injected by the desktop-runtime index tap).
    ...mergedTitleBarOptions(band),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Fullscreen takes the window controls away on both merged platforms, so the
  // band would be dead space: publish the state as a root attribute the band
  // CSS keys off. Done from main (no preload ships) via a tiny attribute write.
  //
  // Windows also needs it because the page cannot see this for itself: its
  // overlay keeps reporting visible with a 38px titlebar area in fullscreen,
  // while nothing is drawn there (measured, not assumed).
  const publishFullscreen = (fullScreen: boolean): void => {
    // Only fullscreen is published at runtime. Whether the band exists at all
    // is baked into the served stylesheet (the sidecar reads it from the env),
    // so a load never flashes an unbanded layout before this arrives.
    const value = fullScreen ? 'true' : 'false'
    void win.webContents.executeJavaScript(
      `document.documentElement.dataset.dshFullscreen = ${JSON.stringify(value)}`,
    ).catch(() => { /* renderer not ready yet; did-finish-load republishes */ })
  }
  // The event says which way it went; isFullScreen() must not be asked here.
  // On Windows both events fire BEFORE the window flips its own state, so
  // reading it back inside the handler publishes the state being left — the
  // band then collapsed on restore and stayed 38px tall in fullscreen.
  win.on('enter-full-screen', () => publishFullscreen(true))
  win.on('leave-full-screen', () => publishFullscreen(false))
  // A load is never mid-transition, so the window is the authority there.
  win.webContents.on('did-finish-load', () => publishFullscreen(win.isFullScreen()))

  // Which way the band's back/forward controls may move. In-page navigation
  // counts: a pushState is what a single-page UI would move through.
  const publishNav = (): void => publishNavigation(win)
  win.webContents.on('did-navigate', publishNav)
  win.webContents.on('did-navigate-in-page', publishNav)
  win.webContents.on('did-finish-load', publishNav)

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${APP_ORIGIN}/`)) return
    event.preventDefault()
    // Model output links without target="_blank" navigate the tab; dropping
    // them silently would make a plain link, or a mailto:, do nothing.
    if (/^(?:https?|mailto):/.test(url)) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}
