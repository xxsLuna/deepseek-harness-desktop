// @ts-check
/**
 * @dsh-desktop/connection — installs the desktop carrier override on the
 * served page, and nothing else.
 *
 * This row used to stand in for upstream's `connection` row: the node half
 * delegated to upstream's `apply` and the browser half re-exported upstream's,
 * with the upstream row disabled in `cordis.patch.yml` to make room. That is
 * gone, and the reason is written where it can be acted on —
 * `src/transport.ts` — because it is the kind of break that reads as a build
 * problem and is not one: upstream's client bundles are in module-host factory
 * form, so re-exporting one compiles to a runtime require against the browser
 * module table, and `dsh-client-modules` builds that table only from MOUNTED
 * loader rows. Disabling the row removed the module we were requiring.
 *
 * So upstream's `connection` row is composed again, with its own config, and
 * this row does the one thing upstream leaves to a shell: put
 * `globalThis.__DSH_TRANSPORT__` on the page before plugin boot. Node-only —
 * there is no `dsh.client` here any more and no `./client` export, so this
 * package is not in the browser module table at all.
 *
 * The other half of the transport is `@dsh-desktop/bundle`, which answers the
 * `/__desktop/remote-stream` bridge the injected `openStream` posts to. The
 * two are one contract; `tests/contract/sidecar.spec.ts` is what holds them
 * together.
 */
import { injectTransport, transportBlock } from './inject.js'

/** Stable Cordis plugin name. */
export const name = 'desktop-connection'

export const inject = ['webServer']

/**
 * Tap the served index with the transport install.
 *
 * The block is built once — it is the same bytes on every response — while the
 * tap itself re-runs per index response, which is what makes the install
 * survive a reload.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const block = transportBlock()
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => injectTransport(html, block)),
    'desktop-connection: transport index tap',
  )
}
