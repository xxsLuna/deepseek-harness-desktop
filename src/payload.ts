/**
 * Is the staged payload still there to boot?
 *
 * The launcher spawns `@dsh-desktop/bundle/lib/boot.js` out of the staged tree,
 * and when that file is gone Node reports it in the only terms it has:
 * `MODULE_NOT_FOUND`, naming a path inside the app's own installation. True,
 * and close to useless — it reads like a packaging mistake, so that is where
 * the looking starts. The one time it happened for real the cause was nowhere
 * near the build: a plugin removal had walked into the installation through a
 * junction and emptied 271 packages (see `packages/market/lib/remove-tree.js`,
 * which is where that can no longer happen).
 *
 * So the launcher answers the question before Node has to. The check is cheap
 * enough to run on every start, including the ones crash recovery makes — a
 * handful of `existsSync` calls against a tree that is either intact or
 * unusable, and the restart path is exactly where the opaque error surfaced.
 *
 * Pure, with the probe injected, so the rule is unit-tested rather than mocked
 * around Electron — CLAUDE.md's convention for anything with a rule in it.
 */
import { join } from 'node:path'

/**
 * Files whose absence means the tree cannot boot, in the order they would
 * fail.
 *
 * More than the entry point on purpose. The damage this exists to name does
 * not remove a file, it empties **packages** — every scoped package present but
 * with nothing inside it, because a delete that follows a junction removes the
 * *link* and leaves the target directory standing. The entry is what fails
 * first; the other two are the anchors of the two scopes the whole harness
 * composes through, so a tree that lost them fails later in boot with a
 * message just as opaque as the one this replaces.
 *
 * Kept short deliberately. This is a smoke check for an unusable installation,
 * not an integrity manifest — `tests/contract/pruned-payload.spec.ts` is what
 * asserts the roster actually resolves.
 */
const REQUIRED: readonly (readonly string[])[] = [
  ['@dsh-desktop', 'bundle', 'lib', 'boot.js'],
  ['@deepseek-ai', 'dsh', 'package.json'],
  ['@deepseek-ai', 'cordis', 'package.json'],
]

/** Intact, or not with the reason ready to put on screen. */
export type PayloadVerdict =
  | { readonly ok: true }
  | { readonly ok: false, readonly missing: readonly string[], readonly summary: string }

/**
 * Decide whether the staged tree can be booted at all.
 * @param harnessRoot - the staged tree, the same path `Sidecar` spawns from.
 * @param exists - probe for one absolute path; `existsSync` in production.
 * @returns ok, or what is missing and what to tell the user.
 */
export function payloadVerdict(
  harnessRoot: string,
  exists: (path: string) => boolean,
): PayloadVerdict {
  const missing = REQUIRED
    .filter((parts) => !exists(join(harnessRoot, 'node_modules', ...parts)))
    // Reported with forward slashes whatever the platform separator is: these
    // are package specifiers to a reader, not paths to open.
    .map((parts) => parts.join('/'))
  if (missing.length === 0) return { ok: true }
  return {
    ok: false,
    missing,
    // Names what is gone and what to do about it, and nothing else. The
    // failure report already carries the log tail, and a user who reinstalls
    // never needs to know why the files left. What this must not do is send
    // them looking at their own machine for a build problem.
    summary:
      "The app's own harness files are missing, so it cannot start. "
      + `Reinstalling the app restores them. Not present: ${missing.join(', ')}`,
  }
}
