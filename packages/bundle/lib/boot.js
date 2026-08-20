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

/**
 * Keep the console windows Windows would otherwise pop for every shell.
 *
 * A console child with no console to inherit gets a fresh one allocated, and it
 * is VISIBLE — so on Windows every bash/pwsh/tool invocation flashed a command
 * prompt that closed when the command finished. Two facts combine: the launcher
 * spawns this process with `windowsHide` (which is what stops the SIDECAR itself
 * from showing a window, at the cost of having no console), and upstream's
 * `dsh-subprocess-local` spawns without `windowsHide` of its own.
 *
 * Upstream is not wrong for its own use: run `dsh` from a terminal and the
 * parent has a console for children to inherit, so nothing flashes. The gap only
 * shows when a GUI process hosts the harness, which is this app.
 *
 * Why the wrap, and not a seam. `ctx.subprocess` is a service and replacing it
 * is the documented pattern, but the spawn happens inside a module-private
 * function and `OutputCollector` and friends are not exported, so "replace" means
 * reimplementing ~1300 lines. Its `internals` hook carries only spillDir,
 * platform, taskkill and a Linux process-group probe — no spawn options. Giving
 * this process a hidden console instead (AllocConsole + ShowWindow through the
 * koffi already in the tree) allocates and hides one fine, and stdout survives,
 * but the children did not inherit it. So the narrowest thing that reaches every
 * console child is the spawn call itself, defaulted here rather than patched
 * upstream.
 *
 * Scope is deliberately small: win32 only, and only when the caller said nothing
 * — an explicit `windowsHide: false` still wins. Terminals are untouched, because
 * `spawnTerminal` goes through node-pty rather than child_process. And it is
 * `windowsHide`, not a flag of our own: upstream already passes it in
 * `dsh-native-command` and `dsh-host-directory-picker-native`, so this fills a
 * gap in its own convention rather than introducing one.
 */
function hideConsoleWindowsForSpawnedShells() {
  if (process.platform !== 'win32') return
  const childProcess = createRequire(import.meta.url)('node:child_process')
  const original = childProcess.spawn
  childProcess.spawn = function spawn(program, args, options) {
    if (options === undefined || options === null) return original.call(this, program, args, { windowsHide: true })
    if (typeof options !== 'object' || Array.isArray(options)) return original.call(this, program, args, options)
    if (options.windowsHide !== undefined) return original.call(this, program, args, options)
    return original.call(this, program, args, { ...options, windowsHide: true })
  }
}

hideConsoleWindowsForSpawnedShells()

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

// The home layer is applied for CLI parity, but it must not be able to revert
// the decisions this surface is BUILT on: re-enabling `webserver`/`connection`
// would bind a real TCP port and mount a WebSocket carrier the app scheme
// cannot serve, and re-enabling `directory-picker` restores an OS chooser this
// process cannot bring to the front (or fails boot on a duplicate service).
// Everything else in the home layer still applies.
for (const id of ['web-startup', 'webserver', 'web-runtime', 'connection', 'client-hmr', 'directory-picker']) {
  overlays.push({ id, disabled: true })
}

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
