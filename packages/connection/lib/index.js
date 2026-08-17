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
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Parameters<typeof upstreamApply>[1]} config - upstream connection config.
 */
export function apply(ctx, config) {
  upstreamApply(ctx, config)
}
