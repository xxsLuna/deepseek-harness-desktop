/**
 * Window-state persistence: pure clamp logic over a JSON file in userData.
 * A window saved on a since-removed monitor comes back on a visible display.
 */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface StoredWindowState extends WindowBounds {
  maximized: boolean
}

export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_STATE: StoredWindowState = { x: NaN, y: NaN, width: 1280, height: 800, maximized: false }

/** Minimum visible overlap (px) for a saved position to count as on-screen. */
const MIN_VISIBLE = 100

/**
 * Parse a stored state file's content; anything malformed falls back to defaults.
 * @param raw - the file content, or undefined when absent.
 * @returns a structurally valid state (position may be NaN = centered).
 */
export function parseWindowState(raw: string | undefined): StoredWindowState {
  if (raw === undefined) return DEFAULT_STATE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_STATE
    const record = parsed as Record<string, unknown>
    const num = (key: string, fallback: number): number =>
      typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : fallback
    return {
      x: num('x', NaN),
      y: num('y', NaN),
      width: Math.max(640, num('width', DEFAULT_STATE.width)),
      height: Math.max(480, num('height', DEFAULT_STATE.height)),
      maximized: record.maximized === true,
    }
  } catch {
    return DEFAULT_STATE
  }
}

/**
 * Clamp a state against the visible displays. A position with no meaningful
 * overlap on any display loses its coordinates (the window centers instead).
 * @param state - the parsed state.
 * @param displays - visible display bounds (screen.getAllDisplays().workArea).
 * @returns the state to apply.
 */
export function clampWindowState(state: StoredWindowState, displays: readonly DisplayBounds[]): StoredWindowState {
  if (Number.isNaN(state.x) || Number.isNaN(state.y)) return state
  const visible = displays.some((d) =>
    state.x + state.width > d.x + MIN_VISIBLE
    && state.x < d.x + d.width - MIN_VISIBLE
    && state.y >= d.y - MIN_VISIBLE
    && state.y < d.y + d.height - MIN_VISIBLE)
  return visible ? state : { ...state, x: NaN, y: NaN }
}
