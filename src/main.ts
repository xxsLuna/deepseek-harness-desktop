/**
 * Electron main: boot order per the desktop architecture —
 *  1. scheme privileges (must precede app ready)
 *  2. single-instance lock (loser quits before any window or sidecar work)
 *  3. protocol handler behind a promise gate (the window may load before the
 *     sidecar answers; requests queue instead of failing)
 *  4. window + sidecar in parallel; show on ready-to-show
 * Shutdown tears the sidecar down before the app exits.
 */
import { app, BrowserWindow, crashReporter, protocol, screen } from 'electron'
import { homedir, tmpdir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { startUpdater } from './updater.js'

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

/** Resolve the node binary and harness root for this launch (packaged vs dev). */
function resolvePaths(): SidecarPaths {
  if (app.isPackaged) {
    const resources = process.resourcesPath
    return {
      nodeBinary: join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
      harnessRoot: join(resources, 'harness'),
    }
  }
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const fetched = join(repoRoot, 'build', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  return {
    // Dev prefers the fetched runtime when present so dev matches the package.
    nodeBinary: existsSync(fetched) ? fetched : 'node',
    harnessRoot: join(repoRoot, 'build', 'harness'),
  }
}

async function run(): Promise<void> {
  const address = createSidecarAddress(process.platform, tmpdir())
  const paths = resolvePaths()

  // Read before anything is built: the title bar the window is constructed
  // with, and the band the sidecar bakes into the served stylesheet, are both
  // this preference.
  const settings = new DesktopSettingsStore()
  const band = titleBand(settings.get().mergedTitleBar)

  const sidecar = new Sidecar({
    ...paths,
    address,
    titleBand: band,
    path: resolveSidecarPath(process.env, process.platform),
    cwd: homedir(),
    onLog: (line) => console.log(`[sidecar] ${line}`),
    onUnexpectedExit: (code) => {
      console.error(`[sidecar] exited unexpectedly (code ${String(code)}); restarting`)
      void sidecar.start().catch((error: unknown) => {
        console.error('[sidecar] restart failed:', error)
        app.exit(1)
      })
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
  // resolves the gate to an error page instead of a dead window.
  const sidecarReady = sidecar.start().then(
    () => createSocketProxy(address),
    (error: unknown) => {
      console.error('[sidecar] startup failed:', error)
      return async () => new Response(
        `<h1>DeepSeek Harness failed to start</h1><pre>${String(error)}</pre>`,
        { status: 503, headers: { 'content-type': 'text/html' } },
      )
    },
  )
  // The launcher's own routes are answered here, ahead of the proxy: they are
  // launcher business, and they must work while the sidecar gate is still
  // pending rather than queue behind it. `updater` is assigned below, after
  // the window; nothing can call this before then.
  let updater: { stop: () => void, checkNow: () => void } | undefined
  const desktopHost = createDesktopHost({
    getWindow: () => BrowserWindow.getAllWindows()[0],
    settings,
    harnessVersion: HARNESS_VERSION,
    updatable: updateMode({
      platform: process.platform,
      packaged: app.isPackaged,
      macUpdatesSigned: true,
    }) !== 'disabled',
    titleBarMergeable: MERGED_TITLE_BAR_PLATFORM,
    checkForUpdates: () => updater?.checkNow(),
  })
  protocol.handle('dsh', async (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    if (isDesktopHostPath(pathname)) return await desktopHost(request, pathname)
    return await (await sidecarReady)(request)
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

  updater = startUpdater(() => settings.get().autoUpdate, win)
  app.on('before-quit', () => updater?.stop())

  // The tray is unconditional: it is how a hidden window comes back, and with
  // "quit on close" the app is gone anyway, so hiding the icon would only ever
  // remove the data folder and update entries.
  const tray = installTray(win, () => updater?.checkNow())
  app.on('before-quit', () => tray.destroy())

  const stopDownloads = installDownloads(win.webContents.session)
  const stopShortcuts = installShortcuts(win)
  app.on('before-quit', () => {
    stopDownloads()
    stopShortcuts()
  })

  if (!app.isPackaged) {
    const { installDevTuning } = await import('./dev-tuning.js')
    installDevTuning(win, fileURLToPath(new URL('..', import.meta.url)))
  }

  win.once('ready-to-show', () => win.show())
  await win.loadURL('dsh://app/')

  void sidecarReady.then(() => {
    const stopNotifications = startNotifications(address, win, () => settings.get())
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
