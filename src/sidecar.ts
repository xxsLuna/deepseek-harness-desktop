/**
 * Sidecar supervision: spawn the harness on Electron's own Node, wait for the
 * socket to answer, restart on unexpected exit, and terminate on quit. The
 * harness process is the only writer of $DSH_HOME state, and the
 * single-instance lock in main guarantees at most one per machine user.
 */
import { spawn, type SpawnOptions } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import type { SidecarAddress } from './socket-path.js'
import type { TitleBand } from './window.js'

export interface SidecarPaths {
  /** The staged harness root (holding node_modules). */
  readonly harnessRoot: string
}

/**
 * The slice of a child process this class touches.
 *
 * Declared structurally so the supervision rules — which exit counts as a
 * crash, what a restart does to the process before it — can be unit-tested
 * against a stub instead of a real harness boot. Each of those rules fails
 * silently when wrong, which is the class of bug this repo pins in tests.
 */
export interface SidecarProcess {
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  /** null while the process runs; the status once it is gone. */
  readonly exitCode: number | null
  on(event: 'exit', listener: (code: number | null) => void): void
  once(event: 'exit', listener: () => void): void
  kill(signal: NodeJS.Signals): void
}

/** How the harness process is launched. Satisfied by node's own `spawn`. */
export type SidecarSpawn = (command: string, args: string[], options: SpawnOptions) => SidecarProcess

export interface SidecarOptions extends SidecarPaths {
  readonly address: SidecarAddress
  /**
   * The band the launcher freed by hiding the native title bar (zero height
   * where the platform kept its own). The served chrome draws itself from
   * this, so the launcher stays the one place the decision is made.
   */
  readonly titleBand: TitleBand
  /** PATH for the harness and everything it spawns; undefined inherits the launcher's. */
  readonly path: string | undefined
  /** Working directory the harness resolves relative paths against. */
  readonly cwd: string
  /** Called with stderr/stdout lines for diagnostics. */
  readonly onLog: (line: string) => void
  /** Called when the process exits without stop() being requested. */
  readonly onUnexpectedExit: (code: number | null) => void
  /**
   * The two steps that touch the outside world, injected only by the unit
   * tests — production passes neither. The alternative is leaving the
   * start/stop/restart rules untested, and the `stopping` flag below has
   * already shown what that costs.
   */
  readonly spawn?: SidecarSpawn
  readonly probe?: (address: SidecarAddress) => Promise<boolean>
}

/** One GET / probe over the socket; resolves true on any HTTP answer. */
function probe(address: SidecarAddress): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({
      socketPath: address.socketPath,
      path: '/',
      method: 'HEAD',
      headers: { host: '127.0.0.1', authorization: `Bearer ${address.token}` },
      timeout: 1_000,
    }, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

export class Sidecar {
  private child: SidecarProcess | undefined
  /**
   * Set by stop() and cleared by start(), for exactly one purpose: the exit
   * handler reads it to tell an intentional shutdown from a crash, so that
   * onUnexpectedExit — and therefore the crash recovery in main — fires for a
   * crash alone.
   *
   * Clearing it in start() is load-bearing. It used to be set and never reset,
   * which left crash recovery dead for the rest of the app's life after the
   * first stop/start cycle. That was invisible while shutdown was the only
   * caller of stop(), and became a real hole the moment restart() became
   * another one. Pinned in tests/unit/sidecar.spec.ts.
   */
  private stopping = false
  /** The restart in flight, if any. See restart() for why it is shared. */
  private restarting: Promise<void> | undefined

  constructor(private readonly options: SidecarOptions) {}

  /** Spawn and resolve once the socket answers (rejects after timeoutMs). */
  async start(timeoutMs = 60_000): Promise<void> {
    const { harnessRoot, address, titleBand, path, cwd, onLog, onUnexpectedExit } = this.options
    // Annotated, not inferred: the union of the injected and the real one
    // widens `child` to both shapes and their event overloads then conflict.
    const launch: SidecarSpawn = this.options.spawn ?? spawn
    const answers: (address: SidecarAddress) => Promise<boolean> = this.options.probe ?? probe
    const entry = join(harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js')
    // A fresh process is not the one that was stopped, so it gets crash
    // recovery back.
    this.stopping = false
    // process.execPath is this app's own Electron binary, and
    // ELECTRON_RUN_AS_NODE below makes it behave as plain node. It replaces the
    // second stock Node binary this used to ship beside the harness — 89MB for
    // one file. Safe because the ABI matches where it has to: Electron 43
    // carries Node 24.18 at NAPI 10 against the stock 24.19 at NAPI 10, so every
    // prebuild in the staged tree loads unchanged. Asserted in
    // tests/contract/native-tools.spec.ts, node:sqlite included — Electron has
    // historically omitted that one, and the sqlite backends need it.
    const child = launch(process.execPath, [entry], {
      // A GUI launch inherits the session manager's cwd (often `/`), which the
      // harness would use as its relative-path base and sandbox root.
      cwd,
      env: {
        ...process.env,
        ...(path === undefined ? {} : { PATH: path }),
        DSH_DESKTOP_SOCKET: address.socketPath,
        DSH_DESKTOP_TOKEN: address.token,
        DSH_DESKTOP_PARENT_PID: String(process.pid),
        // Read back by the desktop-chrome plugin row's config in the patch
        // layer, not by any module: the band is a plugin's configuration.
        DSH_DESKTOP_BAND_HEIGHT: String(titleBand.height),
        DSH_DESKTOP_BAND_LEAD: String(titleBand.lead),
        DSH_DESKTOP_BAND_MENU: titleBand.menuButton ? '1' : '0',
        // Runs execPath as plain node instead of booting a second app window.
        // Inherited by everything the harness spawns, which is what keeps a
        // subagent or a worker_thread re-executing execPath in Node mode too.
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Kept from the stock-Node era, where node.exe was a console binary and a
      // GUI launch popped a window every grandchild shell inherited. Electron's
      // binary is GUI-subsystem so it no longer applies to this process, but the
      // shells the harness spawns are still console binaries.
      windowsHide: true,
    })
    this.child = child
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) if (line.trim() !== '') onLog(line)
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('exit', (code) => {
      this.child = undefined
      if (!this.stopping) onUnexpectedExit(code)
    })

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`sidecar exited during startup with code ${child.exitCode}`)
      if (await answers(address)) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`sidecar did not answer on its socket within ${timeoutMs}ms`)
  }

  /** SIGTERM, then SIGKILL after graceMs. Resolves when the process is gone. */
  async stop(graceMs = 8_000): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
    await exited
    clearTimeout(timer)
    this.child = undefined
  }

  /**
   * Stop the harness and bring it back, resolving once the new process answers
   * its socket.
   *
   * This is the only way a plugin installed while the app runs takes effect: a
   * bundle patch row is composed into the tree at boot, and there is no
   * hot-compose path for a row that appeared afterwards. Nothing above the
   * sidecar has to be rebuilt for it — SidecarAddress is generated once per app
   * run, so the socket path and bearer token do not move across a restart and
   * the protocol handler built over them stays valid.
   *
   * Requests in flight over the socket during the gap DO fail. That is left
   * alone rather than queued: the caller reloads the page afterwards, which is
   * what actually repairs the view, and a queue would only defer the same
   * failures to a moment where they read as fresh ones.
   */
  async restart(): Promise<void> {
    // Coalesced because more than one caller can ask at once — two clicks in
    // the marketplace, or a crash-recovery start landing on top of a requested
    // restart. Each would otherwise run its own stop/start and race into two
    // live harness processes against one $DSH_HOME, which the header comment
    // above says has exactly one writer.
    const inFlight = this.restarting
    if (inFlight !== undefined) return await inFlight
    const run = (async (): Promise<void> => {
      await this.stop()
      await this.start()
    })()
    this.restarting = run
    try {
      await run
    } finally {
      this.restarting = undefined
    }
  }
}
