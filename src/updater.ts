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
import {
  channelOf,
  newestTagOnChannel,
  resolveUpdateChannel,
  type UpdateChannel,
} from './update-channel.js'

const require = createRequire(import.meta.url)

const RELEASES_URL = 'https://github.com/xxsLuna/deepseek-harness-desktop/releases/latest'
const RELEASES_BASE = 'https://github.com/xxsLuna/deepseek-harness-desktop/releases'
/**
 * The channel-blind feed, kept as the fallback for a build whose version this
 * scheme does not describe — a dev run. With one channel it was also correct;
 * `macFeedForChannel` is what makes it correct with more than one.
 */
const FEED_MAC_YML = `${RELEASES_BASE}/latest/download/latest-mac.yml`
/** Newest-first list of every release, the way GitHubProvider reads it. */
const RELEASES_ATOM = 'https://github.com/xxsLuna/deepseek-harness-desktop/releases.atom'
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

/**
 * The mac feed URL for one channel, or undefined when that channel has no
 * release yet.
 *
 * A network read, so it is separated from the pure tag-picking in
 * `newestTagOnChannel`. An unreachable feed returns undefined and the caller
 * simply tries again next interval — an update check must never be fatal.
 * @param channel - the resolved channel identifier.
 * @returns the `latest-mac.yml` URL for that channel's newest release.
 */
async function macFeedForChannel(channel: string): Promise<string | undefined> {
  try {
    const response = await fetch(RELEASES_ATOM, { redirect: 'follow' })
    if (!response.ok) return undefined
    const tag = newestTagOnChannel(await response.text(), channel)
    return tag === undefined ? undefined : `${RELEASES_BASE}/download/${tag}/latest-mac.yml`
  } catch {
    return undefined
  }
}

type AutoUpdater = (typeof import('electron-updater'))['autoUpdater']

/** What a manual check learned, from whichever event answered first. */
type ManualOutcome = { available: string } | 'up-to-date' | { failed: string }

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
  state: 'up-to-date' | 'available' | 'unsupported' | 'failed'
  /** One line for the page; the dialog says the same thing at more length. */
  message: string
  /** The version found, when the check found one. */
  version?: string
}

/** What the launcher supplies that the updater cannot decide for itself. */
export interface UpdaterOptions {
  /**
   * How the app comes down before the installer takes over.
   *
   * The sidecar's stop, not `app.quit()`: `quitAndInstall` spawns the installer
   * and only then quits, so the harness has to be out of the install directory
   * already. See the ordering note in `applyUpdate`.
   */
  readonly shutdown?: () => Promise<void>
  /**
   * Whether an available update may put a dialog on screen.
   *
   * False for the packaged smoke. That gate runs the real updater against the
   * real feed on a CI runner, and assigning a channel sets `allowDowngrade`, so
   * a build newer than its channel's newest release is offered that release and
   * `update-available` fires. A modal with nobody to answer it hangs the gate
   * until its timeout and reports `exit null` — while the check itself is worth
   * keeping, because it is what surfaced an EPIPE crash on an updater log line.
   */
  readonly offerInteractively?: boolean
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
 * How an available update is offered, and how a downloaded one is applied.
 * Both injected by {@link startUpdater}.
 *
 * Module-level for the same reason as `readChannel` below: the listeners are
 * attached to a memoised process singleton, while these two close over the
 * window (to parent a dialog) and over the sidecar (to shut it down). Left
 * undefined, an update is simply never offered — which is what a launcher that
 * never calls `startUpdater` should do.
 */
let offerUpdate: ((version: string) => void) | undefined
let applyUpdate: (() => void) | undefined

/**
 * How the channel preference is read, injected by {@link startUpdater}.
 *
 * A function rather than a value, and module-level rather than a parameter,
 * because the singleton above is memoised per process while the preference
 * changes under it. The default keeps a launcher that never calls
 * `startUpdater` — the tests — following the build's own channel.
 */
let readChannel: () => UpdateChannel = () => 'auto'

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
    // OFF, and this is the whole shape of the update flow.
    //
    // With it on, a check downloaded ~100MB unasked and the only thing the app
    // could then say was "it installs when you quit" — because the install
    // rode `autoInstallOnAppQuit`, whose handler calls `install(true, false)`.
    // That second argument is `isForceRunAfter`, so the app installed and did
    // NOT come back: the user quit, waited, and had to launch it again by hand.
    //
    // Off, the sequence is the one a desktop app is expected to have: ask,
    // download on consent, then install and relaunch. `quitAndInstall(true,
    // true)` is what passes `isForceRunAfter` through (BaseUpdater.js:13-16).
    autoUpdater.autoDownload = false
    // Still on, as the fallback for the gap between a consented download
    // finishing and the relaunch: if the user quits inside it, the update is
    // already on disk and this installs it rather than discarding the work.
    // Harmless once `quitAndInstall` has run — its handler sees
    // `quitAndInstallCalled` and stands down instead of installing twice.
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', (error) => {
      console.warn('[updater]', error.message)
      reportManual?.({ failed: error.message })
    })
    autoUpdater.on('update-available', (info) => {
      reportManual?.({ available: info.version })
      offerUpdate?.(info.version)
    })
    autoUpdater.on('update-not-available', () => reportManual?.('up-to-date'))
    // Only reachable after a consented `downloadUpdate()`, since autoDownload
    // is off above.
    autoUpdater.on('update-downloaded', () => { applyUpdate?.() })
    return autoUpdater
  })()
  let updater: AutoUpdater
  try {
    updater = await wiring
  } catch (error) {
    // A failed import must not poison every later check with a cached rejection.
    wiring = undefined
    throw error
  }
  // Assigned per call rather than inside the memoised wiring: the preference
  // changes while the app runs, and a channel read once at startup would leave
  // the switch doing nothing until a restart with no sign of why.
  //
  // Assigning it also sets `allowDowngrade` as a side effect
  // (AppUpdater.js:33-44), which is what makes a switch AWAY from stable
  // reachable at all — `desktop-alpha0` sorts below `desktop-v0`.
  //
  // Left alone for an off-scheme version — a dev build reports Electron's own —
  // so the updater derives what it can instead of being pointed at a channel
  // nobody publishes to, which would report "up to date" forever.
  const channel = resolveUpdateChannel(readChannel(), app.getVersion())
  if (channel !== undefined) updater.channel = channel
  return updater
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
  channel: () => UpdateChannel = () => 'auto',
  options: UpdaterOptions = {},
): { stop: () => void, checkNow: () => Promise<UpdateCheckResult> } {
  const shutdown = options.shutdown ?? (async () => {})
  const offerInteractively = options.offerInteractively ?? true
  // Read per check, like `enabled`: both are preferences the user changes while
  // the app is running, and neither may be captured.
  readChannel = channel
  // Parented, every dialog below is a sheet. A parentless showMessageBox on
  // macOS runs a modal loop that blocks the main thread outright: no window
  // load, no sidecar output, nothing until someone clicks it (which is a hang
  // on a headless runner, and how this was found).
  const ask = async (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    (win === undefined || win.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(win, options))
  /**
   * Offered once per run, so a four-hourly check cannot nag. A manual check
   * clears it, because asking again is exactly what the user just requested.
   */
  let offered = false

  offerUpdate = (version) => {
    if (!offerInteractively || offered) return
    offered = true
    void (async () => {
      const { response } = await ask({
        type: 'info',
        message: `DeepSeek Harness ${version} is available`,
        // The restart is stated before the download starts, not after. It is
        // the part that costs the user something: the harness sidecar goes
        // down with the app, so anything running in it ends.
        detail: 'It downloads in the background, then the app restarts to finish installing. Any running session ends, so finish what you are doing first.',
        buttons: ['Download and restart', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response !== 0) {
        // Declined, so let a later check offer it again rather than going
        // quiet until the next launch.
        offered = false
        return
      }
      try {
        await (await autoUpdaterOnce()).downloadUpdate()
      } catch (error) {
        offered = false
        console.warn('[updater]', error)
        void ask({
          type: 'warning',
          message: 'Could not download the update',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  applyUpdate = () => {
    void (async () => {
      const updater = await autoUpdaterOnce()
      // The sidecar goes down FIRST, and the order is load-bearing.
      // `quitAndInstall` spawns the installer and only then quits the app
      // (BaseUpdater.js:13-23), so without this the NSIS installer would be
      // rewriting the install directory while the harness is still running out
      // of it — holding open the very files being replaced.
      //
      // The old path got this for free and by accident: the install rode the
      // quit handler, and main's `before-quit` already tears the sidecar down
      // before it exits. Taking the install off that handler means taking the
      // ordering on deliberately.
      try {
        await shutdown()
      } catch (error) {
        // A sidecar that will not stop is not a reason to abandon an update
        // that is already downloaded; the installer waits for the app anyway.
        console.warn('[updater]', error)
      }
      // `true, true` — silent, and run afterwards. The second argument is the
      // one the quit handler hardcodes to false, and the only reason the app
      // used to stay closed.
      updater.quitAndInstall(true, true)
    })()
  }

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
      const running = app.getVersion()
      const target = resolveUpdateChannel(readChannel(), running)
      // Resolve the tag on OUR channel rather than reading
      // `releases/latest/...`, which is GitHub's own newest release on any
      // channel. Without this the one platform that cannot use
      // electron-updater is also the one platform with no channel logic, and a
      // stable macOS user gets an alpha release offered in a modal dialog.
      const feed = target === undefined
        ? FEED_MAC_YML
        : await macFeedForChannel(target)
      if (feed === undefined) return
      const response = await fetch(feed, { redirect: 'follow' })
      if (!response.ok) return
      const text = await response.text()
      const version = /^version:\s*(.+)$/m.exec(text)?.[1]
      if (version === undefined) return
      // Within a channel, "newer" is the question. Across one — the user just
      // switched — it is the wrong question: the channels are deliberately
      // ordered against each other, so the newest release on the channel they
      // chose IS the move, however it sorts against what they are running.
      const switching = target !== undefined && target !== channelOf(running)
      if (!switching && !isNewerVersion(version, running)) return
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
      // `checkForUpdates`, not `…AndNotify`: that variant only notifies when
      // autoDownload produced a download promise, which is now never. It
      // would degrade to this call silently and leave the name lying.
      await (await autoUpdaterOnce()).checkForUpdates()
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
    // The user asked, so they get the offer even if this run already declined
    // one. Without this, "Check now" after a Later would report the version
    // and never put the button back.
    offered = false
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
    if (typeof outcome === 'object' && 'available' in outcome) {
      // No dialog here. `offerUpdate` already put one on screen from the same
      // event, and this used to add a second — it announced a download that
      // autoDownload had started unasked. The consent dialog is now the whole
      // conversation; this only answers the settings page's inline line.
      return {
        state: 'available',
        message: `Version ${outcome.available} is available.`,
        version: outcome.available,
      }
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
