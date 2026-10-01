/**
 * @dsh-desktop/session-history browser half — give the window's back and
 * forward buttons something to walk.
 *
 * The band has had back and forward controls since it was built, and they were
 * never broken: the launcher wires them to `webContents.navigationHistory` and
 * already listens for `did-navigate-in-page`, whose own comment says what this
 * package supplies — "a pushState is what a single-page UI would move through".
 *
 * Nothing ever pushed one. Measured against the running app: no client bundle
 * in the upstream roster calls `pushState`, `replaceState`, `location.assign`
 * or touches the hash, so opening a session changes React state and nothing
 * else. `history.length` stayed at 1 for the life of the window,
 * `canGoBack()` stayed false, and the buttons sat at `opacity: 0.28` with
 * `pointer-events: none` — dimmed because there was genuinely nowhere to go,
 * not because the wiring was wrong.
 *
 * So this plugin is the missing half: record each session the user lands on as
 * a real history entry, and put them back when the window walks to one.
 *
 * ## Why the browser's history rather than a list of our own
 *
 * Keeping our own visited list and teaching the band's buttons to call it would
 * have worked too, and it was the other candidate. The browser's history wins
 * on reach: `goBack()` is also Alt+Left, also the mouse's fourth button, also
 * the swipe gesture, and all of those arrive at `popstate` without this package
 * knowing they exist. A private list would answer the two buttons and silently
 * ignore every other way a person expresses "back".
 *
 * It also keeps the launcher untouched. The band, the CSS that dims the
 * controls, the `/__desktop-host/chrome/back` route and the `data-dsh-nav`
 * attribute all keep working exactly as written.
 *
 * ## The two seams this uses
 *
 * - `ctx.uiSession.adapter.current` — upstream's store for the session being
 *   shown, the same one the renderer's own session adapter reads, so it changes
 *   exactly when the visible session does. `0.1.7` also promotes it to
 *   `uiSession.current`; `0.1.5` keeps the binding private behind the adapter.
 *   `currentSessionSource` takes whichever this pin has, because the channels
 *   carry different ones.
 * - `ctx.uiWorkspace.openSession(sessionId)` — upstream's own lever for showing
 *   a session, the one the sidebar and the conversation hero call.
 *
 * Both are injected rather than reached for, so this fiber does not start
 * before they exist.
 */

/** Stable Cordis plugin name. */
export const name = 'desktop-session-history'

/**
 * Upstream's session face and workspace lever.
 *
 * `uiSession` carries the current-session binding source and `uiWorkspace` the
 * open lever. Declaring both is how the ordering is expressed rather than
 * guessed at — reading either before its service mounts is the kind of failure
 * that shows up as a plugin tree that will not compose.
 */
export const inject = ['uiSession', 'uiWorkspace']

/**
 * What this plugin writes into a history entry.
 *
 * Deliberately just the id. A history entry is a bookmark, not a snapshot: the
 * session it names is looked up fresh when the user returns, so a session that
 * was renamed or had messages added since comes back current rather than as a
 * stale copy. It also keeps entries small, which matters because the browser
 * caps how much state a session history may hold.
 */
interface SessionEntry {
  /** Marks the entry as ours, so a state someone else pushed is left alone. */
  readonly dshDesktopSessionHistory: true
  /** The session to show when the window walks back to this entry. */
  readonly sessionId: string
}

/** A store of the shape upstream's binding sources and adapters both use. */
interface BindingSource {
  getSnapshot: () => unknown
  subscribe: (listener: () => void) => () => void
}

/** The slice of the client context this plugin uses. */
interface SessionHistoryContext {
  uiSession: { adapter?: { current?: BindingSource }, current?: BindingSource }
  uiWorkspace: { openSession: (sessionId: string) => void }
  effect: (execute: () => () => void, label?: string) => unknown
}

/**
 * The current-session store, under whichever name this pin exposes it.
 *
 * `adapter.current` first because it is the one BOTH lines have: `0.1.5` builds
 * the adapter in the constructor and keeps the binding itself private
 * (`this.currentBinding`), while `0.1.7` promotes it to `this.current` and
 * points the adapter at the same object. Reading only `current` found nothing
 * on `0.1.5` — and found it silently, which is this package's whole subject.
 *
 * Both are tried rather than one being chosen, because the channels carry
 * different pins by design and this plugin ships to all of them from one
 * source. The name that is absent costs nothing; the one that is there answers.
 * @param uiSession - upstream's session service.
 * @returns the store to read and subscribe to, or undefined when neither name
 *   is present — in which case this plugin does nothing rather than throwing
 *   into a composition that would reject whole.
 */
export function currentSessionSource(uiSession: SessionHistoryContext['uiSession']): BindingSource | undefined {
  for (const candidate of [uiSession.adapter?.current, uiSession.current]) {
    if (typeof candidate?.getSnapshot === 'function' && typeof candidate.subscribe === 'function') return candidate
  }
  return undefined
}

/**
 * Whether a history state is one this plugin wrote.
 *
 * Checked by its own marker rather than by shape: the page is a composition and
 * another plugin may push entries of its own one day. Walking into one of those
 * and trying to read a session id off it would be this package reaching into a
 * neighbour's state, which is exactly the coupling it should not have.
 * @param state - the `history.state` to classify.
 * @returns the entry when it is ours, otherwise undefined.
 */
export function ownEntry(state: unknown): SessionEntry | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const candidate = state as Partial<SessionEntry>
  if (candidate.dshDesktopSessionHistory !== true) return undefined
  return typeof candidate.sessionId === 'string' ? candidate as SessionEntry : undefined
}

/**
 * Read the session id out of whatever upstream's binding source is holding.
 *
 * `key` first, and that is not a guess: the materialized binding is
 * `{ key: binding.sessionId, ctx, hooks, keyedHooks, props }`, so the id the
 * renderer keys a session by lives under `key` while `sessionId` is the field
 * on the binding it was built from. Reading `sessionId` alone found nothing and
 * the history stayed empty with nothing thrown — the exact silence this whole
 * package exists to end, which is why both names are accepted and asserted.
 *
 * Tolerant beyond that on purpose. The binding carries a whole session view and
 * this needs one field of it; a shape that changes around that field should
 * cost nothing, and a shape that loses it should leave the history alone rather
 * than throw into the plugin tree, where one failed entry rejects the whole
 * composition.
 * @param snapshot - the binding source's current value.
 * @returns the session id, or undefined when the snapshot names none.
 */
export function sessionIdOf(snapshot: unknown): string | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const { key, sessionId } = snapshot as { key?: unknown, sessionId?: unknown }
  for (const candidate of [key, sessionId]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * What to do when the shown session changes.
 *
 * Pure, because the rule is the whole of this plugin and the rest is wiring.
 * Three cases, and the third is the one that makes back/forward feel right:
 *
 * - No session yet, or the same one again — nothing. A re-render that reports
 *   the same id must not stack duplicate entries, or "back" would appear to do
 *   nothing until the user had pressed it as many times as the session had
 *   rendered.
 * - Nothing recorded yet — REPLACE. The first session the window shows is where
 *   the user already is, not somewhere they travelled to; pushing it would make
 *   the very first "back" leave the app's own first screen.
 * - Otherwise — PUSH.
 * @param options - the current and recorded sessions.
 * @returns which history operation the change calls for.
 */
export function historyAction(options: {
  /** The session now being shown, if any. */
  readonly shown: string | undefined
  /** The session the current history entry already names, if any. */
  readonly recorded: string | undefined
}): 'none' | 'replace' | 'push' {
  const { shown, recorded } = options
  if (shown === undefined || shown === recorded) return 'none'
  return recorded === undefined ? 'replace' : 'push'
}

/**
 * Record session changes as history entries, and follow them when walked.
 * @param ctx - client context carrying `uiSession`, `uiWorkspace` and `effect`.
 */
export function apply(ctx: SessionHistoryContext): void {
  ctx.effect(() => {
    const source = currentSessionSource(ctx.uiSession)
    // Nothing to record against. Returning quietly is the right failure here:
    // the band's controls stay as they were, which is what they did before this
    // package existed, and the rest of the app is untouched.
    if (source === undefined) return () => {}

    let disposed = false

    // Set while this plugin is the one changing the session, so the change it
    // causes does not come back round as a new entry. Without it, walking back
    // would open the previous session, observe that the session changed, and
    // push it as somewhere new — the history would grow as you walked it and
    // forward would never be reachable.
    let restoring = false

    const entryState = (sessionId: string): SessionEntry =>
      ({ dshDesktopSessionHistory: true, sessionId })

    const record = (): void => {
      if (disposed || restoring) return
      const shown = sessionIdOf(source.getSnapshot())
      const action = historyAction({ shown, recorded: ownEntry(history.state)?.sessionId })
      if (action === 'none' || shown === undefined) return
      try {
        // The url never changes — this app serves one document and upstream
        // routes nothing through the address. Passing `location.href` keeps it
        // that way while still creating the entry, which is the whole point:
        // the history grows, the page does not reload, and no url has to be
        // invented for a session that has no public address.
        if (action === 'push') history.pushState(entryState(shown), '', location.href)
        else history.replaceState(entryState(shown), '', location.href)
      } catch {
        // A session history that refuses another entry (its state budget is
        // finite) costs this feature and nothing else. The app must not fail
        // because a convenience could not record itself.
      }
    }

    const walked = (event: PopStateEvent): void => {
      if (disposed) return
      const entry = ownEntry(event.state)
      if (entry === undefined) return
      if (sessionIdOf(source.getSnapshot()) === entry.sessionId) return
      restoring = true
      try {
        ctx.uiWorkspace.openSession(entry.sessionId)
      } catch {
        // The session may have been deleted since it was recorded. Upstream
        // owns what that looks like; swallowing here only means the window
        // stays where it is rather than the plugin tree taking the error.
      } finally {
        // Cleared on a later turn, not immediately: `openSession` settles the
        // binding asynchronously, and clearing synchronously would let the
        // change it causes be seen as a fresh one and pushed.
        setTimeout(() => { restoring = false }, 0)
      }
    }

    // Seed first, so the entry the user is already on carries its session.
    // Otherwise the first push would be the second session while the first had
    // no entry of its own, and walking back would land on a bare document.
    record()
    const unsubscribe = source.subscribe(record)
    addEventListener('popstate', walked)

    return () => {
      disposed = true
      unsubscribe()
      removeEventListener('popstate', walked)
    }
  }, 'desktop-session-history')
}
