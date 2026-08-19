# Working on this repo

This is an **unofficial desktop port of DeepSeek Harness**, and it keeps the
harness's own motto: *everything is a plugin*. Two commitments follow from that
and they outrank convenience:

1. **No upstream file is ever edited.** `scripts/stage-harness.mjs` does a plain
   `npm install` of the pinned `@deepseek-ai/dsh` and copies our packages in
   beside it. There is no patch step, no vendored fork, no shadowing file. If a
   change seems to need one, the design is wrong — find the seam instead.
2. **The pinned version keeps moving.** Upstream is tracked, not frozen
   (`harness.json`, and the daily bump workflow). Anything that depends on
   upstream internals must be asserted in `tests/contract` so a version bump
   fails loudly and names the broken seam, instead of shipping a subtly broken
   app.

## Plugin-first is the default, not the fallback

Before writing a line of new behaviour, ask **"can this be a plugin row?"** and
only reach for the launcher when the answer is genuinely no. In order:

1. **A harness plugin** — a package under `packages/`, composed as a row in
   `packages/bundle/cordis.patch.yml`. This is where new behaviour belongs.
2. **A client (browser) plugin** — the same, with a `dsh.client` field and a
   `lib/client.js` bundle. Upstream's UI is built from slots and expects to be
   extended this way.
3. **The Electron launcher** (`src/`) — only for what no plugin can reach.

Keep one concern per package. When something in an existing package turns out to
be a different concern, split it out rather than letting the package grow: the
title band started inside `@dsh-desktop/bundle` and became `@dsh-desktop/chrome`
for exactly that reason.

### Extension points that are known to work

Verified in this repo, so reach for these before inventing anything:

- `ctx.webServer.tapIndex(fn)` — transform the served `index.html`
  (`@dsh-desktop/chrome`).
- `ctx.webServer.register({kind:'exact', path, handler})` — own a route
  (`@dsh-desktop/bundle`'s SSE downlink).
- Provide a service upstream injects, in place of the row you disabled:
  `webServer` (`@dsh-desktop/carrier`), `directoryPicker`
  (`@dsh-desktop/picker`).
- `ctx.slots.register({name, id, order, label}, Component)` — contribute UI.
  The settings shell owns no copy of its own and renders its registrants, so
  `settings.section` adds a whole settings page (`@dsh-desktop/settings`).
  Other seats: `settings.general.item`, `shell.overlay`, `settings.action`.
- Plugin config arrives through the patch row, not `process.env` inside the
  module. Values the launcher decides are passed with `!!js process.env.X` at
  the row, so the launcher stays the single place the decision is made.

### What genuinely cannot be a plugin

The Electron launcher in `src/`. It is the process that *spawns* the harness,
so it runs before any plugin exists and owns things no plugin can reach: the
window and its title bar, the tray, native menus and dialogs, notifications,
downloads, the updater, and the `dsh://` protocol handler. Desktop preferences
live there too, because every one of them is a fact about the window rather
than the session.

When a plugin needs something the launcher owns, do **not** move the plugin into
the launcher. Cross the boundary instead:

- **Page → launcher:** POST to `/__desktop-host/…`, which the protocol handler
  answers before the socket proxy forwards anything (`src/desktop-host.ts`). No
  preload ships, so this is the channel — there is no `ipcRenderer`.
- **Harness → launcher:** a request over the carrier socket under
  `/desktop/…`, which is refused to the renderer (`isHostOnlyPath`). This is
  how the directory picker reaches the launcher's dialog.
- **Launcher → page:** `webContents.executeJavaScript` writing a root
  attribute the CSS keys off (the fullscreen and navigation states).

## The payload is pruned, never bundled

`scripts/prune-payload.mjs` strips what the app never loads from the staged
tree — sourcemaps, declarations, TypeScript sources, PDBs, docs, test trees,
foreign-platform prebuilds, sharp's wasm fallback. On 0.1.0-rc.6/win32-x64 that
is 112MB and 19,893 of 32,796 files. The **file count** is the goal, not the
bytes: NSIS writes files one at a time and Defender scans each, which is what
made installation slow.

Do not replace this with a bundler. The harness resolves plugins by *name at
runtime* — `import(name)` in `@deepseek-ai/cordis-plugin-loader`, where `name`
is a string read from a patch YAML — so no static analysis can see the roster
(195 `@deepseek-ai` packages, 574 manifests). A bundle would also break
`dsh plugin add`, which installs into a profile with pnpm and resolves peers
upward through this very `node_modules`. Pruning keeps the tree a real,
resolvable npm tree, which is why it costs the plugin architecture nothing.

Two rules hold the safety:

- **Manifest-derived guard.** `entryPointPaths` reads every `main`, `bin` and
  `exports` target, so a blanket glob can never delete a live entry. This is
  what protects `node-fetch` (main is `src/index.js`) and the `.mts` in
  `eventsource`'s exports map — and protects the *next* such package by
  construction, rather than by an allowlist someone must remember.
- **Wildcard exports yield to `NEVER_RUNTIME`.** A package exporting
  `"./lib/*"` nominally exposes every file under it, but nothing imports a map
  or a declaration through it. Letting those wildcards win silently kept half
  the tree's sourcemaps.

`src/` is deliberately **not** swept: two packages resolve their entry into it,
and 18MB is not worth a resolution failure class that shifts on every bump.

`tests/contract/pruned-payload.spec.ts` asserts the whole roster still resolves
after pruning. Its assertions read the surviving tree rather than the removal
list, so they hold whether or not the prune has already run — CI prunes before
the contract suite, so the boot tests exercise the tree the installer ships.

## Conventions

- Comments say **why**, not what — especially where a line encodes something
  that was measured rather than assumed. Several decisions here look arbitrary
  until you know the measurement behind them; keep that context in the file.
- Prefer pure, testable functions for anything with a rule in it
  (`parseDesktopSettings`, `titleBand`, `updateMode`, `clampWindowState`), and
  unit-test those rather than mocking Electron.
- When you discover a platform fact the hard way, pin it in a test. Silent
  breakage is the enemy: a wrong icon size, a missing `.ico` frame, or a
  renamed upstream CSS local all fail at runtime with no error otherwise.
- `npm run build` before running; `npm test` (unit) and `npm run test:contract`
  (needs a staged harness) before calling anything done.
