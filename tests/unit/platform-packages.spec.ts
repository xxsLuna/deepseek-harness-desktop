/**
 * The rule that would have caught a bug four releases shipped with.
 *
 * `npm install` chooses platform-specific optional dependencies from the *build
 * host's* os/cpu, not from what is being packaged. Cross-building the Intel macOS
 * target on an Apple Silicon runner therefore staged arm64 packages into an x64
 * app: no koffi (five upstream packages use it), no ripgrep (the glob and grep
 * tools spawn it), no sharp. Nothing failed in CI, because a cross-built app
 * cannot be booted on the runner that made it.
 *
 * The Intel target has since been dropped, so no cross build remains. These
 * assertions stay because re-adding one is a two-line matrix edit, and the
 * symptom last time was silence.
 */
import { describe, expect, it } from 'vitest'
import { unsatisfiedBy } from '../../scripts/platform-packages.mjs'

const INTEL_MAC = { platform: 'darwin', arch: 'x64' }
const APPLE_SILICON = { platform: 'darwin', arch: 'arm64' }

describe('unsatisfiedBy', () => {
  it('passes a package with no platform constraint at all', () => {
    // Which is nearly the whole tree; the check must be quiet about it.
    expect(unsatisfiedBy({ name: 'lodash' }, INTEL_MAC)).toBeUndefined()
    expect(unsatisfiedBy({ name: 'lodash', os: [], cpu: [] }, INTEL_MAC)).toBeUndefined()
  })

  it('passes the package built for the target', () => {
    expect(unsatisfiedBy({ name: '@koromix/koffi-darwin-x64', os: ['darwin'], cpu: ['x64'] }, INTEL_MAC)).toBeUndefined()
  })

  it('catches the exact four packages the Intel build shipped wrong', () => {
    // Read off the published 0.1.0-desktop-v0.8.0 Intel artifact.
    for (const name of [
      '@koromix/koffi-darwin-arm64',
      '@vscode/ripgrep-darwin-arm64',
      '@img/sharp-darwin-arm64',
      'node-addon-require-builtin-darwin-arm64',
    ]) {
      const reason = unsatisfiedBy({ name, os: ['darwin'], cpu: ['arm64'] }, INTEL_MAC)
      expect(reason, name).toBeDefined()
      expect(reason).toContain(name)
      expect(reason).toContain('darwin/x64')
    }
  })

  it('catches a wrong platform as well as a wrong arch', () => {
    expect(unsatisfiedBy({ name: '@img/sharp-win32-x64', os: ['win32'], cpu: ['x64'] }, INTEL_MAC)).toBeDefined()
    expect(unsatisfiedBy({ name: '@img/sharp-linux-x64', os: ['linux'], cpu: ['x64'] }, INTEL_MAC)).toBeDefined()
  })

  it('does not fire on a native build, where host and target agree', () => {
    // The common case: every job builds for its own runner now. A rule that
    // failed here would make every build red rather than the broken one.
    expect(unsatisfiedBy({ name: '@koromix/koffi-darwin-arm64', os: ['darwin'], cpu: ['arm64'] }, APPLE_SILICON)).toBeUndefined()
  })

  it('honours npm exclusion syntax', () => {
    // fsevents-style manifests use `!` rather than an allow list, and reading
    // those as an allow list would report every package that excludes something
    // else — noise that would get the whole check switched off.
    expect(unsatisfiedBy({ name: 'x', os: ['!win32'] }, INTEL_MAC)).toBeUndefined()
    expect(unsatisfiedBy({ name: 'x', os: ['!darwin'] }, INTEL_MAC)).toBeDefined()
    expect(unsatisfiedBy({ name: 'x', cpu: ['!arm64'] }, INTEL_MAC)).toBeUndefined()
    expect(unsatisfiedBy({ name: 'x', cpu: ['!x64'] }, INTEL_MAC)).toBeDefined()
  })

  it('names the package and both sides, so a red build is actionable', () => {
    const reason = unsatisfiedBy({ name: '@vscode/ripgrep-darwin-arm64', os: ['darwin'], cpu: ['arm64'] }, INTEL_MAC)
    expect(reason).toBe('@vscode/ripgrep-darwin-arm64 declares os darwin cpu arm64, which does not include darwin/x64')
  })
})
