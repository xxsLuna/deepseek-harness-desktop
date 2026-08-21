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
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readProfileManifest, resolveProfileDir, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CATALOG, fetchCatalog, fetchTarball, isAllowedSource } from './fetch.js'
import { addInstalled, isPluginName, isPluginVersion, parseInstalled, removeInstalled } from './registry.js'
import { readTarball, tarballFiles } from './tar.js'

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

  /** @returns the profile manifest and the installed names it lists. */
  function readInstalled() {
    try {
      const manifest = readProfileManifest(name, profileDir)
      return { manifest, names: parseInstalled(manifest) }
    } catch {
      // No profile yet (or an unreadable one) is "nothing installed", not an
      // error: the boot entry creates it, and this route must still answer.
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
   * Unpack one verified tarball into the profile, or reject it.
   *
   * The gate is the security boundary, and every clause closes a real hole: a
   * package with no `dsh.bundle` makes `loadProfile` throw and the app stop
   * booting; runtime `dependencies` cannot be satisfied without a package
   * manager, so a package that declares one would resolve to nothing at load;
   * and a name or version that does not match what the catalog promised means
   * the bytes are not the thing that was approved.
   * @param {Buffer} bytes - the verified tarball.
   * @param {{ name: string, version: string }} expected - name and version the catalog promised.
   * @returns {object} the accepted manifest.
   * @throws when the package fails the gate.
   */
  function unpack(bytes, expected) {
    const files = tarballFiles(bytes)
    const manifestBytes = files.get('package.json')
    if (manifestBytes === undefined) throw new Error('the package contains no package.json')
    /** @type {{ name?: unknown, version?: unknown, dependencies?: unknown, dsh?: { bundle?: { patch?: unknown } } }} */
    const manifest = JSON.parse(manifestBytes.toString('utf8'))

    if (manifest.name !== expected.name) {
      throw new Error(`the package is ${String(manifest.name)}, not ${expected.name} as the catalog said`)
    }
    if (manifest.version !== expected.version) {
      throw new Error(`the package is version ${String(manifest.version)}, not ${expected.version}`)
    }
    const declared = manifest.dsh?.bundle?.patch
    if (typeof declared !== 'string') {
      throw new Error('the package declares no dsh.bundle.patch, so it is not a harness plugin')
    }
    // Resolved the same way `loadProfile` will: relative to the package root.
    const patchKey = declared.replace(/^\.\//, '')
    if (!files.has(patchKey)) throw new Error(`its declared patch file ${declared} is not in the package`)
    const dependencies = manifest.dependencies
    if (typeof dependencies === 'object' && dependencies !== null && Object.keys(dependencies).length > 0) {
      throw new Error('the package declares runtime dependencies, which this app cannot install')
    }

    // Extract beside the destination and rename into place: a rename inside one
    // directory is atomic enough that a crash mid-write cannot leave a
    // half-written package that the next boot would try to load.
    mkdirSync(modulesDir, { recursive: true })
    const staging = mkdtempSync(join(modulesDir, '.market-'))
    try {
      for (const entry of readTarball(bytes)) {
        const target = join(staging, entry.path)
        // Belt and braces over tar.js's own path checks: never write outside.
        if (!resolvePath(target).startsWith(resolvePath(staging))) throw new Error('the package tried to escape its directory')
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, entry.bytes, { mode: entry.mode & 0o777 })
      }
      const dest = join(modulesDir, ...expected.name.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      rmSync(dest, { recursive: true, force: true })
      renameSync(staging, dest)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
    return manifest
  }

  /**
   * GET /market/catalog — every allowed source, merged.
   * @param {Response} res - the response.
   */
  async function catalog(res) {
    const sources = trustedSources()
    /** @type {{id: string, name: string, version: string, publisher: string, description: string, source: string}[]} */
    const entries = []
    /** @type {{source: string, message: string}[]} */
    const errors = []
    for (const source of sources) {
      if (!isAllowedSource(source, sources)) {
        errors.push({ source, message: 'not an allowed source (HTTPS only)' })
        continue
      }
      try {
        const view = await fetchCatalog(source, { extraSources: sources })
        for (const plugin of view.plugins) entries.push({ ...plugin, source })
        for (const dropped of view.dropped ?? []) {
          errors.push({ source, message: `a listing was dropped: ${String(dropped.reason ?? 'malformed')}` })
        }
      } catch (error) {
        errors.push({ source, message: error instanceof Error ? error.message : String(error) })
      }
    }
    json(res, 200, { entries, errors })
  }

  /**
   * GET /market/installed — what is on disk, and whether it is live.
   * @param {Response} res - the response.
   */
  function installed(res) {
    const { manifest, names } = readInstalled()
    const dependencies = /** @type {Record<string, string>} */ (
      typeof manifest.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {}
    )
    const entries = names.map((pkg) => ({
      name: pkg,
      version: dependencies[pkg] ?? 'unknown',
      active: bootedWith.has(pkg),
    }))
    const onDisk = new Set(names)
    const restartRequired = entries.some((e) => !e.active)
      || [...bootedWith].some((pkg) => !onDisk.has(pkg))
    // `failed` comes from the row's config, set only by a safe-mode boot. It is
    // NOT derived from the manifest: a plugin the boot entry disabled is still
    // listed as installed, which is exactly why it needs saying separately.
    json(res, 200, { entries, failed: config.failed, restartRequired })
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
    const sources = trustedSources()
    // Resolved from the catalog, never from the request: the request names an
    // id, and the tarball URL, version and digest come from a source the user
    // trusted. A caller cannot point this at bytes of its own choosing.
    /** @type {{ name: string, version: string, tarball: string, integrity: string } | undefined} */
    let listing
    for (const source of sources) {
      if (!isAllowedSource(source, sources)) continue
      try {
        const view = await fetchCatalog(source, { extraSources: sources })
        const found = view.plugins.find((p) => p.name === wanted)
        if (found !== undefined) {
          listing = found
          break
        }
      } catch { /* a dead source is reported by /market/catalog, not here */ }
    }
    if (listing === undefined) return json(res, 404, { ok: false, message: `${wanted} is not listed by any trusted source` })
    if (!isPluginVersion(listing.version)) {
      return json(res, 422, { ok: false, message: `the catalog gave ${listing.name} an unusable version` })
    }

    try {
      const bytes = await fetchTarball(listing.tarball, listing.integrity)
      unpack(Buffer.from(bytes), { name: listing.name, version: listing.version })
    } catch (error) {
      return json(res, 502, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }

    if (!resolvesFromProfile(listing.name)) {
      rmSync(join(modulesDir, ...listing.name.split('/')), { recursive: true, force: true })
      return json(res, 500, { ok: false, message: `${listing.name} was written but does not resolve; it was removed` })
    }

    const { manifest } = readInstalled()
    writeProfileManifest(profileDir, addInstalled(manifest, listing.name, listing.version))
    json(res, 200, { ok: true, restartRequired: true })
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

    // Manifest first, directory second. If the delete fails, the next boot
    // simply does not compose it — whereas a directory removed while still
    // listed makes `loadProfile` throw and the app stop booting.
    const { manifest } = readInstalled()
    writeProfileManifest(profileDir, removeInstalled(manifest, wanted))
    if (isPluginName(wanted)) {
      rmSync(join(modulesDir, ...wanted.split('/')), { recursive: true, force: true })
    }
    json(res, 200, { ok: true, restartRequired: true })
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
    await scope.update({ sources: next })
    json(res, 200, { ok: true, sources: trustedSources() })
  }

  const routes = [
    { path: '/market/catalog', methods: ['GET'], handler: (/** @type {Request} */ _req, /** @type {Response} */ res) => catalog(res) },
    { path: '/market/installed', methods: ['GET'], handler: (/** @type {Request} */ _req, /** @type {Response} */ res) => { installed(res) } },
    { path: '/market/install', methods: ['POST'], handler: install },
    { path: '/market/remove', methods: ['POST'], handler: remove },
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
