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
 * All files are gitignored working files.
 */
import type { BrowserWindow } from 'electron'
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    if (!existsSync(cssPath)) return
    const css = readFileSync(cssPath, 'utf8')
    const next = await win.webContents.insertCSS(css)
    if (cssKey !== undefined) await win.webContents.removeInsertedCSS(cssKey)
    cssKey = next
    console.log(`[dev] applied dev-overrides.css (${css.length} bytes)`)
  }

  const runEval = async (): Promise<void> => {
    if (!existsSync(evalPath)) return
    const code = readFileSync(evalPath, 'utf8')
    if (code.trim() === '') return
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
    const raw = readFileSync(clickPath, 'utf8').trim()
    if (raw === '') return
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

  win.webContents.on('did-finish-load', () => {
    cssKey = undefined
    void applyCss()
  })
  // fs.watch needs the file to exist; seed empty working files.
  for (const path of [cssPath, evalPath, capturePath, clickPath]) {
    if (!existsSync(path)) writeFileSync(path, '')
  }
  watch(cssPath, debounce(() => void applyCss()))
  watch(evalPath, debounce(() => void runEval()))
  watch(capturePath, debounce(() => void capture()))
  watch(clickPath, debounce(() => click()))
  console.log('[dev] live tuning active: dev-overrides.css / dev-eval.js / dev-capture.request / dev-click.request')
}
