/**
 * Global shortcut: bring the window forward from anywhere, or hide it again.
 *
 * The window closes to the tray, so without a keyboard route the only way back
 * is the tray menu. Registration is best-effort by design — an accelerator
 * another application already owns is an environment fact, not a
 * misconfiguration, so it is reported and the app continues.
 *
 * The chord is a preference, which is why this is a small class rather than one
 * call: whether it registered is the answer the Shortcuts page needs, and
 * changing it has to release the old chord before claiming the new one, or the
 * app ends up holding both and the OS still routes the old one here.
 */
import { app, globalShortcut } from 'electron'
import type { BrowserWindow } from 'electron'

/** Default chord: Cmd/Ctrl+Alt+D. */
export const DEFAULT_TOGGLE_ACCELERATOR = 'CommandOrControl+Alt+D'

/** A registered global shortcut that can be re-pointed while the app runs. */
export interface ShortcutHandle {
  /**
   * Point the shortcut at a different chord.
   * @param accelerator - Electron accelerator; '' disables it.
   * @returns true when the new chord is held.
   */
  rebind: (accelerator: string) => boolean
  /** @returns whether a chord is currently held. */
  isActive: () => boolean
  /** Release whatever is held. */
  stop: () => void
}

/**
 * Register the show/hide accelerator.
 * @param win - the window to toggle.
 * @param accelerator - Electron accelerator; an empty string disables it.
 * @returns a handle that can re-point or release the shortcut.
 */
export function installShortcuts(win: BrowserWindow, accelerator = DEFAULT_TOGGLE_ACCELERATOR): ShortcutHandle {
  let held: string | undefined

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

  const release = (): void => {
    if (held === undefined) return
    globalShortcut.unregister(held)
    held = undefined
  }

  const rebind = (next: string): boolean => {
    // Release first: rebinding A to B while still holding A leaves the OS
    // routing both chords here, and nothing would ever unregister A.
    release()
    if (next === '') return false
    let registered = false
    try {
      registered = globalShortcut.register(next, toggle)
    } catch (error) {
      // Electron throws on a chord it cannot parse. A malformed accelerator is
      // a bad preference, not a reason to stop the app; the page reports it as
      // unavailable, exactly like one another application already owns.
      console.warn(`[shortcuts] ${next} could not be registered:`, error)
      return false
    }
    if (!registered) {
      console.warn(`[shortcuts] ${next} is unavailable (another app holds it); the tray still toggles the window`)
      return false
    }
    held = next
    console.log(`[shortcuts] ${next} toggles the window`)
    return true
  }

  rebind(accelerator)

  return {
    rebind,
    isActive: () => held !== undefined,
    stop: release,
  }
}
