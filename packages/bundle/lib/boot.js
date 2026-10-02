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
  PROFILE_PATCH_FILENAME,
  PluginPackages,
  boot,
  bundlePatchPaths,
  createRuntimeResolution,
  initProfile,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  readProfileManifest,
  readProfilePatches,
  removeLinkProjections,
  resolveProfileDir,
  writeProfileBundles,
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
/**
 * Resolve a bundle's patch files, in the order the bundle declares them.
 *
 * This used to be one hard-coded `cordis.patch.yml` beside the package.json,
 * and that was right for exactly as long as a bundle had one patch. 0.1.7
 * ships `dsh-web-app` with FIVE — its own, plus `presets/standard`, `ptc`,
 * `minimal` and `cordis` — because an agent preset became a composed row
 * (`name: '@deepseek-ai/dsh-agent-preset'`) rather than a directory the preset
 * registry scanned. Reading only the first file left the registry with nothing
 * to list, and every `session/create` failed with
 * `agent-preset/not-found: Unknown agent preset: standard, available: []`.
 *
 * `dsh.bundle.patch` is the declaration and `bundlePatchPaths` is upstream's
 * own resolver for it, so this asks the package rather than guessing: a string
 * stays one file, a list is applied in order, and a bundle that adds a sixth
 * file is picked up without a change here.
 * @param {string} pkg - the bundle's package name.
 * @returns {string[]} absolute patch file paths, in application order.
 */
const bundlePatches = (pkg) => {
  const manifestPath = require.resolve(`${pkg}/package.json`)
  const { dsh } = require(manifestPath)
  const bundle = dsh?.bundle
  // A bundle that declares nothing still has the conventional file; upstream's
  // resolver would throw on an absent `patch`, and this path has to keep
  // working against the older pins the other channels carry.
  if (bundle?.patch === undefined) return [join(dirname(manifestPath), PROFILE_PATCH_FILENAME)]
  return bundlePatchPaths(dirname(manifestPath), bundle)
}

const home = resolveDshHome()
const environment = loadLayeredEnv(NAME, home)

/** The profile this app owns under `$DSH_HOME/profiles`. */
const PROFILE = 'desktop'

/**
 * The layers this app owns, in composition order, NAMED IN THE PROFILE.
 *
 * This list used to be empty, and the comment that said so was a good argument
 * for a design 0.1.7 made unworkable. Keeping app-owned layers out of the
 * profile's bundle list did stop an app update and an installed plugin set
 * fighting over one list — but it also meant the running composition could not
 * be rebuilt from the profile, and upstream now rebuilds it on every settings
 * write: `ConfigEditor.edit` calls `readProfilePatches`, which reads exactly
 * this list, and hands the result to `reconcileProfilePatches`, which REPLACES
 * the root Include entry's whole patch list with it.
 *
 * With the list empty that rebuild held none of these three. Every app row was
 * removed, the carrier's socket closed, and the sidecar exited 0 — no error, no
 * log line, nothing written, the save silently lost. Measured against a real
 * booted sidecar, not reasoned about.
 *
 * So the composition is the profile's now, which is what it already is for
 * `dsh --profile` (`PROFILE_TEMPLATES.web` is this same list without the
 * desktop overlay). The fight the old comment feared is answered by rewriting
 * these three to the front on every boot, below: the app owns its own names and
 * the user owns everything after them.
 */
const APP_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsh-desktop/bundle',
])

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
 * @returns the root config, the loaded profile, and the resolution to install.
 */
async function prepareProfile() {
  const dir = resolveProfileDir(PROFILE, home)
  initProfile(dir, [...APP_BUNDLES])

  // Re-asserted on every boot rather than only at creation, and that is the
  // migration: every profile this app has written so far carries an EMPTY list,
  // and an app update can change what the app-owned layers are. The three are
  // rewritten to the front in their own order, and everything after them is the
  // user's, kept in the order the marketplace installed it. Written only when it
  // differs, so a steady-state boot does not touch the file.
  const manifest = readProfileManifest(NAME, dir)
  const listed = manifest.dsh?.profile?.bundles ?? []
  const wanted = [...APP_BUNDLES, ...listed.filter((name) => !APP_BUNDLES.includes(name))]
  if (listed.length !== wanted.length || listed.some((name, index) => name !== wanted[index])) {
    writeProfileBundles(dir, manifest, wanted)
  }

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

  // Every profile this app has ever written carries the link farm the 0.1.5
  // backend built — `<profile>/.dsh-module-fallback/node_modules` plus a
  // symlink per package into it — and 0.1.7 neither writes nor reads it. Left
  // behind it is hundreds of junctions pointing into an app tree that an
  // update replaces, which is the exact shape that once emptied 271 packages
  // when a plugin removal walked through one. Upstream named the cleanup after
  // the release that made the mess ("the link backend of the dsh 0.1.5
  // releases"), so this is its migration and not our invention. It only
  // unlinks symlinks whose target is inside that directory, and a profile
  // without it is untouched — so it is a no-op from the second boot onwards.
  removeLinkProjections(dir)

  const profile = loadProfile(NAME, PROFILE, installAnchor, home)

  // `loadProfileDirectory` SKIPS a bundle it cannot resolve: it reports it and
  // carries on, which is right for an installed plugin and catastrophic for one
  // of these — the app would come up as a tree with no rows in it, and the only
  // trace would be one line on stderr. Now that these three ARE the
  // composition, their absence has to stop the boot.
  const loadedBundles = new Set(profile.layers.map((layer) => layer.packageName))
  const absent = APP_BUNDLES.filter((name) => !loadedBundles.has(name))
  if (absent.length > 0) {
    throw new Error(
      `${NAME}: the profile did not load the app-owned bundle(s) ${absent.join(', ')}. `
      + 'They compose this whole surface, so booting without them would open an empty '
      + 'window with nothing in the log. Check that the staged tree still holds them '
      + 'beside @deepseek-ai/dsh, and that each still declares dsh.bundle.patch.',
    )
  }

  // TWO anchors, and the reason is unchanged from the link-farm era: the walk
  // follows `dependencies` and `peerDependencies` from ONE manifest, and our
  // packages are copied in BESIDE the dsh tree rather than depended on by it.
  // The dsh closure alone carries the upstream roster and none of ours, so
  // every `@dsh-desktop/*` row would fail to resolve once the root config
  // lives in the profile.
  //
  // COUPLING, and a silent one: the sibling `@dsh-desktop/*` entries in this
  // package's `peerDependencies` are what the second walk follows. They look
  // like dead weight — nothing installs this package — but removing one stops
  // its row resolving, and the client-module scan caches an unresolvable name
  // as "not a client package" with no log line. A row named in
  // `cordis.patch.yml` must be named there too.
  //
  // The union is taken over `entries` alone, and the dsh-anchored resolution
  // supplies every other field: `profilesDir`, `profileDir`, `linkedRoots` and
  // `localPackageNames` describe the PROFILE, which both calls see identically,
  // so a second copy of them would be the same answer twice. `entries` is the
  // only part that differs per anchor. Ours are installation scope because they
  // ship inside the app payload, which is what the second call already labels
  // them; the spread keeps whatever upstream adds to the shape next.
  const [upstreamResolution, desktopResolution] = await Promise.all([
    createRuntimeResolution({ installAnchor, profile, home }),
    createRuntimeResolution({ installAnchor: desktopAnchor, profile, home }),
  ])
  const named = new Set(upstreamResolution.entries.map((entry) => entry.name))
  const resolution = Object.freeze({
    ...upstreamResolution,
    entries: Object.freeze([
      ...upstreamResolution.entries,
      ...desktopResolution.entries.filter((entry) => !named.has(entry.name)),
    ]),
  })

  return { rootConfig, profile, resolution }
}

// A profile that cannot be prepared costs the plugin marketplace, not the app.
// Falling back to the app-owned root config is exactly what shipped before any
// of this existed, and booting with no installed plugins beats not booting.
/**
 * @type {{
 *   rootConfig: string,
 *   profile: import('@deepseek-ai/dsh-app-boot').Profile,
 *   resolution: Awaited<ReturnType<typeof createRuntimeResolution>>,
 * } | undefined}
 */
let anchored
try {
  anchored = await prepareProfile()
} catch (error) {
  console.warn(`${NAME}: plugin profile unavailable, continuing with no installed plugins: ${String(error)}`)
}

// Kept separate rather than concatenated straight away, because "does upstream
// still have a row called X" is a different question from "is X anywhere in the
// composition" — and only the first one can be answered by a layer we do not
// write. See requireUpstreamRows below.
const upstreamLayers = [
  ...bundlePatches('@deepseek-ai/dsh-base').flatMap((file) => loadOverlayPatches(NAME, file)),
  ...bundlePatches('@deepseek-ai/dsh-web-app').flatMap((file) => loadOverlayPatches(NAME, file)),
]

/**
 * The composition when there is no profile to compose from.
 *
 * Hand-assembled, and it has to be: `readProfilePatches` reads a profile, and
 * this is the path taken when preparing one threw. Nothing reconciles here —
 * `profileContext` is withheld on this path, so upstream never mounts the
 * settings service and the rebuild that needs the two to agree never runs.
 */
const fallbackLayers = [
  ...upstreamLayers,
  ...loadOverlayPatches(NAME, fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
  // The user's home-level overrides keep working exactly as they do for the CLI.
  ...(loadOptionalPatches(NAME, join(home, 'cordis.patch.yml')) ?? []),
]

// A patch layer carries both top-level rows and `- insert:` groups, and every
// row this composition asks about is an inserted one — scanning only the top
// level silently finds nothing, which is a guard that passes by looking in the
// wrong place.
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

// Only the UPSTREAM index survives. There used to be one over the composed
// layers too, read by the `agent-presets` overlay to carry the row's own config
// across; that overlay is gone (see above) and nothing else needs the composed
// view. The distinction the comment below draws still matters: "does upstream
// still have a row called X" cannot be answered by a layer we write.
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
// the decisions this surface is BUILT on: re-enabling `webserver` would bind a
// real TCP port, and re-enabling `directory-picker` restores an OS chooser this
// process cannot bring to the front (or fails boot on a duplicate service).
// Everything else in the home layer still applies.
const DISABLED_UPSTREAM_ROWS = ['web-startup', 'webserver', 'web-runtime', 'client-hmr', 'directory-picker']
requireUpstreamRows(
  DISABLED_UPSTREAM_ROWS,
  'This app requires them off: webserver would bind a real TCP port, and directory-picker restores '
  + 'an OS chooser this process cannot bring to the front. Refusing to boot rather than starting '
  + 'with them on.',
)
for (const id of DISABLED_UPSTREAM_ROWS) {
  overlays.push({ id, disabled: true })
}

// `connection` is re-asserted the other way round, and it used to be in the
// list above. That is the fix for a break this app shipped: standing in for the
// row meant disabling it, and disabling it took upstream's client module out of
// the browser module table — `dsh-client-modules` builds that table from
// MOUNTED rows only — while `@dsh-desktop/connection` still required it. Every
// client plugin failed at boot behind one `missed the module table`.
//
// So the row is upstream's, and what this surface is built on is that it stays
// ON: `@dsh-desktop/bundle` itself waits on host `ctx.connection` for the
// browser-session URL, and the page's whole RPC plane is that plugin. A home
// overlay turning it off would strand the sidecar with entries pending on a
// service nothing provides. Only the physical carrier is ours, and that arrives
// as `globalThis.__DSH_TRANSPORT__` on the page rather than as a row at all.
//
// The trust fence rides along for the same reason it is in the patch: with the
// row upstream's, `trustedHosts` is the one connection option this surface
// depends on, and a home file widening it is not a preference.
// Off because they cannot work here and must not start working by accident;
// the patch file carries the whole reason. Named here so a rename is loud:
// upstream warns and skips an id it cannot find, which would silently restore
// a pair that reports to the vendor and breaks every settings write.
requireUpstreamRows(
  ['desktop-product-telemetry', 'product-analytics'],
  'This app requires them off: they report to an upstream collector by default and cannot '
  + 'validate without DSH_CLIENT_VERSION, which this launcher does not set. Two inactive '
  + 'entries also make every settings write fail. Refusing to boot rather than starting with '
  + 'them unaccounted for.',
)

requireUpstreamRows(
  ['connection'],
  'This app requires it ON, with the desktop carrier override installed on the page: it provides '
  + 'host ctx.connection, which the desktop runtime waits for, and the browser RPC plane. Refusing '
  + 'to boot rather than starting with a transport that cannot carry anything.',
)
// `inject` and `config` are replaced rather than merged. Upstream's row reads
// `inject: [webRuntime]` and `trustedHosts: !!js ctx.webRuntime.trustedHosts`,
// and `web-runtime` is disabled above — so carrying either through would leave
// the row pending on a service nothing provides, with a config expression that
// has no `ctx.webRuntime` to read.
overlays.push({
  id: 'connection',
  disabled: false,
  inject: [],
  config: { trustedHosts: [] },
})

// There was an `agent-presets` overlay here, pointing the row's `roots` at
// `<dsh>/config/agent-presets`, and a guard saying that without it no preset
// exists and every session.create fails. 0.1.7 renamed the row to
// `agent-preset-registry`, and neither half of that was portable:
//
// - The row no longer takes `roots`. Presets are declared rows now, not
//   directories a registry scans; its whole Config is `default`,
//   `selectedDefault` and `modeSelectionEnabled`.
// - The overlay had ALREADY been dead for some time. `<dsh>/config/
//   agent-presets` is absent from the staged tree on 0.1.5 and 0.1.7 alike,
//   and a missing root was skipped with an ENOENT that produced an empty list
//   — so the configured root contributed nothing, while `includeShippedRoot`
//   (default true) supplied the presets the app actually used. The guard's
//   claim was true when it was written and stopped being true without anything
//   failing, which is the failure mode this repo keeps pinning in tests.
//
// So it is deleted rather than renamed. `tests/contract/upstream-rows.spec.ts`
// requires `agent-preset-registry` to exist — a dependency, not a patch — and
// refuses the old id coming back; `tests/contract/sidecar.spec.ts` creates a
// session against the real sidecar, which is what fails with
// `agent-preset-not-found` when no preset exists. That is the assertion the old
// comment asserted in prose and nothing ever checked.

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

/**
 * What this boot tells upstream about the profile it booted from.
 *
 * Built HERE rather than in `prepareProfile` because `overlays` is the last
 * patch layer and is only complete by this line — and upstream reads that
 * field when it rebuilds the composition, so a half-filled one would rebuild
 * into a different app than the one running.
 *
 * `packageManager` is absent exactly as it is in upstream's own object unless
 * `--package-manager` was passed: `dsh-plugin-manager` falls back to its own
 * pnpm command, and naming one here would be this app inventing a fact.
 * @type {Record<string, unknown> | undefined}
 */
let profileContext = anchored === undefined ? undefined : {
  name: PROFILE,
  dir: anchored.profile.dir,
  patchPath: anchored.profile.patchPath,
  installAnchor,
  startedBundles: anchored.profile.layers.map((layer) => layer.packageName),
  cwd: process.cwd(),
  home,
  overlays,
  telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
}

// The same call upstream composes its own tree with, and that is the whole
// point: `ConfigEditor` reconciles by calling it again, so boot and rebuild are
// one function applied twice rather than two lists that have to be kept in
// step by hand. Precedence is unchanged from the list this replaced — the
// profile's bundle layers (ours first, then installed plugins), the profile's
// own patch file, the home layer, then this surface's hard overlays last.
const patches = profileContext === undefined
  ? [...fallbackLayers, ...overlays]
  : readProfilePatches(NAME, profileContext, anchored.profile)

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
 * `FiberState.ACTIVE`. A `const enum` in cordis’s declarations, so it has no
 * runtime value to import and the number is the only way to say it.
 */
const FIBER_ACTIVE = 2

/**
 * The readiness signal `provideCmdline` takes as its optional `ready`.
 *
 * Upstream's profile boot builds one and commits it once the tree is up, and
 * this surface replaces that boot — so it owes the same signal. Written out
 * rather than imported because upstream’s is a local function in a bundled
 * module; what is public is the OPTION, and the whole contract behind it is
 * one `onReady`.
 *
 * `@deepseek-ai/dsh-hmr` is what needs it, and not optionally: its init throws
 * `Profile HMR requires application readiness` without it. That reads like one
 * entry failing to activate, which is why it was nearly left alone — but that
 * entry is the one that re-applies the patch layers after a profile config
 * write. Without it the first settings write tears the tree down: the root
 * config this app boots from is an empty entry list by design, nothing
 * re-composes the layers over it, every fiber is disposed, and the sidecar
 * exits 0 with nothing in the log and nothing written to disk.
 */
const createAppReady = () => {
  let ready = false
  /** @type {Set<() => void>} */
  const listeners = new Set()
  return {
    service: {
      /**
       * @param {() => void} listener - called once the tree is up.
       * @returns {() => void} unsubscribe.
       */
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

const appReady = createAppReady()
/**
 * The host setup every boot attempt performs.
 * @param hostCtx - the context being prepared.
 */
const prepare = async (hostCtx) => {
  current = hostCtx
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
  // `profileContext` is a service upstream rows are GATED on rather than one
  // they read, which is why its absence was silent. `dsh-base` composes
  // `settings`, `config-editor`, `plugin-manager` and `hmr` with
  // `disabled: !!js "!ctx.get('profileContext')"`, and `dsh-web-app` gates
  // `ui-sidebar-browser` on `?.name !== 'desktop'`. Without it the app boots
  // clean, logs nothing, and simply has no settings service — which a user
  // meets on the Models page, where the provider directory asks for
  // `ctx.get('settings')` and is told it "is absent".
  //
  // Upstream provides it from its own profile boot — the entry this surface
  // replaces, since `web-startup` is disabled. Replacing an entry means
  // inheriting what it provided, and 0.1.7 is the version that added this.
  //
  // Withheld when the composition is not the one the profile describes, which
  // is the honest condition rather than a cautious one: this service is what
  // upstream reconciles THROUGH, so handing it over while running a tree that
  // cannot be rebuilt from the profile is the exact shape of the bug that cost
  // a release. The safe-mode retry below clears it for that reason.
  if (profileContext !== undefined) hostCtx.provide('profileContext', profileContext)
  // Here rather than anywhere else, because `prepare` is the one point upstream
  // documents as after the Loader is installed and before any config-tree entry
  // mounts — and the interception has to be in place before the first row is
  // imported by name. `dsh --profile` installs it from its own prepare for the
  // same reason.
  //
  // Guarded because the profile is optional: when `prepareProfile` threw we boot
  // the app-owned root config with no installed plugins, every row resolves from
  // the payload as it always did, and mounting the service with no resolution
  // would install an interception that routes nothing.
  if (anchored !== undefined) {
    await hostCtx.plugin(PluginPackages, { resolution: anchored.resolution })
  }
  provideCmdline(hostCtx, {
    args: [],
    exit: (code) => void shutdown(code),
    ready: appReady.service,
  })
}

/**
 * The INSTALLED bundles this boot is composing, by package name.
 *
 * Filtered against APP_BUNDLES, and not cosmetically: these three are in the
 * profile's layer list now, and every reader here treats a name in this list as
 * something a user chose and can be offered removal of. Unfiltered, a boot
 * failure with nothing installed would retry in safe mode instead of rethrowing
 * the informative first error, and the marketplace tab would offer to uninstall
 * the app itself.
 */
const installedNames = (anchored?.profile.layers ?? [])
  .map((layer) => layer.packageName)
  .filter((name) => !APP_BUNDLES.includes(name))

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
  // The retry composes a tree the profile does not describe: the installed
  // bundles are still listed there and are deliberately not mounted here. A
  // rebuild from the profile would therefore bring back exactly what just
  // failed, so this boot does not get the service upstream rebuilds through.
  // The cost is that Settings is unavailable in safe mode, which is the right
  // trade: safe mode exists to get the window open so the marketplace tab can
  // offer to remove the plugin that broke it.
  profileContext = undefined
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

// Upstream's own condition, and both halves of it matter: a boot that fell
// through to the safe retry still reaches here, and a tree that failed to
// come up must not tell `hmr` to start watching a composition that is not
// there.
if (ctx.fiber.state === FIBER_ACTIVE && ctx.get('loader') !== undefined) appReady.commit()
console.log(`${NAME}: ready${installedNames.length === 0 ? '' : ` (${installedNames.length} installed plugin(s))`}`)
