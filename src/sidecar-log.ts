/**
 * A file the sidecar's output actually lands in.
 *
 * The launcher used to `console.log` every sidecar line. In a packaged app
 * that goes nowhere: Electron's binary is GUI-subsystem, so there is no
 * console attached and no file behind it. A boot failure therefore printed a
 * complete, accurate diagnosis into the void, and the user saw a white window.
 * Diagnosing one such failure took a reproduction harness and a process-tree
 * autopsy to recover text the app had already written.
 *
 * Deliberately not a logging framework: one file, rotated once at open, plus
 * an in-memory tail the failure page can show without reading back from disk.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** How much sidecar output to keep before rotating, in bytes. */
const MAX_BYTES = 2 * 1024 * 1024

/** How many lines the failure page can show. */
const TAIL_LINES = 40

/**
 * Whether an existing log is due for rotation.
 * @param bytes - the current file size.
 * @param maxBytes - the threshold.
 * @returns true when the file should be moved aside.
 */
export function shouldRotate(bytes: number, maxBytes: number = MAX_BYTES): boolean {
  return bytes >= maxBytes
}

/**
 * Format one log line.
 *
 * ISO timestamps because the question this file answers is almost always "what
 * happened right before it died", and a crash loop makes that unreadable
 * without them — the loop that motivated this wrote a full boot trace every
 * 2.6 seconds.
 * @param at - the moment the line was read.
 * @param line - the sidecar's output line, without a trailing newline.
 * @returns the line to append.
 */
export function formatLogLine(at: Date, line: string): string {
  return `${at.toISOString()} ${line}\n`
}

/** Append-only sidecar log with an in-memory tail. */
export class SidecarLog {
  /** Absolute path of the current log file. */
  readonly path: string
  private readonly recent: string[] = []
  private failed = false

  /**
   * Open (and if needed rotate) the log under `dir`.
   *
   * Never throws: a launcher that cannot write a log must still start the app.
   * @param dir - directory to hold the log; created if absent.
   * @param maxBytes - rotate an existing log at or above this size.
   */
  constructor(dir: string, maxBytes: number = MAX_BYTES) {
    this.path = join(dir, 'sidecar.log')
    try {
      mkdirSync(dir, { recursive: true })
      if (shouldRotate(statSync(this.path).size, maxBytes)) {
        const previous = `${this.path}.1`
        rmSync(previous, { force: true })
        renameSync(this.path, previous)
      }
    } catch {
      // ENOENT on the first run is the common arm; anything else means the log
      // is unavailable, which write() below degrades to a no-op.
    }
  }

  /**
   * Record one line.
   * @param line - the sidecar's output line.
   * @param at - injected by tests; defaults to now.
   */
  write(line: string, at: Date = new Date()): void {
    this.recent.push(line)
    if (this.recent.length > TAIL_LINES) this.recent.shift()
    if (this.failed) return
    try {
      appendFileSync(this.path, formatLogLine(at, line))
    } catch {
      // A log that cannot be written must not take the app down with it, and
      // must not retry on every line either.
      this.failed = true
    }
  }

  /**
   * The most recent lines, oldest first.
   * @returns up to the last {@link TAIL_LINES} lines.
   */
  tail(): string[] {
    return [...this.recent]
  }
}
