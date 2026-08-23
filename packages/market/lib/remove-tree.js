// @ts-check
/**
 * @dsh-desktop/market — deleting a downloaded tree, on the runtime we ship.
 *
 * `rmSync(path, { recursive: true, force: true })` is not enough here, and the
 * gap is specific to this app: on Windows, **Electron's Node refuses to delete
 * a read-only file where stock Node deletes it.** Measured on 0.1.0-rc.6:
 *
 * | | stock Node 22.23 | Electron 39's Node 24.18 |
 * | --- | --- | --- |
 * | `rmSync` over a read-only file | ok | `EPERM`, `syscall: rm` |
 *
 * Node 24 moved `rmSync` to a native binding, and that path dropped the JS
 * rimraf's `fixWinEPERMSync` — the chmod-and-retry that used to make `force`
 * mean "read-only too". `force` now only means "a missing path is not an
 * error", and `maxRetries` only helps a transient lock, not an attribute.
 *
 * That matters because **git guarantees read-only files**: it writes its object
 * store and pack files without the write bit. So every plugin installed from a
 * git source would fail on Windows at the moment `.git` is removed — and the
 * launcher runs the harness on Electron's own Node precisely so no second
 * runtime ships, which is what puts the app on the failing side of that table.
 *
 * CLAUDE.md's rule for exactly this: when you discover a platform fact the hard
 * way, pin it in a test. `tests/unit/market-remove-tree.spec.ts` asserts the
 * behaviour, and `tests/contract/native-tools.spec.ts` asserts it against the
 * real Electron binary, so an Electron bump that restores or worsens it is
 * named rather than found by a user whose install fails.
 *
 * Runs inside the harness sidecar (plain Node, no Electron APIs).
 */
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Attempts a stubborn delete makes before giving up, and the pause between.
 *
 * Separate from the read-only problem and worth having anyway: on Windows a
 * directory that a process has just finished writing can stay briefly
 * undeletable while an indexer or scanner still holds a handle, and a git
 * clone is exactly that. Retrying costs nothing when nothing is holding it.
 */
const RETRIES = 3
const RETRY_DELAY_MS = 50

/**
 * Delete a directory tree, including files whose write bit is clear.
 *
 * The plain delete is tried first, so the ordinary case pays nothing: the
 * attribute walk happens only after an `EPERM` on Windows, which is the only
 * platform and code where clearing attributes is the answer. Any other failure
 * is rethrown untouched — a delete that fails because the path is genuinely in
 * use must not be reported as if it succeeded, since the caller is usually
 * about to move something into its place.
 * @param {string} path - the tree to remove; a missing path is not an error.
 * @throws the original error when the tree still cannot be removed.
 */
export function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS })
    return
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code
    if (process.platform !== 'win32' || code !== 'EPERM') throw error
    clearReadOnly(path)
    rmSync(path, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS })
  }
}

/**
 * Give every entry under a path its write bit back.
 *
 * Best-effort by design. A single unreadable directory or a file that vanished
 * between the listing and the `chmod` must not stop the rest from being
 * cleared — the delete that follows is what reports success or failure, and it
 * is a better judge of whether this worked than this function is.
 *
 * `lstat`, not `stat`, so a symlink is chmod'ed as itself rather than followed
 * out of the tree. Nothing here should be able to reach outside the tree it was
 * given, and following a link is the one way it could.
 * @param {string} path - file or directory to clear, recursively.
 */
function clearReadOnly(path) {
  /** @type {import('node:fs').Stats} */
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return
  }
  if (stats.isDirectory()) {
    /** @type {string[]} */
    let names = []
    try {
      names = readdirSync(path)
    } catch { /* an unreadable directory is the delete's problem, not ours */ }
    for (const name of names) clearReadOnly(join(path, name))
  }
  try {
    // 0o666 on a file and 0o777 on a directory: on Windows only the write bit
    // is read at all, and this is the shape of what the JS rimraf used to do.
    chmodSync(path, stats.isDirectory() ? 0o777 : 0o666)
  } catch { /* the delete below is the real verdict */ }
}
