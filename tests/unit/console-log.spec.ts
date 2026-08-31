/**
 * The launcher's own diagnostics reaching the log.
 *
 * `SidecarLog` saved the harness's output; the launcher's still went to a
 * console a packaged app does not have. The line that proved it mattered:
 * `updater.ts` reported every failed update check with
 * `console.warn('[updater]', …)`, and every release ever shipped failed every
 * check, and nobody could read it.
 */
import { describe, expect, it, vi } from 'vitest'
import { formatConsoleLine, teeConsole, type TeedConsole } from '../../src/console-log.js'

/** A console stand-in that records what the original methods received. */
const stubConsole = (): TeedConsole & { seen: unknown[][] } => {
  const seen: unknown[][] = []
  return {
    seen,
    warn: (...parts: unknown[]) => void seen.push(['warn', ...parts]),
    error: (...parts: unknown[]) => void seen.push(['error', ...parts]),
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
    const target: TeedConsole = {
      warn: () => order.push('console'),
      error: () => order.push('console'),
    }
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
    const target = { ...stubConsole(), log } as TeedConsole & { log: typeof log }
    const written: string[] = []
    teeConsole(target, (line) => written.push(line))
    target.log('sidecar chatter')
    expect(written).toEqual([])
    expect(log).toHaveBeenCalledOnce()
  })
})
