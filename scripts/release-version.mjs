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

/**
 * `<upstream core>-desktop-<channel><scheme>.<upstream pre-release>.<build>`
 *
 * The fifth field used to be "upstream's rc number" and is now "upstream's
 * pre-release number", whatever stage produced it — that is what lets an alpha
 * pin be expressed at all.
 */
const SHIPPING = /^(\d+)\.(\d+)\.(\d+)-desktop-(v|dev|alpha)(\d+)\.(\d+)\.(\d+)$/

/**
 * Upstream's own shape, and the stage it names.
 *
 * `rc` was the only one for as long as the scheme had nowhere to put anything
 * else. `alpha` is admitted now because a channel exists that carries it;
 * `beta` is matched so the refusal below can name it rather than reporting an
 * unreadable version.
 */
const UPSTREAM = /^(\d+)\.(\d+)\.(\d+)-(alpha|beta|rc)\.(\d+)$/

/**
 * The stage upstream published a version at.
 *
 * Exported for `upstream-bump.mjs`, which has to establish that a dist-tag
 * belongs to a channel at all BEFORE it compares anything: an `alpha` tag
 * measured against an `rc` pin proposes a bump in whichever direction the
 * semver happens to fall, which is the `!=`-versus-newer-than mistake AGENTS.md
 * already records once.
 * @param version - upstream's published version, e.g. `0.1.2-alpha.5`.
 * @returns `alpha`, `beta` or `rc`, or undefined when the version is not a
 * shape this scheme can read — a stable upstream release, among others.
 */
export function upstreamStage(version) {
  return UPSTREAM.exec(version)?.[4]
}

/**
 * Which upstream stage each channel is allowed to carry.
 *
 * Checked rather than assumed, because nothing downstream would catch the
 * mistake: a `desktop-v` version derived from an alpha pin is a release that
 * says stable, is offered to every stable install, and carries a harness
 * upstream has not called ready.
 */
export const STAGE_FOR_CHANNEL = { v: ['rc'], dev: ['rc'], alpha: ['alpha'] }

/** The channel identifiers this script accepts, as the CLI spells them. */
export const CHANNELS = Object.keys(STAGE_FOR_CHANNEL)

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
export function deriveReleaseVersion(upstream, shipping, channel = 'v') {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`release-version: unknown channel '${channel}'; expected one of ${CHANNELS.join(', ')}`)
  }
  const from = UPSTREAM.exec(upstream)
  if (from === null) {
    // A stable upstream release carries no pre-release number and the scheme
    // has no field to put one in. Guessing would pick an ordering, and on the
    // scheme number a channel, on its own — so this stops and asks instead.
    throw new Error(`release-version: cannot read a pre-release number out of upstream '${upstream}'; the scheme needs one, so cut this release by hand`)
  }
  const stage = from[4]
  // Checked, not assumed. Nothing downstream would notice a `desktop-v` version
  // carrying an alpha harness — it would simply be offered to every stable
  // install as an ordinary update.
  if (!STAGE_FOR_CHANNEL[channel].includes(stage)) {
    throw new Error(
      `release-version: upstream '${upstream}' is a ${stage} release and the ${channel} channel carries `
      + `${STAGE_FOR_CHANNEL[channel].join(' or ')}; a release must not say one stage and ship another`,
    )
  }
  const current = SHIPPING.exec(shipping)
  if (current === null) {
    throw new Error(`release-version: '${shipping}' is not '<x.y.z>-desktop-<channel><scheme>.<pre-release>.<build>', so there is no scheme number to carry across`)
  }
  const [major, minor, patch] = fields(from)
  const preRelease = Number(from[5])
  // Fields 5 and 6 of SHIPPING (scheme, pre-release) — index 4 and 5 of the
  // numeric list, because the channel at index 3 is text and drops out.
  const scheme = Number(current[5])
  // The build counter belongs to one harness version, so a new upstream
  // pre-release starts it over. Ordering is safe either way: the pre-release
  // field outranks it.
  const derived = `${major}.${minor}.${patch}-desktop-${channel}${scheme}.${preRelease}.0`
  // Only meaningful within one channel. Across channels the comparison is not
  // just wrong but backwards — `desktop-alpha0` sorts below `desktop-v0` by
  // design — so an alpha cut is never asked to outrank what stable ships.
  if (current[4] === channel && !outranks(shippingFields(derived), shippingFields(shipping))) {
    throw new Error(`release-version: ${derived} does not outrank ${shipping}; upstream ${upstream} does not lead what this channel ships`)
  }
  return derived
}

/**
 * The ordered numeric fields of a shipping version, channel text excluded.
 * @param version - a version matching {@link SHIPPING}.
 * @returns core, scheme, pre-release and build as numbers.
 */
function shippingFields(version) {
  const match = SHIPPING.exec(version)
  /* v8 ignore next -- callers match first */
  if (match === null) throw new Error(`release-version: '${version}' is off-scheme`)
  return [match[1], match[2], match[3], match[5], match[6], match[7]].map(Number)
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
export function appendPublished(source, version, channel = 'v') {
  const name = publishedName(channel)
  const pattern = new RegExp(`^const ${name}: readonly string\\[\\] = \\[(.*)\\]$`, 'gm')
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) {
    throw new Error(`release-version: expected exactly one ${name} array line in version-scheme.spec.ts, found ${matches.length}`)
  }
  const [line, entries] = matches[0]
  if (entries.includes(`'${version}'`)) return source
  // An empty list is not a special case to be tidy about — `[${entries}, ...]`
  // with nothing in `entries` writes `[, 'x']`, which is an elision, so the
  // array silently gains an `undefined` first element. Every channel but
  // stable starts empty, so this is the FIRST append each of them takes.
  const next = entries.trim() === '' ? `'${version}'` : `${entries}, '${version}'`
  return source.replace(line, `const ${name}: readonly string[] = [${next}]`)
}

/**
 * The list a channel's releases are recorded in.
 *
 * One list per channel, because the assertion those lists carry is that the
 * shipping version outranks every entry — and that is false across channels by
 * design, since `desktop-alpha0` sorts below `desktop-v0`. Merging them would
 * turn a correct release into a failing test.
 * @param channel - `v`, `dev` or `alpha`.
 * @returns the constant name in version-scheme.spec.ts.
 */
function publishedName(channel) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`release-version: unknown channel '${channel}'; expected one of ${CHANNELS.join(', ')}`)
  }
  return channel === 'v' ? 'PUBLISHED' : `PUBLISHED_${channel.toUpperCase()}`
}

// The `C:\...` caveat from prune-payload.mjs applies here too: comparing raw
// strings would go silently false on Windows and turn this into a no-op import.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const [upstream, channelArg] = process.argv.slice(2)
  if (upstream === undefined) {
    throw new Error(`usage: node scripts/release-version.mjs <upstream-version> [${CHANNELS.join('|')}]`)
  }
  // Defaults to the stable channel so the existing bump job keeps working
  // unchanged; the other two name themselves.
  const channel = channelArg ?? 'v'
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const pinPath = join(root, 'harness.json')
  const pkgPath = join(root, 'package.json')
  const specPath = join(root, 'tests', 'unit', 'version-scheme.spec.ts')

  // Derived before anything is written, so an upstream shape the scheme cannot
  // express fails the job with the tree untouched.
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const release = deriveReleaseVersion(upstream, pkg.version, channel)
  const spec = appendPublished(readFileSync(specPath, 'utf8'), release, channel)

  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  pin.harness = upstream
  writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`)
  pkg.version = release
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(specPath, spec)

  // stdout is the release version and nothing else, so the workflow can read it
  // with `$(...)`. Anything for a human goes to stderr.
  console.error(`harness.json → ${upstream}; package.json → ${release}; recorded in ${publishedName(channel)}`)
  console.log(release)
}
