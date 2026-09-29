/**
 * The launcher takes the hidden console, so nothing below it has to.
 *
 * THE SYMPTOM, TWICE. A console window flashes for every command the harness
 * runs. `packages/bundle/lib/hide-console.mjs` closed it once, by giving each
 * process a console without showing one: attach to the parent's where there is
 * one, allocate-and-hide only as a fallback. That worked because of a fact
 * about the process tree — "the runner's parent IS the sidecar, so the attach
 * succeeds" — and 0.1.5 stopped making that true. A trace taken under a real
 * GUI launch says so in two lines:
 *
 *   pid 24952 | allocated and hid a console (… /bundle/lib/boot.js)
 *   pid 47520 | allocated and hid a console (… /dsh-sandbox-windows-acl/lib/runner.js)
 *
 * The sidecar allocating once at startup is by design. The ACL RUNNER
 * allocating is the bug: `AllocConsole` creates a window and it is visible for
 * the instant before `ShowWindow` hides it, and the runner is a fresh process
 * for every command.
 *
 * WHY FIX IT HERE RATHER THAN THERE. The attach depends on the immediate
 * parent owning a console, so it is a claim about a shape upstream is free to
 * change — and did. A console is INHERITED by every descendant that is not
 * spawned away from it, so one taken at the top of the tree needs no attach
 * anywhere below: the sidecar inherits the launcher's, the runner inherits the
 * sidecar's, the shell inherits the runner's. Whatever upstream puts in
 * between inherits it too. That is the difference between a fix that holds and
 * one that holds until the next bump.
 *
 * WHAT THIS COSTS. One allocate-and-hide in the launcher, at startup, where a
 * single flash is already indistinguishable from the app opening — instead of
 * one per command forever.
 *
 * THE PAIRING THAT MAKES IT WORK. `Sidecar` spawns with `windowsHide: true`,
 * which is what leaves the sidecar no console to pass down. That flag may only
 * be dropped when this launcher actually owns a HIDDEN console, which is why
 * the outcome is a value rather than a boolean — `present` means a console was
 * already there (a dev terminal launch) and it is not ours to hand out.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * What `allocateHiddenConsole()` did in this process. Mirrors the union in
 * `packages/bundle/lib/hide-console.mjs`, which is the one implementation of
 * the rule — the launcher imports it from the staged tree rather than carrying
 * a second copy of the FFI.
 */
export type ConsoleOutcome = 'unsupported' | 'present' | 'attached' | 'allocated' | 'failed'

/** The outcomes that mean this process owns a console it hid itself. */
const OWNED_AND_HIDDEN: ReadonlySet<string> = new Set(['allocated'])

/**
 * Whether the sidecar spawn still needs `windowsHide`.
 *
 * Only `allocated` earns `false`. The other outcomes each have a reason:
 * `present` is a console someone is reading — handing it to the sidecar would
 * put every harness subprocess in the user's terminal; `attached` is a console
 * this process did not create and cannot vouch for being hidden; `failed` and
 * `unsupported` leave the current behaviour exactly as it was, which is the
 * point of having a rule rather than a flag.
 * @param outcome - what the console setup did.
 * @returns the `windowsHide` value for the sidecar spawn.
 */
export function windowsHideFor(outcome: ConsoleOutcome): boolean {
  return !OWNED_AND_HIDDEN.has(outcome)
}

/**
 * Path of the console helper inside the staged tree.
 * @param harnessRoot - the staged harness root, as `resolvePaths()` returns it.
 * @returns the module path.
 */
export function consoleHelperPath(harnessRoot: string): string {
  return join(harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'hide-console.mjs')
}

/**
 * Give this process a hidden console, using the harness's own helper.
 *
 * Imported from the staged tree rather than reimplemented: the koffi calls,
 * the attach-before-allocate ordering and the tracing all have reasons written
 * down in that file, and a second copy here would be a second place for them
 * to drift. It is also the module every descendant loads through
 * `NODE_OPTIONS`, so launcher and sidecar answer to one implementation.
 *
 * Never throws. A launcher that cannot set up a console still starts — it just
 * keeps `windowsHide`, which is where this began.
 * @param harnessRoot - the staged harness root.
 * @param load - injected by the unit tests; production passes none.
 * @param platform - the platform to decide for; defaults to this process's.
 *   Explicit so the rule is testable on the platforms that never take it,
 *   which is where CI runs three of its four targets.
 * @returns what the setup did.
 */
export async function acquireHiddenConsole(
  harnessRoot: string,
  load?: (specifier: string) => Promise<unknown>,
  platform: NodeJS.Platform = process.platform,
): Promise<ConsoleOutcome> {
  if (platform !== 'win32') return 'unsupported'
  try {
    const specifier = pathToFileURL(consoleHelperPath(harnessRoot)).href
    const imported = await (load ?? ((url: string) => import(/* @vite-ignore */ url)))(specifier)
    const allocate = (imported as { allocateHiddenConsole?: () => ConsoleOutcome }).allocateHiddenConsole
    // Importing the module already runs it — it self-invokes so that a
    // NODE_OPTIONS preload needs no entry point. Calling again is how the
    // outcome is read back, and the helper memoizes it per process.
    if (typeof allocate !== 'function') return 'failed'
    return allocate()
  } catch {
    return 'failed'
  }
}
