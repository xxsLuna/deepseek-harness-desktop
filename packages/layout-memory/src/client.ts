/**
 * @dsh-desktop/layout-memory browser half — remember whether the sidebar was
 * collapsed.
 *
 * Upstream holds the panel widths in a React store and nothing else:
 * `dsh-client-ui-layout` has no `localStorage`, no `sessionStorage`, and the
 * settings schema has no key for it. So every launch opened with the sidebar
 * expanded, whatever the user left it as.
 *
 * Three facts this is built on, each measured against the running app rather
 * than read off the source:
 *
 * 1. The frame div carries `data-sidebar-collapsed` **only while collapsed**
 *    (`sidebarCollapsed || void 0`), so presence is the whole state and no CSS
 *    module class name is involved. Class hashes are exactly the kind of
 *    upstream detail that moves without warning; this survives that.
 * 2. `ctx.layout.toggleSidebar()` is upstream's own cross-plugin panel face,
 *    and it is the only lever available — there is no width setter, and no
 *    getter either, which is why the DOM is the source of truth for reading.
 * 3. The attribute covers both layouts: wide (`panels.sidebar === 0`) and
 *    narrow (`!panels.narrowExpanded`) both render it.
 *
 * Restoring means toggling the store, which happens the moment the lever
 * becomes callable — the layout root's first render — so a remembered collapse
 * may be visible expanded for a paint or two. Not measured precisely, and
 * accepted either way: the alternative is pre-collapsing with CSS, which would
 * fight React's inline `grid-template-columns` and leave the store saying one
 * thing while the window shows another.
 *
 * **Restoring is a reconcile loop, not one toggle, and that is a fix rather
 * than a preference.** It used to call `toggleSidebar()` once and treat a
 * throw as "not ready yet" — upstream's own
 * `panel actions not wired (root entry not mounted)`. `0.1.5` removed that
 * guard: the controller now takes the store's actions in its constructor
 * (`constructor(panels, hasMainPanel)`), so the call always succeeds and the
 * retry never runs. Worse, the toggle's AXIS depends on a width that is not
 * settled yet:
 *
 *   toggleSidebar: (d) => {
 *     if (d.layoutInfo.viewportWidth < 1024) d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded
 *     else d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? 280 : 0
 *   }
 *   setViewportWidth: (d, width) => {
 *     if (d.layoutInfo.viewportWidth < 1024 !== width < 1024) d.layoutInfo.narrowExpanded = false
 *   }
 *
 * So an early toggle can land on `narrowExpanded` and then be WIPED when the
 * real width crosses 1024. The call succeeded, the preference was read, and the
 * sidebar still opened expanded — with nothing thrown and nothing logged.
 *
 * Reconciling against the DOM until it agrees survives all of that, and needs
 * no promise from upstream about when a lever becomes live or which field it
 * moves. It is bounded on three axes — a total budget, a toggle cap, and a
 * settle gap between toggles — because an unbounded loop against a lever that
 * never lands would flap the sidebar in the user's face, which is worse than
 * the bug.
 */

/** Where the preference lives. Per-install, in the renderer's own origin. */
export const STORAGE_KEY = 'dsh-desktop.sidebar-collapsed'

/** The attribute upstream renders while, and only while, the sidebar is collapsed. */
export const COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'

/**
 * How long to keep reconciling before giving up, in ms.
 *
 * The frame arrives with the first render of the client plugin tree, which on a
 * cold start waits on the whole roster. Generous on purpose: the cost of
 * waiting too long is nothing, and the cost of giving up too early is the
 * feature silently not working.
 */
const MOUNT_TIMEOUT_MS = 30_000

/** Poll interval while reconciling, in ms. */
const MOUNT_POLL_MS = 120

/**
 * Minimum gap between toggles, in ms.
 *
 * The store moves synchronously and the DOM follows a render later, so judging
 * the result immediately would read the state before the toggle and toggle
 * straight back. This is the pause that stops the loop oscillating.
 */
const SETTLE_MS = 300

/**
 * How long agreement has to hold before the loop stops, in ms.
 *
 * Not a nicety: `setViewportWidth` clears `narrowExpanded` when the width
 * crosses 1024, which lands AFTER the first render. Stopping the moment the DOM
 * first agrees would hand the sidebar back to that reset and leave the launch
 * expanded — the exact bug, one beat later.
 */
const AGREEMENT_HOLD_MS = 700

/**
 * Cap on toggles.
 *
 * A lever that never lands must not flap the sidebar in the user's face for
 * thirty seconds. Six is enough for the two or three the width settling can
 * cost and far short of anything a person would read as flicker.
 */
const MAX_TOGGLES = 6

/** What the reconcile loop knows when it decides what to do next. */
export interface ReconcileState {
  /** The remembered preference, or undefined when nothing was stored. */
  readonly stored: boolean | undefined
  /** What the DOM says right now. */
  readonly current: boolean
  /** Toggles issued so far this restore. */
  readonly toggles: number
  /** Since the last toggle, in ms; Infinity before the first. */
  readonly sinceToggleMs: number
  /** How long the DOM has agreed with `stored`, in ms; undefined when it does not. */
  readonly agreedForMs: number | undefined
  /** Since the restore began, in ms. */
  readonly elapsedMs: number
}

/** `observe` ends the restore and starts recording; `wait` polls again. */
export type ReconcileAction = 'observe' | 'toggle' | 'wait'

/**
 * One step of the restore, as a rule rather than a control flow.
 *
 * Pure so the whole of it can be tested against upstream's actual store
 * semantics — width-dependent axis and the reset that follows — without a
 * browser. The previous version's rule was "call it and see if it throws",
 * which was untestable for the same reason it was wrong: it asked upstream a
 * question upstream stopped answering.
 * @param state - what the loop knows.
 * @returns what to do next.
 */
export function decideReconcile(state: ReconcileState): ReconcileAction {
  // Nothing remembered: upstream's own state is the right answer, and touching
  // it would be the regression.
  if (state.stored === undefined) return 'observe'
  // Out of budget. Still observe, so this launch records what the user does
  // even though it could not be restored.
  if (state.elapsedMs >= MOUNT_TIMEOUT_MS) return 'observe'
  if (state.current === state.stored) {
    return state.agreedForMs !== undefined && state.agreedForMs >= AGREEMENT_HOLD_MS ? 'observe' : 'wait'
  }
  // Mismatched, and out of toggles: give up rather than flap.
  if (state.toggles >= MAX_TOGGLES) return 'observe'
  // Mismatched, but the last toggle has not had time to render.
  if (state.sinceToggleMs < SETTLE_MS) return 'wait'
  return 'toggle'
}

/**
 * Read the stored preference.
 * @param raw - what `localStorage.getItem` returned.
 * @returns the remembered state, or undefined when nothing was stored.
 */
export function parseStored(raw: string | null): boolean | undefined {
  if (raw === 'true') return true
  if (raw === 'false') return false
  // Anything else — absent, or written by a version that stored something
  // different — is "no preference", which leaves upstream's default alone.
  return undefined
}

/**
 * Whether the sidebar has to be toggled to match what was remembered.
 * @param stored - the remembered state, or undefined for no preference.
 * @param current - what the DOM says right now.
 * @returns true when a single toggle would reconcile them.
 */
export function shouldToggle(stored: boolean | undefined, current: boolean): boolean {
  return stored !== undefined && stored !== current
}

/** Whether the sidebar is collapsed right now. */
function isCollapsed(): boolean {
  return document.querySelector(`[${COLLAPSED_ATTRIBUTE}]`) !== null
}

/**
 * Read the preference, tolerating a storage that refuses.
 * @returns the remembered state, or undefined.
 */
function read(): boolean | undefined {
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY))
  } catch {
    // Private mode, or site data blocked. A convenience must not throw into
    // the plugin tree, where one failed entry rejects the whole composition.
    return undefined
  }
}

/**
 * Persist the preference, tolerating a storage that refuses.
 * @param collapsed - the state to remember.
 */
function write(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false')
  } catch { /* see read() */ }
}

/** The slice of the client context this plugin uses. */
interface LayoutContext {
  layout: { toggleSidebar: () => void }
  effect: (execute: () => () => void, label?: string) => unknown
}

/** Stable Cordis plugin name. */
export const name = 'desktop-layout-memory'

/**
 * Upstream's panel face. Declared so this fiber does not start before
 * `ctx.layout` exists — `toggleSidebar` throws until the root entry is mounted,
 * and injecting is how that ordering is expressed rather than guessed at.
 */
export const inject = ['layout']

/**
 * Restore the remembered state once the frame is up, then keep it current.
 * @param ctx - client context carrying `layout` and `effect`.
 */
export function apply(ctx: LayoutContext): void {
  ctx.effect(() => {
    let disposed = false
    let observer: MutationObserver | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    // Watch the attribute rather than wrapping the toggle: the sidebar also
    // moves by drag and by narrow-layout changes, and all of them land here.
    const observe = (): void => {
      observer = new MutationObserver(() => write(isCollapsed()))
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: [COLLAPSED_ATTRIBUTE],
      })
    }

    // Reconciling against the DOM, not waiting for a lever.
    //
    // This used to attempt the toggle and treat a throw as "not yet", because
    // upstream threw `panel actions not wired (root entry not mounted)` until
    // the layout root had rendered. 0.1.5 removed that guard, so the first
    // attempt always succeeds and the retry never runs — and if the window
    // width has not settled, the toggle lands on `narrowExpanded` and is wiped
    // when the width crosses 1024. The call succeeds, nothing throws, and the
    // sidebar opens expanded.
    //
    // So the loop asks the DOM instead: toggle while it disagrees, stop once it
    // has agreed for long enough that the reset cannot still be coming.
    // `observe` starts only at the end, which also keeps upstream's own early
    // churn from being recorded as the user's preference.
    const started = Date.now()
    let toggles = 0
    let lastToggleAt = Number.NEGATIVE_INFINITY
    let agreedAt: number | undefined

    const tick = (): void => {
      if (disposed) return
      const now = Date.now()
      const stored = read()
      const current = isCollapsed()
      if (stored === undefined || current !== stored) agreedAt = undefined
      else agreedAt ??= now

      const action = decideReconcile({
        stored,
        current,
        toggles,
        sinceToggleMs: now - lastToggleAt,
        agreedForMs: agreedAt === undefined ? undefined : now - agreedAt,
        elapsedMs: now - started,
      })
      if (action === 'observe') {
        observe()
        return
      }
      if (action === 'toggle') {
        try {
          ctx.layout.toggleSidebar()
          toggles += 1
          lastToggleAt = now
        } catch {
          // Still not callable. Not an error here — the next tick asks again,
          // and the budget is what ends it.
        }
      }
      timer = setTimeout(tick, MOUNT_POLL_MS)
    }
    tick()

    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
    }
  }, 'desktop-layout-memory')
}
