/**
 * Electron main: boot order per the desktop architecture —
 *  1. scheme privileges (must precede app ready)
 *  2. single-instance lock (loser quits before any window or sidecar work)
 *  3. protocol handler behind a promise gate (the window may load before the
 *     sidecar answers; requests queue instead of failing)
 *  4. window + sidecar in parallel; show on ready-to-show
 * Shutdown tears the sidecar down before the app exits.
 *
 * Every failure along the way has to end up on screen. A harness that cannot
 * boot used to reach the user as a white window or a spinner that never
 * resolved, because the launcher restarted the sidecar forever and its only
 * account of why went to a stdout a packaged GUI app cannot print. So: the
 * output goes to a file (SidecarLog), the restarts are budgeted
 * (restart-policy), and running out of budget serves the reason instead of the
 * app (failure-page).
 */
import { app, BrowserWindow, crashReporter, protocol, screen } from 'electron'
import { homedir, tmpdir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchDshHome } from './dsh-home.js'
import { SidecarLog } from './sidecar-log.js'
import { teeConsole } from './console-log.js'
import { failureResponse, type FailureReport } from './failure-page.js'
import { reloadDelayMs, shouldRestart } from './restart-policy.js'
import { createSidecarAddress } from './socket-path.js'
import { createSocketProxy, isDesktopHostPath } from './socket-proxy.js'
import { Sidecar, type SidecarPaths } from './sidecar.js'
import { createMainWindow, MERGED_TITLE_BAR_PLATFORM, titleBand } from './window.js'
import { installMenu } from './menu.js'
import { createDesktopHost } from './desktop-host.js'
import { DesktopSettingsStore } from './settings-host.js'
import { updateMode } from './update-gate.js'
import { installTray } from './tray.js'
import { installShortcuts } from './shortcuts.js'
import { installDownloads } from './downloads.js'
import { resolveSidecarPath } from './login-path.js'
import { startNotifications } from './notifications.js'
import { startPickerHost } from './picker-host.js'
import { clampWindowState, parseWindowState, type StoredWindowState } from './window-state.js'
import { DEEP_LINK_SCHEME, deepLinkFromArgv, parseDeepLink } from './deep-link.js'
import { macUpdatesSigned, startUpdater, type UpdateCheckResult } from './updater.js'
import { UsageStore } from './usage-store.js'
import { canPositionWindow, installWindowMagnet } from './window-magnet.js'
import type { ShortcutHandle } from './shortcuts.js'

/** Product name shown in the menu bar, Dock, About panel, and notifications. */
const APP_NAME = 'DeepSeek Harness'

/**
 * The bundled harness version, read from the pin this app was built against.
 * Shown in the About panel so a bug report names the harness, not just the
 * shell — the two track each other but the shell can be re-released.
 */
const HARNESS_VERSION = (() => {
  try {
    const pin = JSON.parse(readFileSync(fileURLToPath(new URL('../harness.json', import.meta.url)), 'utf8')) as { harness?: string }
    return pin.harness ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

// Unpackaged Electron reports its own name, and the menu bar / notification
// source read app.getName() — so set it before ready, ahead of anything that
// builds a menu or shows a notification. In a packaged app the bundle metadata
// already says this; calling it here keeps dev and packaged identical.
app.setName(APP_NAME)
/**
 * Windows groups taskbar entries and toast notifications by this id — and,
 * when an installer has registered a Start Menu shortcut carrying it, resolves
 * the taskbar icon through that shortcut rather than from the window.
 *
 * A dev run therefore must NOT claim the installed app's id: it would inherit
 * the installed build's icon and taskbar group, so the window's own icon never
 * shows however right the artwork is (measured on a machine with an older
 * release installed). It is also simply true — a checkout is not the installed
 * application.
 */
const APP_USER_MODEL_ID = 'com.github.xxsluna.deepseek-harness-desktop'
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : `${APP_USER_MODEL_ID}.dev`)
}
// Before anything resolves the home: the sidecar inherits this, and the tray's
// "Open Data Folder" and the settings diagnostics read it per click. See
// launchDshHome for what a shared home costs when the pins differ.
const devHome = launchDshHome(app.isPackaged, process.env, homedir())
if (devHome !== undefined) process.env.DSH_HOME = devHome

protocol.registerSchemesAsPrivileged([{
  scheme: 'dsh',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

crashReporter.start({ uploadToServer: false, compress: true })

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  // macOS delivers launch-time deep links here; registration must precede ready.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (parseDeepLink(url) !== undefined) focusMainWindow()
  })
  void run()
}

/** Restore/show/focus the main window, if one exists. */
function focusMainWindow(): void {
  const [win] = BrowserWindow.getAllWindows()
  if (win === undefined) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Resolve the harness root for this launch (packaged vs dev).
 *
 * No runtime to resolve any more: the sidecar runs the harness on this app's
 * own Electron binary under ELECTRON_RUN_AS_NODE, which is correct in both
 * modes without a branch — packaged it is the installed executable, in dev it
 * is node_modules/electron. That also removes the old dev/packaged skew, where
 * dev fell back to whatever `node` PATH offered when build/node was absent.
 */
function resolvePaths(): SidecarPaths {
  if (app.isPackaged) return { harnessRoot: join(process.resourcesPath, 'harness') }
  return { harnessRoot: join(fileURLToPath(new URL('..', import.meta.url)), 'build', 'harness') }
}

async function run(): Promise<void> {
  const address = createSidecarAddress(process.platform, tmpdir())
  const paths = resolvePaths()

  // Read before anything is built: the title bar the window is constructed
  // with, and the band the sidecar bakes into the served stylesheet, are both
  // this preference.
  const settings = new DesktopSettingsStore()
  const band = titleBand(settings.get().mergedTitleBar)

  // Opened before the sidecar so its very first line is captured. In a
  // packaged app this file is the ONLY place sidecar output survives.
  const logs = new SidecarLog(join(app.getPath('userData'), 'logs'))
  // Everything the launcher warns or errors about lands in the same file from
  // here on, including the modules that never knew about it. Installed right
  // after the log so it covers the rest of startup.
  teeConsole(console, (line) => logs.write(line))

  /**
   * Set once the launcher has stopped trying. Read per request below rather
   * than captured, because it is assigned long after the protocol handler is
   * installed — that is the whole point: a crash loop that outlives its budget
   * has to be able to change what the page gets.
   */
  let failure: FailureReport | undefined

  /**
   * The socket proxy, once a sidecar has answered. Built from `address`, which
   * `Sidecar.restart` keeps stable across restarts, so one instance serves for
   * the life of the app however many times the harness comes and goes.
   */
  let proxy: ((request: Request) => Promise<Response>) | undefined

  /** Reload the window, if there still is one. */
  const reloadWindow = (): void => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win === undefined || win.isDestroyed()) return
    win.webContents.reload()
  }

  /** Give up on the harness and put the reason on screen. */
  const reportFailure = (summary: string, detail: string): FailureReport => {
    // One collapse reports once, however many callers reach here for it — a
    // coalesced restart rejects one per waiter, and the initial start rejects
    // separately from the recovery it triggered.
    //
    // A second report still gets through when the sidecar came back in
    // between, because `connected` cleared this. That is not a duplicate: it
    // happens when the harness binds its socket and only then dies, so
    // `Sidecar.start`'s probe — which asks whether the socket answers, not
    // whether the app is up — resolves before the boot fails. Two collapses,
    // two reports, and the last one is the one on screen.
    if (failure !== undefined) return failure
    // One call, not two: the console tee writes this to the log, and the tail
    // below has to contain it — so it is emitted before the report is built.
    console.error(`launcher: ${summary}: ${detail}`)
    const report = { summary, detail, logPath: logs.path, tail: logs.tail() }
    failure = report
    // The page is only served on the next request, so ask for one.
    reloadWindow()
    return report
  }

  /**
   * A sidecar is answering: serve it, and drop any failure the last one left
   * behind. Clearing `failure` is what makes a recovered crash actually
   * recover — without it the app was up and the window kept showing why it
   * had been down.
   */
  const connected = (): void => {
    proxy ??= createSocketProxy(address)
    failure = undefined
  }

  /** Unexpected exit timestamps, for the crash-loop budget. */
  const exits: number[] = []

  const sidecar = new Sidecar({
    ...paths,
    address,
    titleBand: band,
    path: resolveSidecarPath(process.env, process.platform),
    cwd: homedir(),
    onLog: (line) => {
      console.log(`[sidecar] ${line}`)
      logs.write(line)
    },
    onUnexpectedExit: (code) => {
      const detail = `sidecar exited unexpectedly (code ${String(code)})`
      exits.push(Date.now())
      // A boot that fails on its own state fails identically every time, so
      // without this the launcher respawns forever and the window shows a
      // white page or a spinner with no reason anywhere. Measured at ~2.6s per
      // cycle against a `.credentials.yaml` a newer pin had migrated.
      if (!shouldRestart(exits, Date.now())) {
        reportFailure('The harness keeps exiting during startup, so the launcher stopped restarting it.', detail)
        return
      }
      console.error(`launcher: ${detail}; restarting`)
      // restart(), not start(): with the crash handler and the marketplace's
      // market/restart both able to bring the harness back, this is the only
      // way the two share one coalesced restart instead of racing two
      // processes onto one $DSH_HOME. stop() is a no-op here — the process is
      // already gone — so the recovery itself behaves as it always did.
      void sidecar.restart().then(
        // What `Sidecar.restart` documents as the caller's half: the served
        // index.html bakes window.__DSH_BOOT__ in, so a page that lived across
        // the gap holds URLs for a process that no longer exists and every
        // fetch it makes fails. market/restart already did this; crash
        // recovery did not, which is why a blip left the window permanently
        // showing "Failed to load plugins".
        () => {
          connected()
          reloadWindow()
        },
        (error: unknown) => {
          reportFailure('The harness crashed and could not be restarted.', String(error))
        },
      )
    },
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void sidecar.stop().finally(() => app.exit(0))
  })
  // The window close keeps the app (and sidecar) alive; Cmd+Q / menu quits.
  app.on('window-all-closed', () => {})
  app.on('second-instance', (_event, argv) => {
    deepLinkFromArgv(argv) // v1's only route is "open"; recognized or not, focus.
    focusMainWindow()
  })

  await app.whenReady()

  // The About panel is otherwise labelled from the Electron bundle in dev.
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: `harness ${HARNESS_VERSION}`,
    copyright: 'MIT — bundles DeepSeek Harness (c) DeepSeek AI',
  })

  // Requests queue on this gate until the sidecar answers; a startup failure
  // leaves `proxy` unset and `failure` reported, which the handler below reads.
  //
  // The proxy is a variable rather than this promise's value because recovery
  // has to be able to replace it. A gate that resolved to a failure-page
  // handler kept serving that page after a later restart succeeded — the app
  // was up, and the window said it was down, forever.
  const sidecarReady = sidecar.start().then(connected, (error: unknown) => {
    reportFailure('The harness did not start.', String(error))
  })
  // The launcher's own routes are answered here, ahead of the proxy: they are
  // launcher business, and they must work while the sidecar gate is still
  // pending rather than queue behind it. `updater` is assigned below, after
  // the window; nothing can call this before then.
  let updater: { stop: () => void, checkNow: () => Promise<UpdateCheckResult> } | undefined
  // Assigned with the window below. The routes that read it are answered before
  // the window guard, so both are looked up per request rather than captured.
  let shortcuts: ShortcutHandle | undefined
  const usage = new UsageStore()
  app.on('before-quit', () => usage.flush())
  const desktopHost = createDesktopHost({
    getWindow: () => BrowserWindow.getAllWindows()[0],
    settings,
    harnessVersion: HARNESS_VERSION,
    // The real flag, not a hardcoded true. Passing true here made the section
    // describe an unsigned macOS build as installing updates, which it cannot;
    // `startUpdater` has always resolved the same value for its own behaviour.
    updates: updateMode({
      platform: process.platform,
      packaged: app.isPackaged,
      macUpdatesSigned: macUpdatesSigned(),
    }),
    titleBarMergeable: MERGED_TITLE_BAR_PLATFORM,
    canPositionWindow: canPositionWindow(process.platform, process.env.XDG_SESSION_TYPE),
    toggleAcceleratorActive: () => shortcuts?.isActive() === true,
    checkForUpdates: async () =>
      await (updater?.checkNow() ?? Promise.resolve<UpdateCheckResult>({
        state: 'unsupported',
        message: 'The updater is not running yet.',
      })),
    usage: () => usage.view(),
    resetUsage: () => usage.reset(),
    restartSidecar: () => sidecar.restart(),
  })
  protocol.handle('dsh', async (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (isDesktopHostPath(pathname)) return await desktopHost(request, pathname)
    await sidecarReady
    // Both read per request, not captured at the gate: the sidecar can be lost
    // long after this resolved, and can come back afterwards. Every fetch the
    // page makes has to be answered with the current truth rather than left
    // hanging on a socket nobody is listening on — that hang is exactly what a
    // user sees as an endless spinner.
    if (failure !== undefined) return failureResponse(failure)
    if (proxy === undefined) {
      return failureResponse({
        summary: 'The harness is not running.',
        detail: 'The sidecar never answered its socket.',
        logPath: logs.path,
        tail: logs.tail(),
      })
    }
    return await proxy(request)
  })

  installMenu()

  // Window-state persistence: parse, clamp against live displays, debounce saves.
  const statePath = join(app.getPath('userData'), 'window-state.json')
  const readState = (): string | undefined => {
    try {
      return readFileSync(statePath, 'utf8')
    } catch {
      return undefined
    }
  }
  const state = clampWindowState(parseWindowState(readState()), screen.getAllDisplays().map((d) => d.workArea))

  const win = createMainWindow(band)
  if (!Number.isNaN(state.x)) win.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height })
  else win.setSize(state.width, state.height)
  if (state.maximized) win.maximize()

  let saveTimer: NodeJS.Timeout | undefined
  const saveState = (): void => {
    const bounds = win.getNormalBounds()
    const next: StoredWindowState = { ...bounds, maximized: win.isMaximized() }
    try {
      writeFileSync(statePath, JSON.stringify(next))
    } catch { /* state persistence is best-effort */ }
  }
  const scheduleSave = (): void => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveState, 250)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('maximize', scheduleSave)
  win.on('unmaximize', scheduleSave)

  // Closing hides to the tray by default; Desktop Settings can make it quit.
  // Read per close, not captured: the preference changes while the app runs.
  win.on('close', (event) => {
    if (quitting) return
    saveState()
    if (settings.get().closeAction === 'quit') {
      // Let the close through; before-quit tears the sidecar down.
      app.quit()
      return
    }
    event.preventDefault()
    win.hide()
  })

  // Both preferences are read per check rather than captured: the user changes
  // them while the app runs, and a captured channel would leave the switch
  // doing nothing until a restart.
  updater = startUpdater(() => settings.get().autoUpdate, win, () => settings.get().updateChannel)
  app.on('before-quit', () => updater?.stop())

  // The tray is unconditional: it is how a hidden window comes back, and with
  // "quit on close" the app is gone anyway, so hiding the icon would only ever
  // remove the data folder and update entries.
  // The tray item wants no answer back: checkNow reports through its own
  // dialog, and the promise only exists so the settings page can render the
  // outcome inline. Discarded explicitly rather than left floating.
  const tray = installTray(win, () => { void updater?.checkNow() })
  app.on('before-quit', () => tray.destroy())

  const stopDownloads = installDownloads(win.webContents.session)
  shortcuts = installShortcuts(win, settings.get().toggleAccelerator)
  const stopMagnet = installWindowMagnet(win, () => settings.get().snapToEdges)
  // The accelerator is the one preference that cannot be read per use: the OS
  // routes the chord, so the app has to be holding the right one in advance.
  // Everything else here is read at the moment it matters.
  const stopWatchingSettings = settings.subscribe((next) => {
    shortcuts?.rebind(next.toggleAccelerator)
  })
  app.on('before-quit', () => {
    stopDownloads()
    stopWatchingSettings()
    stopMagnet()
    shortcuts?.stop()
  })

  if (!app.isPackaged) {
    const { installDevTuning } = await import('./dev-tuning.js')
    installDevTuning(win, fileURLToPath(new URL('..', import.meta.url)))
  }

  // A failed load leaves the window blank for the rest of the app's life:
  // nothing else retries, and the renderer has no reason to try again on its
  // own. Bounded by reloadDelayMs so a sidecar that is genuinely gone becomes
  // a visible window rather than an endless reload.
  const loadFailures: number[] = []
  win.webContents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) => {
    // ERR_ABORTED (-3) is what a navigation the app itself replaced reports,
    // and a subframe failure is the page's own business.
    if (!isMainFrame || errorCode === -3) return
    loadFailures.push(Date.now())
    const delay = reloadDelayMs(loadFailures, Date.now())
    // console, not logs.write: the tee carries it to the log either way, and a
    // dev run gets to see it in the terminal too.
    console.warn(
      `launcher: page load failed (${String(errorCode)} ${description})`
      + (delay === undefined ? '; giving up' : `; retrying in ${String(delay)}ms`),
    )
    if (delay === undefined) {
      // Better a blank window the user can act on — the View menu still
      // reloads — than an app that looks like it never launched.
      if (!win.isDestroyed() && !win.isVisible()) win.show()
      return
    }
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload()
    }, delay)
  })

  win.once('ready-to-show', () => win.show())
  await win.loadURL('dsh://app/')

  void sidecarReady.then(() => {
    const stopNotifications = startNotifications(address, win, () => settings.get(), { usage })
    const stopPickerHost = startPickerHost(address, win)
    app.on('before-quit', () => {
      stopNotifications()
      stopPickerHost()
    })
  })

  if (process.env.DSH_DESKTOP_SMOKE === '1') await runSmoke(win, () => sidecar.stop())
}

/**
 * Headless self-check for CI and local verification: waits for the client
 * plugin tree to settle, then asserts the UI actually rendered. Prints
 * RESULT lines, stops the sidecar (app.exit skips before-quit), and exits.
 * @param win - the loaded main window.
 * @param stopSidecar - graceful sidecar shutdown to run before exiting.
 */
async function runSmoke(win: Electron.BrowserWindow, stopSidecar: () => Promise<void>): Promise<void> {
  const results: [string, boolean, string][] = []
  const check = (name: string, pass: boolean, detail = ''): void => {
    results.push([name, pass, detail])
    console.log(`RESULT ${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`)
  }
  let pageErrors = 0
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) {
      pageErrors += 1
      console.log(`[renderer:error] ${message}`)
    }
  })
  try {
    const settled = await win.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const root = document.getElementById('root')
        if (root !== null && root.children.length > 0 && document.querySelector('[class]') !== null) {
          return { ok: true, boot: Array.isArray(window.__DSH_BOOT__?.entries) ? window.__DSH_BOOT__.entries.length : 0 }
        }
        await new Promise(r => setTimeout(r, 500))
      }
      return { ok: false, boot: Array.isArray(window.__DSH_BOOT__?.entries) ? window.__DSH_BOOT__.entries.length : 0 }
    })()`)
    check('ui-rendered', settled.ok === true, `boot entries: ${String(settled.boot)}`)
    check('origin', await win.webContents.executeJavaScript('location.origin') === 'dsh://app')
    check('page-errors', pageErrors === 0, `${pageErrors} console errors`)
  } catch (error) {
    check('smoke', false, String(error))
  }
  const pass = results.every(([, ok]) => ok)
  console.log(`SUMMARY ${pass ? 'ALL-PASS' : 'HAS-FAIL'}`)
  await stopSidecar()
  app.exit(pass ? 0 : 1)
}
