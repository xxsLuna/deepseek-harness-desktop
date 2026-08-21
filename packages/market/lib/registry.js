// @ts-check
/**
 * The installed-plugin registry: the rules for reading and editing a harness
 * profile manifest, which is our record of which marketplace plugins are
 * installed.
 *
 * Installed plugins live in a profile directory (`$DSH_HOME/profiles/desktop`)
 * and the authoritative record is that directory's `package.json` — upstream's
 * `dsh.profile.bundles` (the ordered layer list) plus `dependencies` (what is
 * materialised on disk). The format is upstream's `ProfileManifest`
 * (`@deepseek-ai/dsh-app-boot`), and `dsh plugin add` reconciles the same two
 * fields, so whatever we write here has to be something upstream's own
 * `reconcilePlugins` would recognise and leave alone.
 *
 * Everything below is pure. The caller reads and writes the file with
 * upstream's `readProfileManifest`/`writeProfileManifest`; this module owns
 * only the rules, so the rules can be tested without a profile on disk —
 * CLAUDE.md's convention for anything with a rule in it.
 *
 * Three upstream facts shape every function here:
 *
 * - `loadProfile` **throws** on a listed name whose package declares no
 *   `dsh.bundle`: "naming a bundle-less package as a layer is a
 *   misconfiguration, not 'no patches'". A wrong entry does not degrade the
 *   app, it stops it booting. So a name reaches `bundles` only when the caller
 *   has confirmed the package really is a bundle, and `{ bundle: false }` is
 *   how it says otherwise — the same split as the `isBundle` branch of
 *   upstream's reconcile.
 * - The list is **ordered**, and the order is patch application order: each
 *   bundle's patch layer is applied over the ones before it. An install
 *   therefore appends, and a removal keeps the survivors in their existing
 *   relative order. Reordering the list silently changes what the plugins
 *   already installed do.
 * - Upstream reconciles by **installed state, not by dependency diff**, so it
 *   reads the `dependencies` KEYS and recomputes the rest. That is why we
 *   record a name in both places: a `dependencies` entry with no layer entry is
 *   how a plain library is recorded, and it is not an inconsistency.
 *
 * Reading is total and writing is loud, deliberately. The manifest is
 * hand-editable and can be half-written, so no read may throw — the app has to
 * start from whatever is there. A write is our own code recording a package it
 * just installed, so a name or a version we will not record is a bug or a
 * hostile registry entry; failing quietly would leave a package on disk with no
 * record of it.
 */

/**
 * A profile `package.json` as JSON: upstream's `ProfileManifest` fields
 * (`name`, `dependencies`, `dsh.profile.bundles`) plus whatever else the file
 * carries. Typed as an open record rather than a closed shape on purpose — the
 * keys we know nothing about are exactly the ones we must not drop.
 * @typedef {Record<string, unknown>} ProfileManifest
 */

/**
 * How a package is being recorded.
 * @typedef {object} AddOptions
 * @property {boolean} [bundle] - whether the installed package declares
 *   `dsh.bundle` and may therefore be a patch layer. Defaults to true, because
 *   that is what the marketplace installs; pass false for a plain dependency.
 *   Only the caller can know — deciding it means resolving the package on disk,
 *   which a pure function cannot do — and getting it wrong costs the next boot.
 */

/**
 * A plausible npm package name, and nothing more adventurous than that.
 *
 * The threat is concrete: a name recorded here is later handed to Node's
 * resolution as `join(searchPath, packageName)` (upstream's
 * `packageDirFromAnchor`, reached from `resolveBundleDir`), so a name holding
 * `..` or a path separator is a traversal primitive that can point a "plugin"
 * at any directory on the machine. Requiring the first character of the scope
 * and of the body to be alphanumeric is what kills `..`, `.`, and every dotted
 * relative form; allowing `/` only as the single scope separator, and never
 * `\`, is what kills the rest.
 *
 * This is stricter than npm's own rule (npm also permits `~)('!*`, and
 * uppercase in names published long ago). That trade is deliberate: we are the
 * side doing the writing, and the set of legal-but-exotic names excluded is far
 * smaller than the traversal surface left open by matching npm exactly.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** npm's own limit on a package name. */
const NAME_MAX_LENGTH = 214

/**
 * The two names npm reserves. Both pass the pattern above and both collide with
 * a real path inside a profile directory — `node_modules` with the very
 * directory resolution walks.
 */
const RESERVED_NAMES = new Set(['node_modules', 'favicon.ico'])

/**
 * A concrete semver release — `1.4.2`, `0.1.0-rc.8`, build metadata and all.
 *
 * Not a range and not a spec: the value we write is read by the next `pnpm
 * install` in the profile directory, so `file:`/`link:`/`git+` would make the
 * manifest a pointer to code from anywhere on the machine or the network, and a
 * range would reintroduce the drift the exact pin below exists to prevent.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i

/**
 * Whether a value can be recorded as an installed package name.
 *
 * Exported so a caller about to resolve a name read out of the file — which
 * {@link parseInstalled} reports verbatim, junk included — can check it first.
 * @param {unknown} value - the candidate name.
 * @returns {boolean} true when it is a plausible npm package name.
 */
export function isPluginName(value) {
  return typeof value === 'string'
    && value.length <= NAME_MAX_LENGTH
    && PACKAGE_NAME.test(value)
    && !RESERVED_NAMES.has(value)
}

/**
 * Whether a value can be recorded as an installed version.
 * @param {unknown} value - the candidate version.
 * @returns {boolean} true when it is one concrete semver release.
 */
export function isPluginVersion(value) {
  return typeof value === 'string' && EXACT_VERSION.test(value)
}

/**
 * A value as a plain JSON record; anything else reads as an empty one.
 *
 * Every read below goes through this rather than optional chaining. The input
 * is `unknown` on purpose (the caller may hand us anything a JSON file held),
 * and property access on `unknown` is not a thing; collapsing absent, null, a
 * string and an array into one empty record makes each read one expression
 * with no shape left to test for.
 * @param {unknown} value - the candidate record.
 * @returns {Record<string, unknown>} the record, or an empty one.
 */
function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Read the installed bundle names, in layer order.
 *
 * Total by construction: a missing `dsh`, a missing `profile`, a `bundles` that
 * is not an array, entries that are not strings — each yields the shortest true
 * answer rather than throwing, because this runs on a file a user can edit and
 * the app has to start regardless.
 *
 * Entries are reported verbatim, so a name this module would refuse to WRITE
 * still shows up when a hand-edit put it in the file. That is the honest
 * answer: upstream's `loadProfile` fails on such an entry by name, and hiding
 * it here would make the marketplace claim a plugin is not installed while it
 * is exactly what is stopping the app from booting. Check
 * {@link isPluginName} before handing a parsed name to anything that resolves
 * it.
 * @param {unknown} manifest - the profile manifest, of any shape.
 * @returns {string[]} the bundle names, in patch application order.
 */
export function parseInstalled(manifest) {
  const bundles = asRecord(asRecord(asRecord(manifest).dsh).profile).bundles
  if (!Array.isArray(bundles)) return []
  /** @type {string[]} */
  const names = []
  for (const entry of bundles) {
    // A non-string cannot name a package, and a repeat is worse than useless:
    // two loader rows with one id make the loader throw `duplicate loader
    // entry id` and the app does not start. So a name is reported once.
    if (typeof entry === 'string' && entry !== '' && !names.includes(entry)) names.push(entry)
  }
  return names
}

/**
 * Record `name`@`version` as installed.
 *
 * The version is written as an **exact** specifier, with no range prefix. A
 * profile bundle is third-party code that runs in-process with the harness's
 * own privileges, so a caret would let the next `pnpm install` in the profile
 * directory swap it for code nobody chose; and the marketplace is where an
 * upgrade happens, explicitly, through this same function. An exact pin also
 * makes the manifest an accurate record of what is on disk, which is the whole
 * reason we treat it as the registry. Upstream reads only the KEYS of
 * `dependencies` when it reconciles, so the value's sole consumer is that next
 * install — and reproducing the installed tree is what we want from it.
 *
 * Idempotent on the layer list: re-installing an already-listed name updates
 * `dependencies` and leaves the list untouched, order included. A duplicate
 * entry would take the app down (see {@link parseInstalled}), and a move would
 * change the patch order of plugins the user did not touch.
 *
 * `bundles` is written back from {@link parseInstalled}, not from the raw
 * array: an entry that is not a string cannot name a layer, and a repeat cannot
 * be loaded, so carrying either forward would mean writing a file we already
 * know will not boot. That normalises the list's SHAPE only — a string entry is
 * never dropped, however implausible, because repairing a name a user typed is
 * not ours to do. Every other field, including ones this module knows nothing
 * about, is carried through untouched.
 * @param {unknown} manifest - the profile manifest to record into.
 * @param {string} name - the installed package name.
 * @param {string} version - the exact installed version.
 * @param {AddOptions} [options] - how the package is being recorded.
 * @returns {ProfileManifest} a new manifest; the input is not touched.
 * @throws when `name` or `version` is not one we will write — see the module
 *   note on total reads and loud writes.
 */
export function addInstalled(manifest, name, version, options = {}) {
  if (!isPluginName(name)) {
    throw new Error(`market: refusing to record ${JSON.stringify(name)} as installed: not an npm package name`)
  }
  if (!isPluginVersion(version)) {
    throw new Error(`market: refusing to record ${JSON.stringify(name)} at ${JSON.stringify(version)}: not one exact version`)
  }
  const record = asRecord(manifest)
  const dsh = asRecord(record.dsh)
  const profile = asRecord(dsh.profile)
  const listed = parseInstalled(record)
  const bundles = options.bundle === false
    // A plain dependency must NOT be a layer, and a name that was a layer until
    // this version dropped its `dsh.bundle` declaration has to leave the list —
    // the `!stillBundle` branch of upstream's reconcile. Leaving the stale
    // entry behind takes the app down on the next boot.
    ? listed.filter((entry) => entry !== name)
    // Appended, never inserted: the list is patch application order, so a new
    // layer goes last, over the plugins already installed, which is also where
    // upstream's reconcile appends it.
    : listed.includes(name) ? listed : [...listed, name]
  return {
    ...record,
    // Spreading first keeps an existing key in its existing position, so a
    // re-install at a new version rewrites one value and moves nothing.
    dependencies: { ...asRecord(record.dependencies), [name]: version },
    dsh: { ...dsh, profile: { ...profile, bundles } },
  }
}

/**
 * Record `name` as no longer installed: gone from `dependencies` and from the
 * layer list, with the survivors in their existing relative order.
 *
 * A name that is not installed is a no-op, and a no-op invents nothing — a
 * manifest with no `dependencies` and no `dsh` does not grow empty ones just
 * because a removal was attempted.
 *
 * No name validation here. An entry a hand-edit put in the file is exactly the
 * one a user needs to be able to take back out; validation guards what we
 * write, not what we retract.
 * @param {unknown} manifest - the profile manifest to record into.
 * @param {string} name - the package name to drop.
 * @returns {ProfileManifest} a new manifest; the input is not touched.
 */
export function removeInstalled(manifest, name) {
  const record = asRecord(manifest)
  /** @type {ProfileManifest} */
  const next = { ...record }
  const dependencies = asRecord(record.dependencies)
  if (Object.hasOwn(dependencies, name)) {
    const { [name]: _dropped, ...rest } = dependencies
    next.dependencies = rest
  }
  const listed = parseInstalled(record)
  if (listed.includes(name)) {
    const dsh = asRecord(record.dsh)
    // Rebuilt by spread so a sibling `dsh.bundle` (a profile directory that is
    // itself a bundle) and every other key survive the edit.
    next.dsh = {
      ...dsh,
      profile: { ...asRecord(dsh.profile), bundles: listed.filter((entry) => entry !== name) },
    }
  }
  return next
}
