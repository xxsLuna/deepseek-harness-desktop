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

/**
 * The browser session every request carries once the sidecar is up.
 *
 * Minted during the readiness wait and then attached by `socketRequest`, which
 * is what the launcher's proxy does for the renderer. Undefined until then, so
 * the readiness probe itself can observe the 401 that says the fence is live.
 */
let sessionCookie: string | undefined
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
      // Bearer token AND session cookie, because upstream wants both since
      // 0.1.2 and the launcher's proxy sends both on every forwarded request
      // (src/socket-proxy.ts). A helper that sent only the token would make
      // every test here 401 while the app worked, which is the least useful
      // kind of red. `sessionCookie` is minted once readiness is reached.
      headers: {
        host: '127.0.0.1',
        authorization: `Bearer ${token}`,
        ...(sessionCookie === undefined ? {} : { cookie: sessionCookie }),
        ...options.headers,
      },
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

/**
 * Mint the browser session `/api` requires, the way the launcher does.
 *
 * Harness 0.1.2 put `/api` behind `BrowserAuth`: the carrier's bearer token
 * gets a request past the carrier, and a `dsh-auth-<authority>` cookie gets it
 * past upstream's fence. The cookie is minted by GETting `/` with this
 * process's launch token, which `@dsh-desktop/bundle` hands out on
 * `/desktop/index-url` — a launcher-only path, because whoever can read it can
 * mint a session.
 *
 * This mirrors `src/browser-session.ts` deliberately rather than importing it:
 * that module belongs to the Electron main process and this suite speaks to the
 * socket directly. Mirroring means a change that breaks the launcher's exchange
 * breaks this too, which is the coupling worth having — the alternative is a
 * green suite over an app that cannot authenticate.
 *
 * The exchange answers 303 with the cookie on the redirect itself, so the
 * `set-cookie` is read from that response rather than followed.
 * @param socketPath - the carrier socket.
 * @returns the `cookie` request-header value, or undefined when unavailable.
 */
async function mintBrowserSession(socketPath: string): Promise<string | undefined> {
  const answer = await socketRequest(socketPath, { path: '/desktop/index-url' })
  if (answer.status !== 200) return undefined
  const url = (JSON.parse(answer.body) as { url?: string }).url
  if (url === undefined) return undefined
  const target = new URL(url)
  const minted = await socketRequest(socketPath, { path: `${target.pathname}${target.search}` })
  const setCookie = minted.headers['set-cookie'] ?? []
  const pairs = setCookie
    .map((line) => line.split(';', 1)[0]?.trim())
    .filter((pair): pair is string => pair !== undefined && pair.includes('='))
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

/**
 * Fetch one client bundle the way 0.1.2 addresses them.
 *
 * Bundles are served under a combo URL —
 * `/plugins/??<id>/client.js[,…]&rev=<revision>` — and there is no single
 * revision to write down: 0.1.2 derives one PER ENTRY from content, so the
 * `rev` on the index's own script tag answers for that batch and 404s for
 * anything else.
 *
 * The boot manifest carries each entry's `url` already, which is both the only
 * reliable source and the honest assertion: it is the URL the page will load.
 * @param socketPath - the carrier socket.
 * @param id - the package id whose client bundle is wanted.
 * @returns the bundle response.
 */
async function pluginBundle(socketPath: string, id: string): Promise<SocketResponse> {
  const index = await socketRequest(socketPath, { path: '/' })
  const manifest = /globalThis\["__DSH_BOOT__"\] = (\{[\s\S]*?\})<\/script>/.exec(index.body)
  expect(manifest, 'the served index carries no boot manifest').not.toBeNull()
  const entries = (JSON.parse(manifest![1]!) as { entries: { id: string, url: string }[] }).entries
  const entry = entries.find((candidate) => candidate.id === id)
  expect(entry, `the boot manifest lists no entry for ${id}`).toBeDefined()
  return await socketRequest(socketPath, { path: entry!.url.replaceAll('&amp;', '&') })
}

/**
 * A Remote payload: the named arguments wrapped in the one field 0.1.2 wants.
 *
 * The envelope is checked before anything is dispatched — "Remote payload must
 * contain exactly one plain-object args field" — and the arguments inside it
 * are then matched against the method descriptor EXACTLY: an unknown field or
 * a missing required one is `gateway/arguments-invalid`, not a default.
 *
 * So the wire names in these tests are assertions about upstream's surface,
 * which is what makes them worth having: 0.1.2 renamed the arguments as well
 * as the endpoints, and a positional or loosely-named call fails identically
 * whether the field moved or the method vanished.
 * @param args - named arguments, keyed by the descriptor's wire names.
 * @returns the payload to put on the wire.
 */
function remoteArgs(args: Record<string, unknown>): { args: Record<string, unknown> } {
  return { args }
}

/**
 * The first value a logical stream yields, over the desktop bridge.
 *
 * 0.1.2 turned several listings into streams: `workspace.list` is gone and
 * `workspace/follow` "streams a complete Workspace baseline followed by
 * ordered increments", so the baseline IS the list and it arrives as the
 * stream's first frame.
 *
 * Read through `/__desktop/remote-stream` rather than the Gateway's WebSocket
 * mux, because that bridge is what the renderer uses — the app scheme carries
 * no upgrade. Using it here means a test that reads a listing also exercises
 * the transport the app depends on.
 * @param socketPath - the carrier socket.
 * @param endpoint - `namespace/method` of a stream method.
 * @param payload - the named wire arguments.
 * @returns the first value the stream yielded.
 * @throws when the stream failed or ended without a value.
 */
async function firstStreamValue(
  socketPath: string,
  endpoint: string,
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await socketRequest(socketPath, {
    path: '/__desktop/remote-stream',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: remoteArgs(payload) }),
    // The baseline is the first frame and the stream stays open for
    // increments, so waiting for `end` would wait for the generation to be
    // cancelled. One chunk is the baseline.
    firstChunkOnly: true,
  })
  if (res.status !== 200) throw new Error(`${endpoint}: HTTP ${String(res.status)}`)
  const first = res.body.split('\n').find((line) => line !== '')
  if (first === undefined) throw new Error(`${endpoint}: the bridge framed nothing`)
  const frame = JSON.parse(first) as { v?: unknown, e?: { message?: string } }
  if ('e' in frame && frame.e !== undefined) throw new Error(`${endpoint}: ${frame.e.message ?? 'stream failed'}`)
  return frame.v
}

/**
 * One unary RPC over the socket, unwrapped to its result.
 * @param socketPath - the carrier socket.
 * @param method - `namespace/method`.
 * @param args - the named wire arguments, exact.
 * @returns the RPC result, ok or error.
 */
async function rpc(socketPath: string, method: string, args: Record<string, unknown> = {}): Promise<{
  ok: boolean
  value?: unknown
  error?: { code: string }
}> {
  const res = await socketRequest(socketPath, {
    path: `/api/${method}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: remoteArgs(args) }),
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
    //
    // Two things about this probe changed with harness 0.1.2, and both are the
    // seam moving rather than the app breaking.
    //
    // It mints a browser session first. `/api` is behind `BrowserAuth` now, and
    // a request without the cookie is answered 401 whatever it asks for. This
    // test speaks to the socket directly rather than through the launcher's
    // proxy, so it has to do for itself what `src/browser-session.ts` does for
    // the renderer — which is also what keeps this honest: if the exchange
    // stopped working, the launcher's path would be broken too and this fails.
    //
    // And it asks for `$events/result`, because `host.describe` no longer
    // exists — host facts ride the Remote event generation's opening frame in
    // 0.1.2. `$events/result` is an endpoint the Gateway's `claimsEndpoint`
    // accepts, which is exactly what readiness means here: the /api route owner
    // has registered and its interceptor is claiming.
    const deadline = Date.now() + 90_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`sidecar exited during startup:\n${log}`)
      // Pipe names have no filesystem presence on Windows; just try connecting.
      if (process.platform === 'win32' || existsSync(socketPath)) {
        try {
          sessionCookie = await mintBrowserSession(socketPath)
          const probe = await socketRequest(socketPath, {
            path: '/api/$events/result',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: '$events/result', payload: {} }),
          })
          // 200 and nothing else, and the three outcomes are cleanly apart:
          // 200 with a session, 401 without one, 404 for an endpoint the
          // Gateway does not claim. The response BODY carries a business error
          // (`gateway/internal` — this probe sends no real arguments) and that
          // is fine: what readiness means here is that the fence passed and
          // the interceptor claimed the endpoint.
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

  it('answers readiness on the desktop surface, not on the auth fence', async () => {
    // What the launcher's readiness probe may and may not ask.
    //
    // The probe used to HEAD `/` and accept any status below 500. Since 0.1.2
    // `/` sits behind `BrowserAuth`, so an unauthenticated HEAD is answered
    // 401 — and 401 was inside that accept set. Readiness therefore meant only
    // "the socket is bound", which it reaches before any plugin route exists.
    //
    // The cost was total and silent: the window loaded through a proxy that
    // could not yet mint a session, upstream answered the index 401, and a
    // document load happens once, so nothing retried. The app printed `ready`,
    // logged nothing, and showed an empty window. Both halves are asserted
    // here because the bug needed both to be true.
    const headWithoutCookie = (path: string): Promise<number> => new Promise((resolve, reject) => {
      const req = httpRequest({
        socketPath,
        path,
        method: 'HEAD',
        // The bearer token but deliberately NO cookie: exactly what the
        // launcher can present before it has a session, which is the moment
        // readiness is being decided.
        headers: { host: '127.0.0.1', authorization: `Bearer ${token}` },
      }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })

    // Half one: `/` cannot be the probe, because the fence answers it.
    expect(await headWithoutCookie('/'), '/ no longer 401s without a session; re-read what readiness can mean').toBe(401)
    // Half two: the route the probe uses now answers 200, and it exists only
    // once `@dsh-desktop/bundle` has run inside `ctx.inject(['connection'])` —
    // which is the condition the proxy needs before it can mint anything.
    expect(await headWithoutCookie('/desktop/index-url'), 'the desktop surface no longer answers the readiness path').toBe(200)
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
    // `namespace/method`, with a SLASH. Harness 0.1.2's Gateway claims an
    // endpoint only when it splits into exactly two segments
    // (`claimsEndpoint`), so the old dotted `session.list` is a path the
    // Gateway does not claim and the carrier answers 404. Same call, new
    // spelling — this is the shape upstream's own client now sends.
    const res = await socketRequest(socketPath, {
      path: '/api/session/list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: {} }),
    })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as { rpcId: string, result: { ok: boolean } }
    // The envelope, not the business result: this asserts the route owner is
    // there and the correlation holds. A bare `payload: {}` is not a valid
    // argument set for the method, so upstream answers `ok: false` with
    // `gateway/internal` — the Gateway having DISPATCHED rather than having
    // refused the endpoint, which is what a 404 would mean.
    expect(parsed.rpcId).toBe(rpcId)
    expect(parsed.result).toHaveProperty('ok')
  })

  it('bridges logical streams over a POST instead of demanding a WebSocket upgrade', async () => {
    // This replaced two exact SSE routes on `/api/events.host` and
    // `/api/events.mux`, whose whole trick was that an exact route beats
    // upstream's `/api` prefix owner. 0.1.2 carries logical streams over the
    // Gateway's WebSocket mux, which the renderer cannot reach from the app
    // scheme, so `@dsh-desktop/bundle` bridges the Gateway's own
    // `wireStream.open` onto NDJSON and `@dsh-desktop/connection` consumes it
    // through the `openStream` transport hook.
    //
    // The endpoint here is deliberately one the Gateway does not claim: what
    // this asserts is that the BRIDGE answers and frames, which a refusal
    // frame proves as well as a value would — and unlike a real stream it
    // terminates on its own.
    const res = await socketRequest(socketPath, {
      path: '/__desktop/remote-stream',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'contract/probe', payload: {} }),
    })
    expect(res.status).toBe(200)
    expect(String(res.headers['content-type'])).toContain('application/x-ndjson')
    // One JSON object per line, and every frame is a value (`v`) or the
    // failure that ended the stream (`e`).
    const frames = res.body.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(frames.length, `the bridge framed nothing: ${res.body}`).toBeGreaterThan(0)
    for (const frame of frames) expect(Object.keys(frame).some((key) => key === 'v' || key === 'e')).toBe(true)
  })

  it('refuses a stream request that names no endpoint', async () => {
    // The bridge hands `endpoint` straight to the Gateway, so its type is
    // checked rather than trusted.
    const res = await socketRequest(socketPath, {
      path: '/__desktop/remote-stream',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: {} }),
    })
    expect(res.status).toBe(400)
  })

  it('serves the desktop client bundle through /plugins', async () => {
    // The combo form, read from the served index rather than spelled here.
    // 0.1.2 addresses client bundles as
    // `/plugins/??<id>/client.js[,<id>/client.js…]&rev=<revision>` and the
    // revision is content-derived, so a hardcoded URL is a 404 waiting for the
    // next build. Asking for the URL the page itself uses is also the stronger
    // assertion: it fails if the index stops pointing anywhere real.
    const index = await socketRequest(socketPath, { path: '/' })
    const combo = /src="(\/plugins\/\?\?[^"]+)"/.exec(index.body)
    expect(combo, 'the served index references no /plugins combo bundle').not.toBeNull()
    const res = await socketRequest(socketPath, { path: combo![1]!.replaceAll('&amp;', '&') })
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
    const res = await pluginBundle(socketPath, '@deepseek-ai/dsh-client-ui-layout')
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
    const res = await pluginBundle(socketPath, '@deepseek-ai/dsh-client-ui-sidebar')
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

  // The agent-preset roster used to be asserted here through
  // `agentPreset.list`. 0.1.2 exposes presets over no Remote at all — the
  // chosen default is a settings namespace now — so the roster is not
  // observable from a client, and there is no endpoint to rename this to.
  //
  // What the check was FOR survives, and is covered: the preset roots are an
  // assembly fact the upstream launcher patches in, and missing that overlay
  // makes every `session/create` fail with agent-preset-not-found. The two
  // tests below create a session, so they fail exactly when this one would
  // have — on the consequence rather than on the inventory.
  //
  // Written down rather than deleted quietly, because "the roster is right"
  // and "a session can be created" are not the same assertion, and a future
  // reader should know which one is still standing.

  it('creates a session and exports it as a downloadable archive', async () => {
    // A fresh home has no workspace; create one through the same API the UI
    // uses after the picker returns a path.
    const created = await rpc(socketPath, 'workspace/create', { request: { path: home } })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    // `workspace.list` is gone: 0.1.2 streams the baseline through
    // `workspace/follow`, so the listing is the stream's first frame — a
    // TAGGED frame, `{type:'baseline',value:{items,archivedSessionIds}}`,
    // because the increments that follow it are tagged too.
    const baseline = await firstStreamValue(socketPath, 'workspace/follow')
    const items = (baseline as { value: { items: { workspaceId: string }[] } }).value.items
    const workspaceId = items[0]?.workspaceId
    expect(workspaceId, 'workspace.create did not produce a workspace').toBeDefined()

    const session = await rpc(socketPath, 'session/create', { request: { workspaceId } })
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
    // Approvals and ask-user questions are SERVER-initiated: the harness asks
    // and the page answers. Both directions have to survive the app scheme,
    // which cannot open a WebSocket — so this is the plane the desktop had to
    // rebuild, and the one test that proves the rebuild carries it.
    //
    // 0.1.2 moved both halves. The downlink was an SSE mux at
    // `/api/events.mux`; it is now a reserved Remote stream named `$events`,
    // opened through the same `wireStream` adapter as any other stream — which
    // means the desktop bridge already carries it, and reading it HERE through
    // the bridge is what shows that. The uplink was `/api/respond`; it is now
    // an ordinary unary RPC, `$events/result`, on the `/api` channel the proxy
    // already forwards.
    //
    // Neither route exists any more, so the old version of this test failed
    // 404 — the honest signal, and the reason the suite is worth keeping.
    const ready = await firstStreamValue(socketPath, '$events')
    // The opening frame is the readiness proof, and it is also where 0.1.2 put
    // the host facts that `host.describe` used to answer for.
    const opened = ready as { type?: string, clientId?: string, host?: unknown }
    expect(opened.type, JSON.stringify(opened)).toBe('ready')
    expect(typeof opened.clientId).toBe('string')
    expect(opened.host).toBeDefined()

    // The uplink, addressed with the `$` segment upstream reserves — a fact
    // about the URL and not only the dispatcher, since the channel validates
    // path segments before anything is dispatched.
    const answered = await rpc(socketPath, '$events/result', {
      clientId: 'contract-no-such-client',
      eventId: crypto.randomUUID(),
      outcome: { kind: 'next' },
    })
    // An unknown client is refused by CORRELATION, not by the transport: the
    // reply path is reachable, parsed the envelope, and then declined to match
    // it to a live generation. A 404 or a 415 here would mean the route moved
    // again; `ok: true` would mean it accepts answers for nobody.
    expect(answered.ok, JSON.stringify(answered)).toBe(false)
    expect(answered.error?.code).toBe('gateway/internal')
  })

  // The working-directory check used to live here, reading `host.describe`.
  // 0.1.2 removed that endpoint — host facts ride the Remote event
  // generation's opening frame now, and that frame carries `home`, not a
  // working directory — so the harness no longer reports the answer to
  // anybody.
  //
  // The check did not go away; it moved to the party that decides it.
  // `cwd` is the LAUNCHER's choice (`homedir()` in main, forwarded by
  // `Sidecar.start`), and asserting that forwarding is a unit test's job:
  // `tests/unit/sidecar.spec.ts`, "spawns the harness in the configured
  // working directory". Recorded here because a reader looking for the
  // filesystem-root guard should find out where it went rather than conclude
  // it was dropped with the endpoint.

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
      // The baseline frame of `workspace/follow`; `workspace.list` is gone.
      const baseline = await firstStreamValue(socketPath, 'workspace/follow')
      const workspaceId = (baseline as { value: { items: { workspaceId: string }[] } }).value.items[0]?.workspaceId
      const session = await rpc(socketPath, 'session/create', { request: { workspaceId } })
      const listed = await rpc(socketPath, 'skills/list', { request: { sessionId: (session.value as { sessionId?: string }).sessionId } })
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
    const created = await rpc(socketPath, 'workspace/create', { request: { path: home } })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    // The baseline frame of `workspace/follow`; `workspace.list` is gone.
    const baseline = await firstStreamValue(socketPath, 'workspace/follow')
    const workspaceId = (baseline as { value: { items: { workspaceId: string }[] } }).value.items[0]?.workspaceId
    const session = await rpc(socketPath, 'session/create', { request: { workspaceId } })
    expect(session.ok, JSON.stringify(session)).toBe(true)
    const sessionId = (session.value as { sessionId?: string }).sessionId

    const listed = await rpc(socketPath, 'skills/list', { request: { sessionId } })
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
    const res = await pluginBundle(socketPath, '@dsh-desktop/market')
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
