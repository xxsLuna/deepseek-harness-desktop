// @ts-check
/**
 * @dsh-desktop/bundle — the desktop surface's runtime glue plugin. Mirrors the
 * upstream `dsh-web-app` glue for a windowed surface with no URL: mounts the
 * `frontend-static` fallback owner over the built web dist, bridges logical
 * Remote streams onto a streaming POST (the renderer cannot open a WebSocket
 * to the app scheme, so the Gateway's WebSocket mux is unreachable), and
 * contributes the desktop-surface prompt section plus the DSH_SURFACE shell
 * variable.
 *
 * The bridge is half of one contract; `@dsh-desktop/connection` is the other,
 * injecting the `openStream` hook upstream reads off the page global. Both
 * ends attach to declared API — `wireStream` here, `__DSH_TRANSPORT__` there —
 * which is what replaced a subclassed API client and a copied connection loop.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'

/** Stable Cordis plugin name. */
export const name = 'desktop-runtime'

export const inject = ['webServer']

/** @typedef {{ surfaceContext: boolean }} Config */
export const Config = z.object({
  /** Register the desktop-surface prompt section and shell variable. */
  surfaceContext: z.boolean().default(true),
})

/** The staged harness root (the directory holding node_modules). */
const HARNESS_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Resolve the built web dist through the frontend package exports. */
function resolveDistIndex() {
  const require = createRequire(import.meta.url)
  return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
}

/** Prompt text telling the model which surface the user is on. */
function desktopSurfacePrompt() {
  return [
    'The user interacts with you through the DeepSeek Harness desktop application (a windowed app, not a browser tab).',
    'There is no URL for this UI and no HTTP server serving it; "this window" or "this app" means the desktop window.',
    'The app provides no implicit DOM, route, or screenshot context.',
    'Starting a web server does not show the user anything unless they open a browser themselves.',
    'Code changes to the harness take effect only after the application restarts; a page refresh is not available.',
  ].join(' ')
}

/**
 * Where the browser half opens a logical stream. Mirrored by `STREAM_PATH` in
 * `@dsh-desktop/connection`'s injected transport script; the two are one
 * contract and `tests/contract/sidecar.spec.ts` is what stops them drifting
 * apart.
 *
 * Outside `/api` deliberately. That prefix has an upstream route owner, and
 * the routes this replaced lived inside it purely so an exact match would beat
 * that owner — which is shadowing, not composing.
 */
const REMOTE_STREAM_PATH = '/__desktop/remote-stream'

/** How much of a request body is a plausible stream request, in bytes. */
const MAX_STREAM_REQUEST_BYTES = 1 << 20

/**
 * Where the launcher asks for the URL that mints a browser session.
 *
 * Under `/desktop/`, so `isHostOnlyPath` in the launcher's proxy refuses it to
 * the renderer. That fence is the point: the answer carries this process's
 * launch token, and a page able to read it could mint a session of its own.
 */
const INDEX_URL_PATH = '/desktop/index-url'

/**
 * The authority the launcher's proxy presents to this server.
 *
 * `src/socket-proxy.ts` rewrites `host` to this on every forwarded request, so
 * upstream's fence sees a loopback authority. It is repeated here rather than
 * shared because the two live in different processes with no import between
 * them — and `tests/contract/browser-auth.spec.ts` is what stops the copy
 * drifting: a cookie is bound to its authority, so a mismatch would mint a
 * session that never authenticates anything.
 */
const PROXY_AUTHORITY = '127.0.0.1'

/**
 * Read the `{ endpoint, payload }` a stream request carries.
 *
 * Bounded, because this reads a request body into memory and the only caller
 * is a local page: a body that does not stop arriving is a bug or an abuse,
 * and either way the answer is to stop reading rather than to grow.
 * @param {import('node:http').IncomingMessage} req - the POST to the bridge.
 * @returns {Promise<{ endpoint: string, payload: unknown } | undefined>} the
 * request, or undefined when it is not one.
 */
async function readStreamRequest(req) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_STREAM_REQUEST_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    // `endpoint` is passed straight to the Gateway, so its type is checked
    // here rather than trusted; `payload` is opaque by contract and is not.
    if (typeof body?.endpoint !== 'string' || body.endpoint === '') return undefined
    return { endpoint: body.endpoint, payload: body.payload }
  } catch {
    return undefined
  }
}

/**
 * Mount the desktop surface glue.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Config} config - surface options.
 */
export function apply(ctx, config) {
  ctx.plugin(FrontendStatic, { distIndex: resolveDistIndex() })

  // The merged title band is NOT here: it is @dsh-desktop/chrome, its own row,
  // because it is window chrome rather than transport and the launcher
  // configures it. It taps the same index this fallback owner serves.

  // The stream bridge. Its page half is @dsh-desktop/connection's injected
  // `openStream` hook; between them they replace the Gateway's WebSocket mux,
  // which the renderer cannot reach because the app scheme does not carry a
  // WebSocket upgrade.
  //
  // `wireStream` is the Gateway's own public adapter, documented as "shared by
  // the WebSocket mux and local Host transports" — so this bridges at the API
  // upstream offers carriers, not at the wire. Nothing here knows how an
  // endpoint decodes into a Remote method, or how the mux frames anything; the
  // endpoint and payload are passed through exactly as they arrived.
  //
  // This replaced two exact routes on `/api/events.mux` and `/api/events.host`
  // whose whole trick was that an exact route beats upstream's `/api` prefix
  // route, so they could shadow the carrier's upgrade answer. Shadowing an
  // upstream route to get a look in is the shape of a missing seam; this path
  // is ours and sits outside `/api` for that reason.
  // The launcher's half of upstream's browser authentication.
  //
  // Since 0.1.2 `/api` is behind `BrowserAuth`: a request is authenticated by a
  // `dsh-auth-<authority>` cookie, and the only way to mint one is to GET `/`
  // carrying this process's launch token as `?token=`. That is upstream's model
  // for `dsh web`, where a human opens a printed URL in a browser.
  //
  // A desktop window is not that. It has no address bar to carry a token, and
  // making the renderer do the exchange would mean relying on Chromium storing
  // a Set-Cookie for a custom scheme and following a redirect through the
  // protocol handler — two behaviours we would be depending on rather than
  // owning. The launcher already injects the carrier's bearer token on every
  // proxied request; the cookie is the same kind of credential and belongs in
  // the same place.
  //
  // So this hands the launcher the authenticated URL and lets it do the
  // exchange over the socket, out of the renderer's reach entirely. Host-only
  // by its `/desktop/` prefix: `isHostOnlyPath` refuses it to the page, which
  // matters more here than for the picker — this URL carries the launch token,
  // and a page that could read it could mint its own session.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.webServer.register({
      kind: 'exact',
      path: INDEX_URL_PATH,
      handler: (req, res) => {
        // The authority the proxy presents on every forwarded request, which is
        // what the cookie will be bound to. Not read from this request: the
        // answer must describe the requests the LAUNCHER will make later, and
        // those are the ones the proxy rewrites.
        const url = connectionCtx.connection.authenticatedUrl(`http://${PROXY_AUTHORITY}`)
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ url }))
      },
    }), `desktop-runtime: ${INDEX_URL_PATH}`)
  })

  ctx.inject(['typertGateway'], (gatewayCtx) => {
    gatewayCtx.effect(() => gatewayCtx.webServer.register({
      kind: 'exact',
      path: REMOTE_STREAM_PATH,
      handler: async (req, res) => {
        const control = new AbortController()
        // The request closing is the only cancellation signal there is: the
        // client aborts its fetch when the logical stream is cancelled, and
        // this is what carries that through to the Gateway.
        res.once('close', () => control.abort())
        const opened = await readStreamRequest(req)
        if (opened === undefined) {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('desktop-runtime: expected {"endpoint":string,"payload":unknown}')
          return
        }
        // NDJSON, not SSE: one request per logical stream means there is
        // nothing to multiplex and no framing to reproduce. Buffering off, or
        // a proxy hop would hold values until something flushed it.
        res.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        })
        const write = (frame) => new Promise((resolve) => { res.write(`${JSON.stringify(frame)}\n`, () => resolve()) })
        try {
          const values = await gatewayCtx.typertGateway.wireStream.open(opened.endpoint, opened.payload, control.signal)
          for await (const value of values) {
            if (control.signal.aborted) break
            await write({ v: value })
          }
        } catch (error) {
          // The Gateway's own failure shape, not a transport paraphrase of it,
          // so the code and message the consumer sees are the ones it would
          // have seen over the mux. An aborted request has nobody to tell.
          if (!control.signal.aborted) {
            await write({ e: gatewayCtx.typertGateway.wireStream.failure(error) })
          }
        } finally {
          res.end()
        }
      },
    }), `desktop-runtime: stream bridge ${REMOTE_STREAM_PATH}`)
  })

  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      addHarnessSourceSection(promptCtx, HARNESS_ROOT)
      promptCtx.systemPrompt.section({
        name: 'app:desktop-surface',
        order: -98,
        text: desktopSurfacePrompt,
      })
    })
    ctx.inject(['shellEnv'], (envCtx) => {
      envCtx.shellEnv.register({
        name: 'desktop-runtime',
        variables: { DSH_SURFACE: { description: 'UI surface serving this session: the DeepSeek Harness desktop application.' } },
        resolve: () => ({ DSH_SURFACE: 'desktop' }),
      })
    })
  }
}
