/**
 * Tray icon: show/hide the window, open the data folder, quit. The window's
 * close button hides to the tray; quitting is explicit (menu, tray, Cmd+Q).
 */
import { app, Menu, nativeImage, shell, Tray, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from './dsh-home.js'

/**
 * Directory holding the shipped image assets. Packaged, electron-builder copies
 * them beside the app; in dev they sit in the checkout.
 */
const ASSETS = app.isPackaged
  ? join(process.resourcesPath, 'assets')
  : join(fileURLToPath(new URL('..', import.meta.url)), 'assets')

/**
 * The tray image. macOS reads a template image from its ALPHA channel and
 * recolours it per menu-bar appearance; the `Template` filename suffix marks it
 * as one, and the `@2x` sibling is picked up automatically for Retina.
 * @returns the tray image, or an empty image when the asset is missing (an
 * empty tray icon beats crashing the launch over artwork).
 */
function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(ASSETS, 'trayTemplate.png'))
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

/**
 * Install the tray. Returns the Tray to keep it referenced (GC otherwise
 * removes the icon on some platforms).
 * @param win - the window the tray controls.
 */
export function installTray(win: BrowserWindow): Tray {
  const tray = new Tray(trayImage())
  tray.setToolTip('DeepSeek Harness')
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
