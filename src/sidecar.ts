/**
 * Sidecar supervision: spawn the harness under the bundled stock Node, wait
 * for the socket to answer, restart on unexpected exit, and terminate on
 * quit. The harness process is the only writer of $DSH_HOME state, and the
 * single-instance lock in main guarantees at most one per machine user.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import type { SidecarAddress } from './socket-path.js'

export interface SidecarPaths {
  /** The bundled node binary (or a PATH command in dev). */
  readonly nodeBinary: string
  /** The staged harness root (holding node_modules). */
  readonly harnessRoot: string
}

export interface SidecarOptions extends SidecarPaths {
  readonly address: SidecarAddress
  /** Called with stderr/stdout lines for diagnostics. */
  readonly onLog: (line: string) => void
  /** Called when the process exits without stop() being requested. */
  readonly onUnexpectedExit: (code: number | null) => void
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
  private child: ChildProcess | undefined
  private stopping = false

  constructor(private readonly options: SidecarOptions) {}

  /** Spawn and resolve once the socket answers (rejects after timeoutMs). */
  async start(timeoutMs = 60_000): Promise<void> {
    const { nodeBinary, harnessRoot, address, onLog, onUnexpectedExit } = this.options
    const entry = join(harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js')
    const child = spawn(nodeBinary, [entry], {
      env: {
        ...process.env,
        DSH_DESKTOP_SOCKET: address.socketPath,
        DSH_DESKTOP_TOKEN: address.token,
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
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
      if (await probe(address)) return
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
}
