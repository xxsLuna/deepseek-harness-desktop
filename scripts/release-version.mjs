// Turning an upstream harness version into the release version this app ships,
// and recording it where the next bump gets compared against it.
//
// The automated bump used to write upstream's bare version straight into
// `package.json` — `0.1.1-rc.2`, a shape the scheme rejects — so every
// upstream-bump PR arrived red on `tests/unit/version-scheme.spec.ts` and
// needed the same two hand edits before its checks said anything about the
// harness. None of that was ever a judgement call: every field of the release
// version is either carried from the version being replaced or read out of
// upstream's, so the bump can derive it and arrive green.
//
// The one field it must NOT invent is the scheme number. That identifier *is*
// electron-updater's channel, so moving it makes the release invisible to the
// entire installed base — a migration someone announces, never a side effect of
// a nightly job (AGENTS.md, "Versioning"). It is carried across unchanged.
//
// Nothing here may import a dependency. `watch-upstream.yml` runs this straight
// after `actions/setup-node` with no install step, and `semver` is a
// devDependency — so the ordering guard below is hand-rolled over the fields
// this file has already parsed. `tests/unit/release-version.spec.ts` checks it
// against the real `semver` on a sweep, since electron-updater's copy is the
// authority and ours is only allowed to agree with it.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** `<upstream core>-desktop-v<scheme>.<upstream rc>.<this shell's build>` */
const SHIPPING = /^(\d+)\.(\d+)\.(\d+)-desktop-v(\d+)\.(\d+)\.(\d+)$/

/** Upstream's own shape. Every version pinned so far has been an `rc`. */
const UPSTREAM = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/

/** The one line `appendPublished` rewrites, matched whole so a reformat cannot half-apply. */
const PUBLISHED_LINE = /^const PUBLISHED: readonly string\[\] = \[(.*)\]$/gm

/** Every ordered field of a release version, most significant first. */
const fields = (match) => match.slice(1).map(Number)

/**
 * Whether `a` outranks `b`, both being field lists of the same length.
 *
 * Numeric field by numeric field, which agrees with semver here for one reason
 * only: `deriveReleaseVersion` carries the scheme number across unchanged, so
 * that field is always equal and never decides anything. It would not agree
 * otherwise — semver reads `desktop-v<scheme>` as one text identifier and
 * compares it character by character, which puts `desktop-v10` BELOW
 * `desktop-v9` (AGENTS.md, "Versioning"; asserted in version-scheme.spec.ts).
 * Do not reuse this to compare versions whose scheme numbers differ.
 */
const outranks = (a, b) => {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/**
 * The release version for an upstream version, given the one being replaced.
 * @param upstream - upstream's published version, e.g. `0.1.1-rc.3`.
 * @param shipping - the current root `package.json` version.
 * @returns the new release version.
 * @throws when either version is off-shape, or when the result would not
 * outrank `shipping` — a version nobody can reach is the failure this scheme
 * exists to prevent, and it is silent at every stage after this one.
 */
export function deriveReleaseVersion(upstream, shipping) {
  const from = UPSTREAM.exec(upstream)
  if (from === null) {
    // A stable upstream release carries no rc number and the scheme has no
    // field to put one in. Guessing would pick an ordering, and on the scheme
    // number a channel, on its own — so this stops and asks instead.
    throw new Error(`release-version: cannot read an rc number out of upstream '${upstream}'; the scheme needs one, so cut this release by hand`)
  }
  const current = SHIPPING.exec(shipping)
  if (current === null) {
    throw new Error(`release-version: '${shipping}' is not '<x.y.z>-desktop-v<scheme>.<rc>.<build>', so there is no scheme number to carry across`)
  }
  const [major, minor, patch, rc] = fields(from)
  const scheme = fields(current)[3]
  // The build counter belongs to one harness version, so a new upstream rc
  // starts it over. Ordering is safe either way: the rc field outranks it.
  const derived = `${major}.${minor}.${patch}-desktop-v${scheme}.${rc}.0`
  if (!outranks(fields(SHIPPING.exec(derived)), fields(current))) {
    throw new Error(`release-version: ${derived} does not outrank ${shipping}; upstream ${upstream} does not lead what this ships`)
  }
  return derived
}

/**
 * `tests/unit/version-scheme.spec.ts` with `version` recorded in PUBLISHED.
 * @param source - the spec file's current contents.
 * @param version - the release version being cut.
 * @returns the rewritten source, unchanged when it is already recorded.
 * @throws when the array is not exactly one line of the shape this expects.
 * A bump that silently failed to record its version would ship a release the
 * next one is never compared against, which is the hole the assertion in that
 * spec was added to close — so this fails loudly and names the seam instead.
 */
export function appendPublished(source, version) {
  const matches = [...source.matchAll(PUBLISHED_LINE)]
  if (matches.length !== 1) {
    throw new Error(`release-version: expected exactly one PUBLISHED array line in version-scheme.spec.ts, found ${matches.length}`)
  }
  const [line, entries] = matches[0]
  if (entries.includes(`'${version}'`)) return source
  return source.replace(line, `const PUBLISHED: readonly string[] = [${entries}, '${version}']`)
}

// The `C:\...` caveat from prune-payload.mjs applies here too: comparing raw
// strings would go silently false on Windows and turn this into a no-op import.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const [upstream] = process.argv.slice(2)
  if (upstream === undefined) {
    throw new Error('usage: node scripts/release-version.mjs <upstream-version>')
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const pinPath = join(root, 'harness.json')
  const pkgPath = join(root, 'package.json')
  const specPath = join(root, 'tests', 'unit', 'version-scheme.spec.ts')

  // Derived before anything is written, so an upstream shape the scheme cannot
  // express fails the job with the tree untouched.
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const release = deriveReleaseVersion(upstream, pkg.version)
  const spec = appendPublished(readFileSync(specPath, 'utf8'), release)

  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.harness = upstream
  writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`)
  pkg.version = release
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(specPath, spec)

  // stdout is the release version and nothing else, so the workflow can read it
  // with `$(...)`. Anything for a human goes to stderr.
  console.error(`harness.json → ${upstream}; package.json → ${release}; recorded in PUBLISHED`)
  console.log(release)
}
