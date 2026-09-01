# Splitting the update channels

**Status: proposed, not implemented.** Nothing in this document describes how the
app behaves today. It exists so the implementation can be argued about before any
of it is written, because the pieces span the launcher, the settings UI and the
release workflows, and because a mistake in this area is invisible until someone
in the field stops receiving updates.

Today there is exactly one channel, `desktop-v0`, and every install is on it.

**Revised from two channels to three.** The first version of this document
proposed stable and develop, split by how well tested *this shell* was. The
channels asked for since are split by **which upstream harness they carry** —
alpha, rc, and a chosen-stable rc. That is a larger change than adding one more
identifier, because the pin stops being a single repo-wide value; see "What the
channels actually differ by", which is the section to read before the rest.

---

## The channel already exists; it is the first pre-release identifier

This is not a mechanism that has to be built. electron-updater derives the
channel from the running version, and `GitHubProvider` only offers a tag whose
channel matches:

```
0.1.1-desktop-v0.2.0
      └────────┘ the channel
```

Verified in `electron-updater@6.8.9`, not inferred:

- `AppUpdater.js:218` — `allowPrerelease = hasPrereleaseComponents(currentVersion)`.
  Every version this app ships has a pre-release part, so **`allowPrerelease` is
  already permanently `true`**. It is not a lever that is still available; the
  custom channel is the only remaining one.
- `GitHubProvider.js:52` — `currentChannel = updater.channel || prerelease(currentVersion)[0]`.
  The explicit setter wins; otherwise the running version decides.
- `GitHubProvider.js:60-88` — the walk over `releases.atom`. For a custom channel
  (anything that is not `alpha` or `beta`) the only branch that can match is
  `isNextPreRelease` at line 83, which is `hrefChannel === currentChannel`.
  **A tag on another channel is skipped, not ranked lower.**
- `GitHubProvider.js:131-140` — the channel file is tried as `<channel>.yml`
  (line 135) and falls back to `latest.yml` when that 404s (line 140). This is why the existing releases
  work while publishing only `latest*.yml`, and it is also why the symptom
  recorded in AGENTS.md named `latest.yml`: with the draft unpublished, both
  requests 404 and the fallback's error is the one that surfaces.

The consequence that makes the updater side of this cheap: **adding a channel
strands nobody, however many are added.** AGENTS.md's warning is about *moving*
the installed base off `desktop-v0`. A new identifier that no existing install
carries takes nothing away from them — their walk keeps matching `desktop-v0`
and ignores the rest.

Cheap in the updater is not cheap overall. What the channels carry, which
branches produce them, and how a fix reaches all of them is where the cost is;
see "What the channels actually differ by".

---

## The three channels

| | identifier | example | upstream it carries | cut from |
| --- | --- | --- | --- | --- |
| Stable | `desktop-v0` | `0.1.1-desktop-v0.2.0` | a chosen `rc` | `main`, as today |
| Develop | `desktop-dev0` | `0.1.1-desktop-dev0.2.0` | the newest `rc` | `dev`, manual tag |
| Alpha | `desktop-alpha0` | `0.1.2-desktop-alpha0.3.0` | the newest `alpha` | `alpha`, manual tag |

Each keeps the trailing scheme number, so the escape hatch documented in
AGENTS.md ("Versioning") exists on every channel and means the same thing on
each.

**`alpha` is a reserved word in electron-updater, and these identifiers are not
it.** `GitHubProvider.js:74-75` special-cases a channel only by exact equality
with `"alpha"` or `"beta"` (`["alpha", "beta"].includes(...)`), and line 83
matches with `hrefChannel === currentChannel`. `desktop-alpha0` is therefore an
ordinary custom channel, matched by exact string equality like the other two and
invisible to them. Naming the channel plain `alpha` would instead opt into the
alpha→beta promotion branch at line 77 — do not.

**They sort in stability order, which is luck rather than design, and worth
knowing.** Compared character by character: `desktop-alpha0` < `desktop-dev0` <
`desktop-v0`, on `a` < `d` < `v`. Two things follow:

- Within the updater it never comes up. The walk matches channels exactly, so
  builds on different channels are never compared against each other.
- Moving *toward* stability is a semver upgrade and needs nothing. Moving away
  from it — stable → develop, develop → alpha — is a downgrade.
  `AppUpdater.js:33-44` handles that: assigning `autoUpdater.channel` sets
  `allowDowngrade = true` as a side effect.

Do not pick identifiers that invert this. An alpha channel sorting *above*
stable would make the stable channel look like a downgrade to every alpha user,
which is the direction that matters least to get right and hardest to notice.

---

## What the channels actually differ by

This is the part that makes three channels a different feature from two, and it
has to be settled before anything is written.

The first version of this document split channels by **how well tested this
shell was**: same upstream pin, different confidence. Three channels named after
upstream's own stages instead split by **which harness they carry**:

```
alpha    harness.json = 0.1.2-alpha.3   (npm dist-tag `alpha`)
develop  harness.json = 0.1.1-rc.2      (npm dist-tag `latest` / `next`)
stable   harness.json = 0.1.1-rc.2      (an rc chosen after it has held up)
```

So `harness.json` stops being one repo-wide value. It becomes a property of a
branch, and the branches are the channels:

| branch | pin follows | tags cut from it |
| --- | --- | --- |
| `main` | a pin promoted from `dev` by hand | `desktop-v` |
| `dev` | npm `latest` (today's watcher) | `desktop-dev` |
| `alpha` | npm `alpha` | `desktop-alpha` |

Two consequences that are easy to miss:

- **`main` stops being "dev plus time".** Today `dev` fast-forwards into `main`
  and both carry the same pin, which is why realigning `dev` after a rebase
  merge is a one-line fast-forward. Once the pins differ, `main` and `dev`
  diverge on `harness.json` permanently, and every promotion is a merge that has
  to keep `main`'s pin or deliberately move it. The AGENTS.md realignment note
  ("Reset `dev` to `main`") stops being correct as written.
- **Shell fixes have to reach three branches.** Today a fix lands on `main` and
  that is the whole story. With three lines a fix like the updater repair has to
  be merged forward into each, or the alpha channel keeps shipping it broken.
  Nothing in the release flow enforces that, and nothing would say so.

The alternative, which is smaller and worth rejecting explicitly rather than by
omission: keep one branch and one pin, and let the channels mean only "how much
has this been exercised". That is the original two-channel design with a third
tier bolted on, and it does **not** deliver what was asked — an alpha user on it
would still be running the rc harness. If the point is to try upstream's alpha
early, the pin has to move, and then the branches have to.

---

## Release flow

Stable is unchanged: tag `v<version>` on `main`, `release.yml` refuses a tag that
is not on `main`, five-target build, draft, publish.

The other two add paths with the same shape and different gates. The
`verify-tag-on-main` job (`release.yml:16-28`, today a bare
`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`) becomes channel-aware
rather than being bypassed:

- a tag whose version carries `desktop-v` must be an ancestor of `main`
- a tag whose version carries `desktop-dev` must be an ancestor of `dev`
- a tag whose version carries `desktop-alpha` must be an ancestor of `alpha`
- anything else fails

Rename the job while doing it: `verify-tag-on-main` stops being what it checks.

Cut by hand when there is something worth trying, per the decision recorded with
this design. Not on every merge, and not automatically from the upstream bump —
both were considered and rejected as producing more releases than anyone would
publish drafts for. That reasoning applies harder to alpha, where upstream
published two releases in two days.

### The upstream watcher becomes per-channel

`watch-upstream.yml` today reads one version and opens one PR:

- `:34` `LATEST=$(npm view @deepseek-ai/dsh version)` — the `latest` dist-tag
- `:90` derives the release version with `scripts/release-version.mjs`
- `:102` opens the PR `--base dev`

For three channels it needs the dist-tag and the base branch as a matrix: the
`alpha` tag onto `alpha`, `latest` onto `dev`, and nothing onto `main` — stable
moves only when someone promotes a pin deliberately, which is the whole meaning
of that channel.

The comparator that decides whether to open a PR at all must compare within a
channel. Comparing an `alpha` dist-tag against a branch pinned to an `rc` would
propose a bump in whichever direction the semver happened to fall, which is the
`!=`-versus-newer-than mistake AGENTS.md already records once.

**Every hazard in AGENTS.md's "Cutting a release" applies unchanged to develop
tags**, including the one that matters most: a draft left unpublished breaks
update checks for everyone already on that channel, because the tag is public in
`releases.atom` the moment it is pushed while its assets are not. A develop
channel with two subscribers has exactly the same failure, just quieter.

---

## The desktop preference

`DesktopSettings` already has an enum field (`closeAction`), so the shape is not
new:

```ts
/** Which release channel this install follows. */
export type UpdateChannel = 'auto' | 'stable' | 'develop' | 'alpha'
```

**The default is `'auto'`, not `'stable'`.** `'auto'` means "follow the channel
this build was installed from", resolved from `app.getVersion()`. Someone who
downloaded a develop build keeps getting develop builds without having to find a
setting first, and someone on stable never sees a develop release. A literal
`'stable'` default would silently strand every develop install on its first
launch after this ships — which is the exact failure mode this feature is
supposed to avoid.

Resolution stays a pure function, per the convention in CLAUDE.md, so it is
unit-testable without Electron:

```ts
resolveUpdateChannel(setting: UpdateChannel, runningVersion: string): string
```

- `'auto'` → the running version's first pre-release identifier
- `'stable'` → `desktop-v<scheme>`
- `'develop'` → `desktop-dev<scheme>`
- `'alpha'` → `desktop-alpha<scheme>`

The scheme number comes from the running version in every case; it is never
invented here, for the reason AGENTS.md gives.

`parseDesktopSettings` stays pure and total with a static `'auto'` default, so
the dynamic part lives entirely in `resolveUpdateChannel` and none of it depends
on a half-written settings file parsing correctly.

The UI reads **Stable / Develop / Alpha**. `'auto'` is not a fourth radio button
— it is the stored state before anyone has chosen, and the UI shows whichever
channel it resolves to. Moving away from stable should say plainly that coming
back may need a manual download, because it is a downgrade and the safety of the
automatic path there is asserted nowhere yet.

**Alpha needs a warning the other two do not.** A develop build is this shell's
own work on a harness that upstream calls a release candidate. An alpha build
runs a harness upstream has not called ready, against a `$DSH_HOME` that the
stable install shares — and upstream migrates the state it finds there in place.
That is not hypothetical: an installed build spent six days in a boot loop
because a newer pin rewrote `.credentials.yaml` into a layout the older one
could not parse (AGENTS.md, "What a green build does not prove"). Switching to
alpha on a machine that also runs stable is a way to reproduce that deliberately,
and the setting should say so.

Whether alpha should therefore get its own `DSH_HOME` — the way a dev checkout
now does through `launchDshHome` — is an open question below, not a decision
this document makes.

---

## The macOS gap, which is the part most likely to be missed

`src/updater.ts` does not use electron-updater on unsigned macOS builds. It
fetches a hardcoded URL and reads the version out with a regex:

```
src/updater.ts:15   https://github.com/.../releases/latest/download/latest-mac.yml
```

`releases/latest` is GitHub's own "latest release", and `build.yml:39` creates
releases without `--prerelease`, so **every release is a candidate and the URL
resolves to whichever was published most recently — on any channel.** A develop
or alpha release would therefore be advertised to stable macOS users, in a modal
dialog, by a code path that never consults the channel at all.

This has to be fixed in the same change that introduces a second channel, not
after. Two options, neither yet chosen:

1. Resolve the tag from `releases.atom` the way `GitHubProvider` does, filtering
   by resolved channel, then fetch that tag's `latest-mac.yml`.
2. Mark non-stable releases with `--prerelease` so `releases/latest` skips them,
   and give each non-stable macOS path its own resolution.

Option 1 is more code and matches the other platforms exactly. Option 2 is
smaller but leans on a GitHub flag that nothing else in this repo depends on,
and it only fixes the stable direction — with three channels that means develop
and alpha macOS users would still see each other's releases, so option 2 gets
worse as channels are added rather than staying merely partial.

Note also that `isNewerVersion` (`src/update-gate.ts`) drives this path, and it
will refuse a move away from stability for the same sorting reason as above.
Whatever fixes the feed URL has to address that too; electron-updater's
`allowDowngrade` does not reach this code.

**This gap is inert today and stays inert until a second channel exists** —
`macUpdatesSigned` is false, and with one channel "most recently published" and
"newest on my channel" are the same release. It becomes live on the first
non-stable publish, which is why it belongs in that change and not in a
follow-up.

---

## What this does to the version scheme tests

`tests/unit/version-scheme.spec.ts` is written around a single channel and does
not survive a second one unmodified:

- `PUBLISHED` cannot stay one list. Its reachability assertion requires the
  shipping version to outrank every entry, and a develop version does not
  outrank a stable one. It becomes one list per channel, each asserted only
  against its own.
- The assertion that the shipping version's channel is exactly `desktop-v0`
  becomes an assertion that it is one of the three known channels.
- The fence against the retired `rc` line is unaffected — `desktop-dev0` and
  `desktop-alpha0` clear it for the same reason `desktop-v0` does (`d` and `a`
  both precede `r`, so both sort below the `rc` line, which is the direction
  that keeps those releases unreachable).

`scripts/release-version.mjs` grows a channel argument. `deriveReleaseVersion`
already carries the scheme number across without inventing it; it would carry
the channel the same way, and `appendPublished` would write into the list for
that channel. Its refusal to derive a version that does not outrank what ships
stays correct per channel and must not be applied across channels.

**Its upstream regex is rc-only and has to widen.** Today:

```js
const UPSTREAM = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/
```

`0.1.2-alpha.3` does not match, and the script stops with "cannot read an rc
number out of upstream … cut this release by hand" — a deliberate refusal, and
the right one while the scheme had nowhere to put an alpha number. With a
channel argument the second field stops meaning "upstream's rc number" and
becomes **upstream's pre-release number**, whatever stage produced it:

```
0.1.2-alpha.3  →  0.1.2-desktop-alpha0.3.0
0.1.1-rc.2     →  0.1.1-desktop-dev0.2.0
```

The stage and the channel must be checked against each other, not just parsed:
deriving a `desktop-v` version from an `alpha` upstream is a release that says
stable and carries an alpha harness, and nothing downstream would catch it. That
pairing belongs in the script, with the refusal it already has for a shape it
cannot express.

Note that alpha and rc number independently within one core — upstream may
publish `0.1.2-alpha.3` and later `0.1.2-rc.1`, and `3` there does not outrank
`1`. Across channels that never matters, because the walk never compares them.
It matters the moment anything sorts the two lists together, which is why
`PUBLISHED` splits rather than growing.

---

## Open questions

These are decisions, not research. Each one changes what gets built.

### Settled

- **The pins differ.** Each channel carries the upstream stage it is named
  after, per "What the channels actually differ by". Everything else in this
  document assumes it.
- **Alpha shares `$DSH_HOME`.** An alpha install and a stable install on one
  machine use the same `~/.dsh`, so an alpha user keeps their sessions and
  plugins — which is the point of trying it on real work rather than an empty
  profile.

  **The cost, stated plainly because it has already been paid once.** Upstream
  migrates the state it finds there in place, and the migrations are one way:
  0.1.1 rewrote `.credentials.yaml` into a layout 0.1.0-rc.8 rejects outright,
  and the installed build spent six days unable to boot. Running alpha on a
  machine that also runs stable is a way to do that on purpose.

  What is different now is that it no longer happens in silence: a boot failure
  writes its reason to `userData/logs/sidecar.log`, the restarts are budgeted
  rather than endless, and the window shows the error instead of a white page.
  The recovery is still manual, and the alpha setting has to say so.

### Still open

- **Three branches, or fewer?** `alpha` and `dev` could be one branch carrying
  whichever pin is newest, with the channel decided at tag time. Cheaper, and it
  gives up the ability to have an alpha build and an rc build in the field
  simultaneously — which is most of the point.
- **How do shell fixes reach every channel?** Nothing proposed here enforces
  forward-merging, and an alpha branch that misses the updater repair ships an
  app that cannot update itself, on the channel whose users most need it to.
- **Does develop or alpha auto-download?** `autoDownload` and
  `autoInstallOnAppQuit` are both on today (`src/updater.ts`). Leaving them on
  means a user on those channels gets every cut on quit, with no chance to skip
  a bad one.
- **Is there a way back?** Moving toward stability is an upgrade in semver terms,
  so it should work through the normal path — but that is a claim, not something
  tested, and it is the claim a user depends on when they decide to try a
  channel at all. It needs a real release on each channel to verify.
- **Does the upstream bump interact with this?** `watch-upstream.yml` does not
  tag, so it produces no release on any channel — but a cut taken straight after
  a bump is the most likely reason to cut one at all, and the two flows should be
  described together once this is built.

---

## What is verified here, and what is not

Verified against the code in this repo and its dependencies, at the line numbers
cited: electron-updater's channel derivation and matching, the `alpha`/`beta`
special case, the `<channel>.yml` → `latest.yml` fallback, today's tag gate, and
what `watch-upstream.yml` reads and targets.

Not verified, because it cannot be without shipping: that a build on one channel
actually receives a release on that channel and ignores the others. Every claim
here about the walk comes from reading `GitHubProvider.js`, and this app has
already had one update path that read correctly and did not work — the
destructured `electron-updater` import that made every check fail for the life
of the project. The first release on each new channel is the test, and it should
be treated as one.
