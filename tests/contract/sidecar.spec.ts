/**
 * The sidecar coupling contract — the version-tracking canary. Boots the
 * staged harness with the desktop patch stack over a Unix socket and asserts
 * every seam this app depends on. When an upstream version bump breaks one of
 * these, the failure names the exact broken contract.
 *
 * Requires a staged harness (npm run stage). Boots on Electron's binary under
 * ELECTRON_RUN_AS_NODE, which is the runtime the shipped app uses, but starts no
 * browser window — so this still runs headless.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const harnessRoot = join(root, 'build', 'harness')
const entry = join(harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js')
const token = 'contract-test-token'
// Resolved through the electron package rather than guessed at, so it follows
// the version pinned in package.json.
const electronBinary = createRequire(import.meta.url)('electron') as string

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

/** One unary RPC over the socket, unwrapped to its result. */
async function rpc(socketPath: string, method: string, payload: Record<string, unknown> = {}): Promise<{
  ok: boolean
  value?: unknown
  error?: { code: string }
}> {
  const res = await socketRequest(socketPath, {
    path: `/api/${method}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
  })
  if (res.status !== 200) throw new Error(`${method}: HTTP ${String(res.status)}`)
  return (JSON.parse(res.body) as { result: { ok: boolean, value?: unknown, error?: { code: string } } }).result
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
    // Electron's own binary, as the launcher spawns it — not this runner's Node.
    // The harness boots on Electron's Node in the shipped app, so booting it on
    // anything else here would leave the one runtime that matters untested.
    //
    // This is why `test:contract` passes --no-file-parallelism. Two spec files
    // spawning the same executable at once made the kernel refuse the exec:
    // ETXTBSY (errno -26) on both Linux runners and EBUSY (-4082) on Windows,
    // while macOS tolerated it and native-tools.spec.ts — which reaches the same
    // binary through execFileSync — passed in the same run. Serialising the
    // files is the fix; these are integration tests that boot a real harness, so
    // they were never good parallelism candidates anyway.
    child = spawn(electronBinary, [entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: home,
        DSH_DESKTOP_SOCKET: socketPath,
        DSH_DESKTOP_TOKEN: token,
        // Boot as a merged-title-bar launch would, so the title-band row is
        // composed and its index tap can be asserted below.
        DSH_DESKTOP_BAND_HEIGHT: '38',
        DSH_DESKTOP_BAND_LEAD: '0',
        DSH_DESKTOP_BAND_MENU: '1',
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
    // Asserts the whole seam, not just the asset: @dsh-desktop/chrome resolved
    // as a plugin row, took its config through the patch layer, and reached
    // the fallback owner's index taps.
    const res = await socketRequest(socketPath, { path: '/' })
    // The block must follow the app root: client plugin CSS lands in <head> at
    // runtime and would win the cascade at equal specificity otherwise.
    expect(res.body.indexOf('data-dsh-desktop-chrome')).toBeGreaterThan(res.body.indexOf('id="root"'))
    expect(res.body).toContain('--dsh-title-band:var(--dsh-title-band-wco,38px)')
    expect(res.body).toContain('--dsh-title-menu-display:inline-flex')
    expect(res.body).toContain('-webkit-app-region: drag')
    expect(res.body).toContain('/__desktop-host/chrome/')
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

  it('composes the shipped agent presets, so sessions can be created', async () => {
    // The preset roots are an assembly fact the upstream LAUNCHER patches in,
    // not any bundle — miss that overlay and every session.create fails with
    // agent-preset-not-found while the app otherwise looks healthy.
    const list = await rpc(socketPath, 'agentPreset.list')
    expect(list.ok, JSON.stringify(list)).toBe(true)
    const ids = (list.value as { presets: { id: string, trust: string }[] }).presets.map((p) => p.id)
    expect(ids).toContain('standard')
    for (const preset of (list.value as { presets: { trust: string }[] }).presets) {
      expect(preset.trust).toBe('system')
    }
  })

  it('creates a session and exports it as a downloadable archive', async () => {
    // A fresh home has no workspace; create one through the same API the UI
    // uses after the picker returns a path.
    const created = await rpc(socketPath, 'workspace.create', { path: home })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const workspaces = await rpc(socketPath, 'workspace.list')
    expect(workspaces.ok).toBe(true)
    const items = (workspaces.value as { items: { workspaceId: string }[] }).items
    const workspaceId = items[0]?.workspaceId
    expect(workspaceId, 'workspace.create did not produce a workspace').toBeDefined()

    const session = await rpc(socketPath, 'session.create', { workspaceId })
    expect(session.ok, JSON.stringify(session)).toBe(true)
    const sessionId = (session.value as { sessionId?: string }).sessionId
    expect(typeof sessionId).toBe('string')

    // GET/HEAD /api/session.export is a query-param boundary, not an RPC
    // envelope; the export is what the UI's download affordance fetches.
    const res = await socketRequest(socketPath, {
      path: `/api/session.export?sessionId=${String(sessionId)}&includeDescendants=true`,
      method: 'HEAD',
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')
  })

  it('keeps the desktop transport decisions even under a hostile home overlay', async () => {
    // The home layer is applied for CLI parity and lands AFTER our patch, so
    // without re-asserting these a user file could bind a real TCP port, mount
    // a WebSocket carrier the app scheme cannot serve, or restore an OS chooser
    // this process cannot bring to the front.
    const graph = await socketRequest(socketPath, { path: '/' })
    const manifest = /window\.__DSH_BOOT__ = (\{.*?\})<\/script>/.exec(graph.body)
    const ids = (JSON.parse(manifest![1]!) as { entries: { id: string }[] }).entries.map((e) => e.id)
    expect(ids).not.toContain('@deepseek-ai/dsh-client-connection')
    expect(ids).toContain('@dsh-desktop/connection')
    // The picker must be ours, i.e. the native interaction served by the
    // launcher rather than a chooser the sidecar spawns.
    const requests = await socketRequest(socketPath, { path: '/desktop/picker/requests', firstChunkOnly: true })
    expect(requests.status).toBe(200)
  })

  it('carries the server-to-client interaction plane', async () => {
    // Approvals and ask-user questions arrive as SERVER-initiated requests on
    // the mux stream and are answered through /api/respond. Both directions
    // must survive the app scheme, which cannot open a WebSocket.
    const mux = await socketRequest(socketPath, { path: '/api/events.mux', firstChunkOnly: true })
    expect(mux.status).toBe(200)
    expect(String(mux.headers['content-type'])).toContain('text/event-stream')

    const answered = await socketRequest(socketPath, {
      path: '/api/respond',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: crypto.randomUUID(), result: { ok: true, value: {} } }),
    })
    // An unknown rpcId is refused with a receipt, not an error: the reply path
    // is reachable and correlating.
    expect(answered.status).toBe(200)
    expect(answered.body).toContain('not-pending')
  })

  it('reports a working directory that is not the filesystem root', async () => {
    // A GUI launch inherits the session manager's cwd; upstream derives the
    // sandbox workspace-write fallback root from it, so `/` would widen the
    // boundary to the whole filesystem.
    const described = await rpc(socketPath, 'host.describe')
    expect(described.ok).toBe(true)
    const cwd = (described.value as { cwd: string }).cwd
    expect(cwd).not.toBe('/')
    expect(cwd.length).toBeGreaterThan(1)
  })

  // ── the plugin profile: the second module-resolution anchor ──
  //
  // Bare plugin names resolve from `ctx.baseUrl`, which is the directory holding
  // the root config. Booting from a copy inside a profile directory under
  // $DSH_HOME is what puts a writable `node_modules` on that resolution walk, so
  // a plugin installed at runtime can be reached at all. These assert the
  // mechanism actually engaged, because boot.js falls back to the app-owned
  // config on any failure — and a run that silently took the fallback passes
  // every other test in this file.

  it('boots from a root config inside the profile, not the app payload', () => {
    // Existence of this file is the proof: boot.js writes it only on the path
    // that also returns it as the config to boot. If preparation had failed, the
    // fallback would have left no profile root here.
    const profileRoot = join(home, 'profiles', 'desktop', 'cordis.yml')
    expect(existsSync(profileRoot)).toBe(true)

    // contract: still an empty entry list after a full boot. The vendored
    // Loader's `tree.write()` serializes the fully patch-COMPOSED entry list
    // into this file, and it fires from paths this app never calls (any fiber
    // config update; any fiber that dies unexpectedly). Baked, the next boot
    // re-applies every bundle patch on top and dies on `duplicate loader entry
    // id`. This is the assertion that catches that in CI instead of at a user's
    // next launch.
    const meaningful = readFileSync(profileRoot, 'utf8')
      .split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l !== '').join('')
    expect(meaningful).toBe('[]')
  })

  it('seeds the profile with no bundles of its own', () => {
    // The three app-owned layers (dsh-base, dsh-web-app, @dsh-desktop/bundle)
    // stay app-owned and are loaded by boot.js directly. The profile's list
    // holds ONLY what a user installed, so an app update and a user's plugin
    // set can never fight over one list.
    const manifest = JSON.parse(
      readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8'),
    ) as { dsh?: { profile?: { bundles?: unknown } } }
    expect(manifest.dsh?.profile?.bundles).toEqual([])
  })

  it('links every local package into the flat module fallback', () => {
    // COUPLING, and a silent one. The fallback is healed from two anchors: the
    // dsh installation (which links the upstream closure) and
    // @dsh-desktop/bundle (which links ours, via its peerDependencies). Our
    // packages are copied in BESIDE the dsh tree rather than depended on by it,
    // so the dsh closure alone links none of them.
    //
    // Read from packages/ rather than hard-coded: a new package whose name was
    // never added to @dsh-desktop/bundle's peerDependencies fails HERE, instead
    // of resolving to nothing at runtime — where the client-module scan caches
    // an unresolvable name as "not a client package" and logs nothing at all.
    const local = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, 'packages', e.name, 'package.json')))
      .map((e) => (JSON.parse(
        readFileSync(join(root, 'packages', e.name, 'package.json'), 'utf8'),
      ) as { name: string }).name)
    expect(local.length).toBeGreaterThan(0)

    const fallback = join(home, 'profiles', 'node_modules')
    for (const name of local) expect(existsSync(join(fallback, name))).toBe(true)
    // And the upstream closure landed too, or nothing composed would resolve.
    expect(existsSync(join(fallback, '@deepseek-ai', 'dsh'))).toBe(true)
  })

  it('leaves the app-owned root config template untouched', () => {
    // The template is version-controlled as `[]`, but in a dev checkout it is an
    // ordinary writable file — so it is exposed to the same write-back. If this
    // ever fails, a boot wrote through to the payload instead of the profile.
    const template = join(harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'config', 'cordis.yml')
    const meaningful = readFileSync(template, 'utf8')
      .split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l !== '').join('')
    expect(meaningful).toBe('[]')
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
