import { describe, expect, it } from 'vitest'
import { clampWindowState, DEFAULT_STATE, parseWindowState } from '../src/window-state.js'

describe('parseWindowState', () => {
  it('falls back to defaults for absent or malformed content', () => {
    expect(parseWindowState(undefined)).toEqual(DEFAULT_STATE)
    expect(parseWindowState('not json')).toEqual(DEFAULT_STATE)
    expect(parseWindowState('null')).toEqual(DEFAULT_STATE)
    expect(parseWindowState('[1,2]').width).toBe(1280)
  })

  it('parses a stored state and enforces minimum size', () => {
    const state = parseWindowState(JSON.stringify({ x: 10, y: 20, width: 100, height: 100, maximized: true }))
    expect(state).toEqual({ x: 10, y: 20, width: 640, height: 480, maximized: true })
  })

  it('drops non-finite coordinates', () => {
    const state = parseWindowState(JSON.stringify({ x: 'a', y: 5, width: 800, height: 600 }))
    expect(Number.isNaN(state.x)).toBe(true)
    expect(state.y).toBe(5)
  })
})

describe('clampWindowState', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 }

  it('keeps a position visible on a display', () => {
    const state = { x: 100, y: 100, width: 800, height: 600, maximized: false }
    expect(clampWindowState(state, [display])).toEqual(state)
  })

  it('drops coordinates saved on a removed monitor', () => {
    const offscreen = { x: 5000, y: 100, width: 800, height: 600, maximized: false }
    const clamped = clampWindowState(offscreen, [display])
    expect(Number.isNaN(clamped.x)).toBe(true)
    expect(clamped.width).toBe(800)
  })

  it('passes centered (NaN) positions through unchanged', () => {
    const centered = { ...DEFAULT_STATE }
    expect(clampWindowState(centered, [display])).toEqual(centered)
  })

  it('accepts a window on a secondary display', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1080 }
    const state = { x: 2000, y: 50, width: 800, height: 600, maximized: false }
    expect(clampWindowState(state, [display, second])).toEqual(state)
  })
})
