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
import { tmpdir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSidecarAddress } from './socket-path.js'
import { createSocketProxy } from './socket-proxy.js'
import { Sidecar, type SidecarPaths } from './sidecar.js'
import { createMainWindow } from './window.js'
import { installMenu } from './menu.js'
import { installTray } from './tray.js'
import { startNotifications } from './notifications.js'
import { clampWindowState, parseWindowState, type StoredWindowState } from './window-state.js'
import { DEEP_LINK_SCHEME, deepLinkFromArgv, parseDeepLink } from './deep-link.js'

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

  const sidecar = new Sidecar({
    ...paths,
    address,
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
  protocol.handle('dsh', async (request) => (await sidecarReady)(request))

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

  const win = createMainWindow()
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

  // Close hides to the tray; quitting is the explicit menu/tray/Cmd+Q path.
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    saveState()
    win.hide()
  })

  const tray = installTray(win)
  void tray

  win.once('ready-to-show', () => win.show())
  await win.loadURL('dsh://app/')

  void sidecarReady.then(() => {
    const stopNotifications = startNotifications(address, win)
    app.on('before-quit', () => stopNotifications())
  })

  if (process.env.DSH_DESKTOP_SMOKE === '1') await runSmoke(win)
}

/**
 * Headless self-check for CI and local verification: waits for the client
 * plugin tree to settle, then asserts the UI actually rendered. Prints
 * RESULT lines and exits.
 * @param win - the loaded main window.
 */
async function runSmoke(win: Electron.BrowserWindow): Promise<void> {
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
  app.exit(pass ? 0 : 1)
}
