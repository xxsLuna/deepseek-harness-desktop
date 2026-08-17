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
