/**
 * Tray icon: show/hide the window, open the data folder, quit. The window's
 * close button hides to the tray; quitting is explicit (menu, tray, Cmd+Q).
 */
import { app, Menu, nativeImage, shell, Tray, type BrowserWindow } from 'electron'
import { resolveDshHome } from './dsh-home.js'

// 16x16 monochrome dot, used as a macOS template image (auto-inverts) and as
// the tray glyph elsewhere. Replaced by real artwork when icons land.
const TRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWElEQVR4nGNgGAWMDAwM/6mFGf4TAcgxlIlUDaQaykSOr0gxlIlcbxJrKBMlYUCMoUyUBiIhQ5moEUv4DGWiVjTjMpSJmukIm6FM1E6ImIYy0SIlohvKBABX7Cxr9NpFWgAAAABJRU5ErkJggg=='

/**
 * Install the tray. Returns the Tray to keep it referenced (GC otherwise
 * removes the icon on some platforms).
 * @param win - the window the tray controls.
 */
export function installTray(win: BrowserWindow): Tray {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_PNG}`)
  if (process.platform === 'darwin') image.setTemplateImage(true)
  const tray = new Tray(image)
  tray.setToolTip('DeepSeek Harness Desktop')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (win.isVisible() && win.isFocused()) {
          win.hide()
        } else {
          win.show()
          win.focus()
        }
      },
    },
    {
      label: 'Open Data Folder',
      click: () => void shell.openPath(resolveDshHome()),
    },
    { type: 'separator' },
    { role: 'quit' },
  ]))
  tray.on('click', () => {
    win.show()
    win.focus()
  })
  return tray
}
