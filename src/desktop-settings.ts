/**
 * Desktop preferences: the settings only this launcher can act on, and the
 * only place their defaults are written down.
 *
 * The harness owns everything about a session; these are about the window it
 * lives in — what closing it does, which events are worth an OS notification,
 * whether the title bar is merged into the UI, and whether the app updates
 * itself. None of that is reachable from a sidecar plugin, so the launcher
 * stores and applies it, and the Desktop Settings section
 * (@dsh-desktop/settings) is a view onto this file.
 *
 * Parsing is pure and total: a hand-edited or half-written file must not stop
 * the app from starting, so every field falls back to its default alone.
 */

/** What closing the window does. */
export type CloseAction = 'tray' | 'quit'

export interface DesktopSettings {
  /**
   * Close to the tray (the default) or quit the app outright. The tray icon
   * itself is not a separate preference: with 'quit' the app is gone the
   * moment the window closes, so an icon that only exists while a window is
   * already open buys nothing — and 'tray' with no icon would hide the window
   * with no way to bring it back.
   */
  readonly closeAction: CloseAction
  /** Notify when the agent asks for approval. */
  readonly notifyApprovals: boolean
  /** Notify when the agent asks a question. */
  readonly notifyQuestions: boolean
  /** Notify when a turn finishes (only while the window is unfocused). */
  readonly notifyTurns: boolean
  /**
   * Also notify when a SUBAGENT's turn finishes.
   *
   * Nested under notifyTurns rather than beside it, because a subagent turn is
   * a step inside the turn you asked for: switching the parent off and this on
   * would notify about the inside of work you said you did not want told about.
   * Off by default -- the launcher cannot tell the two apart without asking, so
   * before this existed every subagent finishing raised a toast that read as
   * "your turn is done" while the agent kept working.
   */
  readonly notifySubagentTurns: boolean
  /** Merge the title bar into the UI, where the platform supports it. */
  readonly mergedTitleBar: boolean
  /** Check GitHub Releases for a newer version in the background. */
  readonly autoUpdate: boolean
  /** Snap the window flush to a screen edge when dragged near one. */
  readonly snapToEdges: boolean
  /**
   * Accelerator that shows or hides the window from anywhere; '' disables it.
   * A string rather than a flag because the chord itself is the preference --
   * the default collides with something on some machines, which is the whole
   * reason this is settable.
   */
  readonly toggleAccelerator: string
}

/**
 * The shipped behaviour: closing hides to the tray, the band is merged, the app
 * keeps itself up to date, and the window snaps to screen edges.
 *
 * Every notification about YOUR turn fires; subagent turns do not. That last
 * default is the one that changed behaviour rather than merely adding to it,
 * and deliberately: a subagent finishing is not an event a person is waiting
 * on, and firing it was indistinguishable from the notification that means the
 * agent is done with you.
 */
export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  closeAction: 'tray',
  notifyApprovals: true,
  notifyQuestions: true,
  notifyTurns: true,
  notifySubagentTurns: false,
  mergedTitleBar: true,
  autoUpdate: true,
  snapToEdges: true,
  toggleAccelerator: 'CommandOrControl+Alt+D',
}

/** The fields that are plain on/off switches. */
type BooleanField = Exclude<keyof DesktopSettings, 'closeAction' | 'toggleAccelerator'>

/** Those fields, enumerable — the write path walks them. */
const BOOLEAN_FIELDS: readonly BooleanField[] = [
  'notifyApprovals', 'notifyQuestions', 'notifyTurns', 'notifySubagentTurns',
  'mergedTitleBar', 'autoUpdate', 'snapToEdges',
]

/**
 * Longest accelerator worth storing.
 *
 * Not a syntax check: Electron owns accelerator grammar and rejecting a chord
 * it would have accepted is worse than passing one through and having
 * globalShortcut report it unavailable, which the app already handles. This
 * only stops an unbounded string reaching a file the app parses at every
 * launch.
 */
const ACCELERATOR_MAX = 120

/**
 * Parse a stored settings file; anything malformed falls back per field.
 * @param raw - the file content, or undefined when absent.
 * @returns a structurally valid settings object.
 */
export function parseDesktopSettings(raw: string | undefined): DesktopSettings {
  if (raw === undefined) return DEFAULT_DESKTOP_SETTINGS
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_DESKTOP_SETTINGS
    record = parsed as Record<string, unknown>
  } catch {
    return DEFAULT_DESKTOP_SETTINGS
  }
  const flag = (key: BooleanField): boolean =>
    typeof record[key] === 'boolean' ? record[key] : DEFAULT_DESKTOP_SETTINGS[key]
  return {
    closeAction: record.closeAction === 'quit' ? 'quit' : 'tray',
    notifyApprovals: flag('notifyApprovals'),
    notifyQuestions: flag('notifyQuestions'),
    notifyTurns: flag('notifyTurns'),
    notifySubagentTurns: flag('notifySubagentTurns'),
    mergedTitleBar: flag('mergedTitleBar'),
    autoUpdate: flag('autoUpdate'),
    snapToEdges: flag('snapToEdges'),
    toggleAccelerator: isAccelerator(record.toggleAccelerator)
      ? record.toggleAccelerator
      : DEFAULT_DESKTOP_SETTINGS.toggleAccelerator,
  }
}

/**
 * Whether a value is storable as the toggle accelerator.
 * @param value - the candidate, of unknown shape.
 * @returns true for a string within bounds; '' is valid and means disabled.
 */
export function isAccelerator(value: unknown): value is string {
  return typeof value === 'string' && value.length <= ACCELERATOR_MAX && !/[\r\n]/.test(value)
}

/**
 * Apply a patch from the settings UI onto the stored settings.
 *
 * A field is taken only when it is present AND of the right shape; anything
 * else leaves the STORED value alone. Reparsing the merge instead would reset
 * a rejected field to its default, which is a worse answer than "the write
 * did not happen" — the user would see an unrelated preference move.
 * @param patch - the incoming JSON body, of unknown shape.
 * @param current - the settings to merge onto.
 * @returns the merged settings.
 */
export function mergeDesktopSettings(patch: unknown, current: DesktopSettings): DesktopSettings {
  if (typeof patch !== 'object' || patch === null) return current
  const record = patch as Record<string, unknown>
  const next = { ...current } as { -readonly [K in keyof DesktopSettings]: DesktopSettings[K] }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof record[key] === 'boolean') next[key] = record[key]
  }
  if (record.closeAction === 'tray' || record.closeAction === 'quit') next.closeAction = record.closeAction
  if (isAccelerator(record.toggleAccelerator)) next.toggleAccelerator = record.toggleAccelerator
  return next
}
