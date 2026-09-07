/**
 * The decision the daily watch makes, per channel.
 *
 * It used to be a `node -e` inside `watch-upstream.yml`, where no test could
 * reach it — and it had already been wrong once in a way that cost a PR a day:
 * the gate was `pinned != latest`, so while the pin sat on a `next` release the
 * watch proposed walking it back to `latest` every morning. Channels add a
 * second way to be wrong in exactly that shape, because `alpha` and `rc` number
 * independently within one core, so `0.1.2-alpha.5` and `0.1.2-rc.1` order by
 * whichever way the semver falls rather than by which is newer work.
 *
 * These assertions pin both: the ordering against the real `semver`, and the
 * refusal to compare a dist-tag against a pin from another stage at all.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// The authority on ordering, so ours is only ever allowed to agree with it.
import { gt } from 'semver'
import { describe, expect, it } from 'vitest'
import { bumpVerdict, isAhead } from '../../scripts/upstream-bump.mjs'
import { CHANNELS, STAGE_FOR_CHANNEL } from '../../scripts/release-version.mjs'

const root = join(import.meta.dirname, '..', '..')
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

const watchWorkflow = read('.github', 'workflows', 'watch-upstream.yml')
const releaseWorkflow = read('.github', 'workflows', 'release.yml')

/** Every `include:` row of the watch matrix, in file order. */
const matrixRows = [...watchWorkflow.matchAll(
  /- channel: (\S+)\n\s+dist_tag: (\S+)\n\s+base: (\S+)/g,
)].map(([, channel, distTag, base]) => ({ channel, distTag, base }))

/** The channel-to-branch map `release.yml` refuses a misplaced tag with. */
const releaseBranches = Object.fromEntries([...releaseWorkflow.matchAll(
  /\*-desktop-(\w+)\*\)\s*BRANCH=(\S+)\s*;;/g,
)].map(([, channel, branch]) => [channel, branch]))

describe('isAhead', () => {
  // A sweep rather than a handful of cases: the failure this function guards is
  // a pin moving the wrong way, which is silent, daily, and only visible as a PR
  // nobody wants.
  const versions = [
    '0.1.1-alpha.1', '0.1.1-alpha.2', '0.1.1-alpha.10',
    '0.1.1-rc.1', '0.1.1-rc.2', '0.1.1-rc.10',
    '0.1.1',
    '0.1.2-alpha.1', '0.1.2-alpha.5', '0.1.2-rc.1',
    '0.2.0-rc.1', '1.0.0-rc.1', '1.0.0',
  ]

  it('agrees with semver on every ordered pair', () => {
    for (const candidate of versions) {
      for (const pinned of versions) {
        expect(isAhead(candidate, pinned), `${candidate} vs ${pinned}`).toBe(gt(candidate, pinned))
      }
    }
  })

  it('reads a numeric identifier as a number, not as text', () => {
    // The reason this is not a string compare: `rc.10` sorts BELOW `rc.9` as
    // text, and upstream will reach a tenth pre-release eventually.
    expect(isAhead('0.1.1-rc.10', '0.1.1-rc.9')).toBe(true)
  })

  it('is not equality — a pin ahead of the tag stays put', () => {
    // The `!=`-versus-newer-than bug, in the shape it actually took: the pin sat
    // on a `next` release while `latest` lagged, and the watch proposed a
    // downgrade every day until someone closed it by hand.
    expect(isAhead('0.1.0-rc.7', '0.1.0-rc.8')).toBe(false)
    expect(isAhead('0.1.0-rc.8', '0.1.0-rc.8')).toBe(false)
  })
})

describe('bumpVerdict', () => {
  it('takes a newer version of the stage its channel carries', () => {
    expect(bumpVerdict('0.1.2-rc.1', '0.1.1-rc.2', 'dev').bump).toBe(true)
    expect(bumpVerdict('0.1.2-alpha.5', '0.1.2-alpha.3', 'alpha').bump).toBe(true)
  })

  it('refuses a candidate from another stage, whichever way it sorts', () => {
    // Both directions, because the trap is not that the answer is wrong — it is
    // that the answer is meaningless and still looks like an answer. An alpha
    // sorts below an rc of the same core, so a naive comparison would quietly
    // say "no" here and "yes" one upstream release later.
    const onto = bumpVerdict('0.1.2-alpha.5', '0.1.1-rc.2', 'dev')
    expect(onto.bump).toBe(false)
    expect(onto.reason).toContain('the dev channel carries rc')
    const back = bumpVerdict('0.1.2-rc.1', '0.1.2-alpha.5', 'alpha')
    expect(back.bump).toBe(false)
    expect(back.reason).toContain('the alpha channel carries alpha')
  })

  it('refuses to compare against a pin its channel does not carry', () => {
    // An `alpha` branch forked from `dev` or `main` starts life pinned to an rc,
    // which is the state it is in before anyone has cut it. Comparing then would
    // pick a direction out of the semver; naming the branch asks for the pin
    // instead.
    const verdict = bumpVerdict('0.1.2-alpha.5', '0.1.1-rc.2', 'alpha')
    expect(verdict.bump).toBe(false)
    expect(verdict.reason).toContain("pinned to '0.1.1-rc.2'")
  })

  it('refuses a stable upstream release rather than inventing a field for it', () => {
    // The scheme's fifth field is upstream's pre-release number and a stable
    // release has none, so `release-version.mjs` cannot derive anything. Saying
    // so beats opening a PR that fails there.
    const verdict = bumpVerdict('0.1.2', '0.1.1-rc.2', 'dev')
    expect(verdict.bump).toBe(false)
    expect(verdict.reason).toContain('cut this by hand')
  })

  it('says why it declined, every time', () => {
    // The watch logs this sentence and nothing else. A refusal with no reason is
    // indistinguishable from a broken job, and this one has been both.
    for (const candidate of ['0.1.2', '0.1.2-alpha.5', '0.1.0-rc.1', '0.1.1-rc.2']) {
      expect(bumpVerdict(candidate, '0.1.1-rc.2', 'dev').reason).not.toBe('')
    }
  })

  it('rejects a channel this repo does not publish', () => {
    expect(() => bumpVerdict('0.1.2-rc.1', '0.1.1-rc.2', 'beta')).toThrow(/unknown channel/)
  })
})

describe('the watch matrix', () => {
  it('names channels release-version.mjs knows', () => {
    expect(matrixRows.length).toBeGreaterThan(0)
    for (const { channel } of matrixRows) expect(CHANNELS).toContain(channel)
  })

  it('leaves stable out', () => {
    // Not an oversight to be tidied up later. `main` moves when someone promotes
    // a pin they have decided to stand behind; a nightly job doing it is the one
    // thing the stable channel exists to prevent.
    expect(matrixRows.map((row) => row.channel)).not.toContain('v')
  })

  it('targets the branch release.yml cuts each channel from', () => {
    // Two files have to agree or the failure is invisible: the watch would open
    // its PR against one branch and `verify-tag-on-channel-branch` would refuse
    // the tag cut from it, at release time, with the work already done.
    for (const { channel, base } of matrixRows) {
      expect(releaseBranches[channel], `release.yml maps no branch for ${channel}`).toBe(base)
    }
  })

  it('watches every channel that carries a stage of its own', () => {
    // Stable shares `rc` with develop and is deliberately unwatched; anything
    // else added to STAGE_FOR_CHANNEL without a row here would silently never
    // see an upstream release again.
    const watched = new Set(matrixRows.map((row) => row.channel))
    for (const channel of CHANNELS) {
      if (channel === 'v') continue
      expect(watched, `no watch row for the ${channel} channel`).toContain(channel)
    }
  })

  it('follows a dist-tag whose name matches the stage its channel carries', () => {
    // Not a proof — a dist-tag's contents are only knowable online, which is why
    // `bumpVerdict` checks the stage again at run time. It does catch the row
    // wired to the wrong tag, which is the mistake that would otherwise show up
    // as an alpha branch quietly tracking rcs.
    for (const { channel, distTag } of matrixRows) {
      const stages = STAGE_FOR_CHANNEL[channel as keyof typeof STAGE_FOR_CHANNEL]
      if (distTag === 'latest') continue
      expect(stages, `the ${channel} row follows the '${distTag}' tag`).toContain(distTag)
    }
  })

  it('runs the decision through the tested script', () => {
    // The point of the extraction. A `node -e` reintroduced here would pass every
    // assertion above and be tested by none of them.
    //
    // Comment lines are dropped first, because the one explaining why the inline
    // script went away contains the very string this looks for.
    const commands = watchWorkflow.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
    expect(commands).toContain('node scripts/upstream-bump.mjs')
    expect(commands, 'the decision belongs in upstream-bump.mjs, where a test can reach it').not.toContain('node -e')
  })
})
