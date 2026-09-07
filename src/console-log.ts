/**
 * Tee the launcher's own diagnostics into the log file.
 *
 * `SidecarLog` closed one half of the hole: the harness's output survives now.
 * The launcher's did not. `console.warn`/`console.error` in the main process go
 * to a console a packaged GUI app does not have — and those are exactly the
 * lines that matter when a feature fails without taking the app down. The one
 * that proved it: every update check in every release died on `Cannot set
 * properties of undefined (setting 'autoDownload')`, `updater.ts` reported it
 * with `console.warn('[updater]', …)`, and nobody could read it for the life of
 * the project.
 *
 * A tee rather than a rewrite of the call sites. `warn`/`error` appear in eight
 * modules; threading a sink into each is a large diff that can miss one, and
 * would not cover the next one written. This covers them all, including
 * whatever Node itself reports through the same channels.
 *
 * `console.log` is deliberately NOT teed. Sidecar output already reaches the log
 * through `Sidecar`'s own `onLog`, so teeing it would write every one of those
 * lines twice.
 *
 * It IS wrapped, though, along with `info` and `debug` — that half is not about
 * logging at all. A packaged GUI app's stdout is whatever it inherited, and a
 * write to a pipe whose reader has gone throws `EPIPE`. electron-updater logs
 * through the global console, so the first time an update was actually found,
 * the log line announcing it crashed the main process. Making every console
 * method non-throwing is the fix; `silenceStreamErrors` closes the asynchronous
 * half of the same hole.
 */

/**
 * Render one console call's arguments as a log line.
 *
 * Errors contribute their stack, because half of what reaches `console.error`
 * here is a caught exception and `String(error)` throws away where it came
 * from — which is the part a bug report needs.
 * @param parts - the arguments the console method was called with.
 * @returns a single line, newlines collapsed so one call stays one entry.
 */
export function formatConsoleLine(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part
      if (part instanceof Error) return part.stack ?? `${part.name}: ${part.message}`
      try {
        return JSON.stringify(part) ?? String(part)
      } catch {
        // Circular, or a getter that throws. The type is still worth saying.
        return Object.prototype.toString.call(part)
      }
    })
    .join(' ')
    .replace(/\r?\n/g, ' | ')
}

/** The console methods this wraps. */
export type TeedConsole = Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>

/**
 * The methods that also reach the sink, and the ones only made safe.
 *
 * `log`, `info` and `debug` are wrapped but NOT teed. Sidecar output already
 * reaches the log through `Sidecar`'s own `onLog`, so teeing them would write
 * every one of those lines twice — but they still have to be made safe,
 * because a console call that throws takes the main process down whoever made
 * it, and the caller is usually not us.
 */
const TEED = ['warn', 'error'] as const
const GUARDED = ['log', 'info', 'debug'] as const

/**
 * Wrap the console so a write can never take the process down, and so `warn`
 * and `error` also reach `write`.
 *
 * The guard is not defensive programming for its own sake. A packaged GUI app's
 * stdout is whatever it inherited, and when that is a pipe whose reader has
 * gone, `console.info` throws `EPIPE` **synchronously**. That is not
 * hypothetical here: electron-updater logs through the global console, so the
 * moment an update was found, `onUpdateAvailable`'s own log line raised an
 * uncaught exception and Electron put "A JavaScript error occurred in the main
 * process" on screen. `updater.ts` promises an update check is never fatal;
 * without this, *reporting* one was.
 *
 * Order matters twice over. The original runs first, so a sink that throws
 * cannot swallow a diagnostic; and the sink runs even when the original threw,
 * because a dead stdout is exactly when the log file is the only place left for
 * the line to go.
 * @param target - the console to wrap; injected so a test need not touch the real one.
 * @param write - the sink, called with one formatted line per teed console call.
 * @returns a disposer restoring the original methods.
 */
export function teeConsole(target: TeedConsole, write: (line: string) => void): () => void {
  const methods = [...TEED, ...GUARDED]
  const original = new Map(methods.map((name) => [name, target[name]] as const))
  for (const method of methods) {
    const inner = original.get(method)
    const teed = (TEED as readonly string[]).includes(method)
    target[method] = (...parts: unknown[]): void => {
      try {
        inner?.apply(target, parts)
      } catch { /* a console that cannot be written to must not break the caller */ }
      if (!teed) return
      try {
        write(formatConsoleLine(parts))
      } catch { /* a log that cannot be written must not break the caller either */ }
    }
  }
  return () => {
    for (const [method, inner] of original) target[method] = inner
  }
}

/**
 * Stop a dead stdout/stderr from killing the process asynchronously.
 *
 * The console guard above covers the synchronous throw, which is the one that
 * was seen. This covers the other half of the same failure: a stream error
 * delivered as an `error` event has no listener by default, and an unhandled
 * `error` event on a stream is an uncaught exception just the same. Both ends
 * of a broken pipe have to be closed or the fix only holds for the path that
 * happened to fail first.
 *
 * Attaching a listener is the whole fix — an `error` event with any listener is
 * no longer fatal. There is nothing useful to do with it: the destination is
 * gone, so the log file is where diagnostics are going now.
 * @param streams - the streams to make non-fatal; the process's own by default.
 */
export function silenceStreamErrors(
  streams: readonly { on: (event: 'error', listener: () => void) => unknown }[] =
  [process.stdout, process.stderr],
): void {
  for (const stream of streams) stream.on('error', () => { /* see above */ })
}
