// @ts-check
/**
 * @dsh-desktop/market node half — the plugin installer.
 *
 * Installing a plugin means writing two things: the package into the desktop
 * profile's `node_modules`, and its name into that profile's manifest. The
 * harness process does it rather than the launcher because the harness is the
 * only writer of `$DSH_HOME` state, and because none of it needs Electron —
 * `fetch`, `node:crypto` and `node:zlib` are the whole toolkit. The packaged app
 * ships no package manager at all (there is not even a stock Node payload any
 * more), so the download, the integrity check and the unpack are ours.
 *
 * Nothing here touches the running plugin tree. `loader.create` would, and it
 * cannot be used: every create/remove/update calls the Loader's `tree.write()`,
 * which serializes the fully patch-COMPOSED entry list into the root config —
 * after which the next boot re-applies every bundle patch on top, `insert`
 * pushes with no dedup, and the first duplicate id stops the app starting. A
 * runtime-installed bundle's patch layer also has no hot-compose path upstream.
 * So an install lands on disk and takes effect at the next boot, and the tab
 * says so. `@dsh-desktop/bundle`'s boot entry is what composes it.
 *
 * Routes live under `/market/`, NOT `/desktop/`: they are for the renderer, and
 * `/desktop/*` is the prefix the socket proxy refuses it. They sit directly on
 * `webServer` rather than behind upstream's `/api`, so the method, content-type
 * and body-size checks upstream would have applied are this module's own job —
 * the same shape `@dsh-desktop/picker` uses for its answer route.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readProfileManifest, resolveProfileDir, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { MARKETPLACE_FILE, parseCatalog } from './catalog.js'
import { DEFAULT_CATALOG, fetchCatalogText, fetchTarball, isAllowedSource } from './fetch.js'
import { classifyPlugin } from './kind.js'
import { removeTree } from './remove-tree.js'
import { fetchGit } from './git.js'
import {
  CLAUDE_PLUGINS_DIR,
  INSTALLED_FILE,
  addInstalled as recordClaude,
  installPath,
  isRecordableVersion,
  parseInstalled as parseClaude,
  removeInstalled as forgetClaude,
} from './installed.js'
import { addInstalled, isPluginName, isPluginVersion, parseInstalled, removeInstalled } from './registry.js'
import { readTarball } from './tar.js'

/** @typedef {import('./catalog.js').CatalogPlugin} Listing */
/** @typedef {import('node:http').IncomingMessage} Request */
/** @typedef {import('node:http').ServerResponse} Response */
/**
 * The context type, with the `webServer` service on it.
 *
 * `webServer` reaches `Context` by module augmentation from
 * `@deepseek-ai/dsh-host-webserver`, so the plain cordis `Context` does not
 * carry it — the augmentation only applies once that package's types are
 * loaded. The import below is type-only and exists solely to load them;
 * `@dsh-desktop/carrier` is what actually PROVIDES the service at runtime.
 */
/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {typeof import('@deepseek-ai/dsh-host-webserver')} _LoadWebServerAugmentation */

/**
 * Stable Cordis plugin name.
 *
 * Function-plugin form: `name` / `inject` / `apply` as named exports, and NO
 * default export. `unwrapExports` takes `default ?? namespace`, so adding
 * `export default apply` hands the Loader the bare function and discards these
 * — the row then dies with `cannot get property "webServer" without inject`,
 * which names the symptom and not the cause. `@dsh-desktop/picker` documents the
 * mirror image of the same trap for the service-class form.
 */
export const name = 'desktop-market'

/** Route owner. Settings is injected separately: it is an optional service. */
export const inject = ['webServer']

/** The profile the desktop app boots; `@dsh-desktop/bundle` owns the name. */
const PROFILE = 'desktop'

/** Settings section holding the trusted-source list. */
const NS = settingsNamespace('desktop-market')

/**
 * The trusted-source list.
 *
 * The default catalog is seeded through the registration's `base` layer rather
 * than hard-coded into the read path, which is what makes it removable: `base`
 * resolves below the user layer, so a user who deletes it writes that deletion
 * into their own layer and it survives the app changing the default. A
 * marketplace nobody can un-register is not registered, it is baked in.
 */
const SourcesSchema = z.object({
  sources: z.array(z.string()).default([]).description('Catalog index URLs. HTTPS only.'),
})

/**
 * This ROW's config — distinct from `SourcesSchema` above, which is the user
 * settings section. `Config` is what the boot entry passes down through the
 * patch row; the settings namespace is what the user edits.
 *
 * `failed` is only ever non-empty on a safe-mode boot: the boot entry drops
 * every installed plugin and retries when the tree would not load, then names
 * them here so the tab can say which ones were disabled and offer to remove
 * them. Nothing else can surface that — a user staring at a plugin that
 * silently stopped working has nowhere else to look.
 */
export const Config = z.object({
  failed: z.array(z.string()).default([]).description('Installed plugins a safe-mode boot disabled.'),
})

/** Largest request body any of these routes will read. All of them are tiny. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Read a JSON request body under a hard cap.
 * @param {Request} req - the incoming request.
 * @returns {Promise<any>} the parsed body, or undefined when it was absent or unreadable.
 */
async function readJson(req) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Answer with JSON.
 * @param {Response} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - the value to serialize.
 */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Mount the marketplace: one settings namespace and the renderer's routes.
 * @param {Context} ctx - plugin context.
 * @param {{ failed: string[] }} config - this row's config; carries the safe-mode casualty list.
 */
export function apply(ctx, config) {
  const home = resolveDshHome()
  const profileDir = resolveProfileDir(PROFILE, home)
  const modulesDir = join(profileDir, 'node_modules')

  /** Where Claude-format plugins live. The layout IS the contract with
   * `@dsh-desktop/claude-plugins`, which reads this tree and knows nothing
   * about this package — which is why a hand-copied plugin works too. */
  const claudeRoot = join(home, CLAUDE_PLUGINS_DIR)
  /** The record of what this package put there. */
  const claudeRecord = join(claudeRoot, INSTALLED_FILE)
  /** Dot-prefixed, because the skill provider skips dot directories at every
   * level — so a half-fetched tree is never walked mid-write. */
  const stagingRoot = join(claudeRoot, '.staging')

  /** @returns {any} the Claude install record, or an empty one. */
  function readClaudeRecord() {
    if (!existsSync(claudeRecord)) return { version: 1, plugins: [] }
    try {
      return JSON.parse(readFileSync(claudeRecord, 'utf8'))
    } catch {
      // Total, like every other read of this file: a hand-mangled record must
      // not stop the tab rendering. The rows it did hold are lost, but the
      // directories are still on disk and the provider still publishes them.
      return { version: 1, plugins: [] }
    }
  }

  /** @param {any} doc - the record to persist. */
  function writeClaudeRecord(doc) {
    mkdirSync(claudeRoot, { recursive: true })
    writeFileSync(claudeRecord, `${JSON.stringify(doc, undefined, 2)}\n`, 'utf8')
  }

  /**
   * The installed set this process actually booted with.
   *
   * Read once, at activation. Everything installed or removed afterwards is on
   * disk but not in the running tree, and comparing against this snapshot is
   * what lets the tab say "pending restart" precisely — the same approach the
   * launcher's settings store uses for its restart-required fields. Asking the
   * Loader instead would answer a different question: whether a row mounted,
   * not whether it matches what the user has since asked for.
   */
  const bootedWith = new Set(readInstalled().names)

  /**
   * @returns the profile manifest and the installed names it lists.
   * @throws when the manifest exists but cannot be read.
   *
   * Absent and unreadable are deliberately NOT the same answer. A missing
   * profile is "nothing installed" — the boot entry creates it, and these
   * routes must still answer. A manifest that exists and will not parse is a
   * different thing entirely, and treating it as empty is destructive: the
   * empty fallback goes straight back through `writeProfileManifest` on the
   * next install or remove, which deregisters every other plugin the user had.
   * Truncation from a mid-write kill is exactly how that file gets damaged, so
   * this is a state the app can reach on its own.
   */
  function readInstalled() {
    try {
      const manifest = readProfileManifest(name, profileDir)
      return { manifest, names: parseInstalled(manifest) }
    } catch (error) {
      if (existsSync(join(profileDir, 'package.json'))) throw error
      // Shaped like a real manifest, `dependencies` included: a narrower
      // fallback makes the union type hide the field every reader below uses.
      return { manifest: { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {} }, names: [] }
    }
  }

  /** @returns the extra sources the user has trusted, beyond the default. */
  function trustedSources() {
    const configured = scope?.get()?.sources
    return Array.isArray(configured) ? configured : [DEFAULT_CATALOG]
  }

  /** @type {{ get: () => { sources: string[] }, update: (patch: object) => Promise<void> } | undefined} */
  let scope
  ctx.inject(['settings'], (/** @type {any} */ settingsCtx) => {
    // `settings` is an optional service, so this is ctx.inject rather than a
    // static entry in `inject`: the registration rides the injected fiber, and
    // disposing this plugin takes the namespace with it.
    scope = settingsCtx.settings.register(NS, SourcesSchema, { base: { sources: [DEFAULT_CATALOG] } })
  })

  /**
   * The sibling that publishes Claude plugins, when it is mounted.
   *
   * Optional on purpose. The two packages share a directory layout, not an
   * import, and the two things that cross between them are a nudge that the
   * tree changed and a read of what that tree publishes. Without it an install
   * still lands correctly — it just waits for the provider's own next look
   * instead of being seen immediately, and the tab shows no skill detail.
   *
   * Typed structurally rather than by importing the sibling's typedef, so a
   * checkout that has not been staged still typechecks. That means drift is
   * not caught here; `tests/contract/market-tab.spec.ts` reads this route
   * against the real service and is what actually holds the shape.
   * @type {{
   *   refresh: () => void,
   *   inventory: () => Promise<{
   *     plugins: { id: string, name: string, version: string }[],
   *     skills: { name: string, kind: string, plugin: string, renamedFrom?: string }[],
   *     refused: { plugin: string, code: string, name?: string, message: string }[],
   *     errors: { path: string, message: string }[],
   *   }>,
   * } | undefined}
   */
  let claudePlugins
  ctx.inject(['claudePlugins'], (/** @type {any} */ pluginsCtx) => {
    claudePlugins = pluginsCtx.claudePlugins
  })

  /**
   * Whether a name resolves from the profile — i.e. whether the next boot will
   * actually find it.
   *
   * Checked immediately after an install because upstream's failure here is
   * silent: the client-module scan caches an unresolvable name as "not a client
   * package", composes no row, serves no bundle and logs nothing. Without this
   * the user would install successfully, restart, and see nothing happen.
   * @param {string} pkg - the package name just written.
   * @returns {boolean} true when Node resolves it from the profile directory.
   */
  function resolvesFromProfile(pkg) {
    try {
      // Anchored on a path INSIDE the profile so the parent walk starts there,
      // which is the same walk the Loader's baseUrl gives the composed rows.
      const anchor = join(profileDir, 'cordis.yml')
      createRequire(pathToFileURL(anchor)).resolve(`${pkg}/package.json`)
      return true
    } catch {
      return false
    }
  }

  /**
   * Write a verified archive's files into a staging directory.
   * @param {Buffer} bytes - the archive, already checked against its digest.
   * @param {string} staging - an empty directory to write into.
   * @returns {void}
   */
  function unpackInto(bytes, staging) {
    // 'auto' rather than 'package': an npm tarball roots at `package/`, but an
    // archive published for a plugin may root at its own wrapper directory or
    // at nothing at all, and only the archive knows which.
    for (const entry of readTarball(bytes, { stripPrefix: 'auto' })) {
      const target = join(staging, entry.path)
      // Belt and braces over tar.js's own path checks: never write outside.
      if (!resolvePath(target).startsWith(resolvePath(staging))) throw new Error('the package tried to escape its directory')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.bytes, { mode: entry.mode & 0o777 })
    }
  }

  /**
   * Bring one listing's bytes down into a fresh staging directory.
   *
   * Transport is chosen by the catalog's `source` discriminant, and the two
   * kinds arrive differently: an archive is bytes this process unpacks, while a
   * git source is a tree `git` writes itself. Splitting here rather than inside
   * the gate is what lets both end at the same directory — an earlier version
   * of this file was built on tarball bytes and had nowhere to put a clone.
   * @param {Listing} listing - the validated catalog row.
   * @returns {Promise<string>} the staging directory; the caller must remove it.
   */
  async function fetchToStaging(listing) {
    mkdirSync(stagingRoot, { recursive: true })
    const staging = mkdtempSync(join(stagingRoot, '.fetch-'))
    try {
      if (listing.source.source === 'archive') {
        // The standard spells an archive digest as bare hex; `fetch.js` verifies
        // SRI. Re-spelling it into SRI *before* the call means the download goes
        // through the one verification path that already exists, rather than a
        // second one here that could drift from it — and `fetchTarball` parses
        // the digest before it opens a socket, so a bad one costs no request.
        const sri = `sha256-${Buffer.from(listing.source.sha256, 'hex').toString('base64')}`
        unpackInto(Buffer.from(await fetchTarball(listing.source.url, sri)), staging)
      } else {
        await fetchGit(listing.source, staging)
      }
      return staging
    } catch (error) {
      removeTree(staging)
      throw error
    }
  }

  /**
   * Move a staged tree onto its final path, without a moment where it is absent.
   *
   * The old tree is renamed aside first and deleted afterwards. A plain
   * delete-then-rename leaves a window with nothing there, and the skill
   * provider walks the disk on every `list()` — so an upgrade would make a
   * plugin briefly vanish from the model's catalog. Two renames cost nothing
   * and remove the window.
   * @param {string} staging - the staged plugin root.
   * @param {string} dest - where it belongs.
   */
  function moveIntoPlace(staging, dest) {
    mkdirSync(dirname(dest), { recursive: true })
    const aside = `${dest}.replaced-${String(Date.now())}`
    const hadPrevious = existsSync(dest)
    if (hadPrevious) renameSync(dest, aside)
    try {
      renameSync(staging, dest)
    } catch (error) {
      if (hadPrevious) renameSync(aside, dest)
      throw error
    }
    if (hadPrevious) removeTree(aside)
  }

  /**
   * GET /market/catalog — every allowed source, merged.
   * @param {Response} res - the response.
   */
  async function catalog(res) {
    const sources = trustedSources()
    /**
     * What the tab renders. Deliberately not the catalog row spread wholesale:
     * a row's `source` is its TRANSPORT descriptor, while the tab's `source` is
     * which catalog it came from, and letting those two share a name is how a
     * URL ends up where an object was expected.
     * @type {{
     *   name: string, displayName: string, description: string, version: string,
     *   publisher: string, kind: string, source: string, marketplace: string,
     * }[]}
     */
    const entries = []
    /** @type {{source: string, message: string}[]} */
    const errors = []
    for (const source of sources) {
      if (!isAllowedSource(source, sources)) {
        errors.push({ source, message: 'not an allowed source (HTTPS only)' })
        continue
      }
      try {
        const view = parseCatalog(await readSource(source))
        for (const plugin of view.plugins) {
          const hinted = plugin.metadata?.kind
          entries.push({
            name: plugin.name,
            displayName: plugin.displayName,
            description: plugin.description ?? '',
            version: plugin.version ?? '',
            // The plugin's own author when it names one, else whoever lists it.
            publisher: plugin.author?.name ?? view.owner.name,
            // A hint from the catalog, shown so the confirmation can warn
            // correctly. `classifyPlugin()` decides for real, from the bytes.
            kind: hinted === 'claude' || hinted === 'dsh' ? hinted : 'unknown',
            source,
            marketplace: view.name,
          })
        }
        for (const dropped of view.dropped) {
          // Named, not counted: a submitter who mistyped a source type needs to
          // read which row and why, and the reasons are stable codes for that.
          errors.push({ source, message: `${String(dropped.name ?? `row ${String(dropped.index)}`)} was dropped: ${dropped.reason}` })
        }
      } catch (error) {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) })
      }
    }
    json(res, 200, { entries, errors })
  }

  /**
   * Read one catalog source's document.
   * @param {string} source - the source URL.
   * @returns {Promise<string>} the manifest text.
   */
  async function readSource(source) {
    return fetchCatalogText(source, { extraSources: trustedSources() })
  }

  /**
   * GET /market/installed — what is on disk, and whether it is live.
   *
   * Also carries the Claude-side inventory, because for that kind "installed"
   * and "published" are not the same claim: a plugin can be on disk with every
   * one of its skills withheld, and a tab that showed only the row would be
   * telling the user something that is true and useless. The inventory is
   * asked of `claudePlugins`, which may not be composed — the two packages are
   * deliberately independent — so its absence degrades to no detail rather
   * than an error.
   * @param {Response} res - the response.
   */
  async function installed(res) {
    const { manifest, names } = readInstalled()
    const dependencies = /** @type {Record<string, string>} */ (
      typeof manifest.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {}
    )
    // Two kinds, one list, and the difference the tab has to show is `active`:
    // a dsh plugin is code the Loader composed at boot, so it is live only if
    // it was there when this process started. A Claude plugin is data the
    // provider re-reads on every lookup, so it is live the moment it is on disk.
    // Enumerated from `dependencies`, NOT from the bundle list, because those
    // two are exactly what tell an enabled plugin from a disabled one: a
    // disabled plugin is still a dependency and still on disk, it has simply
    // left `dsh.profile.bundles` so nothing composes it. Listing from the
    // bundles would make disabling look identical to uninstalling, with no way
    // back from the tab.
    const composed = new Set(names)
    /** @type {{name: string, version: string, kind: string, active: boolean, enabled: boolean, managed: boolean}[]} */
    const entries = Object.keys(dependencies).map((pkg) => ({
      name: pkg,
      version: dependencies[pkg] ?? 'unknown',
      kind: 'dsh',
      active: bootedWith.has(pkg),
      enabled: composed.has(pkg),
      managed: true,
    }))
    for (const row of parseClaude(readClaudeRecord()).entries) {
      const off = row.disabled === true
      entries.push({
        name: row.name,
        version: row.version,
        kind: 'claude',
        // A disabled Claude plugin publishes nothing, so it is not active. An
        // enabled one is live the moment it is on disk — no restart involved.
        active: !off,
        enabled: !off,
        managed: true,
      })
    }
    // A dsh row differs from the running tree in either direction: enabled but
    // not composed at boot, or composed at boot and since disabled or removed.
    const restartRequired = entries.some((e) => e.kind === 'dsh' && e.enabled && !e.active)
      || [...bootedWith].some((pkg) => !composed.has(pkg))
    // What each Claude plugin actually contributes, grouped by the row it
    // belongs to. A refusal is the interesting half: it names a skill the
    // plugin ships that this app will not publish, and why.
    // `Object.create(null)`, not `{}`: a package may legitimately be called
    // `constructor` or `toString`, and on a plain object `detail[name] ??= …`
    // then finds an inherited function, skips the assignment, and the push
    // below throws — blanking the whole inventory for every other plugin too.
    /** @type {Record<string, { skills: {name: string, kind: string, renamedFrom?: string}[], refused: {name?: string, code: string, message: string}[] }>} */
    const detail = Object.create(null)
    /** @type {{path: string, message: string}[]} */
    const skillErrors = []
    if (claudePlugins !== undefined) {
      try {
        const view = await claudePlugins.inventory()
        // Keyed by plugin NAME, which is what the row carries; the inventory
        // keys by id (`<source>/<name>`) because two sources may ship the same
        // name, and this collapses that on purpose — the row is per name.
        const nameOf = new Map(view.plugins.map((plugin) => [plugin.id, plugin.name]))
        for (const plugin of view.plugins) detail[plugin.name] ??= { skills: [], refused: [] }
        for (const skill of view.skills) {
          const bucket = detail[nameOf.get(skill.plugin) ?? skill.plugin]
          bucket?.skills.push({
            name: skill.name,
            kind: skill.kind,
            ...skill.renamedFrom === undefined ? {} : { renamedFrom: skill.renamedFrom },
          })
        }
        for (const refusal of view.refused) {
          const bucket = detail[nameOf.get(refusal.plugin) ?? refusal.plugin]
          bucket?.refused.push({
            ...refusal.name === undefined ? {} : { name: refusal.name },
            code: refusal.code,
            message: refusal.message,
          })
        }
        // A Claude plugin can be under the root without this installer having
        // put it there — copied in by hand, or left behind by an older
        // install whose record was lost. Its skills are already live, so
        // omitting the row would show the user skills with no visible source.
        // It is listed and marked unmanaged instead: removing a directory this
        // app did not create is not this app's call.
        const listed = new Set(entries.filter((e) => e.kind === 'claude').map((e) => e.name))
        for (const plugin of view.plugins) {
          if (listed.has(plugin.name)) continue
          entries.push({ name: plugin.name, version: plugin.version, kind: 'claude', active: true, enabled: true, managed: false })
        }
        skillErrors.push(...view.errors)
      } catch (error) {
        skillErrors.push({ path: claudeRoot, message: error instanceof Error ? error.message : String(error) })
      }
    }
    // `failed` comes from the row's config, set only by a safe-mode boot. It is
    // NOT derived from the manifest: a plugin the boot entry disabled is still
    // listed as installed, which is exactly why it needs saying separately.
    json(res, 200, { entries, failed: config.failed, restartRequired, detail, skillErrors })
  }

  /**
   * POST /market/install — download, gate, write, and record.
   * @param {Request} req - the request.
   * @param {Response} res - the response.
   */
  async function install(req, res) {
    const body = await readJson(req)
    if (body === undefined) return json(res, 400, { ok: false, message: 'unreadable request' })
    const wanted = typeof body.name === 'string' ? body.name : undefined
    if (wanted === undefined || !isPluginName(wanted)) {
      return json(res, 400, { ok: false, message: 'not a usable package name' })
    }
    // Resolved from the catalog, never from the request: the request carries a
    // name, and the source, ref and digest come from a catalog the user chose
    // to trust. A caller cannot point this at bytes of its own choosing.
    /** @type {{ listing: Listing, sourceId: string } | undefined} */
    let found
    try {
      found = await findListing(wanted)
    } catch (error) {
      // Ambiguity across sources, which is a question for the user rather than
      // a failure to retry — 409 rather than the wrapper's generic 500.
      return json(res, 409, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    if (found === undefined) {
      return json(res, 404, { ok: false, message: `${wanted} is not listed by any trusted source` })
    }
    const { listing, sourceId } = found

    /** @type {string | undefined} */
    let staging
    try {
      staging = await fetchToStaging(listing)
      const { kind, version } = classifyPlugin(staging, listing)

      // The catalog may advertise a kind, and the tab shows it before anything
      // is downloaded — which is how the confirmation knows whether to warn
      // about code or about a prompt. So a package that turns out to be the
      // other kind was consented to under the wrong warning, whatever else it
      // is. The bytes are still the authority; this only refuses a disagreement.
      const hinted = listing.metadata?.kind
      if ((hinted === 'claude' || hinted === 'dsh') && hinted !== kind) {
        throw new Error(`the catalog listed ${listing.name} as a ${hinted} plugin, but it is a ${kind} plugin`)
      }

      // Refused BEFORE anything moves, and that ordering is the whole point.
      // Both records reject a version they cannot render — `isPluginVersion`
      // demands one exact semver release, `isRecordableVersion` a short printable
      // string — and both writes happen after an irreversible `moveIntoPlace`.
      // Throwing there left the tree on disk with nothing recording it: a Claude
      // plugin whose skills were already live and which `remove()` could no
      // longer find, or a package sitting in the profile that no route lists and
      // none will ever delete. Thrown here instead, `staging` is still the only
      // copy on disk and the `finally` below sweeps it.
      //
      // Reachable from any catalog but our own: `version` is optional in the
      // marketplace format and optional in `.claude-plugin/plugin.json`, so a
      // row that omits both leaves `classifyPlugin` returning the empty string.
      const recordable = kind === 'dsh' ? isPluginVersion(version) : isRecordableVersion(version)
      if (!recordable) {
        throw new Error(
          `${listing.name} declares ${JSON.stringify(version)}, which cannot be recorded as an installed version`,
        )
      }

      if (kind === 'claude') {
        const dest = join(home, ...installPath(sourceId, listing.name))
        moveIntoPlace(staging, dest)
        staging = undefined
        writeClaudeRecord(recordClaude(readClaudeRecord(), {
          name: listing.name, version, source: sourceId, kind: 'claude',
        }))
        // Live, with no restart: the provider walks the disk on every list(),
        // and this is what tells the registry its cached catalog is stale.
        claudePlugins?.refresh()
        return json(res, 200, { ok: true, kind, restartRequired: false })
      }

      moveIntoPlace(staging, join(modulesDir, ...listing.name.split('/')))
      staging = undefined
      // Upstream's failure here is silent — the client-module scan caches an
      // unresolvable name as "not a client package" and logs nothing — so a
      // package that will not resolve is removed rather than left looking
      // installed until a restart that then does nothing.
      if (!resolvesFromProfile(listing.name)) {
        removeTree(join(modulesDir, ...listing.name.split('/')))
        return json(res, 500, { ok: false, message: `${listing.name} was written but does not resolve; it was removed` })
      }
      const { manifest } = readInstalled()
      writeProfileManifest(profileDir, addInstalled(manifest, listing.name, version))
      return json(res, 200, { ok: true, kind, restartRequired: true })
    } catch (error) {
      return json(res, 502, { ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (staging !== undefined) removeTree(staging)
    }
  }

  /**
   * Find one plugin across every trusted catalog.
   * @param {string} wanted - the plugin name the request asked for.
   * @returns {Promise<{ listing: Listing, sourceId: string } | undefined>} the row
   * and the catalog it came from; the catalog is a path level, so it is what
   * lets two marketplaces publish one name without colliding on disk.
   */
  async function findListing(wanted) {
    const sources = trustedSources()
    /** @type {{ listing: Listing, sourceId: string }[]} */
    const found = []
    for (const source of sources) {
      if (!isAllowedSource(source, sources)) continue
      try {
        const view = parseCatalog(await readSource(source))
        const listing = view.plugins.find((one) => one.name === wanted)
        if (listing !== undefined) found.push({ listing, sourceId: view.name })
      } catch { /* a dead source is reported by /market/catalog, not here */ }
    }
    // Two catalogs may offer the same name, and the request carries only a
    // name. Taking the first would let a source added later decide, silently,
    // which code a click installs — the user picked a row in a list, and
    // nothing in that click says which of the two it was. Refusing names both.
    if (found.length > 1) {
      throw new Error(
        `${wanted} is offered by more than one marketplace (${found.map((one) => one.sourceId).join(', ')}); `
        + 'remove one of them before installing',
      )
    }
    return found[0]
  }

  /**
   * Where a Claude plugin's tree sits, published and parked.
   *
   * Disabling renames it dot-prefixed rather than recording a flag the walk
   * would have to honour. `@dsh-desktop/claude-plugins` already skips
   * dot-prefixed directories at every level — it has to, because this package
   * unpacks into one — so the layout already has a way to say "not this one",
   * and using it keeps the two packages sharing a directory contract instead of
   * gaining an import. It also means a plugin nobody installed through the
   * marketplace can be disabled the same way, by renaming it.
   * @param {string} source - the catalog id it was installed from.
   * @param {string} name - the plugin name.
   * @returns {{ live: string, parked: string }} both absolute paths.
   */
  function claudePaths(source, name) {
    const live = join(home, ...installPath(source, name))
    return { live, parked: join(dirname(live), '.' + name) }
  }

  /**
   * POST /market/remove — forget it, then delete it.
   * @param {Request} req - the request.
   * @param {Response} res - the response.
   */
  async function remove(req, res) {
    const body = await readJson(req)
    if (body === undefined) return json(res, 400, { ok: false, message: 'unreadable request' })
    const wanted = typeof body.name === 'string' ? body.name : undefined
    if (wanted === undefined) return json(res, 400, { ok: false, message: 'no package named' })

    // A Claude plugin is gone the moment the provider stops seeing it, so this
    // half needs no restart. Directory first here, then the record: the record
    // is only a label on a tree, and a row pointing at nothing is harmless
    // where a tree nothing lists would be invisible but still published.
    const claude = parseClaude(readClaudeRecord()).entries.find((one) => one.name === wanted)
    if (claude !== undefined) {
      // Both spellings: a disabled plugin is parked under a dot-prefixed name,
      // and removing it has to take that one too or the tree survives its own
      // record and becomes unreachable from the tab.
      const where = claudePaths(claude.source, claude.name)
      removeTree(where.live)
      removeTree(where.parked)
      writeClaudeRecord(forgetClaude(readClaudeRecord(), wanted))
      claudePlugins?.refresh()
      return json(res, 200, { ok: true, kind: 'claude', restartRequired: false })
    }

    // Manifest first, directory second — the opposite order, for the opposite
    // reason. If the delete fails, the next boot simply does not compose it,
    // whereas a directory removed while still listed makes `loadProfile` throw
    // and the app stop booting.
    const { manifest } = readInstalled()
    writeProfileManifest(profileDir, removeInstalled(manifest, wanted))
    if (isPluginName(wanted)) {
      removeTree(join(modulesDir, ...wanted.split('/')))
    }
    json(res, 200, { ok: true, kind: 'dsh', restartRequired: true })
  }

  /**
   * POST /market/enabled — keep a plugin installed but stop composing it.
   *
   * The difference from removing it is the whole point: nothing is downloaded
   * again to come back, and whatever the plugin wrote stays where it is. The
   * two kinds reach it by different routes because they are published by
   * different mechanisms, and both reuse a switch that already existed rather
   * than inventing a disabled-list nobody else reads.
   * @param {Request} req - the request.
   * @param {Response} res - the response.
   */
  async function setEnabled(req, res) {
    const body = await readJson(req)
    if (body === undefined) return json(res, 400, { ok: false, message: 'unreadable request' })
    const wanted = typeof body.name === 'string' ? body.name : undefined
    if (wanted === undefined) return json(res, 400, { ok: false, message: 'no package named' })
    if (typeof body.enabled !== 'boolean') {
      return json(res, 400, { ok: false, message: 'enabled must be true or false' })
    }
    const enabled = body.enabled

    const record = readClaudeRecord()
    const claude = parseClaude(record).entries.find((one) => one.name === wanted)
    if (claude !== undefined) {
      const where = claudePaths(claude.source, claude.name)
      const from = enabled ? where.parked : where.live
      const to = enabled ? where.live : where.parked
      if (existsSync(from)) {
        // The destination can only exist if a previous attempt died between the
        // two steps. Clearing it is safe because the tree being moved in is the
        // one the record points at.
        removeTree(to)
        renameSync(from, to)
      } else if (!existsSync(to)) {
        return json(res, 404, { ok: false, message: `${wanted} is recorded but its files are missing` })
      }
      // Recorded after the move, so a rename that throws leaves the flag
      // describing where the tree actually is rather than where it was meant
      // to go.
      writeClaudeRecord(recordClaude(record, { ...claude, disabled: !enabled }))
      // Live either way: the provider walks the disk on every lookup, and the
      // walk is what the rename changed.
      claudePlugins?.refresh()
      return json(res, 200, { ok: true, kind: 'claude', enabled, restartRequired: false })
    }

    const { manifest } = readInstalled()
    const dependencies = /** @type {Record<string, string>} */ (
      typeof manifest.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {}
    )
    const version = dependencies[wanted]
    if (version === undefined) {
      return json(res, 404, { ok: false, message: `${wanted} is not installed` })
    }
    if (!isPluginVersion(version)) {
      return json(res, 409, { ok: false, message: `${wanted} is recorded at ${version}, which cannot be written back` })
    }
    // `bundle: false` keeps the package a dependency and drops it from
    // `dsh.profile.bundles`, which is exactly "installed but not composed" —
    // upstream's own reconcile already understands that state, so disabling is
    // a write of a shape the loader was built to read rather than a new one.
    writeProfileManifest(profileDir, addInstalled(manifest, wanted, version, { bundle: enabled }))
    // Both directions need a restart: the tree is composed at boot, so neither
    // dropping a row nor adding one back changes what is running.
    json(res, 200, { ok: true, kind: 'dsh', enabled, restartRequired: true })
  }

  /**
   * GET/POST /market/sources — read or replace the trusted-source list.
   * @param {Request} req - the request.
   * @param {Response} res - the response.
   */
  async function sources(req, res) {
    if (scope === undefined) return json(res, 503, { ok: false, message: 'the settings service is not mounted' })
    if (req.method !== 'POST') return json(res, 200, { sources: trustedSources() })
    const body = await readJson(req)
    const next = body === undefined ? undefined : body.sources
    if (!Array.isArray(next) || next.some((s) => typeof s !== 'string')) {
      return json(res, 400, { ok: false, message: 'expected a list of URLs' })
    }
    // Validated against the SAME policy the fetch path applies, so a source
    // that could never be read cannot be stored and look accepted. Each is
    // checked as though already trusted; the policy still refuses non-HTTPS,
    // credentialed and lookalike URLs.
    const rejected = next.filter((s) => !isAllowedSource(s, next))
    if (rejected.length > 0) {
      return json(res, 422, { ok: false, message: `refused: ${rejected.join(', ')} (HTTPS only, no credentials)` })
    }
    // Deduplicated, because a repeated URL is not a second marketplace: it
    // would be fetched twice, list every row twice, collide on the tab's React
    // keys, and make every install ambiguous against itself. Order is kept —
    // it is the order the user added them in.
    const unique = next.filter((source, index) => next.indexOf(source) === index)
    await scope.update({ sources: unique })
    json(res, 200, { ok: true, sources: trustedSources() })
  }

  const routes = [
    { path: '/market/catalog', methods: ['GET'], handler: (/** @type {Request} */ _req, /** @type {Response} */ res) => catalog(res) },
    { path: '/market/installed', methods: ['GET'], handler: (/** @type {Request} */ _req, /** @type {Response} */ res) => installed(res) },
    { path: '/market/install', methods: ['POST'], handler: install },
    { path: '/market/remove', methods: ['POST'], handler: remove },
    { path: '/market/enabled', methods: ['POST'], handler: setEnabled },
    { path: '/market/sources', methods: ['GET', 'POST'], handler: sources },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: (/** @type {Request} */ req, /** @type {Response} */ res) => {
        if (!route.methods.includes(req.method ?? 'GET')) {
          res.writeHead(405, { allow: route.methods.join(', ') })
          res.end()
          return
        }
        void Promise.resolve(route.handler(req, res)).catch((error) => {
          // A handler that threw must still answer, or the renderer waits out
          // its own timeout with no idea why.
          if (!res.headersSent) json(res, 500, { ok: false, message: String(error) })
        })
      },
    }), `desktop-market: ${route.path}`)
  }
}
