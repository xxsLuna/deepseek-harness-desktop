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
 * The tray image: the app's own mark, sized for a tray slot.
 *
 * macOS reads a template image from its ALPHA channel and recolours it per
 * menu-bar appearance, so it gets the silhouette — the `Template` filename
 * suffix marks it as one. Windows and Linux draw what they are given and would
 * render that silhouette as a black shape, invisible on a dark taskbar, so
 * they get the coloured mark instead. Both have an `@2x` sibling, which
 * nativeImage picks up for high-DPI screens.
 * @returns the tray image, or an empty image when the asset is missing (an
 * empty tray icon beats crashing the launch over artwork).
 */
function trayImage(): Electron.NativeImage {
  const isMac = process.platform === 'darwin'
  const image = nativeImage.createFromPath(join(ASSETS, isMac ? 'trayTemplate.png' : 'tray.png'))
  if (isMac) image.setTemplateImage(true)
  return image
}

/**
 * Install the tray. Returns the Tray to keep it referenced (GC otherwise
 * removes the icon on some platforms).
 * @param win - the window the tray controls.
 * @param checkForUpdates - manual update check; omitted leaves the item out.
 */
export function installTray(win: BrowserWindow, checkForUpdates?: () => void): Tray {
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
    {
      // The harness home and the launcher's own logs are different folders,
      // so "Open Data Folder" cannot reach this one. It earns a seat because
      // it is the only way a user gets at a boot failure's reason: the sidecar
      // writes its diagnosis to stdout, and a packaged GUI app has no console
      // behind that.
      label: 'Open Logs Folder',
      click: () => void shell.openPath(join(app.getPath('userData'), 'logs')),
    },
    ...(checkForUpdates === undefined ? [] : [{ label: 'Check for Updates…', click: checkForUpdates }]),
    { type: 'separator' as const },
    { role: 'quit' },
  ]))
  tray.on('click', () => {
    win.show()
    win.focus()
  })
  return tray
}
