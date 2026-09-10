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

/**
 * This process's console outcome, memoized on a global rather than in a module
 * variable — the same reason DONE is: NODE_OPTIONS can load this module more
 * than once in one process, and each instance would otherwise answer for
 * itself.
 *
 * The LAUNCHER reads it. Only `allocated` means "a console this process created
 * and hid", which is the one case where a child may safely inherit it instead
 * of being spawned with `windowsHide` — see src/hidden-console.ts.
 * @typedef {'unsupported' | 'present' | 'attached' | 'allocated' | 'failed'} ConsoleOutcome
 */
const OUTCOME = Symbol.for('@dsh-desktop/hide-console.outcome')

/** SW_HIDE, for ShowWindow. */
const SW_HIDE = 0

/**
 * The process whose console every descendant should join.
 *
 * `AttachConsole` takes an arbitrary pid, and that is the whole fix. Attaching
 * to the PARENT assumes the parent owns a console, which is a claim about the
 * process tree — and a trace under a real GUI launch shows the claim is false:
 *
 *   pid 31400 ppid 46196 | attached to the parent console   (the sidecar)
 *   pid 28972 ppid 46696 | AttachConsole(parent) failed     (the ACL runner)
 *
 * 46696 is neither the sidecar nor anything that ran this module. Upstream puts
 * a short-lived process between the sidecar and the runner, it owns no console,
 * and so the runner allocated one — visible for the instant before it is
 * hidden, once per command.
 *
 * Publishing the owner's pid removes the assumption entirely: an intermediate
 * that never loads this module still passes the variable down, and the runner
 * attaches to the console owner directly however deep it sits.
 *
 * NOT `DSH_`-prefixed, and that is load-bearing: upstream's `scrubbedParentEnv`
 * drops every `DSH_*` name, so a `DSH_`-named variable reaches the sidecar and
 * nothing below it. The trace switch above learned this the same way.
 */
const CONSOLE_PID_ENV = 'HARNESS_DESKTOP_CONSOLE_PID'

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
    appendFileSync(path, `pid ${process.pid} ppid ${process.ppid} | ${line}\n`)
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
  const globals = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis))
  /** Memoize and answer, so every caller in this process agrees. */
  const settle = (/** @type {ConsoleOutcome} */ value) => {
    globals[OUTCOME] = value
    return value
  }
  if (process.platform !== 'win32') return settle('unsupported')
  if (globals[DONE] === true) return /** @type {ConsoleOutcome} */ (globals[OUTCOME] ?? 'failed')
  globals[DONE] = true

  const trace = process.env.HARNESS_DESKTOP_SPAWN_TRACE
  const report = (line) => {
    if (trace !== undefined && trace !== '') record(trace, line)
  }

  try {
    const koffi = createRequire(import.meta.url)('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const getConsoleWindow = kernel32.func('void * __stdcall GetConsoleWindow()')
    const attachConsole = kernel32.func('int __stdcall AttachConsole(uint32 dwProcessId)')

    /** Name this process as the console to join, for everything below it. */
    const publish = () => {
      process.env[CONSOLE_PID_ENV] = String(process.pid)
    }

    if (getConsoleWindow() !== null) {
      // A terminal launch. The console is not ours to hide, but it IS the one
      // descendants should share, so it is still published.
      publish()
      report('console already present, left alone')
      return settle('present')
    }

    // The published owner first, the parent second, allocation last. Ordering
    // matters at every step: the owner is the only one that survives an
    // intermediate process, the parent is the cheap case when there is none,
    // and AllocConsole CREATES a window that is visible for the instant before
    // ShowWindow hides it — which is the flash this whole module exists to
    // remove, and the runner takes that path once per command without the
    // first branch.
    const owner = Number(process.env[CONSOLE_PID_ENV])
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && attachConsole(owner) !== 0) {
      publish()
      report(`attached to the published console owner ${String(owner)} (argv1 ${String(process.argv[1])})`)
      return settle('attached')
    }

    if (attachConsole(ATTACH_PARENT_PROCESS) !== 0) {
      publish()
      report(`attached to the parent console (argv1 ${String(process.argv[1])})`)
      return settle('attached')
    }
    // NOT GetLastError: koffi makes its own calls between bindings and clobbers
    // the thread's last error, which reported ERROR_ACCESS_DENIED ("this
    // process already has a console") for a process whose AllocConsole then
    // SUCCEEDED — a contradiction, and a wasted round. `ppid` on every line is
    // what answered it instead.
    report(`AttachConsole failed for owner ${String(process.env[CONSOLE_PID_ENV] ?? 'none')} and parent (argv1 ${String(process.argv[1])})`)

    const allocConsole = kernel32.func('int __stdcall AllocConsole()')
    if (allocConsole() === 0) {
      report('AttachConsole and AllocConsole both failed')
      return settle('failed')
    }
    const handle = getConsoleWindow()
    if (handle === null) {
      report('AllocConsole succeeded but returned no window')
      return settle('failed')
    }
    const showWindow = koffi.load('user32.dll').func('int __stdcall ShowWindow(void *hWnd, int nCmdShow)')
    showWindow(handle, SW_HIDE)
    publish()
    report(`allocated and hid a console (argv1 ${String(process.argv[1])})`)
    return settle('allocated')
  } catch (error) {
    // Never fatal. Without this the windows flash, which is where we started.
    report(`console setup failed: ${String(error?.message ?? error)}`)
    return settle('failed')
  }
}

allocateHiddenConsole()
