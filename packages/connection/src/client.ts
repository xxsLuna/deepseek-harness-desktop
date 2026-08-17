/**
 * @dsh-desktop/connection browser half — the SSE carrier for the app scheme.
 *
 * The upstream browser carrier opens WebSockets for the two event streams,
 * which cannot connect from a custom scheme. This carrier subclasses the
 * upstream AbstractApiClient and inherits its fetch/SSE defaults instead, so
 * unary calls and both event streams ride `fetch()` against the same origin.
 * The connection loop (readiness handshake, generation fence, exponential
 * backoff, sink isolation) mirrors the upstream package-internal controller;
 * the public type contracts it implements are imported from the upstream
 * package, so an upstream contract change fails this package's typecheck.
 */
import type { Context } from '@deepseek-ai/cordis'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { RpcId, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  ClientConnectionRpc,
  ConnectionConfig,
  ConnectionHandle,
  ConnectionSinks,
  ConnectionState,
  HostDescription,
  IApiClient,
} from '@deepseek-ai/dsh-client-connection/client'

/** Unary + SSE over the page origin; the base class owns every protocol invariant. */
class AppSchemeApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }
}

// ---- generic RPC caller (mirrors the upstream browser implementation) ------

const INTERNAL_BASE = 'http://dsh.internal'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

function resolveBase(): string {
  const location = globalThis.location
  return location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  if (!CHANNEL_PATTERN.test(channel) || segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment),
  )) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}

/** Browser caller for generic Connection unary RPC channels (Typert Remotes). */
function createConnectionRpc(): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(crypto.randomUUID())
      const message = { type: 'client-request', rpcId, method: endpoint, payload }
      const response = await globalThis.fetch(new URL(`${channel}/${endpoint}`, resolveBase()), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      const full = serverResponseSchema.parse(await response.json())
      if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      return full.result
    },
  }
}

// ---- connection loop (mirrors the upstream package-internal controller) ----

const CONNECTION_DEFAULTS = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  streamOpenTimeoutMs: 3_000,
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/**
 * Opens both streams and keeps iterating, reconnecting with exponential
 * backoff on loss. Sink exceptions never kill the pump; readiness is a
 * host.describe round-trip racing a stream-open timeout.
 */
class ConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  private running = false
  private lastState: ConnectionState | null = null
  private readonly config: typeof CONNECTION_DEFAULTS

  constructor(
    private readonly api: IApiClient,
    private readonly sinks: ConnectionSinks,
    config: ConnectionConfig = {},
  ) {
    this.config = { ...CONNECTION_DEFAULTS, ...config }
  }

  /** Idempotent: begin the connect/pump/reconnect loop. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  /** Stop the loop and abort the current generation's streams. */
  stop(): void {
    this.running = false
    this.current?.abort()
    this.current = null
  }

  private backoffDelay(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
    return cap / 2 + Math.random() * (cap / 2)
  }

  /** Read through a method: stop() flips the flag across awaits. */
  private isRunning(): boolean {
    return this.running
  }

  private isGenerationActive(controller: AbortController): boolean {
    return this.isRunning() && !controller.signal.aborted
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const gen = ++this.generation
      const ac = new AbortController()
      this.current = ac
      let muxOpened: () => void = () => {}
      let hostOpened: () => void = () => {}
      const streamsOpen = Promise.all([
        new Promise<void>((resolve) => { muxOpened = resolve }),
        new Promise<void>((resolve) => { hostOpened = resolve }),
      ])
      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (gen === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        void this.pumpStream(this.api.events.mux({}, ac.signal, muxOpened), this.sinks.onMuxEnvelope, settle)
        void this.pumpStream(this.api.events.host({}, ac.signal, hostOpened), this.sinks.onHostEnvelope, settle)
      })
      try {
        const timeout = new AbortController()
        const [description] = await Promise.all([
          this.api.host.describe({}),
          Promise.race([streamsOpen, sleep(this.config.streamOpenTimeoutMs, timeout.signal)]),
        ])
        timeout.abort()
        const descriptionResult = description.result
        if (!descriptionResult.ok) {
          throw new Error(`host.describe failed: ${descriptionResult.error.code}: ${descriptionResult.error.message}`)
        }
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        this.attempt = 0
        this.emitState('connected')
        if (this.isGenerationActive(ac)) {
          this.callSink(() => {
            this.sinks.onConnected?.(descriptionResult.value)
          })
        }
      } catch {
        if (!ac.signal.aborted) ac.abort()
      }
      await failed
      if (!this.isRunning()) return
      this.emitState('reconnecting')
      this.attempt += 1
      console.warn(`[desktop-runtime] connection lost, retry #${this.attempt}`)
      const idle = new AbortController()
      await sleep(this.backoffDelay(this.attempt), idle.signal)
    }
  }

  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.callSink(() => this.sinks.onStateChange?.(state))
  }

  private async pumpStream<F extends { payload: { type: string } }>(
    stream: AsyncIterable<F>,
    sink: ((envelope: F) => void) | undefined,
    onEnd: () => void,
  ): Promise<void> {
    try {
      for await (const envelope of stream) {
        if (envelope.payload.type === 'stream/error') break
        if (sink !== undefined) this.callSink(() => { sink(envelope) })
      }
    } catch { /* pump loss settles the generation below */ }
    onEnd()
  }

  /** Sink exception isolation: a business-layer throw is logged only. */
  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[desktop-runtime] connection sink threw:', error)
    }
  }
}

// ---- plugin body ------------------------------------------------------------

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * Provide ctx.connection over the app-scheme carrier. The host tree runs in
 * this application's own sidecar process, so the surface is always loopback.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const api: IApiClient = new AppSchemeApiClient()
  const rpc = createConnectionRpc()
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[desktop-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => {
          descriptionListeners.delete(listener)
        }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
