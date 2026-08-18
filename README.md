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

Builds are currently **unsigned**: macOS will ask you to right-click → Open the first time, and Windows SmartScreen will show a warning.

## First run

1. Open **Settings → Models** and enter your DeepSeek API key.
2. Click **Choose workspace** and pick a project directory.
3. Start a session.

Sessions, credentials, and settings live in `~/.dsh`, shared with the `dsh` CLI if you also use it.

## Versioning

The app version tracks the upstream harness version exactly. A desktop release `v0.1.0-rc.6` bundles `@deepseek-ai/dsh@0.1.0-rc.6`; a desktop-only fix appends a build counter (`v0.1.0-rc.6-2`). A daily workflow watches npm and opens a bump PR when upstream publishes; the PR's checks re-run the sidecar contract suite, so a green bump PR is releasable as-is.

## How it works

The app is a thin Electron shell around the **unmodified** published harness:

- `scripts/stage-harness.mjs` installs the pinned `@deepseek-ai/dsh` tree; four small plugin packages of ours are composed in through the harness's own patch-layer system (no upstream file is edited): a `webServer` provider that listens on a socket path with a bearer token, an SSE browser carrier replacing the WebSocket one (WebSockets cannot ride a custom scheme), a directory picker that delegates to the launcher's dialog, and the desktop bundle overlay.
- The main process spawns that tree under a bundled stock Node, so every native prebuild stays valid — no Electron ABI rebuilds, and `node-pty`, the packaged ripgrep and `node:sqlite` all keep working. `protocol.handle('dsh')` proxies the window's requests to the socket.
- Coupling to upstream is confined to the seams asserted by `tests/contract` — the version-tracking canary.

### What running inside a desktop app changes

Some upstream behaviour assumes the harness is the foreground GUI process, or a
browser. Those assumptions are met here rather than patched upstream:

- **The folder picker.** Upstream opens an OS chooser from the harness process; a background sidecar can create one but never bring it forward. The pick is delegated to the launcher's own window-modal dialog.
- **PATH.** A Finder, Dock, or `.desktop` launch inherits the session manager's minimal environment, so the agent's shell tools would not find `git`, `node`, or anything else installed through a shell profile. The user's login shell is asked once at startup.
- **Exports.** A page-initiated download is a no-op in Electron without a handler; session exports land in the OS download folder and the notice reveals the file.
- **The title bar** is merged into the UI on macOS only. Windows and Linux keep their native frame, and the served stylesheet insets nothing there.

## Development

Everything is project-local (`node_modules`), nothing is installed system-wide:

```sh
npm ci
npm run stage        # install the pinned harness into build/harness
npm run build        # compile main, build the client bundle, restage local packages
npm run dev          # launch the app
npm test             # unit tests
npm run test:contract  # boot the sidecar over a socket and assert the coupling contract
```

Docker equivalents (checks and Linux packaging): `docker compose -f docker/compose.yml run --rm ci` / `... run --rm build`.

Packaging locally: `npm run fetch-node && npx electron-builder --<mac|win|linux>` then `node scripts/verify-payload.mjs <resources dir>` and `node scripts/smoke-packaged.mjs`.

## License

[MIT](LICENSE). DeepSeek Harness is © DeepSeek AI, MIT-licensed — see [NOTICE](NOTICE).
