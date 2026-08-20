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

Before publishing, check the feed rather than assuming:

```sh
curl -sSL https://github.com/xxsLuna/deepseek-harness-desktop/releases/download/v<version>/latest.yml
# version: must match package.json exactly
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
- **The macOS update feed covers one architecture.** Both mac jobs write one
  `latest-mac.yml` and the last upload wins. Inert while `macUpdatesSigned` is
  false; **fix it before enabling mac signing** — see the note above `mac:` in
  `electron-builder.yml`.
- **`test:contract` skips silently without a staged harness.** A skip is
  indistinguishable from a pass in exactly the situation the suite exists for.

When you learn a new one of these, pin it in `tests/contract` and add it here.
That is the whole point of both files.
