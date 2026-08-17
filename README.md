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

The app version tracks the upstream harness version exactly. A desktop release `v0.1.0-rc.6` bundles `@deepseek-ai/dsh@0.1.0-rc.6`; a desktop-only fix appends a build counter (`v0.1.0-rc.6-2`).

## License

[MIT](LICENSE). DeepSeek Harness is © DeepSeek AI, MIT-licensed — see [NOTICE](NOTICE).
