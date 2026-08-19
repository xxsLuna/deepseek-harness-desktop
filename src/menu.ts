/**
 * Application menu. Required on macOS: without an Edit menu, clipboard
 * shortcuts (Cmd+C/V/X) do not reach the renderer at all.
 *
 * The same template feeds two surfaces. Where the native menu bar is hidden
 * (Windows, Linux) the band's menu button pops this up as a list, so the two
 * can never drift apart — one template, built fresh per use.
 */
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * The menu template for this platform.
 * @returns role-based top-level menus.
 */
function template(): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  return [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    // The macOS app menu carries About; elsewhere no role menu does, so the
    // configured About panel would be unreachable.
    ...(isMac ? [] : [{ role: 'help' as const, submenu: [{ role: 'about' as const }] }]),
  ]
}

/** Install the role-based application menu. */
export function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()))
}

/**
 * Pop the application menu up as a list, anchored under the band's menu button.
 *
 * Built fresh rather than reusing `Menu.getApplicationMenu()`: that instance is
 * owned by the window frame on Windows, and popping the live menu bar up as a
 * context menu is not what it is attached for.
 * @param win - the window to anchor the popup to.
 * @param x - window-relative x for the popup's top-left corner.
 * @param y - window-relative y for the popup's top-left corner.
 */
export function popupAppMenu(win: BrowserWindow, x: number, y: number): void {
  Menu.buildFromTemplate(template()).popup({ window: win, x, y })
}
