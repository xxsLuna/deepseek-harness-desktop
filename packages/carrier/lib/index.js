// @ts-check
/**
 * @dsh-desktop/carrier — the `webServer` service over a Unix domain socket
 * (macOS/Linux) or a named pipe (Windows) instead of a TCP port. Route
 * registration, the fallback seat, index taps, and dispatch order mirror the
 * upstream `@deepseek-ai/dsh-host-webserver` service surface, so upstream
 * route owners (`/api`, `/plugins`, the SPA fallback) compose against this
 * provider unchanged. Every request must carry the launcher's bearer token;
 * anything else is answered 401 before any route runs.
 */
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'

/**
 * @typedef {import('@deepseek-ai/dsh-host-webserver').WebRoute} WebRoute
 * @typedef {import('@deepseek-ai/dsh-host-webserver').WebUpgradeRoute} WebUpgradeRoute
 * @typedef {import('@deepseek-ai/dsh-host-webserver').IndexInjection} IndexInjection
 */

/** @typedef {{ socketPath: string, token: string }} Config */

export class DesktopCarrier extends Service {
  static Config = z.object({
    /** Absolute Unix-domain-socket path, or a \\.\pipe\ name on Windows. */
    socketPath: z.string().required(),
    /** Bearer token every request must present; the launcher generates it. */
    token: z.string().required(),
  })

  /** @type {Map<string, WebRoute>} */ _exact = new Map()
  /** @type {Map<string, WebRoute>} */ _prefixes = new Map()
  /** @type {Map<string, WebUpgradeRoute>} */ _upgrades = new Map()
  /** @type {((html: string) => string)[]} */ _indexTaps = []
  /** @type {WebRoute['handler'] | undefined} */ _fallback
  /** @type {import('node:http').Server} */ _server
  /** @type {Config} */ _config

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {Config} config - socket path and bearer token.
   */
  constructor(ctx, config) {
    super(ctx, 'webServer')
    this._config = config
  }

  /** No TCP port exists on this carrier; consumers reading it get 0. */
  get port() {
    return 0
  }

  /** Loopback literal: satisfies host-based policy (picker choice, trust fence). */
  get host() {
    return /** @type {'127.0.0.1'} */ ('127.0.0.1')
  }

  /**
   * Register a named route. Duplicate (kind, path) throws — a collision is a
   * misconfiguration, matching the upstream carrier contract.
   * @param {WebRoute} route - kind, path, and the owning handler.
   * @returns {() => void} disposer removing the route.
   */
  register(route) {
    const table = route.kind === 'exact' ? this._exact : this._prefixes
    if (table.has(route.path)) throw new Error(`desktop-carrier: duplicate ${route.kind} route ${route.path}`)
    table.set(route.path, route)
    return () => void table.delete(route.path)
  }

  /**
   * Register an exact-path HTTP upgrade route. Accepted for surface parity;
   * nothing reaches it because the renderer cannot open a WebSocket to the
   * dsh:// scheme, and the desktop composition replaces the sole upstream
   * upgrade registrant.
   * @param {WebUpgradeRoute} route - pathname and negotiation handler.
   * @returns {() => void} disposer removing the route.
   */
  registerUpgrade(route) {
    if (this._upgrades.has(route.path)) throw new Error(`desktop-carrier: duplicate upgrade route ${route.path}`)
    this._upgrades.set(route.path, route)
    return () => void this._upgrades.delete(route.path)
  }

  /**
   * Claim the fallback seat answering every unmatched request. One owner only.
   * @param {WebRoute['handler']} handler - owns unmatched responses.
   * @returns {() => void} disposer releasing the seat.
   */
  registerFallback(handler) {
    if (this._fallback !== undefined) throw new Error('desktop-carrier: fallback seat already claimed')
    this._fallback = handler
    return () => {
      this._fallback = undefined
    }
  }

  /**
   * Register an index.html transform applied by the fallback owner in
   * registration order.
   * @param {(html: string) => string} transform - pure html-to-html function.
   * @returns {() => void} disposer removing the transform.
   */
  tapIndex(transform) {
    this._indexTaps.push(transform)
    return () => {
      const at = this._indexTaps.indexOf(transform)
      if (at !== -1) this._indexTaps.splice(at, 1)
    }
  }

  /**
   * Run an index.html body through the registered taps in registration order.
   * @param {string} html - raw index.html body.
   * @returns {string} the transformed body.
   */
  applyIndexTaps(html) {
    let out = html
    for (const transform of this._indexTaps) out = transform(out)
    return out
  }

  /**
   * Gather the structured injection table: one `webserver/index-inject` emit,
   * every subscriber pushes its current rows.
   *
   * Fresh per call by contract, because subscribers read live state at emit
   * time — `dsh-client-modules` publishes the module graph and
   * `dsh-client-ui-theme` the theme preference, and both change while the app
   * runs.
   * @returns {IndexInjection[]} rows in subscriber activation order.
   */
  collectIndexInjections() {
    /** @type {IndexInjection[]} */
    const table = []
    this.ctx.emit('webserver/index-inject', table)
    return table
  }

  /**
   * Render one index.html body: structured rows first, then the raw taps.
   *
   * This is what the SPA fallback owner calls for every index response, and it
   * is the reason this class cannot simply stop at `applyIndexTaps`. Upstream
   * added the structured layer in 0.1.1-rc.1; before that the fallback called
   * `applyIndexTaps` directly. A provider standing in for the upstream
   * `webServer` has to grow with that interface, and the cost of not doing so
   * is not a missing feature — the call throws, and every page load answers
   * with the carrier's error status instead of the app.
   *
   * The row renderer is imported from upstream rather than reimplemented.
   * Escaping and placement are its rules, and a second copy of them here would
   * be a second thing to keep in step.
   * @param {string} html - raw index.html body.
   * @returns {string} the transformed body.
   */
  renderIndex(html) {
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()))
  }

  /** Bind the socket; resolves once listening (rejection = FAILED fiber). */
  async [Service.init]() {
    const { socketPath, token } = this._config
    const isPipe = socketPath.startsWith('\\\\')
    if (!isPipe) {
      mkdirSync(dirname(socketPath), { recursive: true })
      chmodSync(dirname(socketPath), 0o700)
      rmSync(socketPath, { force: true })
    }

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    const handle = async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401)
        res.end()
        return
      }
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = this._match(rawPath)
      if (route !== undefined) {
        await route.handler(req, res)
        return
      }
      const fallback = this._fallback
      if (fallback === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      await fallback(req, res)
    }

    this._server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err))
        // 500, not 400. A route handler that throws is this server's fault,
        // and answering "bad request" sends whoever is debugging it looking at
        // their own request. That cost real time once: upstream grew a method
        // this provider did not have, every page load threw, and the only
        // evidence was an empty 400 that read like a malformed URL.
        //
        // The message goes in the body for the same reason. Nothing here is
        // reachable without the launcher's bearer token, so there is no
        // untrusted reader to leak it to.
        this.ctx.logger.error(error)
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`carrier: ${req.method ?? 'GET'} ${req.url ?? '/'} failed: ${error.message}`)
      })
    })

    await new Promise((resolve, reject) => {
      this._server.once('error', reject)
      this._server.listen(socketPath, () => {
        this._server.off('error', reject)
        this._server.on('error', (err) => {
          this.ctx.logger.error(err)
        })
        if (!isPipe) chmodSync(socketPath, 0o600)
        resolve(undefined)
      })
    })

    this.ctx.effect(() => async () => {
      const closed = new Promise((resolve) => {
        this._server.close(() => resolve(undefined))
      })
      this._server.closeAllConnections()
      await closed
      if (!isPipe) rmSync(socketPath, { force: true })
    }, 'desktopCarrier.listen')
  }

  /**
   * Exact table first, then longest-prefix-wins over the prefix table.
   * @param {string} pathname - decoded request pathname.
   * @returns {WebRoute | undefined} the owning route, if any.
   */
  _match(pathname) {
    const exact = this._exact.get(pathname)
    if (exact !== undefined) return exact
    /** @type {WebRoute | undefined} */
    let best
    for (const [prefix, route] of this._prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }
}

export default DesktopCarrier
