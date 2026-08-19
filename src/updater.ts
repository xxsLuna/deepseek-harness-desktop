/**
 * Auto-update wiring. Windows (NSIS) and Linux (AppImage) update through
 * electron-updater against this repo's GitHub Releases (public, tokenless).
 * Unsigned macOS builds check the same feed and point the user at the
 * release page instead (see update-gate.ts). Errors are logged, never fatal:
 * an unreachable feed must not affect the app.
 */
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { isNewerVersion, updateMode } from './update-gate.js'

const require = createRequire(import.meta.url)

const RELEASES_URL = 'https://github.com/xxsLuna/deepseek-harness-desktop/releases/latest'
const FEED_MAC_YML = 'https://github.com/xxsLuna/deepseek-harness-desktop/releases/latest/download/latest-mac.yml'
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Read the build-baked macOS signing flag from the packaged manifest. */
function macUpdatesSigned(): boolean {
  try {
    // package.json inside the asar carries extraMetadata from the build.
    const manifest = require('../package.json') as { desktop?: { macUpdatesSigned?: boolean } }
    return manifest.desktop?.macUpdatesSigned === true
  } catch {
    return false
  }
}

/**
 * Start periodic checks against this repo's GitHub Releases.
 * @param enabled - reads the Desktop Settings auto-update preference. Only the
 * scheduled check consults it; an explicit "Check now" always runs, because
 * the user asked for that one.
 * @returns the scheduler's disposer and the manual check.
 */
export function startUpdater(
  enabled: () => boolean = () => true,
  win?: BrowserWindow,
): { stop: () => void, checkNow: () => void } {
  // Parented, every dialog below is a sheet. A parentless showMessageBox on
  // macOS runs a modal loop that blocks the main thread outright: no window
  // load, no sidecar output, nothing until someone clicks it (which is a hang
  // on a headless runner, and how this was found).
  const ask = async (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    (win === undefined || win.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(win, options))
  const mode = updateMode({
    platform: process.platform,
    packaged: app.isPackaged,
    macUpdatesSigned: macUpdatesSigned(),
  })
  if (mode === 'disabled') {
    return {
      stop: () => {},
      // An unpackaged or unsupported build has nothing to check; say so rather
      // than leaving a menu item that appears to do nothing.
      checkNow: () => {
        void ask({
          type: 'info',
          message: 'Updates are not available for this build',
          detail: app.isPackaged
            ? 'This platform cannot self-update; download new versions from the releases page.'
            : 'Development builds are not updated.',
        })
      },
    }
  }

  let timer: NodeJS.Timeout | undefined
  let notified = false

  const checkNotifyOnly = async (manual = false): Promise<void> => {
    try {
      const response = await fetch(FEED_MAC_YML, { redirect: 'follow' })
      if (!response.ok) return
      const text = await response.text()
      const version = /^version:\s*(.+)$/m.exec(text)?.[1]
      if (version === undefined || !isNewerVersion(version, app.getVersion())) return
      if (notified && !manual) return
      notified = true
      const { response: button } = await ask({
        type: 'info',
        message: `DeepSeek Harness ${version} is available`,
        detail: 'Unsigned macOS builds cannot self-update; download the new version from the releases page.',
        buttons: ['Open Releases', 'Later'],
        defaultId: 0,
      })
      if (button === 0) void shell.openExternal(RELEASES_URL)
    } catch { /* feed unreachable: try again next interval */ }
  }

  const checkAuto = async (): Promise<void> => {
    try {
      const { autoUpdater } = await import('electron-updater')
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('error', (error) => console.warn('[updater]', error.message))
      await autoUpdater.checkForUpdatesAndNotify()
    } catch (error) {
      console.warn('[updater]', error)
    }
  }

  const check = mode === 'auto' ? checkAuto : checkNotifyOnly
  const checkIfEnabled = (): void => {
    if (enabled()) void check()
  }
  checkIfEnabled()
  timer = setInterval(checkIfEnabled, CHECK_INTERVAL_MS)
  return {
    stop: () => clearInterval(timer),
    // A manual check reports "up to date" too; the scheduled one stays quiet.
    checkNow: () => {
      if (mode === 'auto') {
        void checkAuto()
        return
      }
      void checkNotifyOnly(true).then(() => {
        if (notified) return
        void ask({ type: 'info', message: 'DeepSeek Harness is up to date', detail: `Version ${app.getVersion()}.` })
      })
    },
  }
}
