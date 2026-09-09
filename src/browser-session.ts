/**
 * The launcher's half of upstream's browser authentication.
 *
 * Since harness 0.1.2 the `/api` surface is behind `BrowserAuth`: a request is
 * authenticated by a `dsh-auth-<authority>` cookie, and the only way to mint
 * one is to GET `/` carrying the sidecar process's launch token as `?token=`.
 * That is upstream's model for `dsh web`, where a person opens a printed URL
 * in a browser and Chromium keeps the cookie from there on.
 *
 * A desktop window is not that, and making the renderer play the browser here
 * would mean leaning on two behaviours we do not own: Chromium storing a
 * `Set-Cookie` for a custom scheme, and a redirect surviving the protocol
 * handler. Neither is written down as supported, and the app scheme already
 * cost this project a WebSocket for exactly that kind of assumption.
 *
 * The launcher is the better place, and not only by elimination. It already
 * injects the carrier's bearer token on every forwarded request
 * (`socket-proxy.ts`), so credentials for the sidecar are its job by
 * precedent — the cookie is one more of the same kind. The renderer then never
 * sees the launch token, never holds a session, and cannot mint one: the URL
 * that would let it is behind `isHostOnlyPath`.
 *
 * One session per sidecar. `reset()` exists because a sidecar restart means a
 * new process, a new launch token, and a cookie bound to a secret the old
 * process minted — reusing it would 401 every request until the app restarted.
 */
import { request as httpRequest } from 'node:http'
import type { SidecarAddress } from './socket-path.js'

/** Where `@dsh-desktop/bundle` answers with the URL that mints a session. */
const INDEX_URL_PATH = '/desktop/index-url'

/** How long the exchange may take before the caller gives up on it. */
const EXCHANGE_TIMEOUT_MS = 10_000

/**
 * Cookies a `set-cookie` header line carries, as a request `cookie` value.
 *
 * Only the name=value pair, dropped attributes and all: `Path`, `HttpOnly` and
 * `SameSite` describe what a browser should do with a cookie it is storing,
 * and this is not storing one — it is replaying a credential on a request it
 * makes itself.
 * @param setCookie - one or more `set-cookie` header values.
 * @returns the `cookie` request-header value, or undefined when none parsed.
 */
export function cookieHeaderFrom(setCookie: readonly string[]): string | undefined {
  const pairs = setCookie
    .map((line) => line.split(';', 1)[0]?.trim())
    .filter((pair): pair is string => pair !== undefined && pair.includes('='))
  return pairs.length === 0 ? undefined : pairs.join('; ')
}

/**
 * The path and query that mint a session, taken from an authenticated URL.
 *
 * The sidecar answers with a whole URL because `authenticatedUrl` builds one;
 * what the exchange needs is the part that goes on the wire, and the authority
 * in that URL is the one the proxy presents rather than anywhere to connect.
 * @param authenticatedUrl - the URL upstream built, carrying `?token=`.
 * @returns pathname and search, or undefined when the URL is unusable.
 */
export function exchangeTarget(authenticatedUrl: string): string | undefined {
  try {
    const url = new URL(authenticatedUrl)
    return url.searchParams.has('token') ? `${url.pathname}${url.search}` : undefined
  } catch {
    return undefined
  }
}

/** One request over the carrier socket, with the launcher's bearer token. */
function socketRequest(
  address: SidecarAddress,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number, body: string, setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath: address.socketPath,
      path,
      method: 'GET',
      timeout: EXCHANGE_TIMEOUT_MS,
      // The same authority the proxy presents on every forwarded request. The
      // cookie is bound to it, so a session minted under any other value
      // authenticates nothing.
      headers: { host: '127.0.0.1', authorization: `Bearer ${address.token}`, ...headers },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 500, body, setCookie: res.headers['set-cookie'] ?? [] })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('browser-session: the sidecar did not answer')) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Holds the one browser session the launcher replays on the renderer's behalf.
 */
export class BrowserSession {
  /** The `cookie` header value, once minted. */
  private cookie: string | undefined
  /** The in-flight mint, so concurrent requests wait on one exchange. */
  private minting: Promise<string | undefined> | undefined

  constructor(private readonly address: SidecarAddress) {}

  /**
   * Forget the session. Called when the sidecar is replaced: the new process
   * mints its own launch token, and a cookie from the old one 401s forever.
   */
  reset(): void {
    this.cookie = undefined
    this.minting = undefined
  }

  /**
   * The cookie header to attach to a forwarded request, minting one if needed.
   *
   * Failures are not fatal and are not cached: the sidecar may simply not be
   * listening yet on the first page load, and the next request tries again.
   * A request sent without the cookie is answered 401 by upstream, which is a
   * far better outcome than a launcher that refuses to proxy at all.
   * @returns the `cookie` value, or undefined when no session could be minted.
   */
  async cookieHeader(): Promise<string | undefined> {
    if (this.cookie !== undefined) return this.cookie
    // Coalesced: a page load fires many requests at once, and each one
    // minting its own session would race for the same cookie jar of one.
    this.minting ??= this.mint().finally(() => { this.minting = undefined })
    return await this.minting
  }

  /** Ask the sidecar for the authenticated URL, then exchange it for a cookie. */
  private async mint(): Promise<string | undefined> {
    try {
      const answer = await socketRequest(this.address, INDEX_URL_PATH)
      if (answer.status !== 200) return undefined
      const target = exchangeTarget((JSON.parse(answer.body) as { url?: string }).url ?? '')
      if (target === undefined) return undefined
      // Upstream answers this with a redirect to the clean `/` and the cookie
      // on the redirect response, so the Set-Cookie is read from THIS response
      // rather than followed — following it would fetch index.html for nobody.
      const minted = await socketRequest(this.address, target)
      this.cookie = cookieHeaderFrom(minted.setCookie)
      return this.cookie
    } catch {
      return undefined
    }
  }
}
