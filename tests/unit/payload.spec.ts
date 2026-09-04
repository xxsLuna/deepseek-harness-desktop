/**
 * The staged-payload preflight.
 *
 * It exists because of one real incident: a plugin removal followed a junction
 * into the app's own installation and emptied 271 packages, after which the app
 * reported `MODULE_NOT_FOUND` for a file inside itself. That is a message about
 * the build, and the cause was a delete — so the looking started in the wrong
 * place. `packages/market/lib/remove-tree.js` is why it cannot happen again;
 * this is why it would be legible if something else ever did it.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { payloadVerdict } from '../../src/payload.js'

const root = join('/opt', 'harness')
const modules = join(root, 'node_modules')

/** A probe that answers no for the given package-relative paths only. */
function without(...gone: string[]): (path: string) => boolean {
  const absent = new Set(gone.map((rel) => join(modules, ...rel.split('/'))))
  return (path) => !absent.has(path)
}

describe('payloadVerdict', () => {
  it('passes an intact tree', () => {
    expect(payloadVerdict(root, () => true)).toEqual({ ok: true })
  })

  it('names the boot entry when it is gone', () => {
    const verdict = payloadVerdict(root, without('@dsh-desktop/bundle/lib/boot.js'))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.missing).toEqual(['@dsh-desktop/bundle/lib/boot.js'])
    // The two things the summary owes a user who cannot open the app: that the
    // files are the app's own, and that reinstalling is the answer.
    expect(verdict.summary).toContain('harness files are missing')
    expect(verdict.summary).toContain('Reinstalling')
    expect(verdict.summary).toContain('@dsh-desktop/bundle/lib/boot.js')
  })

  it('catches an emptied upstream scope, which fails later and just as opaquely', () => {
    // The real damage empties packages rather than removing one file, and the
    // boot entry is only the first casualty. A tree that kept it and lost
    // @deepseek-ai would spawn happily and die a few imports later.
    const verdict = payloadVerdict(root, without('@deepseek-ai/dsh/package.json'))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.missing).toEqual(['@deepseek-ai/dsh/package.json'])
  })

  it('reports every missing anchor, in boot order', () => {
    const verdict = payloadVerdict(root, () => false)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.missing).toEqual([
      '@dsh-desktop/bundle/lib/boot.js',
      '@deepseek-ai/dsh/package.json',
      '@deepseek-ai/cordis/package.json',
    ])
  })

  it('spells the anchors with forward slashes whatever the platform separator is', () => {
    // They read as package specifiers, not as paths to go and open, and the
    // summary is user-facing text.
    const verdict = payloadVerdict(root, () => false)
    if (verdict.ok) return
    for (const name of verdict.missing) expect(name).not.toContain('\\')
  })

  it('probes inside node_modules, under the root it was given', () => {
    // Guards the seam that matters: the preflight has to ask about the same
    // tree Sidecar.start spawns from, or it passes while the real entry is
    // gone.
    const asked: string[] = []
    payloadVerdict(root, (path) => {
      asked.push(path)
      return true
    })
    expect(asked).toContain(join(modules, '@dsh-desktop', 'bundle', 'lib', 'boot.js'))
  })
})
