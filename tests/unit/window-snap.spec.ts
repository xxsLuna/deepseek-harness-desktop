import { describe, expect, it } from 'vitest'
import {
  advanceByCursor,
  sameBounds,
  snapBounds,
  SNAP_THRESHOLD,
  snapToDisplays,
  visibleFromProposed,
  workAreaFor,
} from '../../src/window-snap.js'

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

describe('visibleFromProposed', () => {
  // The exact numbers a Windows 11 drag produced, 914 events of them, every one
  // identical: `will-move` reports the outer rectangle including the invisible
  // resize border, and `setBounds` takes the visible one.
  const proposed = { x: 699, y: 391, width: 1077, height: 708 }
  const visible = { x: 708, y: 391, width: 1061, height: 700 }

  it('keeps the window at ITS OWN size, never the proposed one', () => {
    // The bug this exists to stop: passing the outer rectangle to setBounds
    // sets the VISIBLE frame to the outer size, so the window gains 16x8 on
    // every snap — and compounds, because the next move proposes the new,
    // larger outer rect. Reported as the window growing without limit.
    const translated = visibleFromProposed(proposed, visible)
    expect(translated?.width).toBe(1061)
    expect(translated?.height).toBe(700)
  })

  it('shifts the position by half the width difference', () => {
    // The border is symmetric left and right, so half the width gap is the left
    // inset. 699 + 8 = 707, one pixel left of where the window is — which is
    // the movement the drag was asking for.
    expect(visibleFromProposed(proposed, visible)?.x).toBe(707)
  })

  it('leaves y alone, because the top has no invisible border', () => {
    // Measured: newBounds.y equals getBounds().y on every event of a drag. The
    // whole 8px height difference is at the bottom.
    expect(visibleFromProposed(proposed, visible)?.y).toBe(391)
  })

  it('is a no-op translation when the two rectangles already agree', () => {
    // Any platform that reports the visible rectangle directly gets the
    // proposed position through untouched.
    const same = { x: 100, y: 200, width: 800, height: 600 }
    expect(visibleFromProposed(same, { ...same, x: 0, y: 0 })).toEqual(same)
  })

  it('refuses a difference too large to be a border', () => {
    // That is the OS proposing its own arrangement — Aero Snap offering half
    // the screen — which is a resize, and not ours to reinterpret as a move.
    const aero = { x: 0, y: 696, width: 1280, height: 696 }
    expect(visibleFromProposed(aero, visible)).toBeUndefined()
  })

  it('refuses a proposal SMALLER than the window', () => {
    // A border can only make the outer rectangle bigger. Smaller means the
    // event is not describing the same window state, so nothing is assumed.
    expect(visibleFromProposed({ x: 0, y: 0, width: 500, height: 400 }, visible)).toBeUndefined()
  })

  it('composes with the snap to land the VISIBLE frame flush', () => {
    // End to end, in the units that actually reach setBounds.
    const work = { x: 0, y: 0, width: 2560, height: 1392 }
    const nearLeft = { x: -3, y: 400, width: 1077, height: 708 }
    const here = { x: 5, y: 400, width: 1061, height: 700 }
    const translated = visibleFromProposed(nearLeft, here)
    expect(translated).toBeDefined()
    const snapped = snapBounds(translated!, work)
    expect(snapped).toEqual({ x: 0, y: 400, width: 1061, height: 700 })
  })
})

describe('advanceByCursor', () => {
  const rect = { x: 100, y: 200, width: 800, height: 600 }

  it('moves the rectangle by exactly the cursor travel', () => {
    expect(advanceByCursor(rect, { x: 10, y: 10 }, { x: 25, y: 4 }))
      .toEqual({ x: 115, y: 194, width: 800, height: 600 })
  })

  it('leaves the size alone', () => {
    const moved = advanceByCursor(rect, { x: 0, y: 0 }, { x: 500, y: 500 })
    expect(moved.width).toBe(800)
    expect(moved.height).toBe(600)
  })

  it('does nothing when the cursor did not move', () => {
    expect(advanceByCursor(rect, { x: 7, y: 9 }, { x: 7, y: 9 })).toEqual(rect)
  })

  it('lets a held window escape an edge one pixel of cursor travel at a time', () => {
    // The reported failure, as an assertion. Snapping whatever the OS proposes
    // traps the window: once it is held flush, Windows re-anchors its proposals
    // to the held position, so with `will-move` firing about once per pixel no
    // single event can ever exceed the threshold and the magnet never releases.
    //
    // A rectangle advanced by cursor travel is not influenced by where the
    // window is being held, so the escape accumulates.
    const work = { x: 0, y: 0, width: 2560, height: 1392 }
    let virtual = { x: 4, y: 300, width: 800, height: 600 }
    let cursor = { x: 400, y: 300 }
    const held: number[] = []

    // Drag right, one pixel per event, twenty events.
    for (let step = 0; step < 20; step += 1) {
      const next = { x: cursor.x + 1, y: cursor.y }
      virtual = advanceByCursor(virtual, cursor, next)
      cursor = next
      held.push(snapBounds(virtual, work).x)
    }

    // Held at the edge while the virtual rectangle slides out from under it...
    expect(held[0]).toBe(0)
    expect(held[5]).toBe(0)
    // ...then released, landing where the cursor actually is.
    expect(held[held.length - 1]).toBe(24)
    expect(held.some((x) => x > 0)).toBe(true)
  })
})
