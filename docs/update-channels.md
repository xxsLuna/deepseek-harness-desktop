# Splitting stable and develop update channels

**Status: proposed, not implemented.** Nothing in this document describes how the
app behaves today. It exists so the implementation can be argued about before any
of it is written, because the pieces span the launcher, the settings UI and the
release workflows, and because a mistake in this area is invisible until someone
in the field stops receiving updates.

Today there is exactly one channel, `desktop-v0`, and every install is on it.

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

The consequence that makes this whole feature cheap: **adding a second channel
strands nobody.** AGENTS.md's warning is about *moving* the installed base off
`desktop-v0`. A new identifier that no existing install carries takes nothing
away from them — their walk keeps matching `desktop-v0` and ignores the rest.

---

## The two channels

| | identifier | example | cut from |
| --- | --- | --- | --- |
| Stable | `desktop-v0` | `0.1.1-desktop-v0.2.0` | `main`, as today |
| Develop | `desktop-dev0` | `0.1.1-desktop-dev0.3.0` | `dev`, manual tag |

`desktop-dev` keeps the trailing scheme number, so the escape hatch documented
in AGENTS.md ("Versioning") exists on both channels and means the same thing on
both.

**Develop sorts BELOW stable, and that is deliberate.** Compared character by
character, `desktop-dev0` loses to `desktop-v0` at `d` vs `v`. Two things follow:

- Within the updater it never comes up. The walk matches channels exactly, so a
  develop build and a stable build are never compared against each other.
- Switching stable → develop is therefore a semver *downgrade*.
  `AppUpdater.js:33-44` handles it: assigning `autoUpdater.channel` sets
  `allowDowngrade = true` as a side effect. Switching develop → stable is an
  upgrade and needs nothing.

Picking an identifier that sorted *above* stable would invert that and make the
stable channel look like a downgrade to develop users, which is worse. Leave it
sorting low.

---

## Release flow

Stable is unchanged: tag `v<version>` on `main`, `release.yml` refuses a tag that
is not on `main`, five-target build, draft, publish.

Develop adds a second path with the same shape and a different gate. The
`verify-tag-on-main` job becomes channel-aware rather than being bypassed:

- a tag whose version carries `desktop-v` must be an ancestor of `main`
- a tag whose version carries `desktop-dev` must be an ancestor of `dev`
- anything else fails

Cut by hand from `dev` when there is something worth trying, per the decision
recorded with this design. Not on every merge to `dev`, and not automatically
from the upstream bump — both were considered and rejected as producing more
releases than anyone would publish drafts for.

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
export type UpdateChannel = 'auto' | 'stable' | 'develop'
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

The scheme number comes from the running version in every case; it is never
invented here, for the reason AGENTS.md gives.

`parseDesktopSettings` stays pure and total with a static `'auto'` default, so
the dynamic part lives entirely in `resolveUpdateChannel` and none of it depends
on a half-written settings file parsing correctly.

The UI reads **Stable / Develop**. `'auto'` is not a third radio button — it is
the stored state before anyone has chosen, and the UI shows whichever channel it
resolves to. Choosing Develop from a stable build should say plainly that
returning to stable may need a manual download, because it is a downgrade and
the safety of the automatic path there is asserted nowhere yet.

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
release would therefore be advertised to stable macOS users, in a modal dialog,
by a code path that never consults the channel at all.

This has to be fixed in the same change that introduces the second channel, not
after. Two options, neither yet chosen:

1. Resolve the tag from `releases.atom` the way `GitHubProvider` does, filtering
   by resolved channel, then fetch that tag's `latest-mac.yml`.
2. Mark develop releases with `--prerelease` so `releases/latest` skips them, and
   give the develop macOS path its own resolution.

Option 1 is more code and matches the other platforms exactly. Option 2 is
smaller but leans on a GitHub flag that nothing else in this repo depends on, and
it only fixes the stable direction.

Note also that `isNewerVersion` (`src/update-gate.ts`) drives this path, and it
will refuse a channel switch in the stable → develop direction for the same
sorting reason as above. Whatever fixes the feed URL has to address that too;
electron-updater's `allowDowngrade` does not reach this code.

---

## What this does to the version scheme tests

`tests/unit/version-scheme.spec.ts` is written around a single channel and does
not survive a second one unmodified:

- `PUBLISHED` cannot stay one list. Its reachability assertion requires the
  shipping version to outrank every entry, and a develop version does not
  outrank a stable one. It becomes one list per channel, each asserted only
  against its own.
- The assertion that the shipping version's channel is exactly `desktop-v0`
  becomes an assertion that it is one of the two known channels.
- The fence against the retired `rc` line is unaffected — `desktop-dev0` clears
  it for the same reason `desktop-v0` does.

`scripts/release-version.mjs` grows a channel argument. `deriveReleaseVersion`
already carries the scheme number across without inventing it; it would carry
the channel the same way, and `appendPublished` would write into the list for
that channel. Its refusal to derive a version that does not outrank what ships
stays correct per channel and must not be applied across channels.

---

## Open questions

- **Does develop auto-download?** `autoDownload` and `autoInstallOnAppQuit` are
  both on today (`src/updater.ts:86-87`). Leaving them on for develop means a
  develop user gets every cut on quit, with no chance to skip a bad one.
- **Is there a way back?** Develop → stable is an upgrade in semver terms, so it
  should work through the normal path — but that is a claim, not something
  tested, and it is the claim a develop user depends on when they decide to try
  the channel at all. It needs a real release on each channel to verify.
- **Does the upstream bump interact with this?** `watch-upstream.yml` opens its
  PR against `dev`. It does not tag, so it produces no release on either channel
  — but a develop cut taken straight after a bump is the most likely reason to
  cut one at all, and the two flows should be described together once this is
  built.
