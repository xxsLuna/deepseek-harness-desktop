/**
 * The rule that decides what a downloaded plugin is.
 *
 * This is the only place the two formats are told apart, and it is now imported
 * by two callers: the installer, and the marketplace repository's CI gate. That
 * is the reason it is a module and the reason these tests exist — the gate's
 * whole value is that it applies the SAME rule as the installer, so a
 * regression here is a listing that passes review and fails at a user.
 *
 * Every refusal below is a real failure mode of the app, not a tidiness check:
 * a `dsh` package whose patch file is missing makes `loadProfile` throw and the
 * app stop booting, and one with runtime dependencies resolves to nothing at
 * load because the packaged app ships no package manager.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import { CLAUDE_MANIFEST, classifyPlugin } from '../../packages/market/lib/kind.js'

const temporary: string[] = []
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

/** A plugin tree written from a path -> contents map. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-market-kind-'))
  temporary.push(root)
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, ...path.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents, 'utf8')
  }
  return root
}

/** The message a refusal carried. */
function refusal(root: string, claimed: { name: string, version?: string }): string {
  try {
    classifyPlugin(root, claimed)
  } catch (error) {
    return (error as Error).message
  }
  return 'no refusal'
}

const PATCH = 'plugins/x.yml'

/** A well-formed dsh package. */
const dshFiles = (extra: Record<string, unknown> = {}): Record<string, string> => ({
  'package.json': JSON.stringify({ name: 'p', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...extra }),
  'cordis.patch.yml': '- insert: []\n',
})

describe('classifyPlugin', () => {
  it('names the well-known Claude manifest path', () => {
    // Two packages join this path; a rename that only landed in one of them
    // would make the installer and the skill walk disagree about what exists.
    expect(CLAUDE_MANIFEST).toEqual(['.claude-plugin', 'plugin.json'])
  })

  it('reads a Claude plugin, taking its own version over the row', () => {
    const root = tree({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.2.3' }) })
    expect(classifyPlugin(root, { name: 'p', version: '0.0.1' })).toEqual({ kind: 'claude', version: '1.2.3' })
  })

  it('falls back to the row version when the plugin declares none', () => {
    const root = tree({ '.claude-plugin/plugin.json': JSON.stringify({ description: 'x' }) })
    expect(classifyPlugin(root, { name: 'p', version: '0.4.0' })).toEqual({ kind: 'claude', version: '0.4.0' })
  })

  it('lets a Claude plugin omit its name, but not contradict the row', () => {
    // The row's name is the install key. A plugin need not repeat it; when it
    // does and disagrees, the bytes are not what was approved.
    const quiet = tree({ '.claude-plugin/plugin.json': JSON.stringify({ version: '1.0.0' }) })
    expect(classifyPlugin(quiet, { name: 'p' }).kind).toBe('claude')
    const loud = tree({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'other' }) })
    expect(refusal(loud, { name: 'p' })).toContain('calls itself other')
  })

  it('reads a dsh package, and prefers its manifest over the Claude marker never', () => {
    // Order matters and is asserted: a package carrying both markers is read as
    // Claude, so a dsh payload cannot be smuggled past the weaker warning by
    // adding a plugin.json beside it.
    expect(classifyPlugin(tree(dshFiles()), { name: 'p' })).toEqual({ kind: 'dsh', version: '2.0.0' })
    const both = tree({ ...dshFiles(), '.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }) })
    expect(classifyPlugin(both, { name: 'p' }).kind).toBe('claude')
  })

  it('refuses a dsh package whose name is not the one listed', () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'other', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'cordis.patch.yml': '- insert: []\n',
    })
    expect(refusal(root, { name: 'p' })).toContain('the package is other')
  })

  it('refuses a dsh package whose declared patch file is not in it', () => {
    // loadProfile throws on this at the next boot, and the app does not start —
    // so it has to be caught before the package is on disk, not after.
    const root = tree({ 'package.json': JSON.stringify({ name: 'p', dsh: { bundle: { patch: `./${PATCH}` } } }) })
    expect(refusal(root, { name: 'p' })).toContain(PATCH)
  })

  it('refuses a dsh package with runtime dependencies', () => {
    const root = tree(dshFiles({ dependencies: { lodash: '^4' } }))
    expect(refusal(root, { name: 'p' })).toContain('runtime dependencies')
    // An empty object is not a declaration and must not trip it.
    expect(classifyPlugin(tree(dshFiles({ dependencies: {} })), { name: 'p' }).kind).toBe('dsh')
  })

  it('refuses a tree that is neither, naming both markers', () => {
    const message = refusal(tree({ 'README.md': '# hello\n' }), { name: 'p' })
    expect(message).toContain('.claude-plugin/plugin.json')
    expect(message).toContain('dsh.bundle.patch')
    // A package.json without the marker is still neither — the common mistake,
    // and the one whose message has to say what is missing.
    expect(refusal(tree({ 'package.json': JSON.stringify({ name: 'p' }) }), { name: 'p' }))
      .toContain('dsh.bundle.patch')
  })

  it('refuses a manifest that is present and unparsable, rather than reading it as absent', () => {
    // A truncated download would otherwise be classified as the other kind, or
    // as neither, and reported as the wrong problem entirely.
    const root = tree({ '.claude-plugin/plugin.json': '{ "name": ' })
    expect(refusal(root, { name: 'p' })).toContain('not valid JSON')
  })
})
