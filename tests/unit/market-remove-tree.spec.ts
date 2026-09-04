/**
 * Deleting a tree on the runtime this app actually ships.
 *
 * This exists because of two measured divergences, neither hypothetical. The
 * app runs the harness on Electron's own Node (see CLAUDE.md — no second
 * runtime ships), and Node 24's native `rmSync` differs from the stock Node 22
 * the JS rimraf shipped in:
 *
 *   stock Node 22.23   rmSync(read-only, { recursive, force })  -> ok
 *   Electron 24.18     rmSync(read-only, { recursive, force })  -> EPERM
 *
 *   stock Node 22.23   rmSync(junction,  { recursive, force })  -> unlinks the link
 *   Electron 24.18     rmSync(junction,  { recursive, force })  -> empties the TARGET
 *
 * Git writes its object store read-only, so before `removeTree` existed, every
 * plugin installed from a git source failed on Windows the moment `.git` was
 * cleaned up. The junction half is worse and did real damage: removing a
 * locally developed plugin — installed into the profile as a junction — walked
 * out of the profile and emptied the installed app's own harness tree, after
 * which it could not boot. Both are pinned here.
 *
 * The unit tests below run on whatever Node the suite runs on;
 * `tests/contract/native-tools.spec.ts` is what pins the behaviour against the
 * real Electron binary, which is the runtime that matters.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import { removeTree } from '../../packages/market/lib/remove-tree.js'

const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary) {
    try {
      // removeTree, not rmSync: several of these roots hold a junction on
      // purpose, and a plain recursive rm is exactly what would follow it out
      // of the fixture and delete another test's tree — or, on a developer's
      // machine, whatever the junction happened to point at.
      removeTree(dir)
    } catch { /* a test that left something undeletable already failed */ }
  }
})

/** An empty registered scratch directory. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remove-'))
  temporary.push(root)
  return root
}

/** A tree with one nested file, optionally stripped of its write bit. */
function tree(readonly: boolean): string {
  const root = scratch()
  const dir = join(root, 'a', 'b')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'f.bin')
  writeFileSync(file, 'x')
  if (readonly) chmodSync(file, 0o444)
  return root
}

/**
 * A directory link, spelled the way each platform spells one.
 *
 * `junction` on Windows because that is the kind that actually shows up here —
 * pnpm's hoisted linker and a local-path plugin install both create junctions,
 * and the junction is the type whose recursive delete diverges. POSIX ignores
 * the type argument, so the same call covers both.
 */
function linkTo(target: string, at: string): void {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
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

  it('removes a link without touching what it points at', () => {
    // The incident at its smallest. Node 24's native recursive rm descends
    // into a junction and empties the target, leaving the target DIRECTORY in
    // place — a node_modules full of packages that exist but are empty is the
    // signature. The link is the only thing that may go.
    const root = tree(false)
    const link = join(root, 'installed')
    linkTo(join(root, 'a'), link)
    removeTree(link)
    expect(existsSync(link), 'the link itself should be gone').toBe(false)
    expect(
      existsSync(join(root, 'a', 'b', 'f.bin')),
      'removeTree followed the link and deleted what it pointed at',
    ).toBe(true)
  })

  it('removes a tree holding a link without following it', () => {
    // A plugin tree really does contain one: a locally developed plugin's
    // node_modules is a link into the profile. Deleting the plugin has to stop
    // there, not walk on into whatever the profile links to.
    const outside = tree(false)
    const root = tree(false)
    linkTo(join(outside, 'a'), join(root, 'a', 'node_modules'))
    removeTree(root)
    expect(existsSync(root), 'the tree it was given should be gone').toBe(false)
    expect(
      existsSync(join(outside, 'a', 'b', 'f.bin')),
      'removeTree walked out through a link nested inside the tree',
    ).toBe(true)
  })

  it('stops at the first link, however long the chain behind it is', () => {
    // The real shape, in full: install entry -> plugin source -> its
    // node_modules -> the profile's hoisted link farm -> the installed app's
    // own packages. Four hops from the path `remove()` names to the file the
    // sidecar boots from, which is how deleting one plugin stopped the app
    // from starting. One hop is all it takes, so one hop is where it stops.
    const app = tree(false)
    const profile = scratch()
    linkTo(join(app, 'a'), join(profile, 'pkg'))
    const source = tree(false)
    linkTo(profile, join(source, 'node_modules'))
    const entry = join(scratch(), 'opencode-usage-plugin')
    linkTo(source, entry)

    removeTree(entry)

    expect(existsSync(entry), 'the install entry should be gone').toBe(false)
    expect(readdirSync(source).length, 'the plugin source was deleted through the install link').toBeGreaterThan(0)
    expect(existsSync(join(profile, 'pkg')), "the profile's link farm was raided").toBe(true)
    expect(existsSync(join(app, 'a', 'b', 'f.bin')), "the installed app's own tree was emptied").toBe(true)
  })

  it('removes a link whose target is already gone', () => {
    // A stale link is the normal state of an install whose source moved, and
    // it must not become a removal that throws and leaves the entry behind.
    const root = tree(false)
    const link = join(root, 'installed')
    linkTo(join(root, 'nothing-here'), link)
    expect(() => { removeTree(link) }).not.toThrow()
    // readdir, not existsSync: existsSync follows the link and already answers
    // false for a stale one, so it cannot tell us the entry itself went.
    expect(readdirSync(root)).not.toContain('installed')
  })
})
