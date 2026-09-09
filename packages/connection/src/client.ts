/**
 * @dsh-desktop/connection browser half — the desktop transport, and nothing else.
 *
 * This file used to be 291 lines and a whole `ConnectionHandle` of its own: a
 * subclass of upstream's `AbstractApiClient`, a copy of upstream's browser RPC
 * caller, and a connection loop its own header admitted "mirrors the upstream
 * package-internal controller". It replaced upstream's connection plugin
 * outright, because the one thing it actually needed to change — the renderer
 * cannot open a WebSocket to the app scheme — had no seam.
 *
 * `0.1.2` added the seam, and describes it in exactly our terms: a carrier
 * override "installed on the page global before plugin boot ... a shell that
 * owns a different physical transport ... provides both halves here instead of
 * forking this plugin". So all of that goes, and what is left is two transport
 * functions plus one flag.
 *
 * The ordering rule the seam states — before plugin boot — holds by
 * construction rather than by patch order: the global is assigned at module
 * scope and `apply` is re-exported, so evaluation always precedes the plugin
 * body. That is the same delegation the node half already does, which is why
 * the row's shape does not change.
 *
 * `ownsHost` is the one that deserves a note. This file used to hardcode
 * `isLoopback: true` with the comment "the host tree runs in this
 * application's own sidecar process, so the surface is always loopback" —
 * true, and unprovable to upstream, whose check is
 * `isLoopbackHostname(location.hostname)` and a `dsh://` host is not one.
 * `ownsHost: true` is that same claim, declared where upstream reads it.
 */
import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'

/**
 * Where the sidecar bridges a logical stream. Answered by
 * `@dsh-desktop/bundle`, which hands the endpoint straight to the Gateway's
 * own `wireStream.open` — the adapter upstream documents as "shared by the
 * WebSocket mux and local Host transports".
 *
 * Not under `/api`: that prefix belongs to upstream's route owner, and a path
 * of ours living inside it is how the previous version ended up shadowing
 * upstream routes to get a look in.
 */
const STREAM_PATH = '/__desktop/remote-stream'

/** One NDJSON frame from the bridge: a value, or the failure that ended it. */
type Frame = { readonly v: unknown } | { readonly e: { readonly message?: string, readonly code?: string } }

/**
 * Open one logical stream over a streaming POST instead of the Gateway's
 * WebSocket mux.
 *
 * **NDJSON rather than SSE, and rather than the mux protocol.** The mux exists
 * to multiplex many logical streams onto one socket; here every stream is its
 * own request, so there is nothing to multiplex and reproducing that framing
 * would be copying upstream's internals to solve a problem we do not have.
 * SSE would be the other obvious choice and is worse for this: it cannot carry
 * a request body, so the payload would have to go in the URL, and its framing
 * adds `data:` prefixes and heartbeat lines to filter for no gain when both
 * ends are ours.
 *
 * An async generator, so calling this returns the iterable synchronously the
 * way the hook's signature requires while the fetch is still in flight.
 * @param endpoint - canonical Remote endpoint, passed through untouched.
 * @param payload - decoded carrier payload, passed through untouched.
 * @param signal - logical-stream cancellation; aborts the request, which is
 * what tells the sidecar to abort the Gateway stream behind it.
 * @yields each validated stream value the Gateway produced.
 */
async function* openRemoteStream(
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  const response = await globalThis.fetch(STREAM_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`connection: stream ${endpoint} failed to open: HTTP ${response.status}`)
  }
  const body = response.body
  if (body === null) throw new Error(`connection: stream ${endpoint} opened with no body`)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      // `stream: true` on every decode, including the flush below: a value can
      // split a multi-byte character across two chunks, and decoding each
      // chunk independently turns that into a replacement character inside
      // otherwise valid JSON.
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line !== '') yield unwrap(line, endpoint)
        newline = pending.indexOf('\n')
      }
      if (done) break
    }
    // A frame with no trailing newline is a truncated write, not a value.
    if (pending.trim() !== '') {
      throw new Error(`connection: stream ${endpoint} ended mid-frame`)
    }
  } finally {
    // Releases the lock whether the consumer broke out of the loop, the signal
    // aborted, or a frame threw. Without it an early `break` leaves the body
    // locked and the request open.
    reader.releaseLock()
  }
}

/**
 * Read one frame, turning a failure frame back into a thrown error.
 *
 * The bridge sends whatever `wireStream.failure(error)` produced, so the code
 * and message reaching the consumer are the Gateway's own rather than a
 * transport-shaped paraphrase of them.
 * @param line - one NDJSON line, known non-empty.
 * @param endpoint - for the message when the line is not a frame at all.
 * @returns the value the frame carried.
 */
function unwrap(line: string, endpoint: string): unknown {
  let frame: Frame
  try {
    frame = JSON.parse(line) as Frame
  } catch {
    throw new Error(`connection: stream ${endpoint} sent a frame that is not JSON`)
  }
  if ('e' in frame) {
    const failure = new Error(frame.e.message ?? `stream ${endpoint} failed`)
    if (frame.e.code !== undefined) Object.assign(failure, { code: frame.e.code })
    throw failure
  }
  return frame.v
}

declare global {
  // eslint-disable-next-line no-var
  var __DSH_TRANSPORT__: ClientTransportHooks | undefined
}

/**
 * Installed at module scope, which is what satisfies "before plugin boot".
 *
 * `fetch` is the page's own — unary RPC already rides `fetch()` against this
 * origin and always did; the hook is mandatory, so it is passed through rather
 * than left for upstream to default. `openStream` is the half that exists at
 * all: without it upstream reaches for the Gateway WebSocket, which is the one
 * thing the app scheme cannot do.
 */
globalThis.__DSH_TRANSPORT__ = {
  fetch: (input, init) => globalThis.fetch(input, init),
  openStream: openRemoteStream,
  ownsHost: true,
}

// Upstream's plugin, unchanged, reading the transport above. Everything this
// file used to reimplement — the RPC caller, the generation source, the
// connect/reconnect loop, `ctx.connection` itself — is upstream's again.
export { inject, apply } from '@deepseek-ai/dsh-client-connection/client'
