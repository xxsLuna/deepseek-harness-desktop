/**
 * Deleting a tree on the runtime this app actually ships.
 *
 * This exists because of a measured divergence, not a hypothetical one. The app
 * runs the harness on Electron's own Node (see CLAUDE.md — no second runtime
 * ships), and on Windows that Node refuses to delete a read-only file where
 * stock Node deletes it:
 *
 *   stock Node 22.23   rmSync(read-only, { recursive, force })  -> ok
 *   Electron 24.18     rmSync(read-only, { recursive, force })  -> EPERM
 *
 * Git writes its object store read-only, so before `removeTree` existed, every
 * plugin installed from a git source failed on Windows the moment `.git` was
 * cleaned up. The unit tests below run on whatever Node the suite runs on;
 * `tests/contract/native-tools.spec.ts` is what pins the behaviour against the
 * real Electron binary, which is the runtime that matters.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import { removeTree } from '../../packages/market/lib/remove-tree.js'

const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch { /* a test that left something undeletable already failed */ }
  }
})

/** A tree with one nested file, optionally stripped of its write bit. */
function tree(readonly: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remove-'))
  temporary.push(root)
  const dir = join(root, 'a', 'b')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'f.bin')
  writeFileSync(file, 'x')
  if (readonly) chmodSync(file, 0o444)
  return root
}

describe('removeTree', () => {
  it('removes an ordinary tree', () => {
    const root = tree(false)
    removeTree(root)
    expect(existsSync(root)).toBe(false)
  })

  it('removes a tree holding a read-only file', () => {
    // The whole reason this module exists. `force: true` does NOT cover the
    // Windows read-only attribute on Node 24's native rmSync, and git
    // guarantees read-only files, so a plain rmSync here would make every git
    // install fail on Windows.
    const root = tree(true)
    removeTree(root)
    expect(existsSync(root)).toBe(false)
  })

  it('removes a read-only file named directly', () => {
    const root = tree(true)
    temporary.push(root)
    removeTree(join(root, 'a', 'b', 'f.bin'))
    expect(existsSync(join(root, 'a', 'b', 'f.bin'))).toBe(false)
    // and did not take its parent with it
    expect(existsSync(join(root, 'a', 'b'))).toBe(true)
  })

  it('treats a missing path as nothing to do', () => {
    expect(() => { removeTree(join(tmpdir(), 'dsh-remove-does-not-exist-12345')) }).not.toThrow()
  })

  it('leaves a sibling alone', () => {
    // Guards the direction the git transport got wrong: a removal that reaches
    // outside the tree it was given is data loss, not a cleanup.
    const root = tree(false)
    const keep = join(root, 'a', 'b', '..', '..', 'keep')
    mkdirSync(keep, { recursive: true })
    writeFileSync(join(keep, 'important.txt'), 'x')
    removeTree(join(root, 'a'))
    expect(existsSync(join(root, 'a'))).toBe(false)
    expect(existsSync(join(keep, 'important.txt'))).toBe(true)
  })
})
