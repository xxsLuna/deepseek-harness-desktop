# Working procedures

`CLAUDE.md` holds the architecture rules — plugin-first, why the payload is
pruned and never bundled, the code conventions. **Read it first.** This file
holds the procedures and the things that have already gone wrong once: how to
take an upstream version, how to name and cut a release, how to run the app, and
which couplings fail *silently* so you cannot rely on a green build alone.

Nothing here is preference. Every item is either a rule with a consequence or a
mistake that has already been made in this repo.

---

## Attribution: never in this project

No commit, tag, pull request, issue or release note may state that Claude or a
user called `Minsang-MICUBE` authored anything.

- **No `Co-Authored-By:` trailer.** Not for Claude, not for anyone.
- **No "Generated with Claude Code" footer** in PR bodies, issues or notes.

Both had leaked into the GitHub Contributors list and three commits had to be
rewritten to remove them. The author identity is `Luna <xxs.main@gmail.com>` —
the repo-local git config already sets it, because the global `~/.gitconfig` on
the dev machine supplies a different one and it kept landing in commits.

A **squash merge concatenates the branch's commit messages** into the merge
commit, so a trailer left on any `dev` commit reaches `main` anyway. Prefer
`gh pr merge --rebase`, which copies commits verbatim and adds nothing.

Referencing the filename `CLAUDE.md` is fine — it names a file, not an author.

**A rewrite cleans `main`; it does not clean GitHub.** This is settled now, but
how it was settled is the part worth keeping.

Rewriting `main` left six contaminated commits still served to anonymous readers:
three held by `refs/pull/3/head` (login `Minsang-MICUBE`, one
`Co-Authored-By: Claude Opus 5` trailer each) and three orphans reachable by SHA
alone — `19c3e80`, PR #3's squash-merge commit with five trailer lines, plus
`254a6b7c` and `c46c75bb`, the pre-rewrite originals of two rewritten commits.

**Nothing local could remove them.** `refs/pull/*` is read-only
(`DELETE …/git/refs/pull/3/head` → `422`, `git push --delete` → "deny updating a
hidden ref"), there is no `deletePullRequest` mutation, `archivePullRequest`
returns `FORBIDDEN`, and no branch points at the orphans so another force-push
reaches nothing. **GitHub Support deleted PR #3 and ran a gc on request** — that
is the route, and it took one ticket. Verified anonymously afterwards: all six
`404`/`422`, `/pull/3` redirects to a `404`, `refs/pull/3/head` absent from
`ls-remote`, and the Contributors list down to `xxsLuna` alone.

Two things to carry forward if it ever recurs:

**Enumerate; do not trust a remembered list.** The first pass found only
`19c3e80` and undercounted by two, and the miss was invisible because `main` was
clean and the PR page showed only the three commits its ref held. The support
request had already gone out naming four of the six.

```sh
git cat-file --batch-all-objects --batch-check | awk '$2=="commit"{print $1}' \
  | while read -r s; do git cat-file commit "$s" \
      | grep -qiE 'co-authored-by|generated with \[claude|minsang' && echo "$s"; done
```

**A clean local clone is not evidence.** These were pruned locally with
`git reflog expire --expire-unreachable=now --all && git gc --prune=now` (safe —
every unreachable commit was a contaminated one), which stops a stray push from
republishing them and says nothing about the remote. **Do not report this rule as
satisfied on the strength of a clean `git log`** — check the PR refs and the
orphans with `curl`, unauthenticated.

---

## Taking a new upstream version

### Where to look

Upstream arrives from **npm, not git**. There is no clone and no vendored source:

```
harness.json  { "harness": "0.1.0-rc.8", "node": "24" }
    -> scripts/stage-harness.mjs writes a one-dependency package.json
    -> npm install --omit=dev (3 attempts, cache clean between)
       from https://registry.npmjs.org/
    -> build/harness/node_modules/@deepseek-ai/dsh
```

The published tarball ships `["lib/*.js", "config"]` — built bundles only, no
TypeScript source. That is *why* the no-editing-upstream rule holds by
construction: there is nothing to edit.

**Check `dist-tags`, not just the newest version.** `npm view @deepseek-ai/dsh
dist-tags` has shown `next` ahead of `latest` (rc.8 published as `next` while
`latest` was still rc.7). `watch-upstream.yml` reads `npm view … version`, which
is the `latest` tag. Testing a `next` release and shipping it to users are
separate decisions.

**Pinning ahead of `latest` used to make the daily watch propose a downgrade.**
The gate was `pinned != latest` — inequality, not newer-than — so while the pin
was a `next` release the watch opened a PR walking it *back* to `latest` every
day. It now compares properly and only opens a PR when `latest` is genuinely
ahead; the comparator in `watch-upstream.yml` is the reference. Recorded because
the comparator looks like over-engineering until you know it replaced a `!=`.

### The pin covers one package only

`harness.json` pins the top-level `dsh`. Its ~195 `@deepseek-ai` dependencies and
every third-party transitive resolve through caret ranges, and **no lockfile
survives** — npm writes one into `build/harness`, but the full stage deletes the
directory first, so it never constrains anything. The same pin therefore does not
produce the same tree twice: the same `0.1.0-rc.7` pin
staged 32,796 files one day and 29,489 the next. Do not treat a file count or a
prune total as a fixed property of a version.

### The procedure

```sh
# 1. edit harness.json (upstream pin) and package.json (see Versioning below)
# 2. NOTHING may be running from build/harness — see the hazard below
npm run stage          # full reinstall of the pinned upstream
npm run build
npm test
npm run test:contract  # the version-tracking canary
```

Then open a PR and let the five-target matrix run. CI has caught three real
breaks that passed locally: a cross-build arch mismatch, an Electron exec race,
and a compression memory limit. **A local pass is not evidence.**

### Hazard: staging destroys before it installs

`stage-harness.mjs` does `rmSync(stageDir)` and *then* `npm install`. On Windows a
running app holds `@img/sharp-win32-x64/lib/libvips-42.dll` mapped, the unlink
fails, and you are left with a half-deleted tree — `@deepseek-ai` empty, tens of
thousands of orphan files. **Stop every app instance before staging.** A wrecked
tree looks exactly like "upstream removed everything", which is a wrong
conclusion someone has already nearly drawn from it.

### After a bump, the rows patched by id check themselves

This used to be the highest-value **manual** check, because it was the one thing
that failed with no error at all. It is now automatic, in two places:

- `packages/bundle/lib/boot.js` **refuses to boot** when upstream no longer
  declares a row it patches — the six it disables, plus `agent-presets` and (when
  `DSH_TELEMETRY_DISABLED` is set) `session-telemetry-otel`.
- `tests/contract/upstream-rows.spec.ts` names all eight, so CI says *which* row
  moved rather than "the sidecar did not start".

Two things about that guard are worth knowing before touching it.

**It cannot be written as `rows.has(id)`.** That is the obvious form, and it would
always pass: `rows` is built from every patch layer including our own
`cordis.patch.yml`, which names those same ids, so they are in the composition
whether or not upstream still defines them. The check indexes the **upstream**
layers separately and asks only about those. The pre-existing `rows.has()` guards
on `agent-presets` and `session-telemetry-otel` worked only by luck of those rows
being declared upstream rather than here.

**It throws rather than warns**, because the default state of these rows is *on*:
per the comment in `boot.js`, `webserver`/`connection` would bind a real TCP port
and mount a WebSocket carrier the app scheme cannot serve, and
`directory-picker` would restore an OS chooser this process cannot bring to the
front. `DSH_TELEMETRY_DISABLED` now fails **closed** for the same reason — a
privacy switch that silently stops working is worse than an app that will not
start.

Upstream's applier is what makes all of this necessary: it **warns and skips** an
id it cannot find (`dsh-app-boot`: `warn("patch: entry %C not found", id)`). It
does not throw, and the warning does not surface in the app log.

To check by hand anyway:

```sh
for id in web-startup webserver web-runtime connection client-hmr directory-picker agent-presets session-telemetry-otel; do
  grep -rqs "id: $id\$" build/harness/node_modules/@deepseek-ai/*/cordis.patch.yml \
    && echo "$id present" || echo "$id GONE"
done
```

`session-telemetry-otel` fails differently and worse: its overlay *is* guarded by
`rows.has(...)`, so a rename skips the overlay and `DSH_TELEMETRY_DISABLED`
**fails open** — telemetry stays on with the opt-out set.

---

## Versioning

The number in front is **upstream's, and never changes here**. The desktop build
lives entirely in the pre-release part:

```
0.1.0-desktop-v0.8.0
  ^      ^     ^ ^ ^
  |      |     | | +-- this shell's build of that harness (0, 1, 2 ...)
  |      |     | +---- upstream's rc number (8, 9, 10, 20 ...)
  |      |     +------ this shell's scheme number, if the scheme changes again
  |      +------------ the desktop shell
  +------------------- upstream's version, untouched
```

**The upstream number and the build number are each their own dot-separated
field, and that is load-bearing.** The scheme number is not — `semver.prerelease`
reads `0.1.0-desktop-v0.8.0` as `["desktop-v0", 8, 0]`, so the leading number is
fused into the text field. It overrides everything after it only while it stays
single-digit: `desktop-v10` sorts *below* `desktop-v9`. It is an escape hatch
meant to move roughly never, but do not treat it as a third numeric axis.

**Moving the scheme number is a channel change, not just a sort-order caveat.**
That first pre-release identifier *is* electron-updater's channel
(`GitHubProvider` selects a tag only when its channel equals the running build's,
and the alpha/beta shortcut does not apply to a custom one like `desktop-v0`), so
a `0.1.0-desktop-v1.x` release is **invisible** to every `desktop-v0` install
however much higher semver ranks it. That is the same wall the `rc.*` → `desktop-v0`
move hit, and it is why `v0.8.0` needed a manual download. Changing the leading
number strands the entire installed base for one release. Treat it as a migration,
announce it, and do not spend it on tidiness.

**Two different semver rules bite here, and confusing them leads to the wrong
conclusion.** First: a field of nothing but digits ranks *below* any field
containing a letter or hyphen. That is why the retired scheme broke — with a
hyphenated build counter, `0.1.0-rc.7` compared `7` against `6-3`, and the
numeric `7` lost to the non-numeric `6-3`, making a plain rc.7 **older** than the
published rc.6-3 and offerable to nobody. Second: two non-numeric fields compare
character by character, so `10-1` sorts below `9-1`. Giving each number its own
all-digits field escapes both: `tests/unit/version-scheme.spec.ts` checks every
ordered pair over a wide sweep.

Rules that follow:

- **The automated bump PR derives the release version** rather than copying
  upstream's. `scripts/release-version.mjs`, run from `watch-upstream.yml`,
  takes upstream's core and rc number, carries the scheme number across
  unchanged, and puts the build counter back to `0` — then records the result in
  `PUBLISHED`. So the bump PR arrives green instead of red on the two edits that
  used to be left for a human. It carries no dependency on purpose: the watch
  job has no install step, and `semver` is a devDependency.
- **Deriving is not the same as deciding.** The script refuses rather than
  guesses when upstream publishes a shape the scheme cannot express (a stable
  release, with no rc number to put in that field), and when the version it
  derives would not outrank what ships. Both fail the watch job by name. A
  release cut by hand still owes all three edits, and the unit suite fails on
  each of them separately.
- **Only the root `package.json` carries the release version.** electron-builder
  reads it; everything at runtime goes through `app.getVersion()` or
  `harness.json`. The `packages/*` manifests are not maintained and drift.
- **Our comparator is not the authority.** `isNewerVersion` in
  `src/update-gate.ts` drives only the macOS notify path. Windows and Linux go
  through electron-updater's own `semver`, so a scheme that only satisfies our
  function would strand exactly the platforms that auto-update.
- Releases before `0.1.0-desktop-v0.8.0` used the `rc` line and are
  **deliberately unreachable** — `desktop-v0` sorts below `rc` because `d`
  precedes `r`. Installs from those need one manual download. This is asserted,
  so the scheme cannot drift back into the `rc` line unnoticed.

---

## Cutting a release

Each channel is cut from its own branch, and `release.yml` refuses a tag that is
not on the branch its channel names:

| channel | identifier | branch | cut with |
| --- | --- | --- | --- |
| Stable | `desktop-v` | `main` | `release-version.mjs <upstream> v` |
| Develop | `desktop-dev` | `dev` | `release-version.mjs <upstream> dev` |
| Alpha | `desktop-alpha` | `alpha` | `release-version.mjs <upstream> alpha` |

`docs/update-channels.md` is the design; the alpha branch does not exist yet
because upstream's alpha harness does not build against this shell.

**The version cut is not the script's job when only the build counter moves.**
`release-version.mjs` derives a version for an UPSTREAM bump and resets the
build counter, so a new build of the same pin is cut by hand — edit
`package.json` and `package-lock.json`, then record it with that script's own
`appendPublished(source, version, channel)` so it lands in the right channel's
list. Both places, because the lockfile carries the root version too.

```sh
gh pr merge <n> --rebase                  # rebase, not squash — see Attribution
git push --force-with-lease origin <main-sha>:refs/heads/dev   # see below
git tag -a v<version> origin/main -F <message-file>
git push origin refs/tags/v<version>      # triggers the 5-target release build
```

**`dev` can no longer just be reset to `main`.** It used to be: both branches
carried the same version, so realigning after a `--rebase` merge was a
fast-forward. Since `0.1.1-desktop-dev0.2.0` each branch carries its OWN
channel's version in `package.json` and its own entry in the matching
`PUBLISHED_*` list, so the two diverge there permanently and by design.

The realignment problem itself has not gone away — GitHub replays commits onto
`main` with new SHAs and leaves `dev` pointing at the originals, so `dev` ends up
with commits that are not ancestors of `main` while the trees are otherwise
identical, and the next `dev -> main` PR re-applies the same changes. Rebase
`dev` onto `main` and keep its own version cut on top, rather than resetting.

**A fix on one branch does not reach the others.** Nothing enforces
forward-merging, and this bit on day one: the first develop cut found a real
bug in `appendPublished` (an empty list produced `[, 'x']`, an elision) that
`main` still carried. Cherry-pick such a fix to every branch, or the channel
whose users most need it ships without it. This is the open question the channel
design names and does not answer.

**Publish the draft promptly — do not sit on it.** The tag appears in
`releases.atom` the moment it is pushed, while the assets stay draft-private.
electron-updater's channel walk picks the new tag, fails to fetch its
`latest.yml`, and dies with `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` — swallowed by
the error handler, so **an installed client's update check stays broken for as
long as the draft sits.**

That bites when installed clients are on the *same* channel as the draft, which
is every release from `v0.8.1` on. It did **not** apply to `v0.8.0`: the installs
in the field were `rc.*`, a different channel, so the walk resolved `rc.7-1` and
they quietly reported themselves up to date. Do not read that one quiet release
as evidence the hazard is imaginary. Verify the feed, write the notes, publish.

**With more than one channel that distinction stops being a footnote.** A
develop draft left sitting breaks update checks for develop installs and nobody
else; a stable one breaks them for everybody on stable. The blast radius is per
channel now, which makes a develop draft cheaper to sit on and a stable draft
exactly as expensive as it always was. That is not permission — it is the same
failure with a smaller audience.

### Count the drafts before you publish one

**Still count them, even though the race is fixed.** A `draft` job now creates the
release once, before the matrix, and each build job uploads into it with
`gh release upload --clobber` — nothing else creates a release. That is a change
only a release exercises, so verify it rather than assume it held:

```sh
gh api repos/xxsLuna/deepseek-harness-desktop/releases \
  --jq '.[] | select(.tag_name=="v<version>") | "\(.id) draft=\(.draft) assets=\(.assets|length)"'
```

Expect **one** id and **13 assets**: dmg + zip + 2 blockmaps + `latest-mac.yml`
(mac-arm64), exe + `latest.yml` (win), AppImage + deb + `latest-linux.yml`,
arm64 AppImage + deb + `latest-linux-arm64.yml`.

What it replaced, so nobody reinstates it: all five jobs ran
`electron-builder --publish always`, and each created the release if it did not
already see one. On `0.1.0-desktop-v0.8.0` two checked at the same moment and both
created it — **two drafts on one tag**, assets split 9/7, a `latest-mac.yml` in
each, and `gh release view <tag>` resolving to only one. Earlier releases got a
single draft by luck of when their jobs started.

**Assets now upload after the payload and smoke gates**, which is the other half:
`--publish always` uploaded during `Package`, i.e. before either gate, so a bad
payload reached the draft and the gates could only report on what had already
shipped.

If two drafts ever appear again, consolidating means download-and-re-upload —
there is no move-asset API. Keep the one holding the larger byte total and
**verify each transfer by hash, not by size**: the feeds carry the build's own
`sha512` for every artifact, so a truncated download cannot slip through as a
published installer. Then `DELETE /releases/{id}` the duplicate (by **id** — a
tag-based delete can take the tag with it, and the tag is what `release.yml`
already gated).

Before publishing, check the feed rather than assuming:

```sh
curl -sSL https://github.com/xxsLuna/deepseek-harness-desktop/releases/download/v<version>/latest.yml
# version: must match package.json exactly
```

**The Latest badge belongs to STABLE, and only stable.** This used to read
"publish as Latest" without qualification, which was right while one channel
existed and is wrong now — a develop or alpha release marked Latest moves that
badge off stable.

Why it matters is `src/updater.ts`. The macOS path fetches
`releases/latest/download/latest-mac.yml`, i.e. whatever GitHub currently calls
Latest rather than this release's own feed. That path now resolves its tag by
channel through `releases.atom`, so a current build is safe either way — but an
install still on an older build has the channel-blind version, and it would read
a develop release as the newest stable one. The badge is what protects installs
that cannot protect themselves.

So, per channel:

```sh
gh release edit v<version> --draft=false --prerelease=false --latest         # stable
gh release edit v<version> --draft=false --prerelease=false --latest=false   # develop, alpha
```

**Never tick "Set as a pre-release" on any of them.** That is a different flag
from the badge and it is not the channel mechanism: `GitHubProvider` selects on
the version's channel identifier, not on GitHub's prerelease bit, and
electron-updater's `allowPrerelease` is already permanently true because every
version this app ships has a pre-release part. Setting it changes nothing useful
and hides the release from `releases/latest` resolution in a second, redundant
way.

The older hazard this paragraph recorded still stands for stable: leave an
*older* release as Latest and every mac client on the new version is offered the
older one, because `isNewerVersion('0.1.0-rc.7-1', '0.1.0-desktop-v0.8.0')` is
`true` — `rc` outranks `desktop-v0`. Confirm after publishing that Latest still
resolves to the newest STABLE tag, not to whatever went out most recently:

```sh
curl -s -o /dev/null -w '%{redirect_url}\n' https://github.com/xxsLuna/deepseek-harness-desktop/releases/latest
```

Release notes are hand-written user-facing prose on the GitHub release (there is
no CHANGELOG). Say plainly when a release gives users little — one of them was
mostly a label correction, and the notes said so.

---

## Running the app

```sh
npm run dev      # build + launch
npm run smoke    # build + headless self-check, prints RESULT lines and exits
```

**Use an isolated environment when an installed build is running.** The
single-instance lock (`app.requestSingleInstanceLock()`, `src/main.ts`) makes a
second launch quit immediately, and `$DSH_HOME` defaults to `~/.dsh` — the same
state the installed app writes. The sidecar comment is explicit that the harness
is the *only* writer of that state, so never point two harnesses at one home:

```sh
DSH_HOME=<tmp>/home npx electron . --user-data-dir=<tmp>/userdata
```

### The live-tuning loop (dev only, `!app.isPackaged`)

`src/dev-tuning.ts` watches four gitignored files at the repo root:

| file | effect |
|---|---|
| `dev-overrides.css` | re-injected into the window on every save — styles are fully live |
| `dev-eval.js` | runs in the renderer, result to `dev-eval.out.json` |
| `dev-capture.request` | touch it to save a window screenshot to `dev-capture.png` |
| `dev-click.request` | write `x,y` for a real OS-level click |

**Derive click coordinates from the DOM, never from a screenshot.** Guessing them
from a capture once mis-clicked into the workspace flow and opened a native
folder dialog on the user's desktop. Use `dev-eval.js` and
`getBoundingClientRect()`, then click the computed centre.

**Nothing else is live.** Launcher code, harness plugins and client bundles all
need a restart. Plugin HMR is off on both halves and neither is our doing:
upstream's `dsh-web-app` disables the node half (`- id: hmr / disabled: true`),
and our overlay disables `client-hmr` because its `EventSource('/plugins/events')`
cannot be served over the `dsh://` scheme.

---

## Packaging

```sh
npm run build
npm run prune                 # --platform/--arch default to the host
npx electron-builder --<mac|win|linux>
node scripts/verify-payload.mjs <resources dir>
node scripts/smoke-packaged.mjs
```

- **`npm run prune` is destructive and must run after `build`, never before** —
  `build` restages the local packages.
- **`npm run typecheck` needs the unpruned tree.** `packages/connection` and
  `packages/settings` compile against declarations the prune removes. Run
  `npm run stage` to restore; the prune script says so on exit.
- **Every target is built on its own architecture, and that is not a
  convenience.** There are no cross builds left. The Intel macOS target was
  cross-built on Apple Silicon for four releases and shipped arm64 `koffi`,
  `ripgrep` and `sharp` inside an x64 app, because `npm install` picks
  platform-specific optional dependencies from the **host's** `os`/`cpu` — the
  cross build's own comment argued it was safe since nothing is *compiled* here,
  which is true and beside the point. Intel macOS is not supported. If a
  cross build is ever needed, the prune ordering also has to move (it targets the
  build's arch, so the host's prebuilds go and the harness cannot load in the
  test steps), and `verify-payload.mjs --platform/--arch` is what makes the
  package mismatch fail instead of ship.

---

## Windows: where a spawned command actually comes from

Worth reading before debugging anything about how the harness runs commands on
Windows, because the obvious answer is wrong and cost four failed attempts.

**A console child with no console to inherit gets a fresh, VISIBLE one.** The
launcher spawns the sidecar with `windowsHide`, which stops the sidecar showing a
window and leaves it no console to pass down. Upstream's own use never sees this:
run `dsh` from a terminal and the terminal's console is there to inherit. It only
appears when a GUI process hosts the harness.

**The shell does not come through `child_process`.** On Windows the ACL sandbox
(`@deepseek-ai/dsh-sandbox-windows-acl`) calls `CreateProcessAsUserW` through
koffi, in a *separate runner process*. Defaulting `windowsHide` on
`child_process` — first `spawn`, then the whole family, then carried into
descendants — changed nothing. A tool call logs exactly one `child_process`
spawn, of `process.execPath`, and never the shell.

**Do not "fix" it with a creation flag.** That module's own doc records the
attempt: `CREATE_NO_WINDOW`/`CREATE_NEW_CONSOLE` are *intentionally absent*
because under its restriction scheme hidden-console children die with
`STATUS_DLL_INIT_FAILED (0xC0000142)`. Forcing the flag trades a cosmetic flash
for commands that do not run.

**What works** is the last clause of that same sentence — "the child shares the
host console". `packages/bundle/lib/hide-console.mjs` gives each process a
console without ever showing one: `AttachConsole(ATTACH_PARENT_PROCESS)` first,
which creates no window, and `AllocConsole` + `ShowWindow(SW_HIDE)` only as a
fallback. It resolves differently per level on purpose — the sidecar's parent is
the GUI launcher so it allocates once at startup; the runner's parent is the
sidecar so it just attaches. No creation flags move, so nothing the sandbox
depends on moves.

It reaches the runner through `NODE_OPTIONS=--import`, set in `boot.js`. Each
link was measured: `scrubbedParentEnv` keeps `NODE_OPTIONS`; Electron honours
`--import` under `ELECTRON_RUN_AS_NODE`, **including the packaged binary**, which
mattered because Electron is documented to ignore `NODE_OPTIONS` for packaged
apps.

### Two instrumentation traps this walked into

Both wasted a round, and both look like a result rather than a broken instrument:

- **A spawned child's stderr never reaches the launcher log** —
  `dsh-subprocess-local` pipes it and collects it as command output. Trace to a
  FILE. `HARNESS_DESKTOP_SPAWN_TRACE=<path>` does that.
- **`scrubbedParentEnv` strips every `DSH_*` variable.** A `DSH_`-named trace
  switch reaches the sidecar and nothing below it, so descendants run with
  tracing silently off. That is why the switch above is *not* `DSH_`-prefixed —
  the first version was, and produced a trace that proved nothing about the
  processes it existed to observe.

## What a green build does not prove

The contract suite is the version-tracking canary and it is worth trusting for
what it covers: the socket transport, the boot manifest, `/api` through the
upstream gateway, session create/export, the interaction plane, agent presets,
`node-pty`, the packaged ripgrep, `node:sqlite`, worker threads, the plugin
roster surviving the prune, and the settings-nav divider seams.

It does **not** cover these, and each one fails with no error:

- **Row ids patched by id** — warned and skipped upstream. See the check above.
- **`DSH_TELEMETRY_DISABLED`** — fails open if `session-telemetry-otel` is
  renamed. A privacy switch.
- **The `webServer` service surface** — the patch disables upstream's
  `webserver` row and `@dsh-desktop/carrier` provides the service instead, so
  upstream ADDING a method is a break that nothing at boot notices. 0.1.1-rc.1
  added `renderIndex`/`collectIndexInjections` and moved the SPA fallback onto
  the first; against a carrier without it every page load threw and the server
  answered an empty error while the sidecar reported ready.
  `tests/contract/carrier-surface.spec.ts` reads the method list out of
  upstream's own declaration and compares it against the carrier's prototype,
  so the next addition fails by name. Adding a method to the carrier without
  adding it to `PROVIDER_SURFACE` there is the way to defeat it.
- **Notification event vocabulary** — `src/notifications.ts` switches on upstream
  frame `type` strings and field names (`approval/requested`, `approvalId`,
  `host/session-status`). A rename kills toasts and the approval badge quietly,
  or leaks the badge count upward. It now also reads `host/session-added`,
  `host/session-removed`, the literal `origin: 'subagent'`, and the
  `session.list` summary shape — and those decide whether a toast is suppressed
  and whether a turn is counted as yours, so a rename does not stop the feature,
  it makes it answer wrong. The Usage graphs go quietly empty by the same route.
- **The token-usage vocabulary** — `src/notifications.ts` reads tokens off
  `assistant/chunk` (`data.chunk.type === 'usage'`) and `assistant/message`
  (`data.usage`), with `turn`/`step` beside them, mirroring `usageOf` in
  `@deepseek-ai/dsh-token-meter`. Two ways this goes wrong in silence. A rename
  leaves the Usage page reporting zero tokens forever, which looks like "I have
  not used it much". And if upstream ever stops treating the second report for a
  turn/step as a REPLACEMENT, our subtraction becomes wrong in the other
  direction and every figure halves. The rule is pinned in
  `tests/unit/usage-store.spec.ts`, but only against our own implementation —
  nothing checks upstream still folds it the same way.
- **`will-move` and `moved` for a CSS drag region** — `src/window-magnet.ts`
  snaps the window to a screen edge from those two events. Neither is documented
  as firing for a `-webkit-app-region: drag` strip, which is the only way this
  app's window is dragged. Both DO fire, measured on Windows 11; if a bump stops
  delivering them, snapping simply never happens and nothing errors. The
  release-time handler is registered on every platform for that reason, so at
  least one path survives losing the other.

  Three things about that drag are measured rather than documented, and each one
  produced a visible bug before it was known. `will-move`'s rectangle is the
  OUTER frame, 16x8 larger than `getBounds()` — passing it to `setBounds` grew
  the window by the invisible border on every snap, compounding. A programmatic
  `setBounds` raises neither event, which is the only reason the live and
  release paths cannot feed each other. And after `preventDefault`, Windows
  re-anchors its next proposal to where the window now IS rather than to the
  cursor, so snapping the proposal traps the window against the edge forever —
  the magnet tracks cursor travel instead. All three are pinned in
  `tests/unit/window-snap.spec.ts` with the numbers a real drag produced, but a
  bump could change any of them and the tests would keep passing against our own
  arithmetic. `DSH_MAGNET_TRACE=1` prints every decision, which is how they were
  found.
- **`$DSH_HOME` is shared, and upstream migrates what it finds there in place.**
  `~/.dsh` belongs to the installed app, every checkout, and the `dsh` CLI
  alike. 0.1.1 rewrites `.credentials.yaml` from the pre-release flat layout to
  `version: 1` + `refs:` on first read — values unchanged, log line only. The
  migration is one-way, so a single dev run on a newer pin bricks the installed
  build: 0.1.0-rc.8 wants every top-level key to be a credential ref with a
  string value, throws a `TypeError` on the `version` number, and one failed
  entry rejects the whole plugin tree. The launcher then restarts the sidecar
  every ~2.6s forever, the window shows a white page or a hanging spinner, and
  the reason goes to a stdout a packaged GUI app cannot print. Six days before
  anyone connected the two.

  Two halves, both now closed. `launchDshHome` gives a dev run `~/.dsh-dev`
  unless `DSH_HOME` says otherwise (`tests/unit/dsh-home.spec.ts`), so this
  repo stops being a cause — though nothing stops the `dsh` CLI, another
  checkout, or the next format change. And the *silence* is fixed rather than
  the trigger: `SidecarLog` writes sidecar output to
  `userData/logs/sidecar.log` (tray → Open Logs Folder) and `teeConsole` sends
  the launcher's own `console.warn`/`error` to the same file — a tee rather than
  a rewrite, because those calls live in eight modules and the next one written
  should be covered too. `console.log` is deliberately left out of the tee: the
  sidecar's lines already reach the log through `Sidecar`'s `onLog`, so teeing
  it would double every one of them. `restart-policy`
  budgets the restarts and the page-load retries, and running out of budget
  serves `failure-page` — the error, the log path, and the tail — instead of a
  blank window. Crash recovery now reloads the page too, which is the half of
  `Sidecar.restart`'s contract only `market/restart` was keeping.

  What a green build still does not prove here: the budgets are unit-tested
  against their own arithmetic, not against a real collapse. Both were verified
  once by hand, by writing `version: 2` into `~/.dsh-dev/.credentials.yaml` and
  watching the log — and that is how the first retry budget was caught doing
  nothing, because `did-finish-load` on the failure page reset its counter. If
  you touch either policy, re-run that: plant the file, launch with
  `--user-data-dir`, and read the log.
- **A CJS dependency's named exports, under the loader that actually runs.**
  `electron-updater` defines `autoUpdater` as a lazy getter on `module.exports`.
  cjs-module-lexer cannot see a getter, so Node's native ESM interop never
  surfaces it as a named export — but the `.d.ts` declares it, so
  `const { autoUpdater } = await import('electron-updater')` compiles clean and
  binds `undefined`. That line shipped from the commit that added
  `src/updater.ts`, which means auto-update **never worked in any release**:
  every four-hourly check and every "Check now" died on `Cannot set properties
  of undefined (setting 'autoDownload')`. An app that cannot update itself also
  cannot be moved off a bad state format, which is how it compounded with the
  `$DSH_HOME` entry above.

  The trap worth remembering is the test, not the bug. Vitest loads CJS through
  Vite's interop, which DOES expose the getter as a named export — so the
  obvious unit test passes on a loader that does not have the defect, printing
  green over it. `tests/contract/updater-interop.spec.ts` spawns the real
  binary instead, the way `native-tools.spec.ts` does, and
  `tests/unit/updater-interop.spec.ts` guards the source form. Verified by hand
  in a real Electron app: `import()` throws the user's exact message,
  `require()` sets the property.
- **`ELECTRON_RUN_AS_NODE` inheritance** — set once on the sidecar and relied on
  by every descendant that re-executes `process.execPath`. The day upstream
  passes an explicit env to such a spawn, the child boots a GUI Electron instead
  of Node.
- ~~**`harness.json`'s node major vs upstream's `engines.node`**~~ — compared now,
  in `scripts/node-pin.mjs` via `stage-harness`. It has been `(unspecified)`
  upstream in every version pinned so far, which is why the gap was invisible;
  `tests/unit/node-pin.spec.ts` is the only evidence the check works.
- **Platform-specific packages are chosen by the build host, not by the target.**
  The one that already shipped: four releases of the Intel macOS build carried
  arm64 `koffi`, `ripgrep` and `sharp`, and nothing failed anywhere.
  `verify-payload.mjs --platform/--arch` asserts it now, and the Intel target is
  gone; the entry stays because re-adding a cross build is a two-line matrix edit
  and the symptom was silence. See the matrix comment in `build.yml`.
- **The macOS update feed covered one architecture** while there were two mac
  jobs: app-builder-lib arch-suffixes the manifest only on Linux, so both wrote
  `latest-mac.yml` and only one could survive — on `0.1.0-desktop-v0.8.0` they
  even landed in *separate* drafts, and that release ships a hand-merged feed
  naming all four mac artifacts, x64 first, because electron-updater's `findFile`
  matches a url containing `process.arch` and otherwise falls back to the first
  entry. Moot with one mac job, and it returns the day a second one appears.
  Inert either way while `macUpdatesSigned` is false, since the mac path reads
  nothing from the file but `version:`.
- **`NODE_OPTIONS` is appended for every Node descendant on Windows**
  (`packages/bundle/lib/boot.js`) with no version check. `--import` needs Node
  18.18+ / 20.6+; a project whose own tooling runs an older Node inside the
  harness shell gets a hard startup failure on every `node` invocation, not a
  degraded console fix. Nothing tests this, because the harness's own Node is far
  newer.
- ~~**`test:contract` skips silently without a staged harness.**~~ Fixed:
  `tests/contract/stage-present.spec.ts` does not skip, so a missing stage fails
  and says what to run instead of printing green over nothing.

When you learn a new one of these, pin it in `tests/contract` and add it here.
That is the whole point of both files.
