// @ts-check
/**
 * @dsh-desktop/market — deleting a downloaded tree, on the runtime we ship.
 *
 * `rmSync(path, { recursive: true, force: true })` is wrong here twice over,
 * and both gaps are specific to this app: it runs the harness on **Electron's
 * own Node** (see CLAUDE.md — no second runtime ships), and Node 24 moved
 * `rmSync` to a native binding which dropped two behaviours the JS rimraf had.
 * Measured on win32-x64:
 *
 * | | stock Node 22.23 | Electron's Node 24.18 |
 * | --- | --- | --- |
 * | over a read-only file | deletes it | `EPERM`, `syscall: rm` |
 * | over a **junction** | removes the link | **descends and empties the target** |
 *
 * The first one cost every git install. Node 24's native path lost
 * `fixWinEPERMSync` — the chmod-and-retry that used to make `force` mean
 * "read-only too" — so `force` now only means "a missing path is not an error"
 * and `maxRetries` only helps a transient lock, not an attribute. Git
 * guarantees read-only files: it writes its object store and pack files
 * without the write bit, so a plugin installed from a git source failed on
 * Windows the moment `.git` was removed.
 *
 * The second one cost the whole app, once, on a real machine. A plugin
 * developed locally is installed into the profile as a **junction** to its
 * source directory, and the profile's own `node_modules` is a flat directory of
 * junctions into the installed app's staged harness tree. That farm is not
 * incidental and does not go away: `healProfilesModuleFallback` rebuilds it on
 * every boot (see `@dsh-desktop/bundle`'s `prepareProfile`), because the root
 * config lives in the profile and nothing else would put the app's packages on
 * an installed plugin's resolution walk. Removing that plugin called this
 * function on the junction, and the native rm walked *through* it: into the
 * source directory, out along its `node_modules` junction, and into the app's
 * own tree, where it emptied 271 packages in 4.8 seconds — including
 * `@dsh-desktop/bundle`, the sidecar's entry module. The app could not boot
 * again, with an error naming a file nobody had touched.
 *
 * The wreckage has a signature worth recognising: the **link** is what a
 * delete removes, so the target *directory* survives with its contents gone.
 * A `node_modules` full of packages that are present but empty is this bug.
 *
 * `lstat` reports a junction as a symlink on both runtimes, so detecting one is
 * portable and only the delete disagrees. That is why this module walks the
 * tree itself instead of handing a root to `rmSync`: a link is removed *as a
 * link* and never descended into, on every platform, so the safety does not
 * depend on which Node we happen to be running or on a per-platform branch
 * that the next bump can invalidate.
 *
 * CLAUDE.md's rule for exactly this: when you discover a platform fact the hard
 * way, pin it in a test. `tests/unit/market-remove-tree.spec.ts` asserts both
 * behaviours, and `tests/contract/native-tools.spec.ts` asserts them against
 * the real Electron binary, so a bump that restores or worsens either is named
 * rather than found by a user whose app stops starting.
 *
 * Runs inside the harness sidecar (plain Node, no Electron APIs).
 */
import { chmodSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
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
 * Delete a directory tree, including files whose write bit is clear, without
 * ever following a symlink or a junction out of the tree.
 * @param {string} path - the tree to remove; a missing path is not an error.
 * @throws the original error when the tree still cannot be removed.
 */
export function removeTree(path) {
  const stats = statSelf(path)
  if (stats === undefined) return
  // The junction rule, and the reason this is a walk rather than one rmSync: a
  // link is an entry to delete, never a door to walk through. Descending here
  // is precisely what emptied the app's own payload.
  if (stats.isSymbolicLink()) {
    removeLink(path)
    return
  }
  if (!stats.isDirectory()) {
    attempt(() => { unlinkSync(path) }, path, false)
    return
  }
  // Depth-first, so a directory is only removed once it is empty. Each entry
  // gets its own read-only recovery as it is reached, which is what the old
  // recursive chmod pre-pass was for.
  for (const name of entries(path)) removeTree(join(path, name))
  attempt(() => { rmdirSync(path) }, path, true)
}

/**
 * `lstat`, treating absence as nothing to do.
 *
 * `lstat` rather than `stat` so a link is described as itself. Following one
 * would reintroduce the bug this module is built around, in our own code
 * rather than Node's.
 * @param {string} path - the entry to describe.
 * @returns {import('node:fs').Stats | undefined} the entry, or undefined if it is gone.
 */
function statSelf(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * List a directory, treating absence as empty.
 *
 * A directory that vanished between the `lstat` and here is a concurrent
 * delete finishing our work, not a failure.
 * @param {string} path - the directory to list.
 * @returns {string[]} the entry names.
 */
function entries(path) {
  try {
    return readdirSync(path)
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Remove a symlink or junction, and only it.
 *
 * Two syscalls because the filesystems disagree about what a directory link
 * is: POSIX takes every symlink through `unlink`, while on Windows a junction
 * or a directory symlink *is* a directory and only `rmdir` takes it. Neither
 * call can reach the target, which is what makes this safe where the native
 * recursive rm is not.
 * @param {string} path - the link to remove.
 */
function removeLink(path) {
  try {
    unlinkSync(path)
    return
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code
    if (code === 'ENOENT') return
    // Anything else is a real failure and must not be retried as a directory:
    // a link we cannot remove has to be reported, not worked around.
    if (code !== 'EPERM' && code !== 'EISDIR' && code !== 'EACCES') throw error
  }
  attempt(() => { rmdirSync(path) }, path, true)
}

/**
 * Run one delete, giving a Windows read-only entry its write bit back and
 * retrying a path something else is briefly holding.
 * @param {() => void} action - the single-entry delete to perform.
 * @param {string} path - what it deletes, for the attribute clear.
 * @param {boolean} isDirectory - which mode to restore.
 * @throws the last error when every attempt fails.
 */
function attempt(action, path, isDirectory) {
  for (let remaining = RETRIES; ; remaining--) {
    try {
      action()
      return
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code
      if (code === 'ENOENT') return
      if (code === 'EPERM' && process.platform === 'win32') {
        // 0o666 on a file and 0o777 on a directory: on Windows only the write
        // bit is read at all, and this is the shape of what the JS rimraf did.
        try {
          chmodSync(path, isDirectory ? 0o777 : 0o666)
        } catch { /* the retry below is the real verdict */ }
      }
      if (remaining <= 0) throw error
      pause(RETRY_DELAY_MS)
    }
  }
}

/**
 * Sleep, synchronously.
 *
 * `removeTree` is a sync API called from sync callers, so the retry has to
 * actually wait rather than yield. `Atomics.wait` on a throwaway buffer is the
 * only way to do that without burning the CPU in a spin loop.
 * @param {number} ms - how long to wait.
 */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
