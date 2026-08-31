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

/** How long a manual check waits for electron-updater to answer. */
const MANUAL_CHECK_TIMEOUT_MS = 30_000

/**
 * Read the build-baked macOS signing flag from the packaged manifest.
 *
 * Exported because the settings view needs the same answer: it describes what
 * the update switch does, and on an unsigned macOS build that is "tells you"
 * rather than "installs". Computing the mode from a hardcoded `true` there said
 * the wrong thing on the one platform the flag exists for.
 * @returns true when the build was signed for Squirrel.Mac.
 */
export function macUpdatesSigned(): boolean {
  try {
    // package.json inside the asar carries extraMetadata from the build.
    const manifest = require('../package.json') as { desktop?: { macUpdatesSigned?: boolean } }
    return manifest.desktop?.macUpdatesSigned === true
  } catch {
    return false
  }
}

type AutoUpdater = (typeof import('electron-updater'))['autoUpdater']

/** What a manual check learned, from whichever event answered first. */
type ManualOutcome = 'available' | 'up-to-date' | { failed: string }

/**
 * What a manual check reports back to whoever asked for it.
 *
 * The settings page renders this inline instead of only hearing about it
 * through a dialog: before this existed the route fired the check and returned
 * 204 immediately, so the button did nothing visible for up to thirty seconds
 * and then a native window appeared, which reads as a broken button rather
 * than a slow one.
 */
export interface UpdateCheckResult {
  state: 'up-to-date' | 'downloading' | 'available' | 'unsupported' | 'failed'
  /** One line for the page; the dialog says the same thing at more length. */
  message: string
  /** The version found, when the check found one. */
  version?: string
}

/**
 * electron-updater's `autoUpdater` is a process singleton, so its listeners
 * belong to the process rather than to a check. Registering them inside the
 * check attached one more `error` listener every four hours: a single failure
 * then logged once per accumulated listener, and Node's
 * MaxListenersExceededWarning fired on the eleventh check. Wire it once.
 */
let wiring: Promise<AutoUpdater> | undefined

/**
 * Set only while a manual check is waiting. electron-updater reports through
 * events rather than through the call's return value, so this is how an outcome
 * reaches the dialog. A scheduled check leaves it undefined and stays quiet,
 * which is what the Desktop Settings copy promises.
 */
let reportManual: ((outcome: ManualOutcome) => void) | undefined

/**
 * Load electron-updater and attach its listeners, at most once per process.
 *
 * `require`, not `await import`. electron-updater is CJS and defines
 * `autoUpdater` as a lazy getter on `module.exports`; cjs-module-lexer cannot
 * see a getter, so Node's ESM interop never surfaces it as a named export and
 * `const { autoUpdater } = await import('electron-updater')` binds undefined.
 * TypeScript disagrees — the .d.ts declares the export, so the destructure
 * compiles clean and fails only at runtime, one line later, with `Cannot set
 * properties of undefined (setting 'autoDownload')`.
 *
 * That is what EVERY update check this app ever made returned, scheduled and
 * manual alike, from the commit that added this file onwards. The app could
 * not update itself, which is its own bug and was also the reason an installed
 * build could sit far enough behind the checkout for their `$DSH_HOME` layouts
 * to diverge. Pinned in tests/unit/updater-interop.spec.ts, because nothing
 * about the broken form looks broken.
 * @returns the configured singleton.
 */
async function autoUpdaterOnce(): Promise<AutoUpdater> {
  wiring ??= (async () => {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', (error) => {
      console.warn('[updater]', error.message)
      reportManual?.({ failed: error.message })
    })
    autoUpdater.on('update-available', () => reportManual?.('available'))
    autoUpdater.on('update-not-available', () => reportManual?.('up-to-date'))
    return autoUpdater
  })()
  try {
    return await wiring
  } catch (error) {
    // A failed import must not poison every later check with a cached rejection.
    wiring = undefined
    throw error
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
): { stop: () => void, checkNow: () => Promise<UpdateCheckResult> } {
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
    const detail = app.isPackaged
      ? 'This platform cannot self-update; download new versions from the releases page.'
      : 'Development builds are not updated.'
    return {
      stop: () => {},
      // An unpackaged or unsupported build has nothing to check; say so rather
      // than leaving a menu item that appears to do nothing.
      checkNow: async () => {
        void ask({ type: 'info', message: 'Updates are not available for this build', detail })
        return { state: 'unsupported', message: detail }
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
      await (await autoUpdaterOnce()).checkForUpdatesAndNotify()
    } catch (error) {
      console.warn('[updater]', error)
      reportManual?.({ failed: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The manual check on the electron-updater path.
   *
   * It has to say something. `checkNow` used to fire the check and return, so on
   * Windows and Linux the menu item produced no dialog at all — no "up to date",
   * no error — which is the opposite of what the comment beside it claimed and
   * exactly the platforms that do self-update. electron-updater answers through
   * events, so wait for the first one, with a timeout so a feed that never
   * responds cannot leave the menu item looking dead.
   * @returns nothing; it reports through a dialog.
   */
  const checkAutoManual = async (): Promise<UpdateCheckResult> => {
    const outcome = await new Promise<ManualOutcome>((resolve) => {
      const expiry = setTimeout(() => { resolve({ failed: 'The update check did not answer.' }) }, MANUAL_CHECK_TIMEOUT_MS)
      reportManual = (answer) => {
        clearTimeout(expiry)
        resolve(answer)
      }
      void checkAuto()
    })
    reportManual = undefined
    if (outcome === 'up-to-date') {
      void ask({ type: 'info', message: 'DeepSeek Harness is up to date', detail: `Version ${app.getVersion()}.` })
      return { state: 'up-to-date', message: `Up to date — version ${app.getVersion()}.` }
    }
    if (outcome === 'available') {
      // autoDownload is on and autoInstallOnAppQuit applies it, so the work is
      // already under way. Say that rather than implying a click is needed.
      void ask({
        type: 'info',
        message: 'A new version is downloading',
        detail: 'It installs when you quit DeepSeek Harness.',
      })
      return { state: 'downloading', message: 'A new version is downloading; it installs when you quit.' }
    }
    void ask({ type: 'warning', message: 'Could not check for updates', detail: outcome.failed })
    return { state: 'failed', message: outcome.failed }
  }

  const check = mode === 'auto' ? checkAuto : checkNotifyOnly
  const checkIfEnabled = (): void => {
    if (enabled()) void check()
  }
  checkIfEnabled()
  timer = setInterval(checkIfEnabled, CHECK_INTERVAL_MS)
  /**
   * The manual check in flight, if any.
   *
   * `reportManual` is a single module-level slot, so two overlapping manual
   * checks would have the second overwrite the first's resolver and leave the
   * first hanging until its own timeout. Sharing one promise makes a second
   * click join the check already running instead of starting a race — which
   * matters now that the button is clickable while it waits rather than being
   * followed immediately by a modal dialog.
   */
  let inFlight: Promise<UpdateCheckResult> | undefined

  const runCheck = async (): Promise<UpdateCheckResult> => {
    if (mode === 'auto') return await checkAutoManual()
    await checkNotifyOnly(true)
    if (notified) {
      return { state: 'available', message: 'A newer version is available on the releases page.' }
    }
    void ask({ type: 'info', message: 'DeepSeek Harness is up to date', detail: `Version ${app.getVersion()}.` })
    return { state: 'up-to-date', message: `Up to date — version ${app.getVersion()}.` }
  }

  return {
    stop: () => clearInterval(timer),
    // A manual check reports "up to date" too; the scheduled one stays quiet.
    checkNow: async () => {
      inFlight ??= runCheck().finally(() => { inFlight = undefined })
      return await inFlight
    },
  }
}
