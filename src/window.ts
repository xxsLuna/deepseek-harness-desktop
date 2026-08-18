/**
 * The app window: sandboxed renderer, no preload, and navigation pinned to
 * the app origin — external links open in the system browser. These guards
 * are the primary fence of the desktop authority model (the socket proxy's
 * marker check is the second layer).
 */
import { BrowserWindow, shell } from 'electron'
import { APP_ORIGIN } from './socket-proxy.js'

/**
 * Create the (hidden) main window with navigation guards installed.
 * @returns the window; caller shows it on ready-to-show.
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#111111',
    // Merge the title bar into the top of the UI: on macOS the traffic
    // lights float over the page and the top strip becomes the drag region
    // (injected by the desktop-runtime index tap).
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 14, y: 14 },
    } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // In macOS fullscreen the traffic lights are gone, so the band is dead
  // space: publish the state as a root attribute the band CSS keys off.
  // Done from main (no preload ships) via a tiny attribute write.
  const publishFullscreen = (): void => {
    const value = win.isFullScreen() ? 'true' : 'false'
    void win.webContents.executeJavaScript(
      `document.documentElement.dataset.dshFullscreen = ${JSON.stringify(value)}`,
    ).catch(() => { /* renderer not ready yet; did-finish-load republishes */ })
  }
  win.on('enter-full-screen', publishFullscreen)
  win.on('leave-full-screen', publishFullscreen)
  win.webContents.on('did-finish-load', publishFullscreen)

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}
