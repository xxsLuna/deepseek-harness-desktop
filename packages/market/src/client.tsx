/**
 * @dsh-desktop/market browser half — the Marketplace tab in Plugins settings.
 *
 * Registers one `settings.plugins.tab` entry. Upstream's Plugins section
 * declares that slot and renders whatever registers into it, so this becomes a
 * tab beside the built-in ones without touching the section itself.
 *
 * The catalog is NOT shipped with the app: this fetches it at open time from the
 * sources the harness allows. The app carries only the default catalog URL, and
 * that default is a seeded value in the settings document rather than a constant
 * nobody can remove — a marketplace that cannot be un-registered is not
 * registered, it is baked in.
 *
 * Install and remove go to the harness (`/market/*`), because the harness
 * process is the only writer of $DSH_HOME state. Restart goes to the LAUNCHER
 * (`/__desktop-host/market/restart`), because only the process that spawned the
 * sidecar can respawn it.
 *
 * A catalog lists TWO kinds of plugin and the difference is visible throughout,
 * because it is the difference the user is consenting to:
 *
 * - a **dsh** plugin is code the loader imports into the sidecar, so it can do
 *   anything the agent can, and it only exists once the sidecar restarts;
 * - a **Claude** plugin is markdown the harness reads as skills, so it enters
 *   the model's prompt rather than the process, and it applies immediately.
 *
 * So the confirmation warns differently per kind, the rows say when each takes
 * effect, and an installed Claude plugin shows what it actually published —
 * including the skills this app WITHHELD and why, since a plugin can be on
 * disk with everything it ships refused, and a row alone would hide that.
 *
 * Styling matches @dsh-desktop/settings: self-contained and colour-free, drawn
 * in `currentColor` at varying opacity so it inherits whichever theme the page
 * is painting.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

/** Which sort of plugin a row is. `unknown` when the catalog did not say. */
type Kind = 'claude' | 'dsh' | 'unknown'

/** One row of the merged catalog, as `/market/catalog` reports it. */
interface CatalogEntry {
  /** The package name — the install key, not a label. */
  name: string
  /** What a person reads. The catalog parser falls back to `name`. */
  displayName: string
  version: string
  publisher: string
  description: string
  /**
   * The catalog's own claim about the kind, which is why it is only ever used
   * to word the warning. The installer re-decides from the downloaded bytes and
   * refuses a package that turns out to be the other kind, so a lying catalog
   * gets a refusal rather than the wrong consent.
   */
  kind: Kind
  /** The catalog URL the row came from. */
  source: string
  /** The catalog's own name for itself. */
  marketplace: string
}

/** What `/market/catalog` answers. */
interface CatalogView {
  entries: CatalogEntry[]
  /** Per-source failures, so a dead source is visible instead of silently empty. */
  errors: { source: string, message: string }[]
}

/** One installed plugin, as `/market/installed` reports it. */
interface InstalledEntry {
  name: string
  version: string
  kind: Kind
  /** Whether the row is live in the running tree, or waiting for a restart. */
  active: boolean
  /**
   * Whether this app put it there. A Claude plugin copied under the install
   * root by hand publishes its skills exactly like an installed one, so it is
   * listed — but deleting a directory the marketplace did not create is not the
   * marketplace's call, so it is shown without a Remove button.
   */
  managed: boolean
}

/** What one installed Claude plugin published, and what it did not. */
interface PluginDetail {
  skills: { name: string, kind: string, renamedFrom?: string }[]
  refused: { name?: string, code: string, message: string }[]
}

/** What `/market/installed` answers. */
interface InstalledView {
  entries: InstalledEntry[]
  /** Names the last boot could not compose, so the tab can say which died. */
  failed: string[]
  /** True when the on-disk set no longer matches the running tree. */
  restartRequired: boolean
  /** Per Claude plugin, keyed by name: what it publishes and what was withheld. */
  detail: Record<string, PluginDetail | undefined>
  /** Files present under the Claude root that could not be read at all. */
  skillErrors: { path: string, message: string }[]
}

const MARKET = '/market/'
const LAUNCHER = '/__desktop-host/market/'

/**
 * Call one harness market route.
 * @param action - route name under the market prefix.
 * @param body - JSON body for a write; omitted for a read.
 * @returns the parsed answer, or undefined when the route failed.
 */
async function market<T>(action: string, body?: unknown): Promise<T | undefined> {
  try {
    const response = await fetch(`${MARKET}${action}`, body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) return undefined
    return await response.json() as T
  } catch {
    return undefined
  }
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: '24px', paddingBottom: '24px' },
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
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '20px',
    padding: '14px 0',
    borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  },
  rowText: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
  label: { fontSize: '13px', fontWeight: 500 },
  hint: { fontSize: '12px', opacity: 0.6, lineHeight: 1.45 },
  meta: { fontSize: '11px', opacity: 0.45, fontVariantNumeric: 'tabular-nums' },
  notice: {
    fontSize: '12px',
    lineHeight: 1.5,
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
  },
  button: {
    font: 'inherit',
    fontSize: '12px',
    padding: '5px 12px',
    borderRadius: '6px',
    border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  input: {
    font: 'inherit',
    fontSize: '12px',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
    background: 'transparent',
    color: 'inherit',
    minWidth: '260px',
  },
  confirm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '14px',
    borderRadius: '10px',
    border: '1px solid color-mix(in srgb, currentColor 26%, transparent)',
  },
  warning: { fontSize: '12px', lineHeight: 1.5, opacity: 0.85 },
  badge: {
    fontSize: '10px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    padding: '1px 6px',
    borderRadius: '4px',
    border: '1px solid color-mix(in srgb, currentColor 26%, transparent)',
    opacity: 0.7,
  },
  labelRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  detail: { display: 'flex', flexDirection: 'column', gap: '2px', paddingTop: '4px' },
  withheld: { fontSize: '11px', lineHeight: 1.5, opacity: 0.75 },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
} satisfies Record<string, React.CSSProperties>

/** What each kind is called in the badge. */
const KIND_LABEL: Record<Kind, string> = { claude: 'Skills', dsh: 'Extension', unknown: 'Plugin' }

/**
 * When each kind starts working, which is the practical difference between
 * them: a dsh plugin is composed into the sidecar's plugin tree at boot, so it
 * does not exist until the next one; a Claude plugin is markdown the skill
 * provider re-reads on every lookup, so it exists as soon as it is on disk.
 */
const KIND_TIMING: Record<Kind, string> = {
  claude: 'available immediately',
  dsh: 'available after a restart',
  unknown: 'availability depends on what it turns out to be',
}

/**
 * What the user is actually agreeing to, per kind. Two genuinely different
 * risks, so two genuinely different sentences — a single generic warning would
 * either overstate the Claude case or understate the dsh one, and a warning
 * that does not fit what is in front of you is one people learn to click past.
 */
const KIND_WARNING: Record<Kind, string> = {
  claude: 'This adds skills the agent can read and follow. Their text enters the model’s prompt, '
    + 'so it can steer what the agent does with the tools it already has — it does not add tools of its own.',
  dsh: 'This is code. It is loaded into the harness process and runs with the same access to your '
    + 'files and shell that the agent has. Install it only if you trust its publisher.',
  unknown: 'The catalog did not say what this is. It will be loaded as code, or as skills the agent '
    + 'reads, depending on what it contains — assume the stronger of the two and trust the publisher first.',
}

/**
 * The install confirmation. Rendered in the page rather than as a native
 * dialog: the trigger is already a user click in this same page, and the page
 * is ours — cross-site requests are refused by the socket proxy and the window
 * cannot navigate off the app origin — so a native dialog adds no guarantee.
 * What it does add is the sentence about what a plugin can reach, which is the
 * part that actually informs the decision.
 * @param props - the entry being installed and the two outcomes.
 * @returns the confirmation panel.
 */
function Confirm({ entry, onCancel, onConfirm }: {
  entry: CatalogEntry
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  return (
    <div style={styles.confirm}>
      <div style={styles.labelRow}>
        <span style={styles.label}>Install {entry.displayName}?</span>
        <span style={styles.badge}>{KIND_LABEL[entry.kind]}</span>
      </div>
      <div style={styles.hint}>
        {entry.version === '' ? 'Unversioned' : `Version ${entry.version}`} · published by {entry.publisher}
        {' '}· {KIND_TIMING[entry.kind]}
      </div>
      <div style={styles.meta}>{entry.name} · listed by {entry.marketplace} ({entry.source})</div>
      <div style={styles.warning}>{KIND_WARNING[entry.kind]}</div>
      <div style={styles.actions}>
        <button type="button" style={styles.button} onClick={onCancel}>Cancel</button>
        <button type="button" style={styles.button} onClick={onConfirm}>Install</button>
      </div>
    </div>
  )
}

/**
 * What one installed Claude plugin contributed.
 *
 * Both halves matter and the second is the reason this exists. A plugin can
 * install cleanly and publish nothing, because this app withholds any skill it
 * cannot honour as written — one declaring `allowed-tools` is the common case,
 * since the harness has no way to enforce a tool restriction and quietly
 * widening what an author narrowed is worse than not publishing it. The person
 * who installed it has to be able to see that, and to see the reason, or the
 * plugin simply appears not to work.
 * @param props - the detail for one plugin, absent when the sibling package
 * that publishes them is not composed.
 * @returns the published and withheld lists, or nothing to say.
 */
function Published({ detail }: { detail?: PluginDetail }): ReactNode {
  if (detail === undefined) return null
  if (detail.skills.length === 0 && detail.refused.length === 0) {
    return <span style={styles.withheld}>Ships no skills this app can read.</span>
  }
  return (
    <div style={styles.detail}>
      {detail.skills.length === 0
        ? null
        : (
          <span style={styles.withheld}>
            Skills:{' '}
            {detail.skills.map((skill, index) => (
              <span key={skill.name}>
                {index === 0 ? '' : ', '}
                {skill.name}
                {/* A rename is not cosmetic: it is the name the user has to
                    type, and it happened because another plugin already had
                    the plain one. */}
                {skill.renamedFrom === undefined ? '' : ` (was ${skill.renamedFrom})`}
              </span>
            ))}
          </span>
          )}
      {detail.refused.map((refusal) => (
        <span key={`${refusal.code}:${refusal.name ?? ''}:${refusal.message}`} style={styles.withheld}>
          Withheld{refusal.name === undefined ? '' : ` ${refusal.name}`}: {refusal.message}
        </span>
      ))}
    </div>
  )
}

/**
 * The Marketplace tab: trusted sources, the merged catalog, and what is
 * installed.
 * @returns the tab body.
 */
function MarketplaceTab(): ReactNode {
  const [catalog, setCatalog] = useState<CatalogView | undefined>(undefined)
  const [installed, setInstalled] = useState<InstalledView | undefined>(undefined)
  const [pending, setPending] = useState<CatalogEntry | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const refresh = useCallback(async () => {
    const [next, live] = await Promise.all([
      market<CatalogView>('catalog'),
      market<InstalledView>('installed'),
    ])
    setCatalog(next ?? { entries: [], errors: [{ source: 'harness', message: 'the marketplace route did not answer' }] })
    setInstalled(live ?? { entries: [], failed: [], restartRequired: false, detail: {}, skillErrors: [] })
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const installedByName = useMemo(
    () => new Map((installed?.entries ?? []).map((e) => [e.name, e])),
    [installed],
  )

  const act = useCallback(async (action: 'install' | 'remove', entry: { name: string }) => {
    setBusy(entry.name)
    setFailure(undefined)
    // Only the package name travels. The tarball URL, version and digest are
    // read from the catalog by the harness, so a caller cannot substitute bytes.
    const answer = await market<{ ok: boolean, message?: string }>(action, { name: entry.name })
    // A route that did not answer is a failure, not a silent success: the whole
    // point of the resolve check on the harness side is that a plugin which
    // cannot be reached must not look installed.
    if (answer === undefined || !answer.ok) setFailure(answer?.message ?? `${action} failed`)
    setBusy(undefined)
    await refresh()
  }, [refresh])

  if (catalog === undefined || installed === undefined) {
    return <div style={styles.hint}>Loading…</div>
  }

  return (
    <div style={styles.page}>
      {/* Only ever raised by the dsh half — the harness composes those at boot.
          Worded so it does not imply the Claude plugins are waiting too, since
          they are already live and telling someone to restart for them would
          teach them to restart for nothing. */}
      {installed.restartRequired
        ? (
          <div style={styles.notice}>
            <span>
              An extension is waiting: code plugins are composed when the session server starts,
              so restart to apply it. Skills are already active.
            </span>
            <button
              type="button"
              style={styles.button}
              onClick={() => { void fetch(`${LAUNCHER}restart`, { method: 'POST' }) }}
            >
              Restart now
            </button>
          </div>
          )
        : null}

      {installed.failed.length === 0
        ? null
        : (
          <div style={styles.notice}>
            <span>
              These plugins failed to load and were disabled so the app could start:{' '}
              {installed.failed.join(', ')}. Removing one clears the warning.
            </span>
          </div>
          )}

      {failure === undefined ? null : <div style={styles.notice}><span>{failure}</span></div>}

      {installed.skillErrors.map((error) => (
        <div key={error.path} style={styles.notice}>
          <span>Could not read {error.path}: {error.message}</span>
        </div>
      ))}

      {catalog.errors.map((error) => (
        <div key={error.source} style={styles.notice}>
          <span>Could not read {error.source}: {error.message}</span>
        </div>
      ))}

      {pending === undefined
        ? null
        : (
          <Confirm
            entry={pending}
            onCancel={() => { setPending(undefined) }}
            onConfirm={() => {
              const entry = pending
              setPending(undefined)
              void act('install', entry)
            }}
          />
          )}

      <section>
        <div style={styles.groupTitle}>Available</div>
        {catalog.entries.length === 0
          ? <div style={{ ...styles.hint, padding: '14px 0' }}>No plugins are listed. Check your sources below, or your network.</div>
          : catalog.entries.map((entry) => {
            const live = installedByName.get(entry.name)
            return (
              <div key={`${entry.source}:${entry.name}`} style={styles.row}>
                <div style={styles.rowText}>
                  <span style={styles.labelRow}>
                    <span style={styles.label}>{entry.displayName}</span>
                    {/* The badge reads the CATALOG's claim, which is all that is
                        known before a download; once installed, the row below
                        shows the kind the installer actually found. */}
                    <span style={styles.badge}>{KIND_LABEL[live?.kind ?? entry.kind]}</span>
                  </span>
                  <span style={styles.hint}>{entry.description}</span>
                  <span style={styles.meta}>
                    {entry.version === '' ? entry.name : entry.version} · {entry.publisher}
                    {live === undefined ? '' : live.active ? ' · installed' : ' · installed, pending restart'}
                  </span>
                  {live === undefined || live.kind !== 'claude'
                    ? null
                    : <Published detail={installed.detail[entry.name]} />}
                </div>
                {live !== undefined && !live.managed
                  ? <span style={styles.meta}>placed by hand</span>
                  : (
                    <button
                      type="button"
                      style={styles.button}
                      disabled={busy === entry.name}
                      onClick={() => {
                        if (live === undefined) setPending(entry)
                        else void act('remove', entry)
                      }}
                    >
                      {busy === entry.name ? '…' : live === undefined ? 'Install' : 'Remove'}
                    </button>
                    )}
              </div>
            )
          })}
      </section>

      {/* Installed plugins that are not in any catalog still have to be
          removable — a source can be un-trusted, or a listing withdrawn, and an
          entry only reachable through a catalog would then be stranded. */}
      {installed.entries.filter((e) => !catalog.entries.some((c) => c.name === e.name)).length === 0
        ? null
        : (
          <section>
            <div style={styles.groupTitle}>Installed, not listed</div>
            {installed.entries.filter((e) => !catalog.entries.some((c) => c.name === e.name)).map((entry) => (
              <div key={`${entry.kind}:${entry.name}`} style={styles.row}>
                <div style={styles.rowText}>
                  <span style={styles.labelRow}>
                    <span style={styles.label}>{entry.name}</span>
                    <span style={styles.badge}>{KIND_LABEL[entry.kind]}</span>
                  </span>
                  <span style={styles.meta}>
                    {entry.version === '' ? 'unversioned' : entry.version}
                    {entry.active ? '' : ' · pending restart'}
                  </span>
                  {entry.kind !== 'claude' ? null : <Published detail={installed.detail[entry.name]} />}
                </div>
                {entry.managed
                  ? (
                    <button
                      type="button"
                      style={styles.button}
                      disabled={busy === entry.name}
                      onClick={() => { void act('remove', entry) }}
                    >
                      {busy === entry.name ? '…' : 'Remove'}
                    </button>
                    )
                  : <span style={styles.meta}>placed by hand</span>}
              </div>
            ))}
          </section>
          )}

      <Sources onChanged={refresh} />
    </div>
  )
}

/**
 * The trusted-source list, read and written through the harness settings
 * document. Kept out of the launcher's preferences on purpose: which
 * marketplaces to trust is a fact about the plugin composition, not about the
 * window, and it belongs in the same document the CLI reads.
 * @param props - callback to re-read the catalog after a change.
 * @returns the sources section.
 */
function Sources({ onChanged }: { onChanged: () => Promise<void> }): ReactNode {
  const [sources, setSources] = useState<string[] | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [rejected, setRejected] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    const view = await market<{ sources: string[] }>('sources')
    setSources(view?.sources ?? [])
  }, [])
  useEffect(() => { void load() }, [load])

  const write = useCallback(async (next: string[]): Promise<boolean> => {
    setRejected(undefined)
    const answer = await market<{ ok: boolean, message?: string, sources?: string[] }>('sources', { sources: next })
    if (answer === undefined || !answer.ok) {
      setRejected(answer?.message ?? 'the harness refused that source')
      return false
    }
    setSources(answer.sources ?? next)
    await onChanged()
    return true
  }, [onChanged])

  if (sources === undefined) return null

  return (
    <section>
      <div style={styles.groupTitle}>Sources</div>
      <div style={{ ...styles.hint, paddingBottom: '4px' }}>
        Marketplaces the app will read, each a URL to a <code>.claude-plugin/marketplace.json</code>.
        HTTPS only. The default is listed like any other and can be removed.
      </div>
      {sources.map((source) => (
        <div key={source} style={styles.row}>
          <div style={styles.rowText}><span style={styles.hint}>{source}</span></div>
          <button
            type="button"
            style={styles.button}
            onClick={() => { void write(sources.filter((s) => s !== source)) }}
          >
            Remove
          </button>
        </div>
      ))}
      <div style={{ ...styles.row, alignItems: 'center' }}>
        <input
          style={styles.input}
          value={draft}
          placeholder="https://raw.githubusercontent.com/…/.claude-plugin/marketplace.json"
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button
          type="button"
          style={styles.button}
          disabled={draft.trim() === ''}
          onClick={() => {
            // Cleared only on success. Clearing it after a refusal throws away
            // the URL the user typed along with their chance to fix the typo,
            // while the message beside it still explains what was wrong with a
            // string no longer on screen.
            void write([...sources, draft.trim()]).then((accepted) => { if (accepted) setDraft('') })
          }}
        >
          Add source
        </button>
      </div>
      {rejected === undefined ? null : <div style={styles.notice}><span>{rejected}</span></div>}
    </section>
  )
}

/**
 * Required cordis services. `settingsScope` is not listed: the trusted-source
 * list is read and written through the harness market routes instead, which
 * keeps this tab's whole data path on one transport rather than half on the
 * settings wire and half on ours.
 */
export const inject = ['slots']

/**
 * Contribute the Marketplace tab.
 * @param ctx - client root context.
 */
export function apply(ctx: {
  slots: {
    register: (options: object, component: () => ReactNode) => () => void
    inject: (name: string, mount: () => unknown) => unknown
  }
}): void {
  // slots.inject rather than a bare register: `settings.plugins.tab` is declared
  // by upstream's Plugins section, which may activate after this row. Injecting
  // waits for the declaration instead of racing it.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
    {
      name: 'settings.plugins.tab',
      id: 'marketplace',
      order: 20,
      label: 'Marketplace',
      registrant: '@dsh-desktop/market',
    },
    MarketplaceTab,
  ))
}
