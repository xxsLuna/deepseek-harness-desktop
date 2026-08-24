import { describe, expect, it } from 'vitest'
import { sameBounds, snapBounds, SNAP_THRESHOLD, snapToDisplays, workAreaFor } from '../../src/window-snap.js'

/** A 1920x1080 display whose taskbar takes the bottom 40px. */
const work = { x: 0, y: 0, width: 1920, height: 1040 }
const size = { width: 800, height: 600 }

describe('snapBounds', () => {
  it('leaves a window that is nowhere near an edge alone', () => {
    const free = { x: 500, y: 300, ...size }
    expect(snapBounds(free, work)).toEqual(free)
  })

  it('pulls each edge flush from just inside and just outside the threshold', () => {
    expect(snapBounds({ x: 8, y: 300, ...size }, work).x).toBe(0)
    expect(snapBounds({ x: -8, y: 300, ...size }, work).x).toBe(0)
    expect(snapBounds({ x: 300, y: 8, ...size }, work).y).toBe(0)
    expect(snapBounds({ x: 1920 - 800 - 8, y: 300, ...size }, work).x).toBe(1120)
    expect(snapBounds({ x: 300, y: 1040 - 600 + 8, ...size }, work).y).toBe(440)
  })

  it('does not pull from beyond the threshold', () => {
    const beyond = { x: SNAP_THRESHOLD + 1, y: 300, ...size }
    expect(snapBounds(beyond, work).x).toBe(SNAP_THRESHOLD + 1)
  })

  it('snaps a corner by snapping both axes', () => {
    // The corner needs no rule of its own; this is the assertion that says so.
    expect(snapBounds({ x: 5, y: 5, ...size }, work)).toEqual({ x: 0, y: 0, ...size })
    expect(snapBounds({ x: 1115, y: 435, ...size }, work)).toEqual({ x: 1120, y: 440, ...size })
  })

  it('snaps to the work area, so a maximal window clears the taskbar', () => {
    // 1040, not 1080: flush to the display bottom on Windows is underneath it.
    const tall = { x: 3, y: 3, width: 1920, height: 1040 }
    expect(snapBounds(tall, work)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('picks the nearer edge when a full-width window is in range of both', () => {
    // Applying both would move it twice and land it wherever the second
    // assignment put it, regardless of which edge the user was reaching for.
    const wide = { x: -4, y: 300, width: 1920, height: 600 }
    expect(snapBounds(wide, work).x).toBe(0)
    const shifted = { x: 4, y: 300, width: 1920, height: 600 }
    expect(snapBounds(shifted, work).x).toBe(0)
  })

  it('never changes the size', () => {
    const snapped = snapBounds({ x: 2, y: 2, ...size }, work)
    expect(snapped.width).toBe(800)
    expect(snapped.height).toBe(600)
  })

  it('is idempotent, because the call site re-enters through its own setBounds', () => {
    const once = snapBounds({ x: 6, y: 6, ...size }, work)
    expect(snapBounds(once, work)).toEqual(once)
  })

  it('returns integers', () => {
    const snapped = snapBounds({ x: 0.4, y: 300.6, ...size }, work)
    expect(Number.isInteger(snapped.x)).toBe(true)
    expect(Number.isInteger(snapped.y)).toBe(true)
  })

  it('disables entirely at threshold 0', () => {
    const touching = { x: 1, y: 1, ...size }
    expect(snapBounds(touching, work, 0)).toEqual(touching)
  })
})

describe('workAreaFor', () => {
  const left = { x: 0, y: 0, width: 1920, height: 1040 }
  const right = { x: 1920, y: 0, width: 1920, height: 1040 }

  it('picks by centre, so the shared seam flips exactly once', () => {
    // Straddling the seam, the window is in range of two opposing magnets. By
    // top-left it would stay on the left display until fully across; by centre
    // it changes hands halfway, and the seam never holds it.
    // Centre is x + 400, so the hand-off is at x = 1520, not at the seam.
    expect(workAreaFor({ x: 1519, y: 100, ...size }, [left, right])).toBe(left)
    expect(workAreaFor({ x: 1520, y: 100, ...size }, [left, right])).toBe(right)
  })

  it('finds nothing when the centre is off every display', () => {
    expect(workAreaFor({ x: 5000, y: 100, ...size }, [left, right])).toBeUndefined()
  })
})

describe('snapToDisplays', () => {
  const left = { x: 0, y: 0, width: 1920, height: 1040 }
  const right = { x: 1920, y: 0, width: 1920, height: 1040 }

  it('snaps against the display the window is centred on', () => {
    expect(snapToDisplays({ x: 1925, y: 100, ...size }, [left, right]).x).toBe(1920)
  })

  it('does not pull a window across the inner seam', () => {
    // 1920 is the right edge of `left` and the left edge of `right`. A window
    // centred on `right` and near the seam snaps to 1920 — which is `right`'s
    // own left edge, not a jump backwards onto the other display.
    const nearSeam = { x: 1928, y: 100, ...size }
    expect(snapToDisplays(nearSeam, [left, right])).toEqual({ x: 1920, y: 100, ...size })
  })

  it('leaves the window alone when its centre is on no display', () => {
    const orphan = { x: 5000, y: 100, ...size }
    expect(snapToDisplays(orphan, [left])).toEqual(orphan)
  })
})

describe('sameBounds', () => {
  it('is exact, so an unchanged drag step can be left alone', () => {
    expect(sameBounds({ x: 1, y: 2, ...size }, { x: 1, y: 2, ...size })).toBe(true)
    expect(sameBounds({ x: 1, y: 2, ...size }, { x: 1, y: 3, ...size })).toBe(false)
  })
})
