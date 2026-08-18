/**
 * The native tool paths, exercised under the runtime the packaged app ships.
 *
 * These are the capabilities an Electron-ABI port would have had to rebuild:
 * running the harness on a bundled stock Node keeps every prebuild valid, and
 * that is only worth anything if it is actually asserted. Each check spawns or
 * loads the real thing rather than probing for a file.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const harnessRoot = join(root, 'build', 'harness')
const bundledNode = join(root, 'build', 'node', process.platform === 'win32' ? 'node.exe' : 'node')

/**
 * Whether the staged runtime matches this machine's architecture.
 *
 * A cross-build stages the TARGET architecture's Node. On macOS Rosetta will
 * happily RUN an x64 binary on Apple Silicon, so "does it start" is not the
 * question — under translation `process.arch` reports x64 while the staged
 * prebuilds are arm64, and the probes would fail on that mismatch rather than
 * on anything real. Compare architectures instead.
 * @returns true when the staged binary is for this host.
 */
function bundledNodeMatchesHost(): boolean {
  if (!existsSync(bundledNode)) return false
  try {
    const arch = execFileSync(bundledNode, ['-p', 'process.arch'], { encoding: 'utf8', timeout: 10_000 }).trim()
    return arch === process.arch
  } catch {
    return false
  }
}

// Prefer the shipped runtime, but fall back to the runner's own when the stage
// holds a foreign architecture (or nothing yet) — the subject is the harness
// tree's native payload, not which Node loads it.
const nodeBinary = bundledNodeMatchesHost() ? bundledNode : process.execPath

/**
 * Run one probe script inside the staged harness tree.
 * @param source - ESM source; its stdout must be a single JSON line.
 * @returns the parsed result.
 */
function probe(source: string): unknown {
  const out = execFileSync(nodeBinary, ['--input-type=module', '-e', source], {
    cwd: harnessRoot,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return JSON.parse(out.trim().split('\n').at(-1) ?? 'null')
}

// Each probe spawns a fresh Node and real binaries; the default 5s budget is
// shorter than the PTY probe's own wait.
describe.skipIf(!existsSync(harnessRoot))('native tool paths', () => {
  it('runs the packaged ripgrep binary that glob and grep spawn', () => {
    const result = probe(`
      const { rgPath } = await import('@vscode/ripgrep')
      const { execFileSync } = await import('node:child_process')
      const version = execFileSync(rgPath, ['--version'], { encoding: 'utf8' }).split('\\n')[0]
      console.log(JSON.stringify({ version }))
    `) as { version: string }
    expect(result.version).toContain('ripgrep')
  })

  it('spawns a real PTY, which the bash and terminal tools need', () => {
    const result = probe(`
      const pty = await import('node-pty')
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      const args = process.platform === 'win32' ? ['/c', 'echo pty-works'] : ['-c', 'echo pty-works']
      const term = pty.spawn(shell, args, { cols: 80, rows: 24 })
      const output = await new Promise((resolve) => {
        let buffer = ''
        term.onData((d) => { buffer += d; if (buffer.includes('pty-works')) resolve('ok') })
        setTimeout(() => resolve('timeout: ' + JSON.stringify(buffer)), 8000)
      })
      term.kill()
      console.log(JSON.stringify({ output }))
    `) as { output: string }
    expect(result.output).toBe('ok')
  })

  it('exposes node:sqlite, so the opt-in sqlite backends remain available', () => {
    // Free on a stock-Node sidecar; an Electron-hosted harness may not have it,
    // and its absence would quietly rule out sqlite persistence and search.
    const result = probe(`
      const sqlite = await import('node:sqlite')
      console.log(JSON.stringify({ available: typeof sqlite.DatabaseSync === 'function' }))
    `) as { available: boolean }
    expect(result.available).toBe(true)
  })
}, 60_000)
