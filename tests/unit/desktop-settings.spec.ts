/**
 * Desktop preferences. The file is hand-editable and the patch comes off the
 * wire, so both directions are total: a launch must never fail over a stored
 * preference, and a bad write must never move a preference the user did not
 * touch.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESKTOP_SETTINGS,
  mergeDesktopSettings,
  parseDesktopSettings,
} from '../../src/desktop-settings.js'

describe('parseDesktopSettings', () => {
  it('defaults to the behaviour the app shipped with', () => {
    // These defaults ARE the pre-settings behaviour: closing hid to the tray,
    // every notification fired, the band was merged, updates were automatic.
    expect(DEFAULT_DESKTOP_SETTINGS).toEqual({
      closeAction: 'tray',
      notifyApprovals: true,
      notifyQuestions: true,
      notifyTurns: true,
      mergedTitleBar: true,
      autoUpdate: true,
    })
    expect(parseDesktopSettings(undefined)).toEqual(DEFAULT_DESKTOP_SETTINGS)
  })

  it('survives anything the file could contain', () => {
    for (const raw of ['', '{', 'null', '[]', '"tray"', '42']) {
      expect(parseDesktopSettings(raw), raw).toEqual(DEFAULT_DESKTOP_SETTINGS)
    }
  })

  it('falls back per field, keeping the readable ones', () => {
    const parsed = parseDesktopSettings(JSON.stringify({
      closeAction: 'quit',
      notifyTurns: false,
      notifyApprovals: 'yes',
      unknownField: 1,
    }))
    expect(parsed.closeAction).toBe('quit')
    expect(parsed.notifyTurns).toBe(false)
    // Unreadable, so the default stands rather than the whole file failing.
    expect(parsed.notifyApprovals).toBe(true)
    expect(parsed).not.toHaveProperty('unknownField')
  })

  it('treats any unknown close action as the safe one', () => {
    // Anything but 'quit' hides to the tray: a window that vanishes when the
    // user expected the app to stay is the recoverable mistake of the two.
    expect(parseDesktopSettings('{"closeAction":"explode"}').closeAction).toBe('tray')
  })
})

describe('mergeDesktopSettings', () => {
  const stored = { ...DEFAULT_DESKTOP_SETTINGS, closeAction: 'quit' as const, notifyTurns: false }

  it('applies the fields a patch names and leaves the rest', () => {
    expect(mergeDesktopSettings({ notifyQuestions: false }, stored)).toEqual({ ...stored, notifyQuestions: false })
    expect(mergeDesktopSettings({ closeAction: 'tray' }, stored).closeAction).toBe('tray')
  })

  it('ignores a field it cannot use rather than resetting it', () => {
    // The stored value must survive: resetting a rejected field to its default
    // would move a preference the user never touched.
    expect(mergeDesktopSettings({ notifyTurns: 'no' }, stored).notifyTurns).toBe(false)
    expect(mergeDesktopSettings({ closeAction: 'explode' }, stored).closeAction).toBe('quit')
    expect(mergeDesktopSettings({ unknownField: true }, stored)).toEqual(stored)
  })

  it('ignores a body that is not an object at all', () => {
    for (const patch of [undefined, null, 'quit', 7, []]) {
      expect(mergeDesktopSettings(patch, stored), String(patch)).toEqual(stored)
    }
  })
})
