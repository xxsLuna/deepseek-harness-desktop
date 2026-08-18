/**
 * Global shortcut: bring the window forward from anywhere, or hide it again.
 *
 * The window closes to the tray, so without a keyboard route the only way back
 * is the tray menu. Registration is best-effort by design — an accelerator
 * another application already owns is an environment fact, not a
 * misconfiguration, so it is reported and the app continues.
 */
import { app, globalShortcut } from 'electron'
import type { BrowserWindow } from 'electron'

/** Default chord: Cmd/Ctrl+Alt+D. */
export const DEFAULT_TOGGLE_ACCELERATOR = 'CommandOrControl+Alt+D'

/**
 * Register the show/hide accelerator.
 * @param win - the window to toggle.
 * @param accelerator - Electron accelerator; an empty string disables it.
 * @returns a stop function unregistering whatever was registered.
 */
export function installShortcuts(win: BrowserWindow, accelerator = DEFAULT_TOGGLE_ACCELERATOR): () => void {
  if (accelerator === '') return () => {}

  const toggle = (): void => {
    if (win.isVisible() && win.isFocused()) {
      win.hide()
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    // macOS keeps the app unfocused when it was not frontmost; without this the
    // window rises behind whatever the user was in.
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.focus()
  }

  const registered = globalShortcut.register(accelerator, toggle)
  if (!registered) {
    console.warn(`[shortcuts] ${accelerator} is unavailable (another app holds it); the tray still toggles the window`)
    return () => {}
  }
  console.log(`[shortcuts] ${accelerator} toggles the window`)
  return () => globalShortcut.unregister(accelerator)
}
