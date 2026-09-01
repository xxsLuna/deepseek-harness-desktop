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
    // every notification about YOUR turn fired, the band was merged, updates
    // were automatic.
    //
    // notifySubagentTurns is the one exception, and it is off deliberately: a
    // subagent finishing raised a toast that read as "your turn is done" while
    // the agent kept working, so the shipped behaviour was the bug.
    // updateChannel is 'auto' rather than 'stable' for the same reason: 'auto'
    // follows whichever channel the build was cut on, so shipping this setting
    // changes nothing for anyone. 'stable' would move every non-stable install
    // onto stable at its first launch, which is the failure it exists to avoid.
    expect(DEFAULT_DESKTOP_SETTINGS).toEqual({
      closeAction: 'tray',
      notifyApprovals: true,
      notifyQuestions: true,
      notifyTurns: true,
      notifySubagentTurns: false,
      mergedTitleBar: true,
      autoUpdate: true,
      updateChannel: 'auto',
      snapToEdges: true,
      toggleAccelerator: 'CommandOrControl+Alt+D',
    })
    expect(parseDesktopSettings(undefined)).toEqual(DEFAULT_DESKTOP_SETTINGS)
  })

  it('takes an accelerator, including the empty one that means disabled', () => {
    expect(parseDesktopSettings(JSON.stringify({ toggleAccelerator: '' })).toggleAccelerator).toBe('')
    expect(parseDesktopSettings(JSON.stringify({ toggleAccelerator: 'Alt+Space' })).toggleAccelerator).toBe('Alt+Space')
  })

  it('refuses an accelerator that is not a bounded single-line string', () => {
    // Not a syntax check — Electron owns accelerator grammar and rejecting a
    // chord it would have taken is worse than letting globalShortcut report it
    // unavailable. This only stops junk reaching a file parsed at every launch.
    const fallback = DEFAULT_DESKTOP_SETTINGS.toggleAccelerator
    for (const bad of [42, null, 'a'.repeat(200), 'Ctrl+\nA']) {
      expect(parseDesktopSettings(JSON.stringify({ toggleAccelerator: bad })).toggleAccelerator).toBe(fallback)
    }
  })

  it('merges the accelerator, and leaves it alone when the patch is unusable', () => {
    const current = { ...DEFAULT_DESKTOP_SETTINGS, toggleAccelerator: 'Alt+Space' }
    expect(mergeDesktopSettings({ toggleAccelerator: 'Ctrl+Alt+H' }, current).toggleAccelerator).toBe('Ctrl+Alt+H')
    expect(mergeDesktopSettings({ toggleAccelerator: 7 }, current).toggleAccelerator).toBe('Alt+Space')
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

describe('parseDesktopSettings: updateChannel', () => {
  const parse = (record: Record<string, unknown>): string =>
    parseDesktopSettings(JSON.stringify(record)).updateChannel

  it('keeps each channel it understands', () => {
    for (const channel of ['auto', 'stable', 'develop', 'alpha']) {
      expect(parse({ updateChannel: channel }), channel).toBe(channel)
    }
  })

  it('falls back to auto, never to stable', () => {
    // The distinction is the whole safety of the field: 'auto' defers to the
    // channel the build was cut on, 'stable' overrides it. Falling back to
    // 'stable' would move a develop or alpha install onto stable the first
    // time its settings file was unreadable.
    for (const value of [undefined, '', 'STABLE', 'nightly', 3, null, {}]) {
      expect(parse({ updateChannel: value }), String(value)).toBe('auto')
    }
  })

  it('survives a file with nothing else in it', () => {
    expect(parse({})).toBe('auto')
  })
})

describe('mergeDesktopSettings: updateChannel', () => {
  const onDevelop = { ...DEFAULT_DESKTOP_SETTINGS, updateChannel: 'develop' as const }

  it('applies a channel the user chose', () => {
    expect(mergeDesktopSettings({ updateChannel: 'alpha' }, onDevelop).updateChannel).toBe('alpha')
    expect(mergeDesktopSettings({ updateChannel: 'auto' }, onDevelop).updateChannel).toBe('auto')
  })

  it('leaves the stored channel alone when the patch is unusable', () => {
    // Not 'auto' — that is parse's fallback for an unreadable FILE. A rejected
    // patch field must not move a preference the user never touched, and here
    // that would silently switch someone off the channel they chose.
    for (const value of ['nightly', 3, null, undefined]) {
      expect(mergeDesktopSettings({ updateChannel: value }, onDevelop).updateChannel, String(value)).toBe('develop')
    }
  })
})
