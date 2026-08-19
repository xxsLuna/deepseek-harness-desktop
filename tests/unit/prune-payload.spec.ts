/**
 * The payload prune rule. Every case here is a file the staged tree actually
 * carries, so a rule that drifts fails against reality rather than a mock.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- a build script, deliberately outside the typed src/ rootDir
import { NEVER_RUNTIME, pruneReason } from '../../scripts/prune-payload.mjs'

const win = { platform: 'win32', arch: 'x64' }
const linuxArm = { platform: 'linux', arch: 'arm64' }

describe('pruneReason', () => {
  it('drops what no runtime ever loads', () => {
    expect(pruneReason('node_modules/openai/index.mjs.map', win)).toBe('sourcemap')
    expect(pruneReason('node_modules/openai/index.d.ts', win)).toBe('type declaration')
    expect(pruneReason('node_modules/openai/index.d.mts', win)).toBe('type declaration')
    expect(pruneReason('node_modules/zod/v4/core/util.ts', win)).toBe('typescript source')
    expect(pruneReason('node_modules/node-pty/prebuilds/win32-x64/conpty.pdb', win)).toBe('debug symbols')
  })

  it('keeps the code the harness runs', () => {
    expect(pruneReason('node_modules/@deepseek-ai/dsh/lib/bin.js', win)).toBeUndefined()
    expect(pruneReason('node_modules/@dsh-desktop/bundle/lib/boot.js', win)).toBeUndefined()
    expect(pruneReason('node_modules/@deepseek-ai/dsh-base/cordis.patch.yml', win)).toBeUndefined()
    expect(pruneReason('node_modules/shiki/dist/onig.wasm', win)).toBeUndefined()
    expect(pruneReason('node_modules/@img/sharp-win32-x64/lib/libvips-42.dll', win)).toBeUndefined()
  })

  it('keeps package.json and licences whatever else matches', () => {
    // package.json is how the resolver finds anything at all, so it must
    // outrank every rule — including the test-tree and prebuild sweeps.
    expect(pruneReason('node_modules/node-pty/prebuilds/darwin-x64/package.json', win)).toBeUndefined()
    expect(pruneReason('node_modules/some-pkg/test/package.json', win)).toBeUndefined()
    expect(pruneReason('node_modules/openai/LICENSE', win)).toBeUndefined()
    expect(pruneReason('node_modules/openai/NOTICE', win)).toBeUndefined()
  })

  it('keeps only the target platform prebuild', () => {
    // node-pty ships all six prebuilds as tarball files, so npm cannot strip
    // them by platform the way it does optionalDependencies.
    expect(pruneReason('node_modules/node-pty/prebuilds/win32-x64/pty.node', win)).toBeUndefined()
    expect(pruneReason('node_modules/node-pty/prebuilds/win32-arm64/pty.node', win)).toBe('prebuild for win32-arm64')
    expect(pruneReason('node_modules/node-pty/prebuilds/darwin-arm64/pty.node', win)).toBe('prebuild for darwin-arm64')
    expect(pruneReason('node_modules/node-pty/prebuilds/linux-x64/pty.node', win)).toBe('prebuild for linux-x64')

    // ...and the rule follows the target, so a cross-build keeps the right one.
    expect(pruneReason('node_modules/node-pty/prebuilds/linux-arm64/pty.node', linuxArm)).toBeUndefined()
    expect(pruneReason('node_modules/node-pty/prebuilds/win32-x64/pty.node', linuxArm)).toBe('prebuild for win32-x64')
  })

  it('treats a linuxmusl prebuild as the linux platform, deciding on arch alone', () => {
    expect(pruneReason('node_modules/pkg/prebuilds/linuxmusl-arm64/x.node', linuxArm)).toBeUndefined()
    expect(pruneReason('node_modules/pkg/prebuilds/linuxmusl-x64/x.node', linuxArm)).toBe('prebuild for linuxmusl-x64')
  })

  it('matches prebuild DIRECTORIES only, never a package whose name ends that way', () => {
    // The @img/sharp-libvips-* family are real optionalDependencies: npm
    // already installs only this platform's, and matching on the package name
    // would delete the one that IS needed on a host npm resolved differently.
    expect(pruneReason('node_modules/@img/sharp-libvips-linux-arm64/lib/x.so', win)).toBeUndefined()
    expect(pruneReason('node_modules/@img/sharp-win32-x64/lib/libvips-42.dll', linuxArm)).toBeUndefined()
    expect(pruneReason('node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe', linuxArm)).toBeUndefined()
  })

  it('sweeps the conpty payloads node-pty vendors per Windows arch', () => {
    expect(pruneReason('node_modules/node-pty/third_party/conpty/1.25/win10-x64/conpty.dll', win)).toBeUndefined()
    expect(pruneReason('node_modules/node-pty/third_party/conpty/1.25/win10-arm64/conpty.dll', win)).toBe('prebuild for win10-arm64')
    // A non-Windows target needs no conpty at all.
    expect(pruneReason('node_modules/node-pty/third_party/conpty/1.25/win10-x64/conpty.dll', linuxArm)).toBe('prebuild for win10-x64')
  })

  it('drops sharp wasm only when the native binary for this target is staged', () => {
    const path = 'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.3.node.wasm'
    expect(pruneReason(path, { ...win, nativeSharp: true })).toBe('wasm fallback')
    expect(pruneReason(path, { ...win, nativeSharp: false })).toBeUndefined()
  })

  it('drops docs in every spelling upstream uses, including the localized ones', () => {
    expect(pruneReason('node_modules/@deepseek-ai/dsh-base/README.md', win)).toBe('docs')
    expect(pruneReason('node_modules/@deepseek-ai/dsh-base/README.zh.md', win)).toBe('docs')
    expect(pruneReason('node_modules/@deepseek-ai/dsh-base/README.i18n.yaml', win)).toBe('docs')
    expect(pruneReason('node_modules/openai/CHANGELOG.md', win)).toBe('docs')
  })

  it('sweeps test trees by directory, not by filename', () => {
    expect(pruneReason('node_modules/js-yaml/test/helper.js', win)).toBe('test tree')
    expect(pruneReason('node_modules/protobufjs/tests/data/x.json', win)).toBe('test tree')
    expect(pruneReason('node_modules/katex/__tests__/x.js', win)).toBe('test tree')
    expect(pruneReason('node_modules/pkg/fixtures/sample.png', win)).toBe('test tree')
    // A file merely NAMED like a test is real code somewhere.
    expect(pruneReason('node_modules/pkg/lib/test-utils.js', win)).toBeUndefined()
  })
})

describe('NEVER_RUNTIME', () => {
  it('names exactly the reasons that outrank a wildcard export', () => {
    // A package exporting `"./*": "./*"` nominally exposes every file under it,
    // but nothing can be imported from a map, a declaration, a PDB or a README.
    // Letting those wildcards win kept half the tree's sourcemaps (36.5MB).
    expect([...NEVER_RUNTIME].sort()).toEqual(['debug symbols', 'docs', 'sourcemap', 'type declaration'])
    // A foreign prebuild is NOT here: it is a real loadable binary, so only an
    // exact entry path should ever shield it, and the platform rule decides.
    expect(NEVER_RUNTIME.has('wasm fallback')).toBe(false)
    expect(NEVER_RUNTIME.has('test tree')).toBe(false)
  })
})
