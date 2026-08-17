import { describe, expect, it } from 'vitest'
import { updateMode } from '../../src/update-gate.js'

describe('updateMode', () => {
  it('disables updates in dev', () => {
    expect(updateMode({ platform: 'darwin', packaged: false, macUpdatesSigned: false })).toBe('disabled')
    expect(updateMode({ platform: 'win32', packaged: false, macUpdatesSigned: false })).toBe('disabled')
  })

  it('auto-updates Windows and Linux regardless of signing', () => {
    expect(updateMode({ platform: 'win32', packaged: true, macUpdatesSigned: false })).toBe('auto')
    expect(updateMode({ platform: 'linux', packaged: true, macUpdatesSigned: false })).toBe('auto')
  })

  it('falls back to notify-only on unsigned macOS', () => {
    expect(updateMode({ platform: 'darwin', packaged: true, macUpdatesSigned: false })).toBe('notify-only')
  })

  it('auto-updates macOS once the build is signed', () => {
    expect(updateMode({ platform: 'darwin', packaged: true, macUpdatesSigned: true })).toBe('auto')
  })
})
