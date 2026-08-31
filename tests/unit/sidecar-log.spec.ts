/**
 * The sidecar log.
 *
 * Its reason for existing is that `console.log` in a packaged Electron app
 * writes to nothing: the binary is GUI-subsystem, so a complete diagnosis of a
 * boot failure was printed and lost on every one of a six-day crash loop.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatLogLine, shouldRotate, SidecarLog } from '../../src/sidecar-log.js'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('formatLogLine', () => {
  it('stamps the line, because a crash loop is unreadable without times', () => {
    expect(formatLogLine(new Date('2026-08-31T05:04:27.123Z'), 'boot: failed'))
      .toBe('2026-08-31T05:04:27.123Z boot: failed\n')
  })
})

describe('shouldRotate', () => {
  it('rotates at the threshold, not past it', () => {
    expect(shouldRotate(99, 100)).toBe(false)
    expect(shouldRotate(100, 100)).toBe(true)
  })
})

describe('SidecarLog', () => {
  it('writes lines to a file under the given directory', () => {
    const log = new SidecarLog(join(scratch(), 'logs'))
    log.write('boot: starting')
    log.write('boot: failed')
    const text = readFileSync(log.path, 'utf8')
    expect(text).toContain('boot: starting')
    expect(text).toContain('boot: failed')
  })

  it('keeps a tail for the failure page without reading back from disk', () => {
    const log = new SidecarLog(join(scratch(), 'logs'))
    log.write('one')
    log.write('two')
    expect(log.tail()).toEqual(['one', 'two'])
  })

  it('bounds the tail', () => {
    // A crash loop writes a full boot trace every couple of seconds; an
    // unbounded tail would grow for as long as the loop runs.
    const log = new SidecarLog(join(scratch(), 'logs'))
    for (let i = 0; i < 500; i += 1) log.write(`line ${String(i)}`)
    const tail = log.tail()
    expect(tail.length).toBeLessThanOrEqual(100)
    expect(tail.at(-1)).toBe('line 499')
  })

  it('rotates an oversized log aside instead of growing forever', () => {
    const dir = join(scratch(), 'logs')
    const first = new SidecarLog(dir, 10)
    first.write('the old run')
    const second = new SidecarLog(dir, 10)
    second.write('the new run')
    expect(readFileSync(second.path, 'utf8')).not.toContain('the old run')
    expect(readFileSync(`${second.path}.1`, 'utf8')).toContain('the old run')
  })

  it('keeps only one rotation, so the folder cannot grow without bound', () => {
    const dir = join(scratch(), 'logs')
    for (const run of ['first', 'second', 'third']) {
      const log = new SidecarLog(dir, 10)
      log.write(run)
    }
    expect(readFileSync(join(dir, 'sidecar.log.1'), 'utf8')).toContain('second')
    expect(() => statSync(join(dir, 'sidecar.log.2'))).toThrow()
  })

  it('degrades to a no-op rather than taking the launch down with it', () => {
    // A launcher that cannot write a log must still start the app. Standing a
    // FILE where the log directory goes makes every filesystem call fail.
    const dir = scratch()
    const blocked = join(dir, 'logs')
    writeFileSync(blocked, 'not a directory')
    const log = new SidecarLog(blocked)
    expect(() => log.write('boot: starting')).not.toThrow()
    // The tail still works, so the failure page has something to show even
    // when the file does not exist.
    expect(log.tail()).toEqual(['boot: starting'])
  })
})
