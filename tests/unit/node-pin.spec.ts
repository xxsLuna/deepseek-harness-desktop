/**
 * harness.json's Node pin against what upstream declares it needs.
 *
 * The gap this closes: Electron's bundled Node is checked against the pin
 * (`tests/contract/native-tools.spec.ts`), and the pin decides which Electron may
 * run the harness — but nothing compared the pin to upstream's own
 * `engines.node`. A release that raised its requirement past the Electron this
 * app ships would have staged, packaged and shipped, then failed at whatever the
 * newer Node was for.
 *
 * Upstream has left `engines` unset in every version pinned so far, which is why
 * nobody noticed: there was nothing to disagree with. So these cases are the only
 * evidence the check works at all.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodePinVerdict } from '../../scripts/node-pin.mjs'

const pin = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'harness.json'), 'utf8'),
) as { node: string }

describe('nodePinVerdict', () => {
  it('says nothing when upstream declares no requirement', () => {
    // Today's case, on every version pinned so far.
    for (const engines of [undefined, null, '', '   ']) {
      expect(nodePinVerdict(engines, '24')).toEqual({})
    }
  })

  it('says nothing when the pin satisfies the range', () => {
    for (const engines of ['>=24', '>=20', '^24.0.0', '>=24 <25', '24.x', '>=22.0.0']) {
      expect(nodePinVerdict(engines, '24'), engines).toEqual({})
    }
  })

  it('reports a pin that is too old for upstream', () => {
    // The failure it exists for: upstream moves to a Node newer than the
    // Electron this app ships, and everything else stays green.
    const verdict = nodePinVerdict('>=26', '24')
    expect(verdict.conflict).toBe('upstream requires Node >=26, but harness.json pins 24')
    expect(verdict.unparseable).toBeUndefined()
  })

  it('reports a range the pinned major cannot promise', () => {
    // `>=24.5.0` against a pin of `24`: the pin names a major and nothing more,
    // so it cannot promise the minor. Reported rather than waved through — only
    // Electron's actual Node could satisfy it, and that is a separate assertion.
    expect(nodePinVerdict('>=24.5.0', '24').conflict).toContain('>=24.5.0')
  })

  it('degrades to a warning on a range it cannot read, rather than failing the stage', () => {
    // A malformed engines field is upstream's problem, and refusing to stage over
    // it would block work on a version that is otherwise fine.
    expect(nodePinVerdict('not-a-range', '24')).toEqual({ unparseable: 'not-a-range' })
    expect(nodePinVerdict('>= <', '24').unparseable).toBeDefined()
  })

  it('accepts the pin this repo actually carries', () => {
    // Guards the shape of harness.json's `node` as much as the rule: a pin
    // written as "24.x" or ">=24" instead of a bare major would make every
    // comparison above meaningless.
    expect(pin.node).toMatch(/^\d+$/)
    expect(nodePinVerdict(`>=${pin.node}`, pin.node)).toEqual({})
  })
})
