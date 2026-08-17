/**
 * Application menu. Required on macOS: without an Edit menu, clipboard
 * shortcuts (Cmd+C/V/X) do not reach the renderer at all.
 */
import { app, Menu } from 'electron'

/** Install the role-based application menu. */
export function installMenu(): void {
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]))
}
