import { describe, expect, it } from 'vitest'
import { createSidecarAddress } from '../src/socket-path.js'

describe('createSidecarAddress', () => {
  it('uses a named pipe on Windows', () => {
    const address = createSidecarAddress('win32', 'C:\\ignored')
    expect(address.socketPath.startsWith('\\\\.\\pipe\\dsh-')).toBe(true)
    expect(address.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses a short tmp socket path on POSIX', () => {
    const address = createSidecarAddress('darwin', '/tmp')
    expect(address.socketPath.startsWith('/tmp/dsh-')).toBe(true)
    expect(address.socketPath.endsWith('/s')).toBe(true)
    // macOS sun_path limit is ~104 bytes; leave generous headroom.
    expect(address.socketPath.length).toBeLessThan(60)
  })

  it('generates a fresh token and path per call', () => {
    const a = createSidecarAddress('linux', '/tmp')
    const b = createSidecarAddress('linux', '/tmp')
    expect(a.token).not.toBe(b.token)
    expect(a.socketPath).not.toBe(b.socketPath)
  })
})
