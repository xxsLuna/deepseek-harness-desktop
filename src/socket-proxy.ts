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
 * Build the protocol handler bound to one sidecar address.
 * @param address - socket path and bearer token.
 * @returns the handler for protocol.handle('dsh', ...).
 */
export function createSocketProxy(address: SidecarAddress): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!isTrustedRendererRequest(req)) {
      return new Response('forbidden', { status: 403 })
    }
    const url = new URL(req.url)
    if (isHostOnlyPath(decodeURIComponent(url.pathname))) {
      return new Response('forbidden', { status: 403 })
    }

    const headers: Record<string, string> = {}
    req.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      if (lower === 'origin' || lower.startsWith('sec-fetch-') || lower === 'host' || lower === 'authorization') return
      headers[lower] = value
    })
    headers.host = '127.0.0.1'
    headers.authorization = `Bearer ${address.token}`

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
}
