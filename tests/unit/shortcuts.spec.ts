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
    const handle = installShortcuts(windowStub({ visible: false, focused: false }).win)
    expect(handle.isActive()).toBe(false)
    unregister.mockClear()
    handle.stop()
    expect(unregister).not.toHaveBeenCalled()
  })

  it('registers nothing when disabled with an empty accelerator', () => {
    register.mockClear()
    const handle = installShortcuts(windowStub({ visible: true, focused: true }).win, '')
    expect(register).not.toHaveBeenCalled()
    expect(handle.isActive()).toBe(false)
  })

  it('unregisters exactly what it registered', () => {
    register.mockReturnValue(true)
    const handle = installShortcuts(windowStub({ visible: true, focused: true }).win)
    expect(handle.isActive()).toBe(true)
    handle.stop()
    expect(unregister).toHaveBeenCalledWith(DEFAULT_TOGGLE_ACCELERATOR)
  })

  it('releases the old chord before claiming the new one', () => {
    // Rebinding while still holding the old chord would leave the OS routing
    // both here, with nothing left that knows to unregister the first.
    register.mockReturnValue(true)
    const handle = installShortcuts(windowStub({ visible: true, focused: true }).win)
    unregister.mockClear()
    register.mockClear()
    expect(handle.rebind('CommandOrControl+Shift+K')).toBe(true)
    expect(unregister).toHaveBeenCalledWith(DEFAULT_TOGGLE_ACCELERATOR)
    expect(register.mock.calls[0]![0]).toBe('CommandOrControl+Shift+K')
    handle.stop()
    expect(unregister).toHaveBeenLastCalledWith('CommandOrControl+Shift+K')
  })

  it('rebinding to empty releases without registering', () => {
    register.mockReturnValue(true)
    const handle = installShortcuts(windowStub({ visible: true, focused: true }).win)
    unregister.mockClear()
    register.mockClear()
    expect(handle.rebind('')).toBe(false)
    expect(unregister).toHaveBeenCalledWith(DEFAULT_TOGGLE_ACCELERATOR)
    expect(register).not.toHaveBeenCalled()
    expect(handle.isActive()).toBe(false)
  })

  it('survives an accelerator Electron refuses to parse', () => {
    // A malformed chord is a bad preference, not a reason to stop the app.
    register.mockReturnValue(true)
    const handle = installShortcuts(windowStub({ visible: true, focused: true }).win)
    register.mockImplementation(() => { throw new Error('Invalid accelerator') })
    expect(handle.rebind('NotAKey+')).toBe(false)
    expect(handle.isActive()).toBe(false)
    register.mockReset()
    register.mockReturnValue(true)
  })
})
