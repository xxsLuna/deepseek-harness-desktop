# The Electron pin, and why it is exact

Since 0.1.7 the harness reaches Node's internals through
`node-addon-require-builtin`, and that addon fingerprints the **exact V8 build**
rather than a Node or Electron version range. The prebuilt binary carries three
fingerprints, and anything else is refused at boot.

## The table

Read it out of the binary rather than trusting this file, because upstream may
widen it:

```powershell
$b = "build/harness/node_modules/node-addon-require-builtin-win32-x64-msvc/prebuilt/win32-x64-msvc-napi-v9.node"
$text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($b))
[regex]::Matches($text, '[\x20-\x7E]{8,60}') | ForEach-Object { $_.Value } |
  Where-Object { $_ -match 'electron' } | Select-Object -Unique
```

As measured on addon 0.1.6 and 0.1.7 (identical tables):

| V8 fingerprint | Electron releases |
| --- | --- |
| `15.0.245.13-electron.0` | 43.0.0, 43.1.0 |
| `15.2.124.13-electron.0` | **44.0.0** |
| `15.4.80-electron.0` | 45-alpha, 46-nightly (no stable) |

Map a fingerprint to releases with Electron's own data — do not guess:

```powershell
$rel = (Invoke-WebRequest -Uri "https://releases.electronjs.org/releases.json" -UseBasicParsing).Content | ConvertFrom-Json
$rel | Where-Object { $_.v8 -eq '<fingerprint without the -electron.0 suffix>' } | Select-Object version,v8,node
```

## Why the pin is exact, not a caret

`^44.0.0` resolves 44.5.1, whose V8 is `15.2.124.28` — not in the table. The app
would **refuse to boot**, and the message names a V8 build rather than a call,
so it reads like an upstream fault:

```
unsupported Electron runtime fingerprint: Node 24.18.1, V8 15.2.124.28-electron.0
  (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6)
```

`npm install --save-dev electron@<v>` writes a caret. Correct it to the bare
version afterwards, and check `package-lock.json` resolved the same.

## Checking a candidate before committing to it

Run the addon under the real binary. This is five minutes and it is the
difference between knowing and assuming:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "node_modules\electron\dist\electron.exe" <probe.cjs>
```

where the probe loads `node-addon-require-builtin` and calls `requireBuiltin`
for all five modules `internalModules()` wants:
`internal/modules/{esm/loader,cjs/loader,helpers,esm/utils,esm/resolve}`.

Then run `npm run test:contract` — `tests/contract/native-tools.spec.ts` exists
for exactly this question and boots Node major, NAPI level, `node:sqlite`,
worker threads, `node-pty` and the packaged ripgrep under the real binary.
`CLAUDE.md` records three divergences found the hard way here; none was
hypothetical.

## The proper fix, which is upstream's

`internalModules()` goes straight to the addon with no alternative. Upstream's
own `cordis-plugin-loader` needs the same internals and gets them, because its
`requireInternal(id)` tries `--expose-internals` **first** and treats the addon
as the fallback, swallowing failures:

```js
if (process.execArgv.includes("--expose-internals")) try { return require(id) } catch {}
try { return require("node-addon-require-builtin").requireBuiltin(id) } catch {}
```

The launcher already passes `--expose-internals` (`src/sidecar.ts`), and all
five internals plus every interface `internalModules()` type-checks were
verified present that way on Electron 43.4.0. So the ask upstream is a fallback
rather than a feature, and until it lands the pin is the only lever.

If the user wants that reported, the evidence above is the report. Do not file
it without asking — it is outward-facing, and search for an existing issue
first.
