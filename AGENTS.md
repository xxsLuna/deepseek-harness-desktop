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

**The rewrite cleaned `main`; it did not clean GitHub.** `main` is clean (checked
anonymously: 0 trailers in 50 commits), but GitHub keeps the pre-rewrite objects
and still serves them to anonymous readers:

- `refs/pull/3/head` — a live server-side ref. `pulls/3/commits` returns
  `67e46a3`, `8153843`, `396cfe3`, each with GitHub login `Minsang-MICUBE` and a
  `Co-Authored-By: Claude Opus 5` trailer. The PR's Commits tab shows this.
- **Three orphans**, unreachable from every branch, tag *and* pull ref, yet each
  still `200` at `/commit/<sha>`: `19c3e80` (PR #3's squash-merge commit, five
  trailer lines naming both Claude and `Minsang Cho`), `254a6b7c` and `c46c75bb`
  (the pre-rewrite originals of two rewritten commits, `Minsang-MICUBE` with a
  Claude trailer each). A fourth, `65063fbe`, exists only in local clones —
  GitHub answers `404` for it.

  Enumerate them rather than trusting a remembered list; the first pass at this
  found only `19c3e80` and undercounted by two:

  ```sh
  git cat-file --batch-all-objects --batch-check | awk '$2=="commit"{print $1}' \
    | while read -r s; do git cat-file commit "$s" \
        | grep -qiE 'co-authored-by|generated with \[claude|minsang' && echo "$s"; done
  ```

  A clean local clone is not evidence either way: the objects were pruned here
  with `git reflog expire --expire-unreachable=now --all && git gc --prune=now`
  (safe — all four unreachable commits were the contaminated ones), which stops a
  stray push from republishing them but changes nothing on GitHub. Check the
  remote with `curl`.

Nothing local removes these: no branch points at them, so `git push --force` and
another rewrite change nothing. Removal needs GitHub Support to purge the
unreachable objects and PR refs, or the repo to be recreated (which forfeits the
releases and their download counts). **Do not report this rule as satisfied on the
strength of a clean `git log`** — check the PR refs too.

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

**Pinning ahead of `latest` makes the daily watch propose a downgrade.** Its gate
is `pinned != latest` — inequality, not newer-than — so while the pin is a `next`
release the watch opens a PR walking it *back* to `latest` every day. Check the
gate before pinning ahead of `latest`, or expect to close that PR repeatedly.

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

### After a bump, check the rows patched by id

This is the highest-value manual check, because it is the one thing that fails
with no error at all.

`packages/bundle/cordis.patch.yml` disables six upstream rows **by id**, and
`packages/bundle/lib/boot.js:68` re-asserts the same six unconditionally — with no
`rows.has()` guard, unlike the `agent-presets` (`:75`) and `session-telemetry-otel`
(`:87`) overlays right beside it, which do check. Upstream's patch applier **warns
and skips** an id it cannot find (`dsh-app-boot`: `warn("patch: entry %C not
found", id)`) — it does not throw, and the warning does not surface in the app
log. Adding the guard to that loop, and failing when a targeted id is absent, is
the cheapest way to close this whole class.

```sh
for id in web-startup webserver web-runtime connection client-hmr directory-picker session-telemetry-otel; do
  grep -rqs "id: $id\$" build/harness/node_modules/@deepseek-ai/*/cordis.patch.yml \
    && echo "$id present" || echo "$id GONE"
done
```

What a silently-dropped disable costs, per the comment in `boot.js`: re-enabling
`webserver`/`connection` binds a real TCP port and mounts a WebSocket carrier the
app scheme cannot serve; re-enabling `directory-picker` restores an OS chooser
this process cannot bring to the front.

**Only four of the six are actually silent.** `sidecar.spec.ts` asserts the boot
manifest carries neither `@deepseek-ai/dsh-client-connection` nor
`dsh-client-hmr`, which is exactly what the `connection` and `client-hmr` disables
remove — so a rename of either turns into a red contract test. The unwatched four
are `web-startup`, `webserver`, `web-runtime` and `directory-picker`.

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

- **The automated bump PR writes the bare upstream version** into `package.json`.
  That is not a version this scheme accepts. Correct it by hand; the unit suite
  fails on the shape if you forget.
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

Releases come from `main` only; `release.yml` refuses a tag whose commit is not
on `main`.

```sh
gh pr merge <n> --rebase                  # rebase, not squash — see Attribution
git push --force-with-lease origin <main-sha>:refs/heads/dev   # see below
git tag -a v<version> origin/main -F <message-file>
git push origin refs/tags/v<version>      # triggers the 5-target release build
```

**Realign `dev` after every `--rebase` merge.** GitHub replays the commits onto
`main` with new SHAs and leaves `dev` pointing at the originals, so `dev` ends up
with commits that are not ancestors of `main` while the trees are identical. The
next `dev -> main` PR then re-applies the same changes. Reset `dev` to `main`.

**Publish the draft promptly — do not sit on it.** The tag appears in
`releases.atom` the moment it is pushed, while the assets stay draft-private.
electron-updater's channel walk picks the new tag, fails to fetch its
`latest.yml`, and dies with `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` — swallowed by
the error handler. **Every existing client's update check is broken for as long
as the draft sits.** Verify the feed, write the notes, publish.

### Count the drafts before you publish one

**The five build jobs race to create the release, and can end up creating two.**
All five run `electron-builder --publish always` in parallel (`build.yml`, the
`Package` step); each one creates the draft if it does not already see one, and
two jobs that check at the same moment both create it. On
`0.1.0-desktop-v0.8.0` that produced **two drafts on the same tag** with the
assets split 9/7 and a `latest-mac.yml` in each. `gh release view <tag>` resolves
to just one of them, so publishing "the draft" ships an incomplete release and
orphans the rest — and the feed it publishes describes files that are not there.

Earlier releases got one draft by luck, not by design: the jobs happened to start
far enough apart. Assume it will recur, and check by id rather than by tag:

```sh
gh api repos/xxsLuna/deepseek-harness-desktop/releases \
  --jq '.[] | select(.tag_name=="v<version>") | "\(.id) draft=\(.draft) assets=\(.assets|length)"'
```

There is no move-asset API, so consolidating means download-and-re-upload. Keep
the draft holding the larger byte total and move the other's assets into it — and
**verify each transfer by hash, not by size**: the feeds carry the build's own
`sha512` for every artifact, so a truncated download cannot slip through as a
published installer. Then `DELETE /releases/{id}` the duplicate (by **id** — a
tag-based delete can take the tag with it, and the tag is what `release.yml`
already gated).

A proper fix is to stop the matrix jobs from creating the release at all — one
job creates the draft, the five upload into it. Untested here; it can only be
validated by cutting a release.

Before publishing, check the feed rather than assuming:

```sh
curl -sSL https://github.com/xxsLuna/deepseek-harness-desktop/releases/download/v<version>/latest.yml
# version: must match package.json exactly
```

**Publish as Latest — never tick "Set as a pre-release".** The macOS path fetches
`releases/latest/download/latest-mac.yml` (`src/updater.ts`), so it reads whatever
GitHub currently calls Latest rather than this release's own feed. Leave an older
release as Latest and every mac client on the new version is offered the **older**
one, because `isNewerVersion('0.1.0-rc.7-1', '0.1.0-desktop-v0.8.0')` is `true` —
`rc` outranks `desktop-v0`. electron-publish creates the draft
`prerelease: false`, so the default is already right; this is about not changing
it. Confirm after publishing:

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
npm run prune                 # add --platform/--arch when cross-building
npx electron-builder --<mac|win|linux>
node scripts/verify-payload.mjs <resources dir>
node scripts/smoke-packaged.mjs
```

- **`npm run prune` is destructive and must run after `build`, never before** —
  `build` restages the local packages.
- **`npm run typecheck` needs the unpruned tree.** `packages/connection` and
  `packages/settings` compile against declarations the prune removes. Run
  `npm run stage` to restore; the prune script says so on exit.
- On a **cross build** the prune targets the build's arch, not the runner's, so
  the host's own prebuilds are gone and the harness cannot load. CI therefore
  prunes *after* the test steps for cross builds and *before* them for native
  ones — do not "simplify" that into one step.

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
- **Notification event vocabulary** — `src/notifications.ts` switches on upstream
  frame `type` strings and field names (`approval/requested`, `approvalId`,
  `host/session-status`). A rename kills toasts and the approval badge quietly,
  or leaks the badge count upward.
- **`ELECTRON_RUN_AS_NODE` inheritance** — set once on the sidecar and relied on
  by every descendant that re-executes `process.execPath`. The day upstream
  passes an explicit env to such a spawn, the child boots a GUI Electron instead
  of Node.
- **`harness.json`'s node major vs upstream's `engines.node`** — never compared.
  It has been `(unspecified)` upstream so far.
- **The macOS update feed covers one architecture.** Each mac job writes a
  `latest-mac.yml` listing only its own arch. The mechanism is not
  last-upload-wins as this once said: on `0.1.0-desktop-v0.8.0` the two landed in
  *separate* drafts (see the release section), and consolidating can only keep
  one. Inert while `macUpdatesSigned` is false — the mac path reads nothing from
  the file but `version:` — so it is invisible until the day signing is enabled,
  which is precisely why it is written down. **Fix it before enabling mac
  signing**; see the note above `mac:` in `electron-builder.yml`. That release
  ships a hand-merged feed listing all four mac artifacts, x64 first, because
  electron-updater's `findFile` matches a url containing `process.arch` and
  otherwise falls back to the first entry — and the x64 names carry no `x64`.
- **`NODE_OPTIONS` is appended for every Node descendant on Windows**
  (`packages/bundle/lib/boot.js`) with no version check. `--import` needs Node
  18.18+ / 20.6+; a project whose own tooling runs an older Node inside the
  harness shell gets a hard startup failure on every `node` invocation, not a
  degraded console fix. Nothing tests this, because the harness's own Node is far
  newer.
- **`test:contract` skips silently without a staged harness.** A skip is
  indistinguishable from a pass in exactly the situation the suite exists for.

When you learn a new one of these, pin it in `tests/contract` and add it here.
That is the whole point of both files.
