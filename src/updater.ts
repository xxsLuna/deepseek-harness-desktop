/**
 * Auto-update wiring. Windows (NSIS) and Linux (AppImage) update through
 * electron-updater against this repo's GitHub Releases (public, tokenless).
 * Unsigned macOS builds check the same feed and point the user at the
 * release page instead (see update-gate.ts). Errors are logged, never fatal:
 * an unreachable feed must not affect the app.
 */
import { app, dialog, shell } from 'electron'
import { createRequire } from 'node:module'
import { updateMode } from './update-gate.js'

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

/** Compare two semver-ish tags loosely: returns true when remote differs from local. */
function isDifferentVersion(remote: string, local: string): boolean {
  return remote.trim() !== '' && remote.trim() !== local.trim()
}

/** Start periodic checks; returns a disposer. */
export function startUpdater(): () => void {
  const mode = updateMode({
    platform: process.platform,
    packaged: app.isPackaged,
    macUpdatesSigned: macUpdatesSigned(),
  })
  if (mode === 'disabled') return () => {}

  let timer: NodeJS.Timeout | undefined
  let notified = false

  const checkNotifyOnly = async (): Promise<void> => {
    try {
      const response = await fetch(FEED_MAC_YML, { redirect: 'follow' })
      if (!response.ok) return
      const text = await response.text()
      const version = /^version:\s*(.+)$/m.exec(text)?.[1]
      if (version === undefined || !isDifferentVersion(version, app.getVersion()) || notified) return
      notified = true
      const { response: button } = await dialog.showMessageBox({
        type: 'info',
        message: `DeepSeek Harness Desktop ${version} is available`,
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
  void check()
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS)
  return () => clearTimeout(timer)
}
