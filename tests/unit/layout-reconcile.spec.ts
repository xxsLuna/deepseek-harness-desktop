/**
 * Restoring the sidebar against upstream's store, as it actually behaves.
 *
 * The old restore called `toggleSidebar()` once and treated a throw as "not
 * ready yet" — upstream's `panel actions not wired (root entry not mounted)`.
 * `0.1.5` removed that guard, so the call always succeeds, the retry never
 * runs, and the toggle can land on the wrong field:
 *
 *   toggleSidebar: (d) => {
 *     if (d.layoutInfo.viewportWidth < 1024) d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded
 *     else d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? 280 : 0
 *   }
 *   setViewportWidth: (d, width) => {
 *     if (d.layoutInfo.viewportWidth < 1024 !== width < 1024) d.layoutInfo.narrowExpanded = false
 *   }
 *
 * A toggle issued before the width settles flips `narrowExpanded`, and the
 * first real width crossing 1024 clears it. Nothing throws, nothing logs, and
 * the sidebar opens expanded — which is what the user reported.
 *
 * So the simulation below is not a mock of our own code: it is those two
 * actions, transcribed, driving the same rule the plugin runs. That is what
 * makes it able to fail the way production did.
 */
import { describe, expect, it } from 'vitest'
import {
  decideReconcile,
  parseStored,
  shouldToggle,
  type ReconcileAction,
} from '../../packages/layout-memory/src/client.js'

describe('parseStored', () => {
  it.each([['true', true], ['false', false]] as const)('reads %s', (raw, expected) => {
    expect(parseStored(raw)).toBe(expected)
  })

  it.each([null, '', 'TRUE', '1', '{}'])('treats %s as no preference', (raw) => {
    // Anything else leaves upstream's default alone rather than guessing.
    expect(parseStored(raw)).toBeUndefined()
  })
})

describe('shouldToggle', () => {
  it('is false without a preference, whatever the DOM says', () => {
    expect(shouldToggle(undefined, true)).toBe(false)
    expect(shouldToggle(undefined, false)).toBe(false)
  })

  it('is true only when the preference and the DOM disagree', () => {
    expect(shouldToggle(true, false)).toBe(true)
    expect(shouldToggle(false, true)).toBe(true)
    expect(shouldToggle(true, true)).toBe(false)
  })
})

/** A state with the fields a case does not care about set out of the way. */
const state = (over: Partial<Parameters<typeof decideReconcile>[0]>): Parameters<typeof decideReconcile>[0] => ({
  stored: true,
  current: false,
  toggles: 0,
  sinceToggleMs: Number.POSITIVE_INFINITY,
  agreedForMs: undefined,
  elapsedMs: 0,
  ...over,
})

describe('decideReconcile', () => {
  it('does nothing when nothing was remembered', () => {
    expect(decideReconcile(state({ stored: undefined, current: true }))).toBe('observe')
  })

  it('toggles when the DOM disagrees and the last toggle has rendered', () => {
    expect(decideReconcile(state({ stored: true, current: false }))).toBe('toggle')
  })

  it('waits rather than toggling again before the DOM can catch up', () => {
    // The store moves synchronously and the DOM follows a render later.
    // Toggling on the next poll would read the state before the toggle and
    // send the sidebar straight back.
    expect(decideReconcile(state({ sinceToggleMs: 100, toggles: 1 }))).toBe('wait')
  })

  it('keeps watching after the DOM first agrees', () => {
    // Stopping here is what the reset would beat: `setViewportWidth` clears
    // `narrowExpanded` after the first render, so agreement has to hold.
    expect(decideReconcile(state({ current: true, agreedForMs: 100 }))).toBe('wait')
  })

  it('stops once agreement has held', () => {
    expect(decideReconcile(state({ current: true, agreedForMs: 5_000 }))).toBe('observe')
  })

  it('gives up rather than flapping the sidebar forever', () => {
    expect(decideReconcile(state({ toggles: 6 }))).toBe('observe')
  })

  it('gives up when the budget runs out, and still records from then on', () => {
    // `observe` rather than a dead end: a launch that could not be restored
    // must still remember what the user does next.
    expect(decideReconcile(state({ elapsedMs: 30_000 }))).toBe('observe')
  })
})

/** Upstream's two actions, transcribed from `dsh-client-ui-layout`. */
class LayoutStore {
  sidebar = 280
  narrowExpanded = false
  constructor(public viewportWidth: number) {}

  toggleSidebar(): void {
    if (this.viewportWidth < 1024) this.narrowExpanded = !this.narrowExpanded
    else this.sidebar = this.sidebar === 0 ? 280 : 0
  }

  setViewportWidth(width: number): void {
    if (this.viewportWidth === width) return
    if ((this.viewportWidth < 1024) !== (width < 1024)) this.narrowExpanded = false
    this.viewportWidth = width
  }

  /** What the frame renders `data-sidebar-collapsed` from. */
  get collapsed(): boolean {
    return this.viewportWidth < 1024 ? !this.narrowExpanded : this.sidebar === 0
  }
}

/**
 * Drive the rule against the store on a fake clock.
 * @param store - the transcribed upstream store.
 * @param stored - the remembered preference.
 * @param widthAt - a width change to apply at a given elapsed time, if any.
 * @returns the actions taken and whether the DOM ended up matching.
 */
function run(store: LayoutStore, stored: boolean | undefined, widthAt?: { ms: number, width: number }): {
  actions: ReconcileAction[]
  settled: boolean
} {
  const POLL = 120
  const actions: ReconcileAction[] = []
  let now = 0
  let toggles = 0
  let lastToggleAt = Number.NEGATIVE_INFINITY
  let agreedAt: number | undefined
  // The DOM lags the store by one render; anything shorter than the settle gap
  // would let the loop judge its own toggle before it lands.
  let domCollapsed = store.collapsed
  let renderDue: number | undefined

  for (let step = 0; step < 2_000; step += 1) {
    if (widthAt !== undefined && now >= widthAt.ms) {
      store.setViewportWidth(widthAt.width)
      widthAt = undefined
      renderDue = now + 60
    }
    if (renderDue !== undefined && now >= renderDue) {
      domCollapsed = store.collapsed
      renderDue = undefined
    }

    if (stored === undefined || domCollapsed !== stored) agreedAt = undefined
    else agreedAt ??= now

    const action = decideReconcile({
      stored,
      current: domCollapsed,
      toggles,
      sinceToggleMs: now - lastToggleAt,
      agreedForMs: agreedAt === undefined ? undefined : now - agreedAt,
      elapsedMs: now,
    })
    actions.push(action)
    if (action === 'observe') break
    if (action === 'toggle') {
      store.toggleSidebar()
      toggles += 1
      lastToggleAt = now
      renderDue = now + 60
    }
    now += POLL
  }
  return { actions, settled: domCollapsed === stored }
}

describe('restoring against the real store semantics', () => {
  it('survives a toggle that lands on narrowExpanded and is then wiped', () => {
    // THE REPORTED BUG. The store is created before the window is sized, so
    // the first toggle flips `narrowExpanded`; the real width then crosses
    // 1024 and clears it. One toggle would end here, expanded.
    const store = new LayoutStore(800)
    const result = run(store, true, { ms: 400, width: 1600 })
    expect(result.settled, 'the sidebar did not end up collapsed').toBe(true)
    expect(store.sidebar).toBe(0)
  })

  it('collapses a settled wide window', () => {
    const store = new LayoutStore(1600)
    expect(run(store, true).settled).toBe(true)
    expect(store.sidebar).toBe(0)
  })

  it('expands when that is what was remembered', () => {
    const store = new LayoutStore(1600)
    store.sidebar = 0
    expect(run(store, false).settled).toBe(true)
    expect(store.sidebar).toBe(280)
  })

  it('leaves the store alone when nothing was remembered', () => {
    const store = new LayoutStore(1600)
    const result = run(store, undefined)
    expect(result.actions).toEqual(['observe'])
    expect(store.sidebar).toBe(280)
  })

  it('does not toggle a sidebar that already matches', () => {
    const store = new LayoutStore(1600)
    store.sidebar = 0
    const result = run(store, true)
    expect(result.actions).not.toContain('toggle')
  })

  it('stops toggling rather than flapping when the lever does nothing', () => {
    // A lever that never moves the state is the shape of the next upstream
    // change. The loop must give up, not oscillate the sidebar for 30s.
    const store = new LayoutStore(1600)
    store.toggleSidebar = () => {}
    const result = run(store, true)
    expect(result.actions.filter((a) => a === 'toggle').length).toBeLessThanOrEqual(6)
    expect(result.actions.at(-1)).toBe('observe')
  })
})
