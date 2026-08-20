/**
 * The contract suite needs a staged harness. This is the one spec that says so
 * out loud.
 *
 * Every other file here is `describe.skipIf(!existsSync(harnessRoot))`, which is
 * right — a missing stage is not each of their failures. But it made the suite
 * report a clean pass when it had run nothing at all, and a skip is
 * indistinguishable from a pass in exactly the situation the suite exists for:
 * checking this repo still fits an upstream version it does not control.
 *
 * So this one does not skip.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const harnessRoot = join(root, 'build', 'harness')

describe('the contract suite has something to test against', () => {
  it('finds a staged harness', () => {
    expect(
      existsSync(join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
      `no staged harness at ${harnessRoot} — run \`npm run stage\` (then \`npm run build\`). `
      + 'Without it every other contract spec skips and the suite reports a pass it has not earned.',
    ).toBe(true)
  })

  it('finds this repo\'s own packages staged beside it', () => {
    // `npm run stage` alone is not enough: the local packages are copied in by
    // `npm run build`, and a stage without them boots upstream's composition
    // rather than this app's — which several specs would then pass against.
    expect(
      existsSync(join(harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js')),
      'staged harness has no @dsh-desktop/bundle — run `npm run build`',
    ).toBe(true)
  })
})
