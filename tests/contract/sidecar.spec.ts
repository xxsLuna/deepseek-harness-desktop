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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * What `/market/installed` answers, as the Marketplace tab reads it. Declared
 * here rather than imported: the tab's copy is browser TSX in another project,
 * and this is the wire between the two, so both being written out is the point.
 */
interface InstalledView {
  entries: { name: string, version: string, kind: string, active: boolean, enabled: boolean, managed: boolean }[]
  failed: string[]
  restartRequired: boolean
  detail: Record<string, {
    skills: { name: string, kind: string, renamedFrom?: string }[]
    refused: { name?: string, code: string, message: string }[]
  } | undefined>
  skillErrors: { path: string, message: string }[]
}

interface SocketResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** One request over the socket; for SSE, resolves after the first data chunk. */
/**
 * Pull the client boot manifest out of a served index.html.
 *
 * The injection FORM is upstream's and it moved: through 0.1.0-rc.8 the
 * manifest arrived as `window.__DSH_BOOT__ = {...}` written by a raw index
 * tap, and 0.1.1-rc.1 replaced that with a structured `global` injection row,
 * which renders as `globalThis["__DSH_BOOT__"] = {...}`. Both set the same
 * property on a page, so nothing in the app had to change — but our carrier
 * had to grow `renderIndex` to render those rows at all, and this is where a
 * further change to the vocabulary shows up.
 *
 * The property NAME is still asserted directly, because that is the part the
 * page and `runSmoke` in main.ts actually read.
 * @param body - the served index.html.
 * @returns the plugin entry ids the manifest lists.
 */
function bootEntryIds(body: string): string[] {
  expect(body).toContain('__DSH_BOOT__')
  const manifest = /globalThis\["__DSH_BOOT__"\] = (\{[\s\S]*?\})<\/script>/.exec(body)
  expect(manifest, 'the boot manifest is no longer a structured `global` injection row').not.toBeNull()
  return (JSON.parse(manifest![1]!) as { entries: { id: string }[] }).entries.map((entry) => entry.id)
}

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

  /**
   * Place one Claude-format SKILL.md under a hand-made plugin tree.
   * @param slug - the skill's directory name, which is also its name.
   * @param extra - further frontmatter lines, after name and description.
   */
  const placeHandSkill = (slug: string, extra: string[] = []): void => {
    const dir = join(home, 'claude-plugins', 'handplaced', 'note-taker', 'skills', slug)
    mkdirSync(dir, { recursive: true })
    const lines = [
      '---',
      `name: ${slug}`,
      `description: Placed by the contract suite (${slug}).`,
      ...extra,
      '---',
      '',
      'Body.',
      '',
    ]
    writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'), 'utf8')
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-contract-home-'))
    socketDir = mkdtempSync(join(tmpdir(), 'dsh-contract-sock-'))
    socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-contract-${Date.now()}-${process.pid}`
      : join(socketDir, 's')

    // Two Claude plugins placed by HAND, before the sidecar starts — no
    // marketplace involved. This is what justifies @dsh-desktop/claude-plugins
    // being its own package: it publishes what is on disk, and the installer is
    // only one way for something to get there.
    placeHandSkill('contract-note')
    // The second declares a tool restriction the harness has no counterpart
    // for. It must be withheld rather than published with the agent's whole
    // toolset — silently widening what its author narrowed is the failure this
    // whole policy exists to prevent.
    placeHandSkill('contract-restricted', ['allowed-tools: Bash(ls:*)'])
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
    const ids = bootEntryIds(res.body)
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

  it('still emits the rail local the collapsed band cover paints over', async () => {
    // On macOS the traffic lights overhang a collapsed sidebar, so the band
    // cover has to reach the element that actually paints the rail's fill —
    // the column's own background is hidden behind it. That element is matched
    // as [class*='_railIn'], upstream's class for the sidebar drawn as a rail.
    // A rename leaves the cover painting the top 38px only, which puts the
    // horizontal edge back under the lights with nothing failing.
    const res = await socketRequest(socketPath, { path: '/plugins/@deepseek-ai/dsh-client-ui-sidebar/client.js' })
    expect(res.status).toBe(200)
    expect(res.body, "upstream no longer emits '_railIn'").toContain('_railIn')
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
    const ids = bootEntryIds(graph.body)
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

  it('reports what a Claude plugin published and what it withheld', async () => {
    // The wire shape the Marketplace tab reads. @dsh-desktop/market types this
    // service structurally rather than importing the sibling's typedef — the
    // two packages share a directory layout, not an import — so nothing but
    // this test holds the shape. If the inventory drifts, the tab silently
    // renders no skills and no refusals, which looks exactly like a plugin
    // that ships neither.
    const live = await socketRequest(socketPath, { path: '/market/installed' })
    const view = JSON.parse(live.body) as InstalledView

    // Placed by hand, so it must be listed and must NOT offer removal: this
    // app did not create the directory, so it does not delete it.
    const row = view.entries.find((entry) => entry.name === 'note-taker')
    expect(row, `hand-placed plugins are missing from ${JSON.stringify(view.entries)}`).toBeDefined()
    expect(row?.kind).toBe('claude')
    expect(row?.managed).toBe(false)
    expect(row?.active).toBe(true)

    const detail = view.detail['note-taker']
    expect(detail?.skills.map((skill) => skill.name)).toContain('contract-note')
    // The refusal is the half the tab exists to show: the skill is on disk and
    // deliberately not published, and the user has to be able to see why.
    const refused = detail?.refused.find((one) => one.name === 'contract-restricted')
    expect(refused?.code).toBe('allowed-tools')
    expect(refused?.message.length ?? 0).toBeGreaterThan(0)
  })

  it('can disable a Claude plugin without uninstalling it', async () => {
    // Disabling parks the tree under a dot-prefixed name, which the skill walk
    // already skips — the same rule that keeps it from publishing out of a
    // half-written staging directory. That reuse is the point: the two packages
    // share a directory layout and no import, so "not this one" has to be
    // sayable in the layout itself.
    //
    // Driven here against a HAND-PLACED plugin, which the marketplace never
    // installed and has no record of, because the mechanism has to be the
    // layout rather than the record for that case to work at all.
    const parked = join(home, 'claude-plugins', 'handplaced', '.note-taker')
    const live = join(home, 'claude-plugins', 'handplaced', 'note-taker')
    const names = async (): Promise<string[]> => {
      const workspaces = await rpc(socketPath, 'workspace.list')
      const workspaceId = (workspaces.value as { items: { workspaceId: string }[] }).items[0]?.workspaceId
      const session = await rpc(socketPath, 'session.create', { workspaceId })
      const listed = await rpc(socketPath, 'skill.list', { sessionId: (session.value as { sessionId?: string }).sessionId })
      return (listed.value as { skills: { name: string }[] }).skills.map((one) => one.name)
    }

    expect(await names()).toContain('contract-note')
    renameSync(live, parked)
    expect(await names(), 'a parked plugin is still being published').not.toContain('contract-note')
    renameSync(parked, live)
    expect(await names(), 'un-parking did not bring it back').toContain('contract-note')
  })

  it('publishes a hand-placed Claude plugin as a harness skill', async () => {
    // The format is not translated: the harness reads Claude's SKILL.md as its
    // own, and this is the end-to-end proof. skill.list is session-scoped, so a
    // workspace and a session come first — the same calls the UI makes.
    const created = await rpc(socketPath, 'workspace.create', { path: home })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const workspaces = await rpc(socketPath, 'workspace.list')
    const workspaceId = (workspaces.value as { items: { workspaceId: string }[] }).items[0]?.workspaceId
    const session = await rpc(socketPath, 'session.create', { workspaceId })
    expect(session.ok, JSON.stringify(session)).toBe(true)
    const sessionId = (session.value as { sessionId?: string }).sessionId

    const listed = await rpc(socketPath, 'skill.list', { sessionId })
    expect(listed.ok, JSON.stringify(listed)).toBe(true)
    const names = (listed.value as { skills: { name: string }[] }).skills.map((one) => one.name)

    expect(names, 'the hand-placed skill never reached the catalog').toContain('contract-note')
    expect(names, 'a skill declaring allowed-tools was published anyway').not.toContain('contract-restricted')
  })

  it('answers the marketplace routes, with the default catalog registered', async () => {
    // A fresh profile has installed nothing — that is the shipped state, and it
    // is what makes installation opt-in rather than something the app did for
    // you. The restart flag must be false too: nothing has been asked for yet.
    const live = await socketRequest(socketPath, { path: '/market/installed' })
    expect(live.status).toBe(200)
    const installed = JSON.parse(live.body) as InstalledView
    expect(installed.entries.filter((entry) => entry.managed)).toEqual([])
    expect(installed.restartRequired).toBe(false)

    // The default catalog reaches the tab through the settings `base` layer, so
    // it is visible and removable rather than a constant nobody can reach. If
    // this list were empty, the marketplace would be registered nowhere.
    const sources = await socketRequest(socketPath, { path: '/market/sources' })
    expect(sources.status).toBe(200)
    const listed = (JSON.parse(sources.body) as { sources: string[] }).sources
    expect(listed.length).toBeGreaterThan(0)
    for (const source of listed) expect(source.startsWith('https://')).toBe(true)
  })

  it('refuses a non-HTTPS marketplace source', async () => {
    // The store path validates against the SAME policy the fetch path applies,
    // so a source that could never be read cannot be saved and look accepted.
    const res = await socketRequest(socketPath, {
      path: '/market/sources',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: ['http://example.com/index.json'] }),
    })
    expect(res.status).toBe(422)
    expect(res.body).toContain('HTTPS only')
  })

  it('refuses to install a plugin no trusted source lists', async () => {
    // The request carries a name; everything else — the tarball URL, the version
    // and the digest — is read from the catalog. A caller cannot point the
    // installer at bytes of its own choosing, which is the whole reason the
    // request shape is this narrow.
    const res = await socketRequest(socketPath, {
      path: '/market/install',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@evil/not-listed' }),
    })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false })
  })

  it('serves the marketplace tab bundle', async () => {
    // The tab is a client plugin like any other: upstream's client-module scan
    // finds it by its `dsh.client` declaration and serves it. A silent
    // resolution failure would show up here as a 404, not as a log line.
    const res = await socketRequest(socketPath, { path: '/plugins/@dsh-desktop/market/client.js' })
    expect(res.status).toBe(200)
    expect(res.body).toContain('settings.plugins.tab')
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
