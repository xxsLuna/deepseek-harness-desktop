import { describe, expect, it, vi } from 'vitest'

const register = vi.fn<(accelerator: string, handler: () => void) => boolean>()
const unregister = vi.fn()
const focus = vi.fn()

vi.mock('electron', () => ({
  app: { focus },
  globalShortcut: {
    register: (accelerator: string, handler: () => void) => register(accelerator, handler),
    unregister: (accelerator: string) => unregister(accelerator),
  },
}))

const { DEFAULT_TOGGLE_ACCELERATOR, installShortcuts } = await import('../../src/shortcuts.js')

/** A window stub recording what the toggle did to it. */
function windowStub(state: { visible: boolean, focused: boolean, minimized?: boolean }) {
  const calls: string[] = []
  return {
    calls,
    win: {
      isVisible: () => state.visible,
      isFocused: () => state.focused,
      isMinimized: () => state.minimized ?? false,
      restore: () => { calls.push('restore') },
      show: () => { calls.push('show') },
      hide: () => { calls.push('hide') },
      focus: () => { calls.push('focus') },
    } as never,
  }
}

describe('installShortcuts', () => {
  it('hides a window that is already frontmost, and raises one that is not', () => {
    register.mockReturnValue(true)

    const front = windowStub({ visible: true, focused: true })
    installShortcuts(front.win)
    register.mock.calls[0]![1]!()
    expect(front.calls).toEqual(['hide'])

    register.mockClear()
    const behind = windowStub({ visible: true, focused: false, minimized: true })
    installShortcuts(behind.win)
    register.mock.calls[0]![1]!()
    expect(behind.calls).toEqual(['restore', 'show', 'focus'])
  })

  it('keeps running when the accelerator is already taken', () => {
    // Another app holding the chord is an environment fact, not a
    // misconfiguration: the tray still toggles the window.
    register.mockReturnValue(false)
    const stop = installShortcuts(windowStub({ visible: false, focused: false }).win)
    unregister.mockClear()
    stop()
    expect(unregister).not.toHaveBeenCalled()
  })

  it('registers nothing when disabled with an empty accelerator', () => {
    register.mockClear()
    installShortcuts(windowStub({ visible: true, focused: true }).win, '')
    expect(register).not.toHaveBeenCalled()
  })

  it('unregisters exactly what it registered', () => {
    register.mockReturnValue(true)
    const stop = installShortcuts(windowStub({ visible: true, focused: true }).win)
    stop()
    expect(unregister).toHaveBeenCalledWith(DEFAULT_TOGGLE_ACCELERATOR)
  })
})
