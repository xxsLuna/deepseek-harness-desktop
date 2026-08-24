/**
 * Window edge magnetism: the pure rule, with no Electron in it.
 *
 * A dragged window that comes within a few pixels of a screen edge is pulled
 * flush to it. The whole rule is arithmetic over rectangles, so it lives here
 * beside {@link ../window-state.js clampWindowState} — the other pure geometry
 * function this app tests without booting a window — and the call site in
 * main.ts keeps everything Electron-shaped: which event fires, which display
 * the window is on, and whether the platform can be trusted with any of it.
 *
 * Snapping is to the WORK AREA, not the display bounds. Flush to the display
 * on Windows means underneath the taskbar.
 */
import type { DisplayBounds, WindowBounds } from './window-state.js'

/**
 * How close an edge has to be, in DIP, before it pulls.
 *
 * Measured against the two failure directions rather than chosen for looks. Too
 * small and the magnet never catches, because a mouse moving at any speed steps
 * further than the threshold between two move events. Too large and the window
 * cannot be parked NEAR an edge on purpose — every attempt lands flush — and on
 * Windows it starts competing with Aero Snap, which triggers on the CURSOR
 * reaching the true screen edge. 12 is comfortably inside the ~20px of travel
 * left between a flush window and that trigger.
 */
export const SNAP_THRESHOLD = 12

/**
 * Snap a proposed window rectangle to the edges of one work area.
 *
 * Each axis is decided independently, which is also what makes corners work:
 * near a corner both axes are within range and both pull, so the corner needs
 * no rule of its own. They cannot disagree — x only ever reads left/right and
 * y only ever reads top/bottom.
 *
 * Within an axis the nearer edge wins outright rather than both being applied.
 * On a window as wide as the work area both edges are in range at once, and
 * applying left then right would move it twice, landing it wherever the second
 * assignment put it regardless of which the user was reaching for.
 *
 * The size is never changed. A magnet that resized on approach would make the
 * window a different shape than the one that was picked up, and this is invoked
 * mid-drag where that reads as the app fighting the mouse.
 * @param proposed - where the drag wants the window, in DIP.
 * @param workArea - the target display's usable area, taskbar excluded.
 * @param threshold - pull distance in DIP; 0 disables snapping entirely.
 * @returns the rectangle to use — the same numbers when nothing was in range.
 */
export function snapBounds(
  proposed: WindowBounds,
  workArea: DisplayBounds,
  threshold: number = SNAP_THRESHOLD,
): WindowBounds {
  if (threshold <= 0) return proposed

  const near = (a: number, b: number): boolean => Math.abs(a - b) <= threshold

  let { x, y } = proposed
  const right = proposed.x + proposed.width
  const bottom = proposed.y + proposed.height
  const areaRight = workArea.x + workArea.width
  const areaBottom = workArea.y + workArea.height

  const leftGap = Math.abs(proposed.x - workArea.x)
  const rightGap = Math.abs(right - areaRight)
  if (near(proposed.x, workArea.x) && leftGap <= rightGap) x = workArea.x
  else if (near(right, areaRight)) x = areaRight - proposed.width

  const topGap = Math.abs(proposed.y - workArea.y)
  const bottomGap = Math.abs(bottom - areaBottom)
  if (near(proposed.y, workArea.y) && topGap <= bottomGap) y = workArea.y
  else if (near(bottom, areaBottom)) y = areaBottom - proposed.height

  // Integers only: Electron's Rectangle is documented as integer DIP, and a
  // fractional value comes back rounded, which would make the result differ
  // from what was written and defeat the no-op comparison at the call site.
  return { x: Math.round(x), y: Math.round(y), width: proposed.width, height: proposed.height }
}

/**
 * Pick the work area a proposed rectangle should snap against.
 *
 * The window's own CENTRE decides, not its top-left corner, and not "whichever
 * display it overlaps most". Two adjacent displays share an inner seam that is
 * an edge of both work areas, so a window straddling it is in range of two
 * opposing magnets at once; choosing by centre gives that seam a single answer
 * that flips exactly once, at the halfway point, instead of the window sticking
 * to the seam and refusing to be dragged across.
 *
 * A centre that lands on no display — the gap in an L-shaped arrangement, or a
 * monitor unplugged mid-drag — snaps against nothing rather than teleporting
 * the window to a display it was not near.
 * @param proposed - where the drag wants the window, in DIP.
 * @param workAreas - every display's usable area.
 * @returns the containing work area, or undefined when the centre is off-screen.
 */
export function workAreaFor(
  proposed: WindowBounds,
  workAreas: readonly DisplayBounds[],
): DisplayBounds | undefined {
  const cx = proposed.x + proposed.width / 2
  const cy = proposed.y + proposed.height / 2
  return workAreas.find((area) =>
    cx >= area.x && cx < area.x + area.width && cy >= area.y && cy < area.y + area.height)
}

/**
 * Snap against whichever display the window is centred on.
 * @param proposed - where the drag wants the window, in DIP.
 * @param workAreas - every display's usable area.
 * @param threshold - pull distance in DIP.
 * @returns the rectangle to use.
 */
export function snapToDisplays(
  proposed: WindowBounds,
  workAreas: readonly DisplayBounds[],
  threshold: number = SNAP_THRESHOLD,
): WindowBounds {
  const area = workAreaFor(proposed, workAreas)
  return area === undefined ? proposed : snapBounds(proposed, area, threshold)
}

/**
 * Largest frame inset treated as a window border rather than a resize.
 *
 * Windows draws an invisible resize border outside the visible frame, and
 * `will-move` reports the rectangle INCLUDING it while `setBounds` takes the
 * one without. Measured on Windows 11: 8px each side and 8px at the bottom, so
 * `newBounds` runs 16 wider and 8 taller than `getBounds()` on every single
 * move. 32 leaves room for a heavier theme while staying far below the
 * hundreds of pixels an actual OS-initiated snap would change.
 */
const MAX_FRAME_INSET = 32

/**
 * Translate the rectangle a move event proposes into the one setBounds takes.
 *
 * These are two different rectangles and confusing them is not subtle: feeding
 * `will-move`'s bounds straight to `setBounds` sets the VISIBLE frame to the
 * size of the OUTER one, so the window gains the border on every snap — and
 * the next move proposes the new, larger outer rect, so it compounds. Measured
 * at 16x8 per snap before this existed.
 *
 * The inset is derived from the size difference rather than assumed, because
 * the number is a theme and DPI fact rather than a constant. The vertical
 * difference is taken as bottom-only: on Windows the top of the visible frame
 * and the top of the outer rect coincide, which the same measurement confirmed
 * (`newBounds.y` equals `getBounds().y` on every event of a drag).
 * @param proposed - the rectangle the move event carried.
 * @param visible - the window's current bounds, as setBounds understands them.
 * @returns the proposed position in visible coordinates at the window's CURRENT
 * size, or undefined when the difference is too large to be a border — which is
 * the OS proposing its own snap, and not ours to reinterpret.
 */
export function visibleFromProposed(
  proposed: WindowBounds,
  visible: WindowBounds,
): WindowBounds | undefined {
  const widthGap = proposed.width - visible.width
  const heightGap = proposed.height - visible.height
  if (widthGap < 0 || heightGap < 0) return undefined
  if (widthGap > MAX_FRAME_INSET * 2 || heightGap > MAX_FRAME_INSET) return undefined
  return {
    x: proposed.x + Math.round(widthGap / 2),
    y: proposed.y,
    // Never the proposed size. The size is the window's, and a move does not
    // change it; taking it from `proposed` is exactly the bug above.
    width: visible.width,
    height: visible.height,
  }
}

/** A screen point, as the cursor reports one. */
export interface Point {
  x: number
  y: number
}

/**
 * Move a rectangle by how far the cursor moved.
 *
 * This is what makes a magnet releasable, and it is not optional on Windows.
 * Measured: after the handler holds the window flush and the OS's own move is
 * cancelled, the NEXT proposal is re-anchored to where the window now is rather
 * than to where the cursor has travelled — proposals read 692, 692, 693 while
 * the window sat at 692 and the pointer kept going. Since `will-move` fires
 * about once per pixel, no single event can ever differ from the held edge by
 * more than the snap threshold, so snapping the OS's proposal traps the window
 * against the edge for the rest of the drag: it snaps once and never lets go.
 *
 * Tracking the cursor instead gives a position the magnet does not influence.
 * The window is held flush while the virtual rectangle slides out from under
 * it, and the moment that rectangle is further than the threshold the window
 * pops off and lands where the pointer actually is.
 * @param rect - the virtual, un-snapped rectangle.
 * @param from - cursor position at the previous event.
 * @param to - cursor position now.
 * @returns the rectangle advanced by the cursor's travel.
 */
export function advanceByCursor(rect: WindowBounds, from: Point, to: Point): WindowBounds {
  return {
    x: rect.x + (to.x - from.x),
    y: rect.y + (to.y - from.y),
    width: rect.width,
    height: rect.height,
  }
}

/**
 * Whether two rectangles are the same to the pixel.
 *
 * The call site needs this to decide whether to interfere with the drag at all:
 * cancelling a move and re-applying identical bounds is a visible stutter on
 * every mouse step that is nowhere near an edge, which is most of them.
 * @param a - one rectangle.
 * @param b - the other.
 * @returns true when every field matches.
 */
export function sameBounds(a: WindowBounds, b: WindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
