/**
 * The native tool paths, exercised under the runtime the packaged app ships.
 *
 * That runtime is Electron's own Node, reached through ELECTRON_RUN_AS_NODE
 * rather than a stock Node binary shipped beside the harness — 89MB saved for
 * one file. The saving is only safe because the staged prebuilds load unchanged
 * under it, so this file is the assertion that they do: every check spawns or
 * loads the real thing, under the same binary and the same environment variable
 * the sidecar uses.
 *
 * An Electron bump is the thing to watch here. It moves the bundled Node, and
 * the failures would otherwise be silent and specific: a NAPI level that no
 * longer matches the prebuilds, or node:sqlite going missing again.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const harnessRoot = join(root, 'build', 'harness')
const pin = JSON.parse(readFileSync(join(root, 'harness.json'), 'utf8')) as { node: string }

// The app's own binary, standing in for the launcher's process.execPath.
// Resolved through the electron package rather than guessed at, so it follows
// the version pinned in package.json.
const electronBinary = createRequire(import.meta.url)('electron') as string

/**
 * Run one probe script inside the staged harness tree.
 * @param source - ESM source; its stdout must be a single JSON line.
 * @returns the parsed result.
 */
function probe(source: string): unknown {
  const out = execFileSync(electronBinary, ['--input-type=module', '-e', source], {
    cwd: harnessRoot,
    encoding: 'utf8',
    timeout: 30_000,
    // Without this the binary boots an app window instead of running the script.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  return JSON.parse(out.trim().split('\n').at(-1) ?? 'null')
}

// Each probe spawns a fresh Node and real binaries; the default 5s budget is
// shorter than the PTY probe's own wait.
describe.skipIf(!existsSync(harnessRoot) || !existsSync(electronBinary))('native tool paths', () => {
  it('runs the Node major the harness is pinned against', () => {
    // harness.json pins the Node major this app bundles. Nothing fetches a Node
    // binary any more, so that pin is now a constraint on ELECTRON's Node, and
    // this is what makes a bump that breaks it fail by name.
    const result = probe(`
      console.log(JSON.stringify({ node: process.versions.node, napi: process.versions.napi, electron: process.versions.electron ?? null }))
    `) as { node: string, napi: string, electron: string | null }
    expect(result.electron, 'the probe must run Electron, not a stray node').not.toBeNull()
    expect(result.node.split('.')[0]).toBe(pin.node)
    // Every native prebuild in the staged tree is NAPI, which is exactly why the
    // Electron/stock ABI difference (module versions 148 vs 137) does not matter.
    expect(Number(result.napi)).toBeGreaterThanOrEqual(10)
  })

  it('runs worker threads, which the workflow worker plugin needs', () => {
    const result = probe(`
      const { Worker } = await import('node:worker_threads')
      // Dynamic import, not require: an eval'd worker spawned from an ES module
      // parent is itself evaluated as ESM, where require is not defined.
      const worker = new Worker('const { parentPort } = await import("node:worker_threads"); parentPort.postMessage("worker-ok")', { eval: true })
      const message = await new Promise((resolve) => {
        worker.on('message', resolve)
        worker.on('error', (error) => resolve('error: ' + error.message))
        setTimeout(() => resolve('timeout'), 8000)
      })
      await worker.terminate()
      console.log(JSON.stringify({ message }))
    `) as { message: string }
    expect(result.message).toBe('worker-ok')
  })

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
    // The check that decided whether dropping the stock Node binary was safe at
    // all. Electron has historically omitted node:sqlite, and its absence would
    // quietly rule out the sqlite persistence and search backends. Present on
    // Electron 43; this fails by name if a bump takes it away.
    const result = probe(`
      const sqlite = await import('node:sqlite')
      console.log(JSON.stringify({ available: typeof sqlite.DatabaseSync === 'function' }))
    `) as { available: boolean }
    expect(result.available).toBe(true)
  })

  it('resolves koffi from @dsh-desktop/bundle, which the console fix requires', () => {
    // `hide-console.mjs` does createRequire(import.meta.url)('koffi'), and
    // `@dsh-desktop/bundle` cannot install its own dependencies — the stage copy
    // deliberately excludes node_modules, so this resolves upward to whatever
    // upstream hoisted. Five upstream packages declare koffi today, so the hoist
    // is stable in practice; the failure if it ever moves is the reason for this
    // assertion. hide-console.mjs swallows its own errors on purpose (a console
    // that cannot be hidden must not stop the harness booting), so a missing
    // koffi would come back as the flashing window and nothing else.
    const result = probe(`
      const { createRequire } = await import('node:module')
      const { pathToFileURL } = await import('node:url')
      const { join } = await import('node:path')
      const lib = join(process.cwd(), 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'hide-console.mjs')
      const koffi = createRequire(pathToFileURL(lib).href)('koffi')
      console.log(JSON.stringify({ loaded: typeof koffi.load === 'function' }))
    `) as { loaded: boolean }
    expect(result.loaded).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('binds the four Win32 calls the console fix makes', () => {
    // The signatures are strings handed to koffi at runtime, so a koffi API
    // change or a typo in one of them throws where hide-console.mjs catches it —
    // silently, and only on the machines that had the symptom. Bind each one
    // under the shipped runtime rather than trusting the string.
    const result = probe(`
      const { createRequire } = await import('node:module')
      const { pathToFileURL } = await import('node:url')
      const { join } = await import('node:path')
      const lib = join(process.cwd(), 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'hide-console.mjs')
      const koffi = createRequire(pathToFileURL(lib).href)('koffi')
      const kernel32 = koffi.load('kernel32.dll')
      const user32 = koffi.load('user32.dll')
      const bound = {
        GetConsoleWindow: typeof kernel32.func('void * __stdcall GetConsoleWindow()') === 'function',
        AttachConsole: typeof kernel32.func('int __stdcall AttachConsole(uint32 dwProcessId)') === 'function',
        AllocConsole: typeof kernel32.func('int __stdcall AllocConsole()') === 'function',
        ShowWindow: typeof user32.func('int __stdcall ShowWindow(void *hWnd, int nCmdShow)') === 'function',
      }
      console.log(JSON.stringify(bound))
    `) as Record<string, boolean>
    expect(result).toEqual({
      GetConsoleWindow: true,
      AttachConsole: true,
      AllocConsole: true,
      ShowWindow: true,
    })
  })

  it.skipIf(process.platform !== 'win32')('honours NODE_OPTIONS --import, which is how the fix reaches the ACL runner', () => {
    // The load-bearing half. On Windows the shell is started by the sandbox in a
    // SEPARATE runner process, so the sidecar hiding its own console fixes
    // nothing; NODE_OPTIONS is the channel. Electron is documented to ignore
    // NODE_OPTIONS for packaged apps, so that it works under
    // ELECTRON_RUN_AS_NODE is a measured fact rather than an assumption — and
    // exactly the kind that a bump breaks with no error.
    //
    // hide-console.mjs marks globalThis with a symbol when it has run, which is
    // what makes the preload observable from outside.
    const preload = pathToFileURL(join(harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'hide-console.mjs')).href
    const out = execFileSync(electronBinary, [
      '--input-type=module',
      '-e', 'console.log(JSON.stringify({ ran: globalThis[Symbol.for("@dsh-desktop/hide-console.done")] === true }))',
    ], {
      cwd: harnessRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--import ${preload}` },
    })
    expect(JSON.parse(out.trim().split('\n').at(-1) ?? 'null')).toEqual({ ran: true })
  })
}, 60_000)
