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
 */

/** Where the preference lives. Per-install, in the renderer's own origin. */
export const STORAGE_KEY = 'dsh-desktop.sidebar-collapsed'

/** The attribute upstream renders while, and only while, the sidebar is collapsed. */
export const COLLAPSED_ATTRIBUTE = 'data-sidebar-collapsed'

/**
 * How long to keep looking for the frame before giving up, in ms.
 *
 * The frame arrives with the first render of the client plugin tree, which on a
 * cold start waits on the whole roster. Generous on purpose: the cost of
 * waiting too long is nothing, and the cost of giving up too early is the
 * feature silently not working.
 */
const MOUNT_TIMEOUT_MS = 30_000

/** Poll interval while waiting for the frame, in ms. */
const MOUNT_POLL_MS = 100

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

    // Waiting for the lever, not for a render.
    //
    // `inject: ['layout']` only guarantees the SERVICE exists. `toggleSidebar`
    // additionally needs the layout root entry to have rendered, because that
    // is what calls `attachPanels`, and until then it throws
    // `panel actions not wired (root entry not mounted)`. Measured: with
    // `#root` already populated, the very first attempt threw and the sidebar
    // stayed expanded for the rest of the session — a swallowed throw and no
    // retry is precisely a feature that silently does not work.
    //
    // There is no state to poll for readiness instead: the frame carries no
    // attribute of its own while expanded, and the layout face exposes no
    // getter. So the precondition IS the signal — attempt, and treat a throw
    // as "not yet". Bounded, because an unbounded retry against a lever that
    // will never appear is the same invisible failure in another costume.
    const deadline = Date.now() + MOUNT_TIMEOUT_MS
    const restore = (): void => {
      if (disposed) return
      const stored = read()
      // Nothing remembered, or already matching: upstream's own state is the
      // right answer and touching it would be the regression.
      if (!shouldToggle(stored, isCollapsed())) {
        observe()
        return
      }
      try {
        ctx.layout.toggleSidebar()
      } catch {
        if (Date.now() < deadline) {
          timer = setTimeout(restore, MOUNT_POLL_MS)
          return
        }
        // Out of budget: keep recording what the user does even though this
        // launch could not be restored.
        observe()
        return
      }
      observe()
    }
    restore()

    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
    }
  }, 'desktop-layout-memory')
}
