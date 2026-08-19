/**
 * Dev-only live-tuning loop (never active in a packaged app):
 *
 *  - `dev-overrides.css` at the repo root is injected into the window and
 *    re-injected on every save — style tuning without an app restart.
 *  - writing JS into `dev-eval.js` executes it in the renderer and writes the
 *    JSON result to `dev-eval.out.json` — DOM inspection while tuning.
 *  - touching `dev-capture.request` saves a window screenshot to
 *    `dev-capture.png`.
 *  - writing `x,y` into `dev-click.request` sends an OS-level click at those
 *    window coordinates — React ignores synthetic `el.click()` on some
 *    controls, so driving the real input path is the only reliable way to
 *    exercise them while tuning.
 *
 * All files are gitignored working files, so they come and go: deleting one is
 * itself a watch event, and every handler here runs inside an fs.watch
 * callback where a throw is an uncaught exception in the MAIN process — which
 * Electron shows as a crash dialog over the app. Nothing below is allowed to
 * throw for a file that is simply not there.
 */
import type { BrowserWindow } from 'electron'
import { readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Read a watched working file.
 * @param path - the file to read.
 * @returns its contents, or undefined when it is missing or unreadable — the
 * file can be deleted, renamed or replaced between the event and the read, so
 * an existsSync guard would still race.
 */
function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Wrap a watch handler so nothing it does can reach the main process as an
 * uncaught exception or an unhandled rejection.
 * @param label - name used when reporting a failure.
 * @param run - the handler.
 * @returns the guarded handler.
 */
function guard(label: string, run: () => void | Promise<void>): () => void {
  const report = (error: unknown): void => console.error(`[dev] ${label} failed:`, error)
  return () => {
    try {
      const result = run()
      if (result instanceof Promise) void result.catch(report)
    } catch (error) {
      report(error)
    }
  }
}

/**
 * Install the watchers on the main window.
 * @param win - the app window.
 * @param repoRoot - checkout root holding the dev files.
 */
export function installDevTuning(win: BrowserWindow, repoRoot: string): void {
  const cssPath = join(repoRoot, 'dev-overrides.css')
  const evalPath = join(repoRoot, 'dev-eval.js')
  const capturePath = join(repoRoot, 'dev-capture.request')
  const clickPath = join(repoRoot, 'dev-click.request')

  let cssKey: string | undefined
  const applyCss = async (): Promise<void> => {
    const css = read(cssPath)
    if (css === undefined) return
    const next = await win.webContents.insertCSS(css)
    if (cssKey !== undefined) await win.webContents.removeInsertedCSS(cssKey)
    cssKey = next
    console.log(`[dev] applied dev-overrides.css (${css.length} bytes)`)
  }

  const runEval = async (): Promise<void> => {
    const code = read(evalPath)
    if (code === undefined || code.trim() === '') return
    try {
      const result: unknown = await win.webContents.executeJavaScript(code)
      writeFileSync(join(repoRoot, 'dev-eval.out.json'), JSON.stringify(result, null, 2))
      console.log('[dev] eval done -> dev-eval.out.json')
    } catch (error) {
      writeFileSync(join(repoRoot, 'dev-eval.out.json'), JSON.stringify({ error: String(error) }, null, 2))
      console.log('[dev] eval failed -> dev-eval.out.json')
    }
  }

  const capture = async (): Promise<void> => {
    const image = await win.webContents.capturePage()
    writeFileSync(join(repoRoot, 'dev-capture.png'), image.toPNG())
    console.log('[dev] captured -> dev-capture.png')
  }

  const click = (): void => {
    // Consume the request: fs.watch fires more than once per write, and a
    // repeated click silently undoes whatever the first one toggled.
    const raw = read(clickPath)?.trim()
    if (raw === undefined || raw === '') return
    writeFileSync(clickPath, '')
    const [x = NaN, y = NaN] = raw.split(',').map(Number)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    for (const type of ['mouseDown', 'mouseUp'] as const) {
      win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
    }
    console.log(`[dev] clicked ${x},${y}`)
  }

  const debounce = (fn: () => void): (() => void) => {
    let timer: NodeJS.Timeout | undefined
    return () => {
      clearTimeout(timer)
      timer = setTimeout(fn, 150)
    }
  }

  win.webContents.on('did-finish-load', guard('css', () => {
    cssKey = undefined
    return applyCss()
  }))
  // fs.watch needs the file to exist; seed empty working files.
  for (const path of [cssPath, evalPath, capturePath, clickPath]) {
    if (read(path) === undefined) writeFileSync(path, '')
  }
  // An FSWatcher throws its 'error' event when nothing is listening, and
  // deleting a watched file is one way to raise one.
  for (const [path, label, run] of [
    [cssPath, 'css', applyCss],
    [evalPath, 'eval', runEval],
    [capturePath, 'capture', capture],
    [clickPath, 'click', click],
  ] as const) {
    watch(path, debounce(guard(label, run))).on('error', (error) => console.error(`[dev] watch ${label} failed:`, error))
  }
  console.log('[dev] live tuning active: dev-overrides.css / dev-eval.js / dev-capture.request / dev-click.request')
}
