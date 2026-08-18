/**
 * The sidecar coupling contract — the version-tracking canary. Boots the
 * staged harness with the desktop patch stack over a Unix socket and asserts
 * every seam this app depends on. When an upstream version bump breaks one of
 * these, the failure names the exact broken contract.
 *
 * Requires a staged harness (npm run stage) and runs without Electron.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const harnessRoot = join(root, 'build', 'harness')
const entry = join(harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js')
const token = 'contract-test-token'

interface SocketResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** One request over the socket; for SSE, resolves after the first data chunk. */
function socketRequest(socketPath: string, options: {
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
  firstChunkOnly?: boolean
}): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      path: options.path,
      method: options.method ?? 'GET',
      headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, ...options.headers },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        if (options.firstChunkOnly === true) {
          res.destroy()
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
        }
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.setTimeout(30_000, () => {
      req.destroy()
      reject(new Error(`timeout: ${options.path}`))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

describe.skipIf(!existsSync(entry))('sidecar contract', () => {
  let child: ChildProcess
  let home: string
  let socketDir: string
  let socketPath: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-contract-home-'))
    socketDir = mkdtempSync(join(tmpdir(), 'dsh-contract-sock-'))
    socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-contract-${Date.now()}-${process.pid}`
      : join(socketDir, 's')
    child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_DESKTOP_SOCKET: socketPath,
        DSH_DESKTOP_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString() })

    // Readiness must be judged on /api, not the static fallback: the carrier
    // answers 404 for unclaimed paths during startup, so a static probe can
    // pass before the /api route owner has registered.
    const deadline = Date.now() + 90_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`sidecar exited during startup:\n${log}`)
      // Pipe names have no filesystem presence on Windows; just try connecting.
      if (process.platform === 'win32' || existsSync(socketPath)) {
        try {
          const probe = await socketRequest(socketPath, {
            path: '/api/host.describe',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'host.describe', payload: {} }),
          })
          if (probe.status === 200) return
        } catch { /* not accepting yet */ }
      }
      if (Date.now() > deadline) throw new Error(`sidecar never answered:\n${log}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  }, 120_000)

  afterAll(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
      await exited
      clearTimeout(timer)
    }
    // contract: a SIGTERM shutdown removes the socket file (POSIX only —
    // named pipes vanish with their last handle)
    if (process.platform !== 'win32') expect(existsSync(socketPath)).toBe(false)
    rmSync(home, { recursive: true, force: true })
    rmSync(socketDir, { recursive: true, force: true })
  }, 30_000)

  it('rejects requests without the bearer token', async () => {
    const bare = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ socketPath, path: '/', method: 'GET', headers: { host: '127.0.0.1' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(bare).toBe(401)
  })

  it('serves the UI with the boot manifest and the desktop connection row', async () => {
    const res = await socketRequest(socketPath, { path: '/' })
    expect(res.status).toBe(200)
    expect(res.body).toContain('window.__DSH_BOOT__')
    const manifest = /window\.__DSH_BOOT__ = (\{.*?\})<\/script>/.exec(res.body)
    expect(manifest).not.toBeNull()
    const graph = JSON.parse(manifest![1]!) as { entries: { id: string }[] }
    const ids = graph.entries.map((e) => e.id)
    expect(ids).toContain('@dsh-desktop/connection')
    expect(ids).not.toContain('@deepseek-ai/dsh-client-connection')
    expect(ids).not.toContain('@deepseek-ai/dsh-client-hmr')
  })

  it('answers /api unary calls through the upstream gateway', async () => {
    const rpcId = crypto.randomUUID()
    const res = await socketRequest(socketPath, {
      path: '/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.list', payload: {} }),
    })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as { rpcId: string, result: { ok: boolean } }
    expect(parsed.rpcId).toBe(rpcId)
    expect(parsed.result.ok).toBe(true)
  })

  it('streams SSE on both event paths instead of demanding a WebSocket upgrade', async () => {
    for (const path of ['/api/events.host', '/api/events.mux']) {
      const res = await socketRequest(socketPath, { path, firstChunkOnly: true })
      expect(res.status, path).toBe(200)
      expect(String(res.headers['content-type']), path).toContain('text/event-stream')
      expect(res.body, path).toContain(': connected')
    }
  })

  it('serves the desktop client bundle through /plugins', async () => {
    const res = await socketRequest(socketPath, { path: '/plugins/@dsh-desktop/connection/client.js' })
    expect(res.status).toBe(200)
    expect(res.body).toContain('__ModuleLoader__.load')
  })

  it('serves the title-band chrome with the document', async () => {
    const res = await socketRequest(socketPath, { path: '/' })
    // The block must follow the app root: client plugin CSS lands in <head> at
    // runtime and would win the cascade at equal specificity otherwise.
    expect(res.body.indexOf('data-dsh-desktop-chrome')).toBeGreaterThan(res.body.indexOf('id="root"'))
    expect(res.body).toContain('--dsh-title-band')
    expect(res.body).toContain('-webkit-app-region: drag')
  })

  it('still emits the column classes the title band insets', async () => {
    // The band selects upstream CSS-module locals by substring. A rename would
    // silently un-inset the UI, so fail here instead: each local must appear in
    // the layout bundle that owns the frame.
    const res = await socketRequest(socketPath, { path: '/plugins/@deepseek-ai/dsh-client-ui-layout/client.js' })
    expect(res.status).toBe(200)
    for (const local of ['_sidebarCol', '_centerCol', '_detailsCol']) {
      expect(res.body, `upstream no longer emits ${local}`).toContain(local)
    }
  })

  it('exposes the launcher-only picker channel, which rejects an unknown pick id', async () => {
    // The picker replaces the upstream native backend, whose OS chooser cannot
    // be fronted from this background sidecar.
    const answer = await socketRequest(socketPath, {
      path: '/desktop/picker/answer',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'no-such-pick', path: '/tmp' }),
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('"accepted":false')
  })

  it.skipIf(process.platform === 'win32')('holds no TCP listeners', async () => {
    const { execFileSync } = await import('node:child_process')
    try {
      const out = execFileSync('lsof', ['-p', String(child.pid), '-a', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
      expect(out.trim()).toBe('')
    } catch (error) {
      // lsof exits 1 with no output when nothing matches — that IS the pass.
      const output = (error as { stdout?: string }).stdout ?? ''
      expect(output.trim()).toBe('')
    }
  })
}, 180_000)
