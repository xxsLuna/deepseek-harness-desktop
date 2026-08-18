import { describe, expect, it } from 'vitest'
import { APP_ORIGIN, isHostOnlyPath, isTrustedRendererRequest } from '../../src/socket-proxy.js'

describe('isHostOnlyPath', () => {
  it('refuses the launcher-only surface', () => {
    // The proxy injects the bearer token on everything it forwards, so without
    // this fence a page could subscribe to launcher channels and forge their
    // answers — for the picker, opening a workspace at a path it chose.
    for (const path of ['/desktop', '/desktop/', '/desktop/picker/requests', '/desktop/picker/answer']) {
      expect(isHostOnlyPath(path)).toBe(true)
    }
  })

  it('allows the renderer surface', () => {
    for (const path of ['/', '/api/session.list', '/api/events.mux', '/plugins/@scope/pkg/client.js', '/assets/index.js']) {
      expect(isHostOnlyPath(path)).toBe(false)
    }
  })

  it('does not treat a lookalike prefix as launcher-only', () => {
    expect(isHostOnlyPath('/desktops')).toBe(false)
    expect(isHostOnlyPath('/api/desktop/x')).toBe(false)
  })
})

describe('isTrustedRendererRequest', () => {
  const req = (headers: Record<string, string>) => new Request('dsh://app/api/session.list', { headers })

  it('accepts same-origin and marker-less requests', () => {
    expect(isTrustedRendererRequest(req({ origin: APP_ORIGIN }))).toBe(true)
    expect(isTrustedRendererRequest(req({}))).toBe(true)
  })

  it('refuses a cross-site marker or a foreign origin', () => {
    expect(isTrustedRendererRequest(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isTrustedRendererRequest(req({ origin: 'https://evil.example' }))).toBe(false)
  })
})
