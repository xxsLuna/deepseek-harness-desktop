// @ts-check
/**
 * @dsh-desktop/connection node half — delegates to the upstream
 * `@deepseek-ai/dsh-client-connection` apply: the /api route on the carrier,
 * the browser-trust fence, the privileged-method pin, and host-side
 * `ctx.connection` (required by the API gateway) all stay upstream code.
 * Only the browser half differs: this package's `./client` bundle provides
 * the SSE carrier, replacing the upstream WebSocket one that cannot connect
 * from the app scheme.
 */
export { Config, inject } from '@deepseek-ai/dsh-client-connection'
import { apply as upstreamApply } from '@deepseek-ai/dsh-client-connection'

/** Stable Cordis plugin name. */
export const name = 'desktop-connection'

/**
 * Mount the upstream node half unchanged.
 *
 * `async`, and the promise is awaited rather than dropped — since 0.1.2
 * upstream's apply is itself async and builds `HostConnectionService` AFTER an
 * `await BrowserAuth.create(...)`. A wrapper that returns synchronously lets
 * cordis close the fiber's active window first, so the Service constructor
 * reaches `ctx.provide` on a dead context and the sidecar dies at boot with
 * `cannot create effect on inactive context` — a cordis error naming neither
 * upstream's apply nor this delegation.
 *
 * The general rule this is an instance of: a delegation wrapper has to forward
 * whatever the callee returns, because that value is how the framework learns
 * the plugin is still initialising.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Parameters<typeof upstreamApply>[1]} config - upstream connection config.
 */
export async function apply(ctx, config) {
  await upstreamApply(ctx, config)
}
