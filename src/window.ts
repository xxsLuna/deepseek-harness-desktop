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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}
