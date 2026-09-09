/**
 * The dsh:// protocol handler: forward each renderer request to the sidecar
 * over the socket, streaming both directions. This is the only path between
 * the window and the harness.
 *
 * Browser-marker policy: the renderer's own origin is `dsh://app`, which the
 * upstream /api trust fence would reject (its Origin must match the Host
 * authority). Same-origin-ness is therefore enforced HERE — a cross-site
 * marker or a foreign Origin is refused before anything is forwarded — and
 * the markers are stripped from the forwarded request, which then passes the
 * upstream fence via its loopback Host. The upstream 415 content-type fence
 * stays fully in force downstream.
 */
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import type { SidecarAddress } from './socket-path.js'
import { BrowserSession } from './browser-session.js'

/** The renderer's origin under the standard+secure dsh scheme. */
export const APP_ORIGIN = 'dsh://app'

/** Response headers that must not be copied onto a fetch Response. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade'])

/**
 * Route prefix the launcher owns and the renderer must never reach. This proxy
 * injects the bearer token on every forwarded request, so without this fence a
 * page could subscribe to launcher-only channels and forge their answers — for
 * the picker that means opening a workspace at a path it chose.
 */
const HOST_ONLY_PREFIX = '/desktop/'

/**
 * Whether a pathname belongs to the launcher-only surface.
 * @param pathname - decoded request pathname.
 * @returns true when the renderer must be refused.
 */
export function isHostOnlyPath(pathname: string): boolean {
  return pathname === '/desktop' || pathname.startsWith(HOST_ONLY_PREFIX)
}

/**
 * Route prefix the launcher answers itself instead of forwarding. Some of what
 * the page shows is launcher business — a native menu, the window's navigation
 * history, the caption-button colour, the desktop preferences — and no preload
 * ships to carry it, so the page posts here and main answers.
 *
 * Distinct from HOST_ONLY_PREFIX, which the renderer is refused: this one is
 * *for* the renderer. Neither reaches the sidecar.
 */
const DESKTOP_HOST_PREFIX = '/__desktop-host/'

/**
 * Whether a pathname is one the launcher answers itself.
 * @param pathname - decoded request pathname.
 * @returns true when the launcher answers instead of the sidecar.
 */
export function isDesktopHostPath(pathname: string): boolean {
  return pathname.startsWith(DESKTOP_HOST_PREFIX)
}

/**
 * The action a launcher request names, e.g. `chrome/menu`, `settings/read`.
 * @param pathname - decoded pathname, already matched by isDesktopHostPath.
 * @returns the trailing path.
 */
export function desktopHostAction(pathname: string): string {
  return pathname.slice(DESKTOP_HOST_PREFIX.length)
}

/**
 * Whether a renderer request may reach the sidecar at all.
 * @param req - the protocol-handler request.
 * @returns true for same-origin (or marker-less) requests only.
 */
export function isTrustedRendererRequest(req: Request): boolean {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false
  const origin = req.headers.get('origin')
  return origin === null || origin === APP_ORIGIN
}

/**
 * Whether a 401 is worth one retry with a freshly minted browser session.
 *
 * A 401 is not a failed load. Chromium reports `did-fail-load` for transport
 * errors, so the launcher's bounded reload never sees an HTTP status — a 401
 * document renders as a page and nothing retries it, which for the index is a
 * blank window for the rest of the app's life. That is exactly what the
 * readiness bug looked like (`src/sidecar.ts`). Readiness no longer produces
 * one, and this covers what that analysis cannot: the cookie's own 30-day
 * expiry, and a credentials record rotated under a running app.
 *
 * Only without a body. A request body is a stream already piped to the sidecar
 * and cannot be replayed, so a retry would send an empty one — worse than the
 * 401 it replaced. The fatal case is a document load, which carries no body, so
 * the restriction costs nothing that matters.
 *
 * Retrying at most once is the CALLER's structure, not a flag here: one re-mint
 * either fixes it or the session is not the problem, and a predicate that could
 * say yes twice is a loop waiting to happen.
 * @param status - the sidecar's response status.
 * @param hasBody - whether the request carried a body.
 * @returns true when the caller should re-mint and send the request again.
 */
export function shouldRetryUnauthorized(status: number, hasBody: boolean): boolean {
  return status === 401 && !hasBody
}

/**
 * Build the protocol handler bound to one sidecar address.
 * @param address - socket path and bearer token.
 * @returns the handler for protocol.handle('dsh', ...).
 */
export function createSocketProxy(address: SidecarAddress): (req: Request) => Promise<Response> {
  const session = new BrowserSession(address)

  /** One forward over the socket, with the session cookie of the moment. */
  const forward = async (req: Request, url: URL): Promise<Response> => {
    const headers: Record<string, string> = {}
    req.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      if (lower === 'origin' || lower.startsWith('sec-fetch-') || lower === 'host' || lower === 'authorization') return
      headers[lower] = value
    })
    headers.host = '127.0.0.1'
    headers.authorization = `Bearer ${address.token}`
    // Upstream's `/api` fence wants a browser session on top of the carrier
    // token (harness 0.1.2's BrowserAuth). The launcher holds the one session
    // and replays it here, for the same reason it injects the token above: the
    // renderer is a window, not a browser that followed a printed URL, and the
    // cookie is a credential for the sidecar rather than page state. See
    // browser-session.ts. Any cookie the page sent is replaced, never merged —
    // this header is the launcher's to state.
    const cookie = await session.cookieHeader()
    if (cookie !== undefined) headers.cookie = cookie

    return await new Promise<Response>((resolve, reject) => {
      const upstream = httpRequest({
        socketPath: address.socketPath,
        path: url.pathname + url.search,
        method: req.method,
        headers,
      }, (res) => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue
          for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(name, v)
        }
        const status = res.statusCode ?? 500
        const body = status === 204 || status === 304 || req.method === 'HEAD'
          ? null
          : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
        resolve(new Response(body, { status, headers: responseHeaders }))
      })
      upstream.on('error', reject)
      if (req.body === null) {
        upstream.end()
      } else {
        Readable.fromWeb(req.body as import('node:stream/web').ReadableStream<Uint8Array>)
          .pipe(upstream)
          .on('error', reject)
      }
    })
  }

  return async (req) => {
    if (!isTrustedRendererRequest(req)) {
      return new Response('forbidden', { status: 403 })
    }
    const url = new URL(req.url)
    if (isHostOnlyPath(decodeURIComponent(url.pathname))) {
      return new Response('forbidden', { status: 403 })
    }

    const hasBody = req.body !== null
    const answer = await forward(req, url)
    if (!shouldRetryUnauthorized(answer.status, hasBody)) return answer
    // Cancelled, not dropped: the body is a live socket stream, and abandoning
    // it would hold the connection open for a response nobody will read.
    await answer.body?.cancel()
    session.reset()
    return await forward(req, url)
  }
}
