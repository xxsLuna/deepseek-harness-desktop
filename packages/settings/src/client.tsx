/**
 * @dsh-desktop/settings browser half — the Desktop Settings section.
 *
 * Registers one `settings.section` entry, which is the whole integration: the
 * upstream settings shell owns no copy of its own and renders whatever its
 * registrants contribute, so a section is added without touching it.
 *
 * Every value here belongs to the LAUNCHER, not the harness — what closing the
 * window does, which events are worth an OS notification, whether the title bar
 * was merged, whether the app updates itself. None of it is reachable from a
 * sidecar plugin, so this talks to the route main answers ahead of the socket
 * proxy (src/desktop-host.ts).
 *
 * Styling is self-contained and colour-free: the app ships a light theme and a
 * dark one, so everything is drawn in `currentColor` at varying opacity and
 * inherits whichever the page is painting.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DESKTOP_SECTIONS, navGroupCss } from './nav-group.js'

/** Mirrors src/desktop-settings.ts; the launcher is the authority. */
interface DesktopSettings {
  closeAction: 'tray' | 'quit'
  notifyApprovals: boolean
  notifyQuestions: boolean
  notifyTurns: boolean
  notifySubagentTurns: boolean
  mergedTitleBar: boolean
  autoUpdate: boolean
  snapToEdges: boolean
  toggleAccelerator: string
}

/** Mirrors DesktopSettingsView in src/settings-host.ts. */
interface View {
  settings: DesktopSettings
  version: string
  harnessVersion: string
  updates: 'auto' | 'notify-only' | 'disabled'
  pendingRestart: readonly string[]
  titleBarMergeable: boolean
  canPositionWindow: boolean
  defaultToggleAccelerator: string
  toggleAcceleratorActive: boolean
}

/** Mirrors UpdateCheckResult in src/updater.ts. */
interface UpdateCheck {
  state: 'up-to-date' | 'downloading' | 'available' | 'unsupported' | 'failed'
  message: string
  version?: string
}

/** Mirrors UsageView in src/usage.ts. */
interface Usage {
  since: number
  daily: Record<string, number>
  dailySubagent: Record<string, number>
  hourly: number[]
  hourlySubagent: number[]
  dailyTokens: Record<string, number>
  hourlyTokens: number[]
  totals: {
    turns: number
    subagentTurns: number
    activeMs: number
    days: number
    tokens: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }
  }
}

const ROUTE = '/__desktop-host/settings/'

/**
 * Call one launcher settings action.
 * @param action - route name under the settings prefix.
 * @param body - JSON body for a write.
 * @returns the launcher's view of the settings, or undefined when it answered
 * with no content (a check request) or could not be reached.
 */
async function call<T = View>(action: string, body?: unknown): Promise<T | undefined> {
  try {
    const response = await fetch(`${ROUTE}${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (!response.ok || response.status === 204) return undefined
    return await response.json() as T
  } catch {
    return undefined
  }
}

/**
 * Read the launcher's settings once, for a page that only renders them.
 *
 * Each section is mounted on its own by the shell — only the ACTIVE panel
 * exists — so every one of them fetches for itself rather than sharing state
 * that would not survive switching tabs.
 * @returns the view, `undefined` while loading, and whether the read failed.
 */
function useDesktopView(): {
  view: View | undefined
  failed: boolean
  setView: React.Dispatch<React.SetStateAction<View | undefined>>
} {
  const [view, setView] = useState<View | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    void call('read').then((next) => {
      if (!live) return
      if (next === undefined) setFailed(true)
      else setView(next)
    })
    return () => { live = false }
  }, [])
  return { view, failed, setView }
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: '28px', paddingBottom: '24px' },
  groupTitle: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    opacity: 0.55,
    marginBottom: '4px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '24px',
    padding: '14px 0',
    borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  },
  rowText: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
  label: { fontSize: '13px', fontWeight: 500 },
  hint: { fontSize: '12px', opacity: 0.6, lineHeight: 1.45 },
  notice: {
    fontSize: '12px',
    lineHeight: 1.5,
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    background: 'color-mix(in srgb, currentColor 6%, transparent)',
  },
  segment: {
    display: 'inline-flex',
    padding: '2px',
    borderRadius: '8px',
    background: 'color-mix(in srgb, currentColor 10%, transparent)',
    flexShrink: 0,
  },
  button: {
    appearance: 'none',
    border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
    borderRadius: '8px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: '12px',
    padding: '7px 14px',
    cursor: 'pointer',
    flexShrink: 0,
  },
} as const satisfies Record<string, React.CSSProperties>

/**
 * One labelled row with its control on the right.
 *
 * `nested` indents the row and drops the rule above it, so it reads as a
 * qualifier on the row before rather than a peer of it. That distinction is
 * load-bearing for the subagent switch: as a peer it would look like a second,
 * unrelated notification, when what it actually controls is a subset of the one
 * above.
 */
function Row({ label, hint, nested, children }: {
  label: string
  hint?: string
  nested?: boolean
  children: ReactNode
}): ReactNode {
  const style = nested === true
    ? { ...styles.row, borderTop: 0, paddingTop: 0, paddingLeft: '22px' }
    : styles.row
  return (
    <div style={style}>
      <div style={styles.rowText}>
        <span style={{ ...styles.label, ...(nested === true ? { opacity: 0.85 } : {}) }}>{label}</span>
        {hint === undefined ? null : <span style={styles.hint}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** A two-state segmented control — the shape the app uses for Appearance. */
function Segmented<T extends string>({ value, options, disabled, onSelect }: {
  value: T
  options: readonly { value: T, label: string }[]
  disabled?: boolean
  onSelect: (value: T) => void
}): ReactNode {
  return (
    <div style={styles.segment} role="radiogroup">
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled === true}
            onClick={() => { onSelect(option.value) }}
            style={{
              appearance: 'none',
              border: 0,
              borderRadius: '6px',
              font: 'inherit',
              fontSize: '12px',
              padding: '6px 14px',
              cursor: disabled === true ? 'default' : 'pointer',
              color: 'inherit',
              opacity: disabled === true ? 0.4 : active ? 1 : 0.62,
              background: active ? 'color-mix(in srgb, currentColor 16%, transparent)' : 'transparent',
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A spinning ring, for a button whose work takes visible time.
 *
 * Drawn rather than animated with a keyframes rule, because this plugin injects
 * no stylesheet of its own for the page — everything here is inline styles — and
 * an @keyframes cannot be expressed inline. The rotation therefore comes from a
 * <style> the component renders beside itself, named uniquely so mounting two
 * of them cannot collide.
 * @returns the spinner.
 */
function Spinner(): ReactNode {
  return (
    <>
      <style>{'@keyframes dsh-desktop-spin { to { transform: rotate(360deg) } }'}</style>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: '11px',
          height: '11px',
          marginRight: '6px',
          verticalAlign: '-1px',
          borderRadius: '50%',
          border: '1.5px solid color-mix(in srgb, currentColor 25%, transparent)',
          borderTopColor: 'currentColor',
          animation: 'dsh-desktop-spin 700ms linear infinite',
        }}
      />
    </>
  )
}

/** An on/off switch. */
function Switch({ checked, disabled, onToggle }: {
  checked: boolean
  disabled?: boolean
  onToggle: (next: boolean) => void
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled === true}
      onClick={() => { onToggle(!checked) }}
      style={{
        appearance: 'none',
        border: 0,
        padding: 0,
        width: '38px',
        height: '22px',
        flexShrink: 0,
        borderRadius: '999px',
        cursor: disabled === true ? 'default' : 'pointer',
        opacity: disabled === true ? 0.4 : 1,
        background: checked
          ? 'color-mix(in srgb, currentColor 58%, transparent)'
          : 'color-mix(in srgb, currentColor 18%, transparent)',
        transition: 'background 120ms',
      }}
    >
      <span
        style={{
          display: 'block',
          width: '18px',
          height: '18px',
          margin: '2px',
          borderRadius: '50%',
          background: 'canvas',
          transform: checked ? 'translateX(16px)' : 'none',
          transition: 'transform 120ms',
        }}
      />
    </button>
  )
}

/**
 * The Desktop Settings page.
 * @returns the section content, or null until the launcher has answered.
 */
function DesktopSettingsSection(): ReactNode {
  const { view, failed, setView } = useDesktopView()
  const [check, setCheck] = useState<'idle' | 'checking'>('idle')
  const [checked, setChecked] = useState<UpdateCheck | undefined>(undefined)

  const patch = useCallback((change: Partial<DesktopSettings>) => {
    // Optimistic: the launcher is in-process and the write cannot conflict
    // with anyone, so waiting a round trip to move a switch only feels slow.
    setView((current) => (current === undefined ? current : { ...current, settings: { ...current.settings, ...change } }))
    void call('write', change).then((next) => { if (next !== undefined) setView(next) })
  }, [])

  const runCheck = useCallback(() => {
    setCheck('checking')
    setChecked(undefined)
    // The route now waits for electron-updater to answer, so this promise is
    // the check. It used to return 204 the instant the check started, which is
    // why the button appeared to do nothing for up to thirty seconds.
    void call<UpdateCheck>('check-updates').then((result) => {
      setCheck('idle')
      setChecked(result ?? { state: 'failed', message: 'The launcher did not answer.' })
    })
  }, [])

  if (failed) {
    return <div style={styles.notice}>Desktop settings are unavailable — this window is not running inside the desktop app.</div>
  }
  if (view === undefined) return null

  const { settings, pendingRestart, titleBarMergeable, updates } = view

  return (
    <div style={styles.page}>
      <section>
        <div style={styles.groupTitle}>Window</div>
        <Row
          label="When the window is closed"
          hint={settings.closeAction === 'tray'
            ? 'The app keeps running; the tray icon brings the window back.'
            : 'Quitting stops the agent and its session server.'}
        >
          <Segmented
            value={settings.closeAction}
            options={[{ value: 'tray', label: 'Hide to tray' }, { value: 'quit', label: 'Quit' }]}
            onSelect={(closeAction) => { patch({ closeAction }) }}
          />
        </Row>
        <Row
          label="Title bar"
          hint={titleBarMergeable
            ? 'Merged draws the window controls over the app. Takes effect after a restart.'
            : 'This platform always draws its own title bar.'}
        >
          <Segmented
            value={settings.mergedTitleBar ? 'merged' : 'native'}
            disabled={!titleBarMergeable}
            options={[{ value: 'merged', label: 'Merged' }, { value: 'native', label: 'Native' }]}
            onSelect={(choice) => { patch({ mergedTitleBar: choice === 'merged' }) }}
          />
        </Row>
        <Row
          label="Snap to screen edges"
          hint={view.canPositionWindow
            ? 'Dragging the window near an edge or corner pulls it flush.'
            : 'This session lets the compositor place windows, so the app cannot move its own.'}
        >
          <Switch
            checked={settings.snapToEdges}
            disabled={!view.canPositionWindow}
            onToggle={(snapToEdges) => { patch({ snapToEdges }) }}
          />
        </Row>
        {pendingRestart.length === 0
          ? null
          : <div style={{ ...styles.notice, marginTop: '12px' }}>Restart DeepSeek Harness to apply the title bar change.</div>}
      </section>

      <section>
        <div style={styles.groupTitle}>Notifications</div>
        <Row label="Approval requests" hint="When the agent needs permission to continue.">
          <Switch checked={settings.notifyApprovals} onToggle={(notifyApprovals) => { patch({ notifyApprovals }) }} />
        </Row>
        <Row label="Questions" hint="When the agent asks you something.">
          <Switch checked={settings.notifyQuestions} onToggle={(notifyQuestions) => { patch({ notifyQuestions }) }} />
        </Row>
        <Row label="Finished turns" hint="Only while the window is in the background.">
          <Switch checked={settings.notifyTurns} onToggle={(notifyTurns) => { patch({ notifyTurns }) }} />
        </Row>
        <Row
          label="Including subagent turns"
          nested
          hint={settings.notifyTurns
            ? 'A subagent finishing is a step inside your turn, not the end of it.'
            : 'Turn notifications are off, so this has nothing to add to.'}
        >
          <Switch
            checked={settings.notifySubagentTurns}
            disabled={!settings.notifyTurns}
            onToggle={(notifySubagentTurns) => { patch({ notifySubagentTurns }) }}
          />
        </Row>
      </section>

      <section>
        <div style={styles.groupTitle}>Updates</div>
        <Row
          label="Check for updates automatically"
          hint={updates === 'disabled'
            ? 'Development builds are not updated.'
            : updates === 'auto'
              ? 'Looks at the project’s GitHub releases every few hours and installs a newer version.'
              // Unsigned macOS builds cannot self-update — Squirrel.Mac verifies
              // the signature — so this path only ever opens the releases page.
              // Promising an install here was wrong on the one platform the
              // distinction exists for.
              : 'Looks at the project’s GitHub releases every few hours and tells you when a newer version is available.'}
        >
          <Switch checked={settings.autoUpdate} disabled={updates === 'disabled'} onToggle={(autoUpdate) => { patch({ autoUpdate }) }} />
        </Row>
        <Row
          label="Version"
          hint={checked === undefined ? `Harness ${view.harnessVersion}` : checked.message}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ ...styles.hint, opacity: 0.75 }}>{view.version}</span>
            <button
              type="button"
              style={{ ...styles.button, opacity: check === 'checking' ? 0.55 : 1, cursor: check === 'checking' ? 'default' : 'pointer' }}
              disabled={check === 'checking'}
              aria-busy={check === 'checking'}
              onClick={runCheck}
            >
              {check === 'checking' ? <><Spinner /> Checking…</> : 'Check now'}
            </button>
          </div>
        </Row>
      </section>
    </div>
  )
}

/**
 * Turn a keydown into an Electron accelerator.
 *
 * Electron's grammar, not the browser's: `CommandOrControl` so one stored chord
 * means Cmd on macOS and Ctrl elsewhere, and `event.code` rather than
 * `event.key` for the base key, because `key` is what the modifiers PRODUCED —
 * Shift+2 arrives as "@" and Alt+D on macOS as "∂", neither of which Electron
 * will register.
 * @param event - the keydown to read.
 * @returns the accelerator, or undefined while the chord is not usable yet.
 */
export function acceleratorFrom(event: {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string | undefined {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const { code } = event
  let key: string | undefined
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(code)) key = code
  else if (code === 'Space') key = 'Space'
  else if (code === 'Enter') key = 'Return'
  else if (code === 'Backquote') key = '`'
  else if (code.startsWith('Arrow')) key = code.slice(5)
  if (key === undefined) return undefined

  // A bare letter registered globally would swallow that key everywhere on the
  // machine. Function keys are the one exception people actually reach for.
  if (parts.length === 0 && !/^F\d{1,2}$/.test(key)) return undefined
  parts.push(key)
  return parts.join('+')
}

/**
 * How an accelerator reads on this platform.
 * @param accelerator - the stored chord.
 * @param mac - whether to use the Apple glyphs.
 * @returns a display string.
 */
export function prettyAccelerator(accelerator: string, mac: boolean): string {
  if (accelerator === '') return 'Off'
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl') return mac ? '⌘' : 'Ctrl'
      if (part === 'Alt') return mac ? '⌥' : 'Alt'
      if (part === 'Shift') return mac ? '⇧' : 'Shift'
      return part
    })
    .join(mac ? '' : '+')
}

/** Desktop actions that are fixed, listed so the page is the whole answer. */
const FIXED_SHORTCUTS: readonly { keys: string, what: string }[] = [
  { keys: 'Alt', what: 'Open the menu bar' },
  { keys: 'CommandOrControl+R', what: 'Reload the window' },
  { keys: 'CommandOrControl+Shift+I', what: 'Toggle developer tools' },
  { keys: 'CommandOrControl+Q', what: 'Quit' },
]

/**
 * The Shortcuts page.
 *
 * Only one shortcut is the launcher's to change. Everything else in the menus is
 * a role-based item, which means the platform picks its accelerator and the
 * native behaviour comes with the role — rebinding would mean giving that up.
 * Those are listed read-only rather than hidden, because "what are this app's
 * shortcuts" is the question the page exists to answer, and a page showing one
 * row would look broken.
 * @returns the section content.
 */
function ShortcutsSection(): ReactNode {
  const { view, failed, setView } = useDesktopView()
  const [recording, setRecording] = useState(false)
  const recorder = useRef<HTMLButtonElement | null>(null)
  const mac = useMemo(() => navigator.platform.toLowerCase().includes('mac'), [])

  const write = useCallback((toggleAccelerator: string) => {
    setView((current) => (current === undefined
      ? current
      : { ...current, settings: { ...current.settings, toggleAccelerator } }))
    // Waiting for the launcher's answer matters here, unlike the switches: it
    // reports whether the chord actually registered, and another application
    // may already hold it.
    void call('write', { toggleAccelerator }).then((next) => { if (next !== undefined) setView(next) })
  }, [setView])

  if (failed) {
    return <div style={styles.notice}>Desktop settings are unavailable — this window is not running inside the desktop app.</div>
  }
  if (view === undefined) return null

  const { settings } = view
  const isDefault = settings.toggleAccelerator === view.defaultToggleAccelerator

  return (
    <div style={styles.page}>
      <section>
        <div style={styles.groupTitle}>Global</div>
        <Row
          label="Show or hide the window"
          hint={settings.toggleAccelerator === ''
            ? 'No chord set; the tray icon still brings the window back.'
            : view.toggleAcceleratorActive
              ? 'Works from any application, even while the window is hidden.'
              : 'Another application already holds this chord, so it is not active.'}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              ref={recorder}
              type="button"
              style={{
                ...styles.button,
                minWidth: '128px',
                borderColor: recording
                  ? 'color-mix(in srgb, currentColor 55%, transparent)'
                  : 'color-mix(in srgb, currentColor 22%, transparent)',
                opacity: settings.toggleAccelerator === '' && !recording ? 0.6 : 1,
              }}
              aria-label="Record a new shortcut"
              onClick={() => { setRecording(true) }}
              onBlur={() => { setRecording(false) }}
              onKeyDown={(event) => {
                if (!recording) return
                // Swallow everything while recording, so the chord being
                // captured cannot also activate the button or move focus off it.
                event.preventDefault()
                event.stopPropagation()
                if (event.code === 'Escape') { setRecording(false); return }
                if (event.code === 'Backspace' || event.code === 'Delete') {
                  setRecording(false)
                  write('')
                  return
                }
                const next = acceleratorFrom(event)
                if (next === undefined) return
                setRecording(false)
                write(next)
                recorder.current?.blur()
              }}
            >
              {recording ? 'Press keys…' : prettyAccelerator(settings.toggleAccelerator, mac)}
            </button>
            <button
              type="button"
              style={{ ...styles.button, opacity: isDefault ? 0.4 : 1, cursor: isDefault ? 'default' : 'pointer' }}
              disabled={isDefault}
              onClick={() => { write(view.defaultToggleAccelerator) }}
            >
              Reset
            </button>
          </div>
        </Row>
        <div style={{ ...styles.hint, paddingTop: '10px' }}>
          Click the chord, then press the keys you want. Escape cancels, Backspace turns it off.
        </div>
      </section>

      <section>
        <div style={styles.groupTitle}>Fixed</div>
        <div style={{ ...styles.hint, paddingBottom: '4px' }}>
          These come from the platform’s own menu roles, which is where their
          behaviour comes from too, so the app does not rebind them.
        </div>
        {FIXED_SHORTCUTS.map((shortcut) => (
          <Row key={shortcut.keys} label={shortcut.what}>
            <span style={{ ...styles.hint, opacity: 0.75 }}>{prettyAccelerator(shortcut.keys, mac)}</span>
          </Row>
        ))}
      </section>
    </div>
  )
}

/**
 * A token count, short enough to sit in a tooltip.
 *
 * Three significant figures and a unit, because the number itself is never the
 * point — nobody reads 1,204,873 as anything but "about 1.2 million", and the
 * exact figure would push the rest of the tooltip off the screen.
 * @param tokens - the count.
 * @returns e.g. `0`, `847`, `12.4K`, `1.2M`.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}K`
  return `${Math.round(tokens / 100_000) / 10}M`
}

/**
 * How many weeks of daily history the grass shows.
 *
 * A year, and it is the width that decided it rather than the span. At 27 weeks
 * of fixed 11px cells the grid came out 375px inside an 800px panel — a block
 * hugging the left edge with half the row empty beside it, which reads as
 * broken layout whether or not there is any data in it. Filling the panel takes
 * roughly this many columns, and a year is the unit a contribution graph is
 * read in anyway. Comfortably inside the record's own 400-day retention.
 */
const GRASS_WEEKS = 53

/** Gap between cells, in px. */
const GRASS_GAP = 2

/**
 * Narrowest the calendar may get before it scrolls instead of shrinking.
 *
 * The columns are fractional so the grid tracks the panel, but a cell has a
 * floor: below about 7px the rounded corners eat the fill and neighbouring days
 * stop being separable. Past that the wrapper scrolls, which keeps a narrow
 * window legible rather than merely fitting.
 *
 * The gaps are part of the sum, which is the arithmetic that was wrong the
 * first time: `weeks * cell` alone left the bound satisfied at a width where
 * the cells had already been squeezed to 7.7px, so the floor never engaged.
 * The gap is 2px rather than 3 for the same reason — a year of columns and 3px
 * gaps does not leave a legible cell in a settings panel this wide.
 */
const GRASS_MIN_WIDTH = GRASS_WEEKS * 7 + (GRASS_WEEKS - 1) * GRASS_GAP

/**
 * The three cut points that split a chart's own values into four shades.
 *
 * Quantiles of the NON-ZERO values, not fractions of the peak. Fractions of the
 * peak look right until the chart has real data in it: usage clusters, so on a
 * week where every working day is somewhere between 20 and 26 turns, every one
 * of them is above 75% of the peak and the whole calendar comes out the same
 * flat maximum — measured, on the first run with data in it. Ranking the values
 * instead guarantees the shades are actually used, whatever the scale.
 *
 * Empty days are excluded before ranking. They are the majority of most
 * calendars, and including them would push every real value into the top band —
 * the same washout by the other route.
 * @param values - every value in the chart.
 * @returns three ascending cut points; equal ones simply merge two bands.
 */
export function grassThresholds(values: readonly number[]): [number, number, number] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (active.length === 0) return [0, 0, 0]
  // Indexed across `length - 1`, so the top cut lands strictly below the
  // maximum. Indexing across `length` put the largest value ON the top cut, and
  // with the bands compared inclusively the busiest day came out one shade
  // short of the darkest — which is the one cell a reader looks for.
  const last = active.length - 1
  const at = (fraction: number): number => active[Math.floor(last * fraction)] ?? 0
  return [at(0.25), at(0.5), at(0.75)]
}

/**
 * Which of five shades a count earns.
 *
 * Compared strictly, so a value sitting exactly on a cut falls in the band
 * below it and the maximum always reaches the top.
 * @param count - the bucket's value.
 * @param thresholds - from {@link grassThresholds} for the same chart.
 * @returns 0 for empty, then 1-4.
 */
export function grassLevel(count: number, thresholds: readonly [number, number, number]): number {
  if (count <= 0) return 0
  if (count > thresholds[2]) return 4
  if (count > thresholds[1]) return 3
  if (count > thresholds[0]) return 2
  return 1
}

/**
 * The five shades, as opacities of currentColor.
 *
 * Colour-free like the rest of this page, because the app ships a light theme
 * and a dark one and the section inherits whichever is painting. Level 0 is a
 * faint wash rather than nothing, so an empty day still reads as a cell — the
 * grid's shape is what makes it legible as a calendar. The top stops short of
 * full: at 88% on the dark theme the busiest cells glare against everything
 * around them, which draws the eye to the maximum rather than to the pattern.
 */
const GRASS_SHADES = ['6%', '18%', '34%', '54%', '76%'] as const

/**
 * The local date keys for the grass, oldest first, aligned to whole weeks.
 *
 * Built by walking the calendar rather than adding 86,400,000ms, so a DST day
 * does not shift every subsequent column by an hour and duplicate a key.
 * @param today - the last day to include.
 * @param weeks - how many columns.
 * @returns `weeks * 7` keys, the last of which is today.
 */
export function grassDays(today: Date, weeks: number): string[] {
  const days: string[] = []
  // Finish the current week so today lands in the last column, then walk back.
  const total = weeks * 7
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (total - 1))
  for (let index = 0; index < total; index += 1) {
    const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const month = String(at.getMonth() + 1).padStart(2, '0')
    const day = String(at.getDate()).padStart(2, '0')
    days.push(`${at.getFullYear()}-${month}-${day}`)
  }
  return days
}

/**
 * One cell of either chart.
 *
 * Square by aspect ratio rather than by a pixel height, so a cell can be laid
 * out in a fractional column and still come out a square — that is what lets
 * both charts stretch to whatever width the settings panel happens to be
 * instead of sitting at a fixed size in the corner of it.
 * @param level - shade index from {@link grassLevel}, or a fixed one for the legend.
 * @param title - the hover text; empty for the legend swatches.
 * @param size - a fixed pixel width, for the legend only. Omitted, the cell fills its column.
 */
function GrassCell({ level, title, size }: { level: number, title: string, size?: number }): ReactNode {
  return (
    <div
      title={title}
      style={{
        width: size === undefined ? '100%' : `${size}px`,
        aspectRatio: '1',
        borderRadius: '2px',
        background: `color-mix(in srgb, currentColor ${GRASS_SHADES[level] ?? '6%'}, transparent)`,
      }}
    />
  )
}

/** The shared legend, so both charts are read the same way. */
function GrassLegend(): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', ...styles.hint }}>
      <span>Less</span>
      {GRASS_SHADES.map((shade, level) => <GrassCell key={shade} level={level} size={10} title="" />)}
      <span>More</span>
    </div>
  )
}

/**
 * The Usage page.
 *
 * The record is the launcher's, kept from the same event stream the
 * notifications come off, and it only holds what has happened since the feature
 * shipped — there is no back-fill, because the only place the history exists is
 * inside every session's durable log and walking all of them to draw a graph
 * would tie this page to upstream's log format. The page says so rather than
 * showing an empty year and letting it read as a bug.
 * @returns the section content.
 */
function UsageSection(): ReactNode {
  const [usage, setUsage] = useState<Usage | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let live = true
    void call<Usage>('usage').then((next) => {
      if (!live) return
      if (next === undefined) setFailed(true)
      else setUsage(next)
    })
    return () => { live = false }
  }, [])

  const days = useMemo(() => grassDays(new Date(), GRASS_WEEKS), [])

  if (failed) {
    return <div style={styles.notice}>Usage is unavailable — this window is not running inside the desktop app.</div>
  }
  if (usage === undefined) return null

  const dayCuts = grassThresholds(days.map((key) => usage.daily[key] ?? 0))
  const hourCuts = grassThresholds(usage.hourly)
  const minutes = Math.round(usage.totals.activeMs / 60_000)
  const running = minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 6) / 10} hours`
  const spentTokens = usage.totals.tokens.inputTokens + usage.totals.tokens.outputTokens
    + usage.totals.tokens.cacheReadTokens + usage.totals.tokens.cacheWriteTokens
  const started = usage.since === 0 ? undefined : new Date(usage.since)

  return (
    <div style={styles.page}>
      <section>
        <div style={styles.groupTitle}>By day</div>
        {started === undefined
          ? <div style={styles.notice}>Nothing recorded yet. This counts turns from the moment it is installed — there is no history to fill in from before that.</div>
          : (
            <div style={{ ...styles.hint, paddingBottom: '10px' }}>
              {usage.totals.turns} turns over {usage.totals.days} days, {running} running,
              {' '}{formatTokens(spentTokens)} tokens
              {spentTokens === 0
                ? null
                // The four counts are disjoint, so the split adds back to the
                // total rather than overlapping it.
                : ` (${formatTokens(usage.totals.tokens.inputTokens)} in, `
                  + `${formatTokens(usage.totals.tokens.outputTokens)} out, `
                  + `${formatTokens(usage.totals.tokens.cacheReadTokens + usage.totals.tokens.cacheWriteTokens)} cached)`}.
              {' '}Recording since {started.toLocaleDateString()}.
            </div>
          )}
        <div style={{ overflowX: 'auto', paddingBottom: '4px' }}>
          <div
            role="img"
            aria-label={`Turns per day over the last ${GRASS_WEEKS} weeks`}
            style={{
              display: 'grid',
              // Columns are weeks and rows are days, so the grid flows down
              // each week before moving right — which is what makes it read as
              // a calendar rather than a strip.
              //
              // The columns are declared up front rather than left to
              // gridAutoColumns: auto tracks cannot be fractional, so the grid
              // would size to its content again and go back to hugging the
              // left edge of the panel.
              gridTemplateRows: 'repeat(7, auto)',
              gridTemplateColumns: `repeat(${GRASS_WEEKS}, minmax(0, 1fr))`,
              gridAutoFlow: 'column',
              gap: `${GRASS_GAP}px`,
              width: '100%',
              minWidth: `${GRASS_MIN_WIDTH}px`,
            }}
          >
            {days.map((key) => {
              const count = usage.daily[key] ?? 0
              const sub = usage.dailySubagent[key] ?? 0
              const spent = usage.dailyTokens[key] ?? 0
              const detail = sub === 0 ? '' : ` (+${sub} subagent)`
              const cost = spent === 0 ? '' : ` · ${formatTokens(spent)} tokens`
              return (
                <GrassCell
                  key={key}
                  level={grassLevel(count, dayCuts)}
                  title={`${key} — ${count} turns${detail}${cost}`}
                />
              )
            })}
          </div>
        </div>
        <div style={{ paddingTop: '10px' }}><GrassLegend /></div>
      </section>

      <section>
        <div style={styles.groupTitle}>By hour of day</div>
        <div style={{ ...styles.hint, paddingBottom: '10px' }}>
          Every day in the record, folded onto one clock — the same buckets the
          calendar above sums, read the other way.
        </div>
        <div style={{ overflowX: 'auto', paddingBottom: '4px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(24, minmax(0, 1fr))',
              gap: `${GRASS_GAP}px`,
              width: '100%',
            }}
          >
            {usage.hourly.map((count, hour) => (
              <div key={hour} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                <GrassCell
                  level={grassLevel(count, hourCuts)}
                  title={`${String(hour).padStart(2, '0')}:00 — ${count} turns${
                    (usage.hourlyTokens[hour] ?? 0) === 0
                      ? ''
                      : ` · ${formatTokens(usage.hourlyTokens[hour] ?? 0)} tokens`}`}
                />
                {hour % 3 === 0
                  ? <span style={{ ...styles.hint, fontSize: '10px' }}>{hour}</span>
                  : <span style={{ fontSize: '10px' }}>&nbsp;</span>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div style={styles.groupTitle}>Record</div>
        <Row
          label="Reset usage"
          hint={confirming
            ? 'This cannot be undone; the counts are only kept here.'
            : `Throws away every count and starts again. Subagent turns counted separately: ${usage.totals.subagentTurns}; their tokens are not, because they are billed to you the same.`}
        >
          {confirming
            ? (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  style={styles.button}
                  onClick={() => {
                    setConfirming(false)
                    void call<Usage>('usage-reset').then((next) => { if (next !== undefined) setUsage(next) })
                  }}
                >
                  Reset
                </button>
                <button type="button" style={styles.button} onClick={() => { setConfirming(false) }}>Cancel</button>
              </div>
            )
            : (
              <button
                type="button"
                style={{ ...styles.button, opacity: usage.since === 0 ? 0.4 : 1, cursor: usage.since === 0 ? 'default' : 'pointer' }}
                disabled={usage.since === 0}
                onClick={() => { setConfirming(true) }}
              >
                Reset
              </button>
            )}
        </Row>
      </section>
    </div>
  )
}

/** Required services: the slot registry lives on the client runtime. */
export const inject = ['slots']

/** The component behind each registered section id. */
const SECTIONS: Record<string, () => ReactNode> = {
  'desktop': DesktopSettingsSection,
  'desktop-shortcuts': ShortcutsSection,
  'desktop-usage': UsageSection,
}

/**
 * Contribute the three Desktop pages.
 * @param ctx - client root context.
 */
export function apply(ctx: {
  slots: { register: (options: object, component: () => ReactNode) => () => void }
  effect: (execute: () => () => void, label?: string) => unknown
}): void {
  // Driven off DESKTOP_SECTIONS rather than written out, because the nav
  // heading is placed by counting that many rows back from the end. Registering
  // a section the list does not know about would leave the heading one row too
  // low, and nothing would say so.
  for (const section of DESKTOP_SECTIONS) {
    const component = SECTIONS[section.id]
    if (component === undefined) continue
    ctx.slots.register(
      { name: 'settings.section', ...section, registrant: '@dsh-desktop/settings' },
      component,
    )
  }
  // Through ctx.effect, so unloading this plugin takes the rule with it —
  // otherwise the heading would outlive the entries it names and sit above
  // whichever sections happened to end up last.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@dsh-desktop/settings'
    style.textContent = navGroupCss
    document.head.append(style)
    return () => {
      style.remove()
    }
  }, 'desktop-settings-nav-group')
}
