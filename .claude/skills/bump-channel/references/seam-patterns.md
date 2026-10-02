# Seams that have moved, and what each one looked like

Worked examples from real bumps. Read these to recognise the *shape* of a
failure, not to look up a specific fix — the value is that each one produced a
symptom that pointed somewhere other than the cause.

The common lesson: **the error names the slot, not the call.** A moved argument
reports a type error about a parameter; a missing row reports an empty list; a
renamed export reports a module error. None of them says "this moved".

---

## 1. A function lost its home (0.1.2)

`@deepseek-ai/dsh-host-apiproxy` stopped existing. `packages/connection` had
**subclassed** `AbstractApiClient` from it and reimplemented the connection loop
beside it — its own header admitted the loop "mirrors the upstream
package-internal controller".

**Symptom:** `npm run build` died in esbuild before anything booted.

**Fix shape:** not a new import — a different seam. `globalThis.__DSH_TRANSPORT__`
is upstream's own carrier-override hook, so the package installs
`fetch`/`openStream` hooks instead of reimplementing the client half. 291 lines
became 129.

**What it taught:** a declared export is not automatically a safe seam. The
import path was legitimate; the *coupling shape* was not. Copying an internal
controller means the behaviour you need has no seam yet.

---

## 2. A guard was deleted, and nothing failed (0.1.5)

`@dsh-desktop/layout-memory` restored the sidebar by calling
`ctx.layout.toggleSidebar()` once and treating a throw as "not ready yet".
0.1.5 deleted that throw, so the call always succeeded and the retry loop never
ran.

**Symptom:** none. The preference was written, the plugin loaded,
`tests/contract/layout-surface.spec.ts` was green — and the sidebar came back
expanded.

**Why the suite missed it:** the test asserted the attribute exists and the
method is on the face. Both were still true. What changed was *when* the lever
becomes effective and *which* field it moves — behaviour, not surface, and an
existence test cannot see behaviour.

**Fix shape:** a bounded reconcile loop that asks upstream for no promise about
timing, plus a test that drives the rule against upstream's own actions
transcribed verbatim.

---

## 3. A registry was replaced by a different model (0.1.7)

`settings.register(ns, schema, {base})` is gone. There is no namespace registry:
a plugin's own `Config` is the settings form, read with `describe()` and written
with `update(<entry id>, patch)`. A field must be marked `volatile()` or
`write` refuses the entry outright ("no volatile fields").

**Symptom:** `/market/sources` answered 503 "the settings service is not
mounted" — while `/market/installed` answered 200. The service *was* mounted;
only the method was gone, and the inject callback failed silently.

**Fix shape:** fold the schema into `Config`, move the default into the schema
(which preserves removability — a user who clears the list writes `[]` into
their own layer), and let `NS` be what it now is: the row id, because
`update` resolves it against the profile's entries.

**Bonus the failure exposed:** reading the list never needed the service. The
503 moved below the GET, so a build without the settings row serves the
marketplace read-only instead of refusing to describe itself.

---

## 4. A declaration became a list (0.1.7)

`dsh.bundle.patch` used to be one file. `dsh-web-app` now declares **five** —
its own `cordis.patch.yml` plus `presets/{standard,ptc,minimal,cordis}.patch.yml`
— because an agent preset became a composed row
(`name: '@deepseek-ai/dsh-agent-preset'`) rather than a directory the registry
scanned.

**Symptom:** `agent-preset/not-found: Unknown agent preset: standard,
available: []` on every `session/create`. Nothing said "a patch file was
skipped".

**Fix shape:** `bundlePatchPaths` is upstream's own resolver for the
declaration. Ask the package instead of naming the file, and a sixth file needs
no change.

**What it taught:** this is the one that vindicated a comment. The
`agent-presets` overlay had been provably dead for releases — its configured
root did not exist — but its comment's *claim*, that without a preset every
session fails, was true and untested. Deleting the code and turning the claim
into a `session/create` test is what caught this.

---

## 5. A function grew arguments (0.1.7)

`wireStream.open(endpoint, payload, signal)` became
`open(endpoint, payload, uplink, peer, signal)` — the signal moved **last**.

**Symptom:** `$events: signals[0] is not of type AbortSignal`. The signal had
landed in `uplink`, which `$events` releases before reading the signal, so the
message named a slot nobody passed anything to.

**Fix shape:** pass `undefined` for `uplink` and `peer` deliberately, and say
why in the comment — `uplink` is the client-to-server half of a duplex stream
this bridge does not have, `peer` identifies a caller across the WebSocket mux
and this is a local host transport.

---

## 6. A row was renamed (0.1.7)

`agent-presets` → `agent-preset-registry`, same `config: {default: standard}`,
different package.

**Symptom:** `tests/contract/upstream-rows.spec.ts` failed by name. This is the
suite working exactly as intended — the one failure in this list that pointed
straight at its own cause.

**Fix shape:** the row this app *depends on* is still worth naming in that spec
even when the app does not patch it, so a second rename fails by name rather
than becoming an app that opens and cannot start a session.

---

## 7. The whole resolution mechanism changed (0.1.7)

`healProfilesModuleFallback` — which wrote `<profile>/.dsh-module-fallback` and
a symlink per package — is gone. `createRuntimeResolution` runs the same BFS in
memory and `PluginPackages` installs it over Node's ESM and CJS resolvers.

**Symptom:** `does not provide an export named 'healProfilesModuleFallback'`,
and the sidecar exited during startup.

**Fix shape:** two `createRuntimeResolution` calls (the anchors are unchanged —
our packages are copied in *beside* the dsh tree rather than depended on by it)
unioned over `entries` alone, handed to `PluginPackages` from `boot`'s
`prepare` hook, which upstream documents as after the Loader and before any
entry mounts. Plus `removeLinkProjections(dir)` once per boot: upstream wrote
that migration for the directory the old backend left behind, and naming it
after "the dsh 0.1.5 releases" is how you know it is meant for this app.

**What it also fixed:** that link farm is the shape that once emptied 271
packages when a plugin removal walked through one of its junctions. Asserting
the directory is *absent* is now worth a test of its own.

---

## 8. A row grew a gate, and nothing failed at all (0.1.7)

`dsh-base` started composing `settings`, `config-editor`, `plugin-manager` and
`hmr` with `disabled: !!js "!ctx.get('profileContext')"`, and `dsh-web-app`
gated `ui-sidebar-browser` on `?.name !== 'desktop'`. `profileContext` is
provided by upstream's own profile boot — the entry this surface replaces, so
the app inherited every gate and none of the thing they gate on.

**Symptom:** none. This is the only entry in this list with no failure to
recognise. The bump went green, the release shipped, the app opened, the
sidecar logged `dsh-desktop: ready`. A user found it days later on the Models
page: `Loading the provider directory failed: settings service is absent`.

**Why every existing test missed it:** `upstream-rows.spec.ts` asks whether the
rows this app *patches* still exist — these were neither patched nor missing.
`sidecar.spec.ts` asks whether the boot succeeds — it did. A gated-off row is
indistinguishable from a healthy composition unless something *calls* the
service.

**Fix shape:** provide the service from `prepare` in
`packages/bundle/lib/boot.js`, inside the profile guard, with the fields
upstream's own object carries. Replacing an entry means inheriting what it
provided — that is the general rule, and this is the second time it has cost
something (`web-startup` is the entry; 0.1.2's `connection` was the first).

**What to do on the next bump:** `tests/contract/upstream-gates.spec.ts` now
extracts every `ctx.get('…')` out of every `!!js` expression in the upstream
patch files and fails on a name this app has not answered. If it fails, open
the row, work out what the gate protects, and either provide the service or
record what being without it costs. Do not add the name to make it pass.
