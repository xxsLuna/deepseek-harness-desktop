import { describe, expect, it } from 'vitest'
import { deepLinkFromArgv, parseDeepLink } from '../../src/deep-link.js'

describe('parseDeepLink', () => {
  it('recognizes the app scheme', () => {
    expect(parseDeepLink('dsh-app://open')).toEqual({ kind: 'open' })
    expect(parseDeepLink('dsh-app://anything/else')).toEqual({ kind: 'open' })
  })

  it('rejects foreign schemes and malformed input', () => {
    expect(parseDeepLink('dsh://app/')).toBeUndefined()
    expect(parseDeepLink('https://example.com')).toBeUndefined()
    expect(parseDeepLink('not a url')).toBeUndefined()
  })
})

describe('deepLinkFromArgv', () => {
  it('extracts the last deep link from a second-instance argv', () => {
    expect(deepLinkFromArgv(['app.exe', '--flag', 'dsh-app://open'])).toEqual({ kind: 'open' })
  })

  it('returns undefined when no deep link is present', () => {
    expect(deepLinkFromArgv(['app.exe', '--flag'])).toBeUndefined()
  })
})
