// Deciding whether one channel's upstream pin should move, for
// `watch-upstream.yml`.
//
// This was a ~20-line `node -e` inside the workflow, which was tolerable while
// one channel read one dist-tag. It stops being tolerable across a matrix: the
// comparator would be duplicated per row, and the rule that actually makes a
// per-channel watch correct — that a dist-tag is only ever measured against a
// pin at the SAME upstream stage — has nowhere to live in YAML and no test.
//
// That rule is not decoration. `alpha` and `rc` number independently within one
// core: upstream published `0.1.2-alpha.5` and then `0.1.2-rc.1`, and `5` there
// does not outrank `1`. Compare across stages and the answer is whichever way
// the semver happened to fall — the `!=`-versus-newer-than mistake AGENTS.md
// records once already, in the form that would walk a pin backwards daily.
//
// Nothing here may import a dependency, for the same reason as
// `release-version.mjs`: the watch job runs this straight after
// `actions/setup-node` with no install step, and `semver` is a devDependency.
// `tests/unit/upstream-bump.spec.ts` checks the ordering against the real
// `semver` on a sweep, since that copy is the authority and ours is only
// allowed to agree with it.

import { pathToFileURL } from 'node:url'
import { CHANNELS, STAGE_FOR_CHANNEL, upstreamStage } from './release-version.mjs'

/**
 * A version split into its numeric core and its dot-separated pre-release
 * identifiers, the two things semver precedence is decided on.
 * @param version - e.g. `0.1.2-alpha.5`, with an optional leading `v`.
 * @returns the three core numbers, and the pre-release identifiers as text.
 */
const parts = (version) => {
  // Split on the FIRST hyphen only: `0.1.2-rc.1` keeps `rc.1` whole, and a
  // pre-release carrying its own hyphen would too.
  const [core, pre = ''] = version.replace(/^v/, '').split(/-(.*)/s)
  return { core: core.split('.').map(Number), pre: pre === '' ? [] : pre.split('.') }
}

/**
 * Whether `candidate` sorts strictly above `pinned` by semver precedence.
 *
 * Ahead, not merely different. The pin can legitimately sit ABOVE a dist-tag —
 * upstream publishes to `next` first, and a release cut from a `next` version
 * leaves the pin ahead until `latest` catches up. Gating on inequality made the
 * watch open a PR walking that pin back down, every day, until it was closed by
 * hand.
 * @param candidate - the version a dist-tag currently names.
 * @param pinned - the version `harness.json` holds on that channel's branch.
 * @returns true when a bump would move the pin forward.
 */
export function isAhead(candidate, pinned) {
  const a = parts(candidate)
  const b = parts(pinned)
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i]
  // A release with no pre-release part outranks every pre-release of the same
  // core, in whichever direction that falls here.
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length > 0
  for (let i = 0; ; i += 1) {
    const l = a.pre[i]
    const r = b.pre[i]
    if (l === undefined) return false
    if (r === undefined) return true
    if (l === r) continue
    // Numeric identifiers compare numerically and rank BELOW text ones; text
    // compares as text. Straight from the semver spec, and the reason `rc.10`
    // beats `rc.9` rather than losing to it as a string would.
    const ln = /^\d+$/.test(l)
    const rn = /^\d+$/.test(r)
    return ln !== rn ? rn : ln ? Number(l) > Number(r) : l > r
  }
}

/**
 * Whether a channel should take the version its dist-tag currently names.
 *
 * Every refusal carries the sentence the workflow logs, because a watch that
 * silently does nothing is indistinguishable from a watch that is broken — and
 * this one has been both.
 * @param candidate - the version the channel's dist-tag names.
 * @param pinned - the version `harness.json` holds on the channel's branch.
 * @param channel - `v`, `dev` or `alpha`.
 * @returns whether to open a bump PR, and why not when the answer is no.
 * @throws when `channel` is not one this repo publishes.
 */
export function bumpVerdict(candidate, pinned, channel) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`upstream-bump: unknown channel '${channel}'; expected one of ${CHANNELS.join(', ')}`)
  }
  const wanted = STAGE_FOR_CHANNEL[channel]
  const candidateStage = upstreamStage(candidate)
  if (candidateStage === undefined) {
    // A stable upstream release lands here, and it is the one case a human
    // genuinely has to decide: the scheme has no field for a pre-release number
    // it does not have, so `release-version.mjs` refuses to derive one.
    return { bump: false, reason: `'${candidate}' is not '<x.y.z>-<stage>.<n>', so no release version can be derived from it; cut this by hand` }
  }
  if (!wanted.includes(candidateStage)) {
    // Not an error: upstream promoting its `alpha` tag onto an rc is a normal
    // thing for it to do, and the alpha channel simply has nothing to take.
    return { bump: false, reason: `'${candidate}' is a ${candidateStage} release and the ${channel} channel carries ${wanted.join(' or ')}` }
  }
  const pinnedStage = upstreamStage(pinned)
  if (pinnedStage === undefined || !wanted.includes(pinnedStage)) {
    // The branch is pinned to something its channel does not carry, so there is
    // no meaningful comparison to make — only a direction the semver happens to
    // fall in. Stop and say which branch, rather than proposing either way.
    return { bump: false, reason: `the ${channel} branch is pinned to '${pinned}', which is not ${wanted.join(' or ')}; fix the pin before the watch can compare anything` }
  }
  if (!isAhead(candidate, pinned)) {
    return { bump: false, reason: `'${candidate}' does not lead the pinned '${pinned}'` }
  }
  return { bump: true, reason: `'${candidate}' leads the pinned '${pinned}'` }
}

// The `C:\...` caveat from prune-payload.mjs applies here too: comparing raw
// strings would go silently false on Windows and turn this into a no-op import.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const [candidate, pinned, channel] = process.argv.slice(2)
  if (candidate === undefined || pinned === undefined || channel === undefined) {
    throw new Error(`usage: node scripts/upstream-bump.mjs <candidate> <pinned> <${CHANNELS.join('|')}>`)
  }
  const { bump, reason } = bumpVerdict(candidate, pinned, channel)
  // stdout is the verdict and nothing else, so the workflow can read it with
  // `$(...)`. Anything for a human goes to stderr.
  console.error(reason)
  console.log(bump ? 'yes' : 'no')
}
