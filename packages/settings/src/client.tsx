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
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { navDividerCss } from './nav-divider.js'

/** Mirrors src/desktop-settings.ts; the launcher is the authority. */
interface DesktopSettings {
  closeAction: 'tray' | 'quit'
  notifyApprovals: boolean
  notifyQuestions: boolean
  notifyTurns: boolean
  mergedTitleBar: boolean
  autoUpdate: boolean
}

/** Mirrors DesktopSettingsView in src/settings-host.ts. */
interface View {
  settings: DesktopSettings
  version: string
  harnessVersion: string
  updatable: boolean
  pendingRestart: readonly string[]
  titleBarMergeable: boolean
}

const ROUTE = '/__desktop-host/settings/'

/**
 * Call one launcher settings action.
 * @param action - route name under the settings prefix.
 * @param body - JSON body for a write.
 * @returns the launcher's view of the settings, or undefined when it answered
 * with no content (a check request) or could not be reached.
 */
async function call(action: string, body?: unknown): Promise<View | undefined> {
  try {
    const response = await fetch(`${ROUTE}${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (!response.ok || response.status === 204) return undefined
    return await response.json() as View
  } catch {
    return undefined
  }
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

/** One labelled row with its control on the right. */
function Row({ label, hint, children }: { label: string, hint?: string, children: ReactNode }): ReactNode {
  return (
    <div style={styles.row}>
      <div style={styles.rowText}>
        <span style={styles.label}>{label}</span>
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

  const patch = useCallback((change: Partial<DesktopSettings>) => {
    // Optimistic: the launcher is in-process and the write cannot conflict
    // with anyone, so waiting a round trip to move a switch only feels slow.
    setView((current) => (current === undefined ? current : { ...current, settings: { ...current.settings, ...change } }))
    void call('write', change).then((next) => { if (next !== undefined) setView(next) })
  }, [])

  if (failed) {
    return <div style={styles.notice}>Desktop settings are unavailable — this window is not running inside the desktop app.</div>
  }
  if (view === undefined) return null

  const { settings, pendingRestart, titleBarMergeable, updatable } = view

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
      </section>

      <section>
        <div style={styles.groupTitle}>Updates</div>
        <Row
          label="Check for updates automatically"
          hint={updatable
            ? 'Looks at the project’s GitHub releases every few hours and installs a newer version.'
            : 'Development builds are not updated.'}
        >
          <Switch checked={settings.autoUpdate} disabled={!updatable} onToggle={(autoUpdate) => { patch({ autoUpdate }) }} />
        </Row>
        <Row label="Version" hint={`Harness ${view.harnessVersion}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ ...styles.hint, opacity: 0.75 }}>{view.version}</span>
            <button type="button" style={styles.button} onClick={() => { void call('check-updates') }}>Check now</button>
          </div>
        </Row>
      </section>
    </div>
  )
}

/** Required services: the slot registry lives on the client runtime. */
export const inject = ['slots']

/**
 * Contribute the Desktop Settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: {
  slots: { register: (options: object, component: () => ReactNode) => () => void }
  effect: (execute: () => () => void, label?: string) => unknown
}): void {
  ctx.slots.register(
    { name: 'settings.section', id: 'desktop', order: 100, label: 'Desktop Settings', registrant: '@dsh-desktop/settings' },
    DesktopSettingsSection,
  )
  // Through ctx.effect, so unloading this plugin takes the rule with it —
  // otherwise the divider would outlive the entry it belongs to and point at
  // whichever section happened to end up last.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@dsh-desktop/settings'
    style.textContent = navDividerCss
    document.head.append(style)
    return () => {
      style.remove()
    }
  }, 'desktop-settings-nav-divider')
}
