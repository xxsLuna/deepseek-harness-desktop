/**
 * The launcher's own diagnostics reaching the log — and never taking the app
 * down on the way.
 *
 * `SidecarLog` saved the harness's output; the launcher's still went to a
 * console a packaged app does not have. The line that proved it mattered:
 * `updater.ts` reported every failed update check with
 * `console.warn('[updater]', …)`, and every release ever shipped failed every
 * check, and nobody could read it.
 *
 * The second half came later and from the opposite direction. A packaged GUI
 * app's stdout is whatever it inherited, and writing to a pipe whose reader has
 * gone throws `EPIPE` synchronously. electron-updater logs through the global
 * console, so the first time an update was genuinely found, the line announcing
 * it raised an uncaught exception and Electron put "A JavaScript error occurred
 * in the main process" on screen. Reporting an update killed the app that was
 * meant to install it.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  formatConsoleLine,
  silenceStreamErrors,
  teeConsole,
  type TeedConsole,
} from '../../src/console-log.js'

/** A console stand-in that records what the original methods received. */
const stubConsole = (): TeedConsole & { seen: unknown[][] } => {
  const seen: unknown[][] = []
  const record = (name: string) => (...parts: unknown[]) => void seen.push([name, ...parts])
  return {
    seen,
    log: record('log'),
    info: record('info'),
    debug: record('debug'),
    warn: record('warn'),
    error: record('error'),
  }
}

describe('formatConsoleLine', () => {
  it('joins arguments the way console does', () => {
    expect(formatConsoleLine(['[updater]', 'boom'])).toBe('[updater] boom')
  })

  it('keeps an Error stack, not just its message', () => {
    // Half of what reaches console.error here is a caught exception, and
    // String(error) throws away where it came from.
    const error = new Error('nope')
    const line = formatConsoleLine(['[updater]', error])
    expect(line).toContain('nope')
    expect(line).toContain('console-log.spec')
  })

  it('collapses newlines so one call stays one entry', () => {
    // A stack is multi-line; leaving it that way would make a single warning
    // look like a dozen log entries and break any per-line reading of the file.
    expect(formatConsoleLine(['a\nb\r\nc'])).toBe('a | b | c')
  })

  it('renders non-strings, and survives one that cannot be serialized', () => {
    expect(formatConsoleLine([{ a: 1 }])).toBe('{"a":1}')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => formatConsoleLine([circular])).not.toThrow()
    expect(formatConsoleLine([circular])).toContain('Object')
  })
})

describe('teeConsole', () => {
  it('sends warn and error to the sink', () => {
    const target = stubConsole()
    const written: string[] = []
    teeConsole(target, (line) => written.push(line))
    target.warn('[updater]', 'boom')
    target.error('launcher: dead')
    expect(written).toEqual(['[updater] boom', 'launcher: dead'])
  })

  it('still calls the original console', () => {
    // The tee adds a destination; it must not replace the one that exists.
    const target = stubConsole()
    teeConsole(target, () => {})
    target.warn('hello')
    expect(target.seen).toEqual([['warn', 'hello']])
  })

  it('calls the original first, so a broken sink cannot swallow a diagnostic', () => {
    const order: string[] = []
    const target = { ...stubConsole(), warn: () => order.push('console') }
    teeConsole(target, () => {
      order.push('sink')
      throw new Error('sink is broken')
    })
    expect(() => target.warn('x')).not.toThrow()
    expect(order).toEqual(['console', 'sink'])
  })

  it('restores the original methods', () => {
    const target = stubConsole()
    const warn = target.warn
    const restore = teeConsole(target, () => {})
    expect(target.warn).not.toBe(warn)
    restore()
    expect(target.warn).toBe(warn)
  })

  it('does not tee console.log', () => {
    // Sidecar output already reaches the log through Sidecar's own onLog, so
    // teeing log would write every one of those lines twice.
    const log = vi.fn()
    const target = { ...stubConsole(), log }
    const written: string[] = []
    teeConsole(target, (line) => written.push(line))
    target.log('sidecar chatter')
    expect(written).toEqual([])
    expect(log).toHaveBeenCalledOnce()
  })

  it('survives a console whose write throws', () => {
    // The EPIPE case, and the reason this guard exists. A packaged app's stdout
    // is inherited; when its reader goes away the write throws synchronously,
    // and an uncaught throw in the main process is a dialog on the user's
    // screen. Whoever called console is usually not us — here, electron-updater.
    const epipe = (): never => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) }
    const target = { ...stubConsole(), info: epipe, warn: epipe, error: epipe, log: epipe }
    teeConsole(target, () => {})
    expect(() => target.info('Found version 0.1.1-desktop-v0.2.5')).not.toThrow()
    expect(() => target.log('x')).not.toThrow()
    expect(() => target.warn('x')).not.toThrow()
    expect(() => target.error('x')).not.toThrow()
  })

  it('still writes the line to the log when the console itself is dead', () => {
    // Not a nicety: a dead stdout is exactly when the log file is the only
    // place a diagnostic can still go, so the sink must run after the original
    // throws rather than being skipped with it.
    const target = {
      ...stubConsole(),
      warn: () => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    }
    const written: string[] = []
    teeConsole(target, (line) => written.push(line))
    target.warn('[updater]', 'boom')
    expect(written).toEqual(['[updater] boom'])
  })

  it('restores every method it wrapped, not just the teed ones', () => {
    const target = stubConsole()
    const before = { log: target.log, info: target.info, debug: target.debug, warn: target.warn, error: target.error }
    const restore = teeConsole(target, () => {})
    restore()
    expect({ log: target.log, info: target.info, debug: target.debug, warn: target.warn, error: target.error })
      .toEqual(before)
  })
})

describe('silenceStreamErrors', () => {
  it('gives every stream an error listener', () => {
    // The asynchronous half of the same hole: an `error` event with no listener
    // is an uncaught exception just as surely as a synchronous throw, so both
    // ends of a broken pipe have to be closed.
    const listeners: string[] = []
    const stream = { on: (event: 'error') => void listeners.push(event) }
    silenceStreamErrors([stream, stream])
    expect(listeners).toEqual(['error', 'error'])
  })

  it('swallows the error rather than rethrowing it', () => {
    let handler: (() => void) | undefined
    silenceStreamErrors([{ on: (_event, listener) => { handler = listener } }])
    expect(handler).toBeTypeOf('function')
    expect(() => handler?.()).not.toThrow()
  })
})
