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

/** The console methods this tees. */
export type TeedConsole = Pick<Console, 'warn' | 'error'>

/**
 * Wrap `warn` and `error` so every call also reaches `write`.
 *
 * The original method is always called first, so a sink that throws cannot
 * swallow a diagnostic — and a throwing sink is caught here besides, because a
 * launcher that cannot write its log must still run.
 * @param target - the console to wrap; injected so a test need not touch the real one.
 * @param write - the sink, called with one formatted line per console call.
 * @returns a disposer restoring the original methods.
 */
export function teeConsole(target: TeedConsole, write: (line: string) => void): () => void {
  const original = { warn: target.warn, error: target.error }
  const wrap = (method: 'warn' | 'error'): void => {
    const inner = original[method]
    target[method] = (...parts: unknown[]): void => {
      inner.apply(target, parts)
      try {
        write(formatConsoleLine(parts))
      } catch { /* a log that cannot be written must not break the caller */ }
    }
  }
  wrap('warn')
  wrap('error')
  return () => {
    target.warn = original.warn
    target.error = original.error
  }
}
