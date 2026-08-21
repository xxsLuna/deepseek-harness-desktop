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
import './hide-console.mjs'
import { withPreload } from './node-options.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

const NAME = 'dsh-desktop'

/**
 * Carry the hidden-console setup into every Node descendant.
 *
 * `./hide-console.mjs` handles this process on import. That alone fixes nothing,
 * because on Windows the shell is started by the ACL sandbox in a SEPARATE
 * runner process — see that module for the whole trail. NODE_OPTIONS is what
 * reaches it.
 *
 * The string rule lives in `./node-options.mjs` so a unit test can reach it —
 * importing this file boots the harness. That rule is where the reasons are
 * written down: why the value is a file URL rather than a path, and why the
 * append is guarded.
 */
function carryHiddenConsoleToDescendants() {
  if (process.platform !== 'win32') return
  const preload = pathToFileURL(fileURLToPath(new URL('./hide-console.mjs', import.meta.url))).href
  process.env.NODE_OPTIONS = withPreload(process.env.NODE_OPTIONS, preload)
}

carryHiddenConsoleToDescendants()

if (!process.env.DSH_DESKTOP_SOCKET || !process.env.DSH_DESKTOP_TOKEN) {
  process.stderr.write(`${NAME}: DSH_DESKTOP_SOCKET and DSH_DESKTOP_TOKEN must be set by the launcher\n`)
  process.exit(2)
}

const require = createRequire(import.meta.url)
/** Resolve a bundle's patch file beside its exported package.json. */
const bundlePatch = (pkg) => join(dirname(require.resolve(`${pkg}/package.json`)), 'cordis.patch.yml')

const home = resolveDshHome()
const environment = loadLayeredEnv(NAME, home)

/** The profile this app owns under `$DSH_HOME/profiles`. */
const PROFILE = 'desktop'

/** The dsh installation's manifest: the first anchor bundle names resolve from. */
const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')

/** This bundle's own manifest: the second anchor, for the `@dsh-desktop/*` rows. */
const desktopAnchor = fileURLToPath(new URL('../package.json', import.meta.url))

/** The app-owned root config: an empty entry list the patch layers fill. */
const rootConfigTemplate = fileURLToPath(new URL('../config/cordis.yml', import.meta.url))

/**
 * Whether a root config is still the empty entry list it has to be.
 *
 * Compared textually rather than by parsing YAML, because the only thing that
 * legitimately lives in this file is `[]` and comments — and the failure being
 * looked for (a whole composed tree serialized into it) is unmistakable at that
 * level. Stripping `#` is safe here for the same reason: there are no strings.
 *
 * Split on `\r?\n`, not `\n`: this repo checks out CRLF on Windows, and a `\r`
 * left on the end of a line defeats a `#.*$` strip outright — JavaScript treats
 * `\r` as a line terminator, so `.` does not match it and `$` (unmatched, no
 * `m` flag) never reaches the end of the string. The comment then survives the
 * strip and every clean file reads as dirty. Found by this guard firing on `[]`.
 * @param text - the file's content.
 * @returns true when nothing but comments and an empty list is present.
 */
function isEmptyEntryList(text) {
  const meaningful = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '')
    .join('')
  return meaningful === '[]'
}

/**
 * Open the second module-resolution anchor, and read the installed plugin layers.
 *
 * Bare plugin names — ours and any the user installed — resolve from
 * `ctx.baseUrl`, which is the directory holding the root config. That directory
 * is inside the read-only app payload, so nothing under `$DSH_HOME` is on the
 * resolution walk and an installed plugin could never be reached. Moving the
 * root config into a profile directory moves `baseUrl` with it, and BOTH halves
 * of a plugin follow: the node half resolves through the Loader's internal
 * loader with `baseUrl` as its parent, the client half through
 * `createRequire(baseUrl).resolve('<name>/package.json')`.
 *
 * This is upstream's own mechanism rather than an invention — `dsh --profile`
 * boots exactly this way, and every primitive used here is exported for it.
 * @returns the root config to boot, and the loaded profile.
 */
function prepareProfile() {
  // Two heals into the same flat fallback directory. The BFS walks
  // `dependencies` AND `peerDependencies` from the anchor's manifest, and our
  // packages are copied in BESIDE the dsh tree rather than depended on by it —
  // so the dsh closure alone links the upstream roster and none of ours, and
  // every `@dsh-desktop/*` row would then fail to resolve from the profile.
  //
  // COUPLING, and a silent one: the sibling `@dsh-desktop/*` entries in this
  // package's `peerDependencies` are what the second heal walks. They look like
  // dead weight — nothing installs this package — but removing one stops its row
  // resolving once the root config lives in the profile, and the client-module
  // scan caches an unresolvable name as "not a client package" with no log line.
  // A row named in `cordis.patch.yml` must be named there too.
  healProfilesModuleFallback(installAnchor, home)
  healProfilesModuleFallback(desktopAnchor, home)

  const dir = resolveProfileDir(PROFILE, home)
  // Seeded EMPTY, and left that way. The three app-owned layers (dsh-base,
  // dsh-web-app, this bundle) stay app-owned and are loaded below; the profile's
  // bundle list holds only what the user installed. Keeping the two apart is
  // what stops an app update and a user's plugin set from fighting over one list.
  initProfile(dir, [])

  // Rewritten every boot, and the write is READ BACK. `tree.write()` in the
  // vendored Loader serializes the fully patch-COMPOSED entry list into this
  // file, and it fires from paths this app never calls: any fiber config update,
  // and any fiber that dies unexpectedly (which stamps `disabled: true` and
  // writes back). Left in place, the next boot re-applies every bundle patch on
  // top of that baked tree, `insert` pushes with no dedup, and the first
  // duplicate id throws `duplicate loader entry id` — the app simply does not
  // start. Upstream rewrites its own profile root for this exact reason.
  const rootConfig = join(dir, 'cordis.yml')
  writeFileSync(rootConfig, readFileSync(rootConfigTemplate, 'utf8'))
  if (!isEmptyEntryList(readFileSync(rootConfig, 'utf8'))) {
    throw new Error(`${NAME}: ${rootConfig} is not an empty entry list after being rewritten`)
  }

  return { rootConfig, profile: loadProfile(NAME, PROFILE, installAnchor, home) }
}

// A profile that cannot be prepared costs the plugin marketplace, not the app.
// Falling back to the app-owned root config is exactly what shipped before any
// of this existed, and booting with no installed plugins beats not booting.
/** @type {{ rootConfig: string, profile: import('@deepseek-ai/dsh-app-boot').Profile } | undefined} */
let anchored
try {
  anchored = prepareProfile()
} catch (error) {
  console.warn(`${NAME}: plugin profile unavailable, continuing with no installed plugins: ${String(error)}`)
}

// Kept separate rather than concatenated straight away, because "does upstream
// still have a row called X" is a different question from "is X anywhere in the
// composition" — and only the first one can be answered by a layer we do not
// write. See requireUpstreamRows below.
const upstreamLayers = [
  ...loadOverlayPatches(NAME, bundlePatch('@deepseek-ai/dsh-base')),
  ...loadOverlayPatches(NAME, bundlePatch('@deepseek-ai/dsh-web-app')),
]

const layers = [
  ...upstreamLayers,
  ...loadOverlayPatches(NAME, fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
  // Installed plugins: each bundle's own patch layer, in the order the profile
  // manifest lists them. After the app's own rows so a plugin can configure what
  // the app composed; before the home layer so a machine-local override still
  // outranks a plugin. The hard overlays below still come last, so nothing
  // installed here can re-enable a row this surface is built on having off.
  ...(anchored?.profile.layers.flatMap((layer) => layer.patches) ?? []),
  ...(anchored?.profile.patches ?? []),
  // The user's home-level overrides keep working exactly as they do for the CLI.
  ...(loadOptionalPatches(NAME, join(home, 'cordis.patch.yml')) ?? []),
]

// Resolve the composed rows the way the upstream launcher does, so the two
// overlays it appends can be applied on the same terms. A patch layer carries
// both top-level rows and `- insert:` groups, and the rows we need to patch
// (agent-presets, the telemetry row) are inserted ones — scanning only the top
// level silently finds nothing.
/**
 * Index patch rows by id, following `- insert:` groups as well as top-level rows.
 * @param entries - patch layer entries.
 * @returns the rows by id.
 */
function indexRows(entries) {
  const map = new Map()
  for (const entry of entries) {
    for (const row of Array.isArray(entry?.insert) ? entry.insert : [entry]) {
      if (typeof row?.id === 'string') map.set(row.id, row)
    }
  }
  return map
}

const rows = indexRows(layers)
const upstreamRows = indexRows(upstreamLayers)

/**
 * Fail now if upstream no longer has a row this composition patches by id.
 *
 * Upstream's applier **warns and skips** an id it cannot find — `warn("patch:
 * entry %C not found", id)` in `dsh-app-boot`. It does not throw, and the warning
 * does not reach the app log, so a renamed row leaves our patch a silent no-op
 * and the upstream row at its default. For the rows below that default is "on".
 *
 * The check has to run against the UPSTREAM layers. Testing `rows` would always
 * pass: our own `cordis.patch.yml` names these same ids, so they are in the
 * composition whether or not upstream still defines them. That is why the
 * `rows.has()` guards that already existed did not cover this — the ids they
 * guard (`agent-presets`, `session-telemetry-otel`) happen to come from upstream,
 * so for those it works by luck of where they are declared.
 * @param ids - upstream row ids this app depends on existing.
 * @param why - what breaks if they are gone, for the error message.
 * @returns nothing; throws when any is missing.
 */
function requireUpstreamRows(ids, why) {
  const missing = ids.filter((id) => !upstreamRows.has(id))
  if (missing.length === 0) return
  throw new Error(
    `${NAME}: upstream no longer defines the patch row(s) ${missing.join(', ')}. `
    + `${why} Check the row ids in @deepseek-ai/dsh-base and @deepseek-ai/dsh-web-app `
    + 'against packages/bundle/cordis.patch.yml — a rename here is silent otherwise.',
  )
}

const overlays = []

// The home layer is applied for CLI parity, but it must not be able to revert
// the decisions this surface is BUILT on: re-enabling `webserver`/`connection`
// would bind a real TCP port and mount a WebSocket carrier the app scheme
// cannot serve, and re-enabling `directory-picker` restores an OS chooser this
// process cannot bring to the front (or fails boot on a duplicate service).
// Everything else in the home layer still applies.
const DISABLED_UPSTREAM_ROWS = ['web-startup', 'webserver', 'web-runtime', 'connection', 'client-hmr', 'directory-picker']
requireUpstreamRows(
  DISABLED_UPSTREAM_ROWS,
  'This app requires them off: webserver/connection would bind a real TCP port and mount a WebSocket '
  + 'carrier the app scheme cannot serve, and directory-picker restores an OS chooser this process '
  + 'cannot bring to the front. Refusing to boot rather than starting with them on.',
)
for (const id of DISABLED_UPSTREAM_ROWS) {
  overlays.push({ id, disabled: true })
}

// Agent presets ship inside the dsh package and are pointed at by the
// launcher, not by any bundle — without this overlay no preset exists and
// every session.create fails with `agent-preset-not-found`.
requireUpstreamRows(
  ['agent-presets'],
  'Without this overlay no preset exists and every session.create fails with agent-preset-not-found, '
  + 'which is an app that opens and can do nothing.',
)
const presetRoot = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
overlays.push({
  id: 'agent-presets',
  config: {
    ...rows.get('agent-presets')?.config ?? {},
    roots: [{ path: `${presetRoot}/`, trust: 'system' }],
  },
})

// Same opt-out the CLI honours: any non-empty value disables the row.
if ((process.env.DSH_TELEMETRY_DISABLED ?? '') !== '') {
  // Loud on purpose, and only when the switch is actually set. This is a privacy
  // request: silently failing open because the row was renamed is worse than not
  // starting, and the old `rows.has()` guard did exactly that.
  requireUpstreamRows(
    ['session-telemetry-otel'],
    'DSH_TELEMETRY_DISABLED is set, and the row it disables is gone — so telemetry would stay ON '
    + 'while the switch appears honoured.',
  )
  overlays.push({ id: 'session-telemetry-otel', disabled: true })
}

const patches = [...layers, ...overlays]

// The profile copy when there is one: its DIRECTORY is what anchors bare-name
// resolution, which is the whole point of preparing it. Otherwise the app's own
// template, in place, exactly as before.
const rootConfig = anchored?.rootConfig ?? rootConfigTemplate

// The template is version-controlled as `[]`, but in a dev checkout it is an
// ordinary writable file, so the same Loader write-back that the profile copy is
// rewritten to defend against can have baked a composed tree into it. Booting
// from that dies on `duplicate loader entry id`, which names nothing useful — so
// say what actually happened instead.
if (anchored === undefined && !isEmptyEntryList(readFileSync(rootConfig, 'utf8'))) {
  throw new Error(
    `${NAME}: ${rootConfig} is no longer an empty entry list. The Loader's tree write-back has `
    + 'serialized a composed tree into it; restore it to `[]` (git checkout) before booting.',
  )
}

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

/**
 * The host setup every boot attempt performs.
 * @param hostCtx - the context being prepared.
 */
const prepare = (hostCtx) => {
  current = hostCtx
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
  provideCmdline(hostCtx, { args: [], exit: (code) => void shutdown(code) })
}

/** The installed bundles this boot is composing, by package name. */
const installedNames = (anchored?.profile.layers ?? []).map((layer) => layer.packageName)

/**
 * Boot, and if an installed plugin can stop that, boot again without them.
 *
 * `$DSH_HOME/profiles/desktop` survives app updates and the upstream pin moves
 * daily, so a plugin that was fine yesterday can fail to resolve a peer today —
 * and one failed entry rejects the whole tree. Without this, the app would
 * simply stop opening, with the reason only in a log nobody sees.
 *
 * The retry drops ALL installed plugins rather than bisecting: finding the
 * guilty one costs a boot each, and the app needs to be usable now. Which ones
 * were dropped is passed to the marketplace row so its tab can say so and offer
 * to remove them — that is the only place a user can act on it.
 *
 * A failure with nothing installed is rethrown untouched, and so is a failure
 * that survives the retry — in that case the FIRST error is the informative
 * one, because the second boot is a different composition.
 */
let ctx
try {
  ctx = await boot(NAME, rootConfig, patches, prepare)
} catch (error) {
  if (installedNames.length === 0) throw error
  console.warn(
    `${NAME}: the plugin tree failed to load; retrying with the ${installedNames.length} installed `
    + `plugin(s) disabled (${installedNames.join(', ')}). The cause is not proven to be one of them.`,
  )
  console.warn(String(error))
  const safeLayers = [
    ...upstreamLayers,
    ...loadOverlayPatches(NAME, fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
    ...(loadOptionalPatches(NAME, join(home, 'cordis.patch.yml')) ?? []),
  ]
  try {
    ctx = await boot(NAME, rootConfig, [
      ...safeLayers,
      ...overlays,
      // Through the patch row, not an env var or a file: config reaching a
      // plugin from the launcher's side of a decision is what a row is for.
      { id: 'desktop-market', config: { failed: installedNames } },
    ], prepare)
  } catch {
    throw error
  }
}
current = ctx
console.log(`${NAME}: ready${installedNames.length === 0 ? '' : ` (${installedNames.length} installed plugin(s))`}`)
