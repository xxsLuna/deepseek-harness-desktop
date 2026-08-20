# DeepSeek Harness Desktop

**Unofficial** desktop app for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — run `dsh` as a single application on macOS, Windows, and Linux.

This project is not endorsed by or affiliated with DeepSeek AI. It bundles the official, unmodified [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) packages together with a dedicated Node.js runtime inside an Electron shell.

## What it does

DeepSeek Harness ships a Web UI served by a local HTTP server (`dsh web`). This app turns that into a desktop program:

- **One icon, one window** — no terminal, no browser tab.
- **No open TCP ports** — the harness listens on a Unix domain socket (macOS/Linux) or a named pipe (Windows) instead of an HTTP port; the window talks to it over an internal `dsh://` scheme.
- **The harness itself is untouched** — the upstream packages run exactly as published. The transport is swapped through the harness's own plugin composition layer, not by patching its code.
- **Desktop integration** — tray icon, notifications for approvals and finished turns, global shortcut, deep links, auto-update (Windows/Linux).

## Install

Download the installer for your platform from [Releases](https://github.com/xxsLuna/deepseek-harness-desktop/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon / Intel) | `.dmg` |
| Windows x64 | `.exe` (NSIS) |
| Linux x64 / arm64 | `.AppImage`, `.deb` |

Builds are currently **unsigned**: macOS will ask you to right-click → Open the first time, and Windows SmartScreen will show a warning. For the same reason macOS cannot self-update — Squirrel.Mac validates the signature — so the app points you at the releases page there, while Windows and Linux update themselves.

## First run

1. Open **Settings → Models** and enter your DeepSeek API key.
2. Click **Choose workspace** and pick a project directory.
3. Start a session.

Sessions, credentials, and settings live in `~/.dsh`, shared with the `dsh` CLI if you also use it.

## Versioning

The version in front is upstream's, unchanged: `0.1.0` is
`@deepseek-ai/dsh@0.1.0-*`. Everything about the desktop build lives in the
pre-release part:

```
0.1.0-desktop-v0.8.0
  ^      ^     ^ ^ ^
  |      |     | | +-- this shell's build of that harness (0, 1, 2 ...)
  |      |     | +---- upstream's rc number (8, 9, 10, 20 ...)
  |      |     +------ this shell's own scheme number, if it ever has to change
  |      +------------ the desktop shell
  +------------------- upstream's version, never touched here
```

`harness.json` stays the authority on which upstream is pinned; this is just the
same fact carried where an installer filename and an update feed can see it.

**Each number is its own dot-separated field on purpose.** semver compares a
pre-release field as a *number* only when it contains nothing else, and as TEXT
otherwise — and text compares character by character, so `10` sorts below `9`.
The previous scheme appended a build counter with a hyphen (`0.1.0-rc.6-3`),
which put the upstream number inside a text field and meant a plain
`0.1.0-rc.7` was *older* than `0.1.0-rc.6-3` and would have been offered to
nobody. Splitting the numbers out removes that entirely:
`tests/unit/version-scheme.spec.ts` checks every ordered pair across a wide
sweep and expects no inversion.

Releases before `0.1.0-desktop-v0.8.0` were named `0.1.0-rc.<n>[-<build>]`, and
the new scheme is **deliberately unreachable from them** — `desktop-v0` sorts
below `rc` because `d` precedes `r`. Anything installed from those needs one
manual download; after that it updates normally. That asymmetry is asserted, not
just written down, so nobody renames the scheme back into the `rc` line by
accident.

A daily workflow watches npm and opens a bump PR when upstream publishes; the
PR's checks re-run the sidecar contract suite, so a green bump PR is releasable
as-is. It writes the bare upstream version into `package.json`, which is not a
version this scheme accepts — correct it to the form above before releasing, and
the unit suite will say so if you forget.

Only the root `package.json` carries the release version — electron-builder reads
it, and everything at runtime goes through `app.getVersion()` or `harness.json`.
The `packages/*` manifests are not maintained against it and drift.

## How it works

The app is a thin Electron shell around the **unmodified** published harness:

- `scripts/stage-harness.mjs` installs the pinned `@deepseek-ai/dsh` tree; six small plugin packages of ours are composed in through the harness's own patch-layer system (no upstream file is edited):

| package | what it is |
| --- | --- |
| `@dsh-desktop/carrier` | a `webServer` provider listening on a socket path with a bearer token, instead of a TCP port |
| `@dsh-desktop/connection` | the transport row: upstream's `/api` node half, with an SSE browser carrier replacing the WebSocket one (WebSockets cannot ride a custom scheme) |
| `@dsh-desktop/picker` | a `directoryPicker` provider delegating the pick to the launcher's window-owned dialog |
| `@dsh-desktop/chrome` | the merged title band, injected into the served document; the launcher configures its height, leading inset and menu button through the patch layer |
| `@dsh-desktop/settings` | the **Desktop Settings** section, registered into upstream's `settings.section` slot. Its values are launcher facts (close behaviour, notifications, title bar, auto-update), so its browser half talks to the launcher rather than the sidecar |
| `@dsh-desktop/bundle` | the surface glue — dist fallback owner, the two SSE event routes, the desktop-surface prompt section and `DSH_SURFACE` — plus the sidecar boot entry and the patch layer that composes all of the above |

  Everything the harness process does differently for the desktop is one of those rows. What cannot be a row is the Electron launcher in `src/`: it is the host process that *spawns* the harness, so it runs before any plugin exists and owns things no plugin can reach — the window and its title bar, the tray, native menus, notifications, downloads, the updater, and the `dsh://` protocol handler.
- The main process spawns that tree on its own Electron binary under `ELECTRON_RUN_AS_NODE`, so every native prebuild stays valid — no Electron ABI rebuilds, and `node-pty`, the packaged ripgrep and `node:sqlite` all keep working. No second Node runtime ships, which is 89MB the installer does not carry; `tests/contract/native-tools.spec.ts` asserts the ABI holds rather than assuming it. `protocol.handle('dsh')` proxies the window's requests to the socket.
- Coupling to upstream is confined to the seams asserted by `tests/contract` — the version-tracking canary.

### What running inside a desktop app changes

Some upstream behaviour assumes the harness is the foreground GUI process, or a
browser. Those assumptions are met here rather than patched upstream:

- **The folder picker.** Upstream opens an OS chooser from the harness process; a background sidecar can create one but never bring it forward. The pick is delegated to the launcher's own window-modal dialog.
- **PATH.** A Finder, Dock, or `.desktop` launch inherits the session manager's minimal environment, so the agent's shell tools would not find `git`, `node`, or anything else installed through a shell profile. The user's login shell is asked once at startup.
- **Exports.** A page-initiated download is a no-op in Electron without a handler; session exports land in the OS download folder and the notice reveals the file.
- **The title bar** is merged into the UI on macOS and Windows: macOS floats the traffic lights over the page, Windows hides the frame and keeps its caption buttons in a transparent Window Controls Overlay, and in both cases the page paints the band the launcher freed. Linux keeps its native frame, and the served stylesheet insets nothing there.
- **Desktop preferences** live with the launcher, not the harness: what closing the window does, which events raise an OS notification, whether the title bar is merged, whether the app updates itself. `@dsh-desktop/settings` renders them as a Settings section and reads and writes them over the same `/__desktop-host/` route the band's controls use. The title bar is a window-construction option, so changing it says so and applies on restart.
- **The menu bar** is hidden where the window would draw one (Windows, Linux) rather than sitting between the band and the UI; Alt still reveals it, and the band's menu button pops the same template up as a list. The band's controls are drawn by the page but acted on by the launcher — no preload ships, so they post to a `/__desktop-host/` route the protocol handler answers ahead of the sidecar. Back and forward follow the window's real navigation history, which a single-page harness UI never adds to, so they stay dimmed.

## Branching

`main` is protected and only moves through a pull request whose checks passed:

```sh
git switch dev
# commit your work
git push
gh pr create --base main --head dev --fill
# once all-targets-built is green
gh pr merge --squash   # or --merge
```

`dev` is the integration branch — commit there, and the daily upstream bump
opens its pull request against it too. Releases are cut from `main`: pushing a
`v*` tag refuses to build unless the tagged commit is on `main`.

The one required check is `all-targets-built`, which passes only when all five
platform jobs did. The matrix jobs are not required individually because their
check names embed the matrix values, so editing an entry would rename a
required check and block every pull request.

## Development

Everything is project-local (`node_modules`), nothing is installed system-wide:

```sh
npm ci
npm run stage        # install the pinned harness into build/harness
npm run build        # compile main, build the client bundle, restage local packages
npm run prune:dry    # report what packaging would strip from build/harness
npm run dev          # launch the app
npm test             # unit tests
npm run test:contract  # boot the sidecar over a socket and assert the coupling contract
```

Docker equivalents (checks and Linux packaging): `docker compose -f docker/compose.yml run --rm ci` / `... run --rm build`.

`tests/contract` is the version-tracking canary: it boots the staged harness over a socket without Electron and asserts every seam this app depends on — the transport, the agent presets, session creation and export, the interaction plane, and the native tool paths (`node-pty`, the packaged ripgrep, `node:sqlite`). An upstream bump that breaks one of them fails there by name.

Packaging locally: `npm run prune && npx electron-builder --<mac|win|linux>` then `node scripts/verify-payload.mjs <resources dir>` and `node scripts/smoke-packaged.mjs`.

`npm run prune` is destructive on `build/harness` and pass-specific: it strips
the sourcemaps, declarations, docs, test trees and foreign-platform prebuilds
that the staged tree carries but the app never loads, taking it from 221MB and
32,796 files to 109MB and 12,903 files. Add `--platform`/`--arch` when
cross-building. Run it after `npm run build`, never before — `build` restages
the local packages.

It is a packaging step, not a dev step: `npm run typecheck` compiles
`packages/connection` and `packages/settings` against the staged tree's
declarations, so run `npm run stage` to restore the full tree before
typechecking. `npm test` and `npm run test:contract` pass either way, and CI
prunes after building so the contract suite exercises the tree that ships.

## License

[MIT](LICENSE). DeepSeek Harness is © DeepSeek AI, MIT-licensed — see [NOTICE](NOTICE).

