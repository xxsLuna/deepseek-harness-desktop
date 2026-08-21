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

## Plugins

**Settings → Plugins → Marketplace** lists plugins from a curated catalog and installs the ones you pick. Nothing is installed for you: a fresh install has zero plugins, there is no auto-install and no auto-update.

The app ships **only the catalog's URL** — no catalog content and no plugin code. The catalog lives in its own repository ([DeepSeek-Harness-Desktop-Marketplace](https://github.com/xxsLuna/DeepSeek-Harness-Desktop-Marketplace)) so listings can change without an app release, and a plugin is downloaded at the moment you click Install. A catalog is a `.claude-plugin/marketplace.json` file in a repository — the same format the Claude plugin ecosystem uses — so a marketplace needs no site build and no release step. The default source is listed in the tab like any other and can be removed; you can add your own HTTPS catalogs beside it.

### Two kinds of plugin

A catalog can list both, the tab badges which is which, and the installer decides from the downloaded files rather than from what the catalog claimed — a package that turns out to be the other kind is refused rather than installed under the wrong warning.

| | **Skills** (Claude format) | **Extension** (dsh format) |
| --- | --- | --- |
| identified by | `.claude-plugin/plugin.json` | `dsh.bundle.patch` in `package.json` |
| what it is | markdown the agent reads | code the harness loads |
| what it can do | steer the agent through the tools it already has | anything the harness process can |
| lands in | `~/.dsh/claude-plugins/` | `~/.dsh/profiles/desktop/` |
| takes effect | immediately | after a restart |

Claude-format plugins work unmodified because the harness's skill format *is* Claude's: `<name>/SKILL.md`, the same frontmatter keys, the same `references/` and `scripts/` beside it. Copying one into `~/.dsh/claude-plugins/<anything>/<plugin>/` by hand works exactly as well as installing it — the tab lists those too, and says it did not put them there.

Two limits worth knowing. A skill declaring `allowed-tools` is **withheld**, because the harness has no way to enforce a tool restriction and publishing it anyway would silently widen what its author narrowed; the tab names each withheld skill and why. And a plugin's `agents/`, `hooks/` and `.mcp.json` are ignored — the harness has no counterpart for them yet — so a plugin built around those installs and does nothing.

What the app checks before a plugin lands on disk:

- the download matches the digest the catalog published (`sha256` for an archive, the commit `sha` for a git source)
- it is one of the two kinds above, and the one the catalog said it was
- an extension has no runtime `dependencies` — there is no package manager to install them with
- once written, an extension actually resolves — otherwise it is removed again rather than left looking installed

Installed plugins live under `~/.dsh`, outside the app, so an app update never removes them. Extensions are composed when the session server starts, so installing one asks you to restart; if one ever stops the app from starting, the next launch disables all of them, opens anyway, and the tab names the ones it dropped.

A plugin runs inside the harness process with the same access to your files and shell that the agent has. The catalog is curated for that reason, and adding a source of your own is you taking that judgement on yourself.

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

**The upstream number and the build number are each their own dot-separated
field on purpose.** The scheme number in front is not: semver reads the
pre-release as `["desktop-v0", 8, 0]`, so that one is fused into the text field
and only overrides the rest while it stays single-digit.

**Two different semver rules bite here, and confusing them leads to the wrong
conclusion.** First: a field of nothing but digits ranks *below* any field
containing a letter or hyphen. That is why the retired scheme broke — with a
hyphenated build counter, `0.1.0-rc.7` compared `7` against `6-3`, and the
numeric `7` lost to the non-numeric `6-3`, making a plain rc.7 **older** than the
published rc.6-3 and offerable to nobody. Second: two non-numeric fields compare
character by character, so `10-1` sorts below `9-1`. Giving each number its own
all-digits field escapes both: `tests/unit/version-scheme.spec.ts` checks every
ordered pair over a wide sweep.

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

- `scripts/stage-harness.mjs` installs the pinned `@deepseek-ai/dsh` tree; seven small plugin packages of ours are composed in through the harness's own patch-layer system (no upstream file is edited):

| package | what it is |
| --- | --- |
| `@dsh-desktop/carrier` | a `webServer` provider listening on a socket path with a bearer token, instead of a TCP port |
| `@dsh-desktop/connection` | the transport row: upstream's `/api` node half, with an SSE browser carrier replacing the WebSocket one (WebSockets cannot ride a custom scheme) |
| `@dsh-desktop/picker` | a `directoryPicker` provider delegating the pick to the launcher's window-owned dialog |
| `@dsh-desktop/chrome` | the merged title band, injected into the served document; the launcher configures its height, leading inset and menu button through the patch layer |
| `@dsh-desktop/settings` | the **Desktop Settings** section, registered into upstream's `settings.section` slot. Its values are launcher facts (close behaviour, notifications, title bar, auto-update), so its browser half talks to the launcher rather than the sidecar |
| `@dsh-desktop/market` | the plugin marketplace: the installer (catalog fetch, digest verification, `git clone` for git sources, its own tar reader — the app ships no package manager), the trusted-source settings namespace, and the **Marketplace** tab registered into upstream's `settings.plugins.tab` slot |
| `@dsh-desktop/claude-plugins` | publishes Claude-format plugins on disk as harness skills, through `ctx.skills.registerProvider`. Separate from the marketplace on purpose: it publishes whatever is under the install root, and the marketplace is only one way for something to get there — the two share a directory layout, not an import |
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

