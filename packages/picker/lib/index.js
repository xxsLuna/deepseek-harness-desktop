// @ts-check
/**
 * @dsh-desktop/picker — the `native` directoryPicker interaction, delegated to
 * the launcher instead of an OS chooser spawned here.
 *
 * The upstream native backend runs `osascript`/Zenity/a COM child from the
 * harness process. That assumes the harness IS the foreground GUI process
 * ("Only viable when the operator sits at the host's screen" —
 * dsh-host-directory-picker-native). In this app the harness is a background
 * sidecar with the Electron window in front, so such a dialog is created but
 * can never come forward.
 *
 * So the pick is delegated over the existing carrier socket, which the
 * launcher already authenticates with a bearer token: the launcher subscribes
 * to `/desktop/picker/requests` (SSE) and answers `/desktop/picker/answer`.
 * The dialog is then Electron's own, owned by and modal to the app window, on
 * every platform.
 */
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'

/** Route the launcher long-polls for pending picks. */
const REQUESTS_PATH = '/desktop/picker/requests'
/** Route the launcher posts each outcome to. */
const ANSWER_PATH = '/desktop/picker/answer'
/** Bound on one answer body; a pick outcome is a single path. */
const MAX_ANSWER_BYTES = 8 * 1024

/**
 * @typedef {object} PendingPick
 * @property {(path: string | null) => void} settle - resolve the awaiting pick.
 * @property {(error: Error) => void} fail - reject the awaiting pick.
 */

export default class DesktopDirectoryPicker extends DirectoryPicker {
  // Service-class plugin: the Loader reads injections from the static field.
  // Do NOT also name-export `name`/`inject` — mixing the service and
  // function plugin forms makes the Loader discard the namespace.
  static inject = ['webServer']

  /** @type {Map<string, PendingPick>} */ _pending = new Map()
  /** @type {Set<import('node:http').ServerResponse>} */ _subscribers = new Set()
  /** @type {{ kind: 'native', pick: (signal: AbortSignal) => Promise<string | null> }} */ _capability

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   */
  constructor(ctx) {
    super(ctx)
    this._capability = { kind: 'native', pick: (signal) => this._pick(signal) }

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: REQUESTS_PATH,
      handler: (req, res) => this._subscribe(res),
    }), 'desktop-picker: request stream')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: ANSWER_PATH,
      handler: (req, res) => this._answer(req, res),
    }), 'desktop-picker: answer route')

    // A pick outstanding at teardown would otherwise hang its caller.
    ctx.effect(() => () => {
      for (const pending of this._pending.values()) {
        pending.fail(new Error('desktop-picker: service disposed while a pick was open'))
      }
      this._pending.clear()
      for (const res of this._subscribers) res.end()
      this._subscribers.clear()
    }, 'desktop-picker: settle pending picks')
  }

  /** @returns {{ kind: 'native', pick: (signal: AbortSignal) => Promise<string | null> }} the stable capability. */
  capability() {
    return this._capability
  }

  /**
   * Hold the launcher's subscription open and push pending picks to it.
   * @param {import('node:http').ServerResponse} res - the SSE response.
   */
  _subscribe(res) {
    // Single subscriber: the launcher is the only legitimate one. A second
    // stream would let a hijacker race it for pick requests, so refuse it
    // rather than broadcasting. (The proxy also refuses /desktop/* from the
    // renderer; these are two independent fences.)
    if (this._subscribers.size > 0) {
      res.writeHead(409)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': subscribed\n\n')
    this._subscribers.add(res)
    res.on('close', () => this._subscribers.delete(res))
  }

  /**
   * Record the launcher's outcome for one pick.
   * @param {import('node:http').IncomingMessage} req - the answer request.
   * @param {import('node:http').ServerResponse} res - its response.
   */
  async _answer(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_ANSWER_BYTES) {
        res.writeHead(413)
        res.end()
        return
      }
      chunks.push(chunk)
    }
    /** @type {{ id?: unknown, path?: unknown, error?: unknown }} */
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const id = typeof body.id === 'string' ? body.id : undefined
    const pending = id === undefined ? undefined : this._pending.get(id)
    if (pending === undefined) {
      // The pick was already aborted or answered; a late answer is not a fault.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"accepted":false}')
      return
    }
    this._pending.delete(/** @type {string} */ (id))
    if (typeof body.error === 'string') pending.fail(new Error(`desktop-picker: launcher failed: ${body.error}`))
    else pending.settle(typeof body.path === 'string' ? body.path : null)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"accepted":true}')
  }

  /**
   * Ask the launcher to open its dialog and await the operator.
   * @param {AbortSignal} signal - caller lifetime; abort abandons the wait.
   * @returns {Promise<string | null>} chosen path, or null on cancel.
   */
  _pick(signal) {
    if (this._subscribers.size === 0) {
      return Promise.reject(new Error('desktop-picker: the launcher is not subscribed; no dialog can be shown'))
    }
    const id = `pick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this._pending.delete(id)
        reject(signal.reason instanceof Error ? signal.reason : new Error('desktop-picker: pick aborted'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this._pending.set(id, {
        settle: (path) => {
          signal.removeEventListener('abort', onAbort)
          resolve(path)
        },
        fail: (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      const frame = `data: ${JSON.stringify({ id })}\n\n`
      for (const res of this._subscribers) res.write(frame)
    })
  }
}
