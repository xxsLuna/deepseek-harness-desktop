// @ts-check
/**
 * Sidecar entry: boot the harness tree with the desktop patch stack.
 * Run under the bundled stock Node:
 *   node .../@dsh-desktop/bundle/lib/boot.js
 * with DSH_DESKTOP_SOCKET and DSH_DESKTOP_TOKEN in the environment.
 *
 * Mirrors the upstream `dsh` bin's profile boot through the same exported
 * primitives, minus the profile directory machinery (the composition ships
 * read-only inside the app, so nothing is written into $DSH_HOME/profiles).
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

const NAME = 'dsh-desktop'

if (!process.env.DSH_DESKTOP_SOCKET || !process.env.DSH_DESKTOP_TOKEN) {
  process.stderr.write(`${NAME}: DSH_DESKTOP_SOCKET and DSH_DESKTOP_TOKEN must be set by the launcher\n`)
  process.exit(2)
}

const require = createRequire(import.meta.url)
/** Resolve a bundle's patch file beside its exported package.json. */
const bundlePatch = (pkg) => join(dirname(require.resolve(`${pkg}/package.json`)), 'cordis.patch.yml')

const home = resolveDshHome()
const environment = loadLayeredEnv(NAME, home)

const layers = [
  ...loadOverlayPatches(NAME, bundlePatch('@deepseek-ai/dsh-base')),
  ...loadOverlayPatches(NAME, bundlePatch('@deepseek-ai/dsh-web-app')),
  ...loadOverlayPatches(NAME, fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
  // The user's home-level overrides keep working exactly as they do for the CLI.
  ...(loadOptionalPatches(NAME, join(home, 'cordis.patch.yml')) ?? []),
]

// Resolve the composed rows the way the upstream launcher does, so the two
// overlays it appends can be applied on the same terms. A patch layer carries
// both top-level rows and `- insert:` groups, and the rows we need to patch
// (agent-presets, the telemetry row) are inserted ones — scanning only the top
// level silently finds nothing.
const rows = new Map()
for (const entry of layers) {
  for (const row of Array.isArray(entry?.insert) ? entry.insert : [entry]) {
    if (typeof row?.id === 'string') rows.set(row.id, row)
  }
}

const overlays = []

// Agent presets ship inside the dsh package and are pointed at by the
// launcher, not by any bundle — without this overlay no preset exists and
// every session.create fails with `agent-preset-not-found`.
if (rows.has('agent-presets')) {
  const presetRoot = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
  overlays.push({
    id: 'agent-presets',
    config: {
      ...rows.get('agent-presets')?.config ?? {},
      roots: [{ path: `${presetRoot}/`, trust: 'system' }],
    },
  })
}

// Same opt-out the CLI honours: any non-empty value disables the row.
if ((process.env.DSH_TELEMETRY_DISABLED ?? '') !== '' && rows.has('session-telemetry-otel')) {
  overlays.push({ id: 'session-telemetry-otel', disabled: true })
}

const patches = [...layers, ...overlays]

const rootConfig = fileURLToPath(new URL('../config/cordis.yml', import.meta.url))

/** @type {import('@deepseek-ai/cordis').Context | undefined} */
let current
installFailLoud(NAME, process, async () => {
  await current?.fiber.dispose()
})

const shutdown = async (code) => {
  const ctx = current
  current = undefined
  if (ctx !== undefined) await ctx.fiber.dispose()
  process.exit(code)
}
process.on('SIGTERM', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(130))

// Parent watchdog: the launcher passes its pid; if it dies without managing
// to SIGTERM this process (hard crash, SIGKILL), shut down instead of
// lingering as an orphan holding the socket.
const parentPid = Number(process.env.DSH_DESKTOP_PARENT_PID)
if (Number.isInteger(parentPid) && parentPid > 0) {
  const watchdog = setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch {
      clearInterval(watchdog)
      void shutdown(0)
    }
  }, 5_000)
  watchdog.unref()
}

const ctx = await boot(NAME, rootConfig, patches, (hostCtx) => {
  current = hostCtx
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
  provideCmdline(hostCtx, { args: [], exit: (code) => void shutdown(code) })
})
current = ctx
console.log(`${NAME}: ready`)
