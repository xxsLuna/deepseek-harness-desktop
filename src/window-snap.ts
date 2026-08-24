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
