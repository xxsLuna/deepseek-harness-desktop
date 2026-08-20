// @ts-check
/**
 * Give this process a hidden console, so Windows stops flashing a visible one
 * for every command the harness runs.
 *
 * THE SYMPTOM. On Windows a PowerShell window appeared and closed on every tool
 * call. A console child with no console to inherit gets a fresh one allocated,
 * and that one is visible. The launcher spawns the sidecar with `windowsHide`,
 * which is what stops the SIDECAR from showing a window — at the cost of leaving
 * it with no console to pass down. Run `dsh` from a terminal and none of this
 * shows, because the terminal's console is there to inherit; it only appears
 * when a GUI process hosts the harness, which is this app.
 *
 * WHERE THE COMMAND ACTUALLY COMES FROM. Not child_process. On Windows the ACL
 * sandbox (`@deepseek-ai/dsh-sandbox-windows-acl`) calls CreateProcessAsUserW
 * through koffi, in a separate runner process. Four attempts at defaulting
 * `windowsHide` on child_process — spawn, then the whole spawn family, then
 * carried into descendants — changed nothing, and the trace showed why: a tool
 * call logged one child_process spawn, of `process.execPath`, and never the
 * shell.
 *
 * WHY NOT JUST PASS CREATE_NO_WINDOW THERE. Upstream already tried, and says so
 * in that module's own doc:
 *
 *   "Console isolation (CREATE_NO_WINDOW / CREATE_NEW_CONSOLE) is intentionally
 *    absent: under this restriction scheme hidden-console children die with
 *    STATUS_DLL_INIT_FAILED (0xC0000142) — verified empirically ... the child
 *    shares the host console."
 *
 * Forcing the flag would trade a cosmetic flash for commands that do not run.
 *
 * WHAT THIS DOES INSTEAD. The last clause of that sentence is the seam: the
 * child SHARES the host console. So give the host one and hide it. No creation
 * flag changes, nothing the sandbox depends on moves — it takes the path upstream
 * already documents. Confirmed on the reported symptom: with this in place the
 * window stops appearing, and the trace shows the ACL runner allocating and
 * hiding its own console before the restricted child shares it.
 *
 * HOW IT REACHES THE RUNNER. `boot.js` imports this module for the sidecar and
 * adds it to NODE_OPTIONS as `--import`, so every Node descendant loads it too.
 * That is the half that matters, since the runner is a separate process. Each
 * link was measured rather than assumed: upstream's `scrubbedParentEnv` strips
 * only `DSH_*` and /KEY|PASSWORD|SECRET|TOKEN/i, so NODE_OPTIONS survives;
 * Electron honours `--import` under ELECTRON_RUN_AS_NODE, and so does the
 * PACKAGED binary, which mattered because Electron is documented to ignore
 * NODE_OPTIONS for packaged apps.
 *
 * Set HARNESS_DESKTOP_SPAWN_TRACE to a file path to see what each process does.
 * The name is deliberately NOT DSH_-prefixed: scrubbedParentEnv drops that
 * prefix, so a DSH_-named switch reaches the sidecar and nothing below it — an
 * earlier version used one and produced a trace that proved nothing about the
 * descendants it existed to observe.
 */
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** Set once per process; a descendant inherits NODE_OPTIONS and loads this again. */
const DONE = Symbol.for('@dsh-desktop/hide-console.done')

/** SW_HIDE, for ShowWindow. */
const SW_HIDE = 0

/**
 * ATTACH_PARENT_PROCESS — attach to the console the parent already owns.
 *
 * Written as the unsigned value, not -1: the parameter is a DWORD and koffi
 * binds it as uint32, which will not take a negative.
 */
const ATTACH_PARENT_PROCESS = 0xFFFFFFFF

/**
 * Append one line to the trace file, if tracing is on.
 *
 * A FILE, not stderr: a spawned child's stderr is piped and collected by
 * `dsh-subprocess-local` as command output, so it never reaches the launcher log.
 * Tracing to stderr made a descendant's report invisible — which is exactly the
 * process whose behaviour was in question.
 * @param path - the trace file.
 * @param line - what to record.
 * @returns nothing.
 */
function record(path, line) {
  try {
    appendFileSync(path, `pid ${process.pid} | ${line}\n`)
  } catch {
    // Tracing must never be able to break a boot.
  }
}

/**
 * Make sure this process has a console, without ever showing one.
 *
 * Attaches to the parent's console when there is one, and only allocates (then
 * hides) as a fallback. Idempotent, and deliberately a no-op when a console is
 * already there: that means a terminal launch, and hiding a console someone is
 * reading would be worse than the flash this removes.
 * @returns nothing.
 */
export function allocateHiddenConsole() {
  if (process.platform !== 'win32') return
  const globals = /** @type {Record<symbol, boolean>} */ (/** @type {unknown} */ (globalThis))
  if (globals[DONE] === true) return
  globals[DONE] = true

  const trace = process.env.HARNESS_DESKTOP_SPAWN_TRACE
  const report = (line) => {
    if (trace !== undefined && trace !== '') record(trace, line)
  }

  try {
    const koffi = createRequire(import.meta.url)('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const getConsoleWindow = kernel32.func('void * __stdcall GetConsoleWindow()')
    if (getConsoleWindow() !== null) {
      report('console already present, left alone')
      return
    }

    // ATTACH before ALLOC, and that ordering is the difference between a blink
    // per command and none. AllocConsole CREATES a console window and it is
    // visible for the instant before ShowWindow hides it — once per process, and
    // the ACL runner is a fresh process for every command, so the flash simply
    // got shorter rather than going away. Attaching to the parent's console
    // creates no window at all.
    //
    // It resolves differently at each level, which is exactly what is wanted:
    // the sidecar's parent is the Electron launcher, a GUI process with no
    // console, so the attach fails there and it allocates once at startup. The
    // runner's parent IS the sidecar, so the attach succeeds and it reuses the
    // hidden console instead of making its own.
    const attachConsole = kernel32.func('int __stdcall AttachConsole(uint32 dwProcessId)')
    if (attachConsole(ATTACH_PARENT_PROCESS) !== 0) {
      report(`attached to the parent console (argv1 ${String(process.argv[1])})`)
      return
    }

    const allocConsole = kernel32.func('int __stdcall AllocConsole()')
    if (allocConsole() === 0) {
      report('AttachConsole and AllocConsole both failed')
      return
    }
    const handle = getConsoleWindow()
    if (handle === null) {
      report('AllocConsole succeeded but returned no window')
      return
    }
    const showWindow = koffi.load('user32.dll').func('int __stdcall ShowWindow(void *hWnd, int nCmdShow)')
    showWindow(handle, SW_HIDE)
    report(`allocated and hid a console (argv1 ${String(process.argv[1])})`)
  } catch (error) {
    // Never fatal. Without this the windows flash, which is where we started.
    report(`console setup failed: ${String(error?.message ?? error)}`)
  }
}

allocateHiddenConsole()
