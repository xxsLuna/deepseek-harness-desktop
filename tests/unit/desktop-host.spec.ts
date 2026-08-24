/**
 * The launcher's back channel, on the one action that has side effects the
 * user cannot undo by clicking again: market/restart tears the harness down.
 *
 * What matters is the order and the failure paths — a page reloaded before the
 * new process answers shows a dead socket, and a page reloaded after the
 * window went away is a call on a destroyed handle.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// desktop-host reaches electron through menu.ts (the native popup) and
// settings-host.ts (app paths and version), neither of which this exercises.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0-test' },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
}))

const { createDesktopHost } = await import('../../src/desktop-host.js')
const { DesktopSettingsStore } = await import('../../src/settings-host.js')

/** Resolves after the microtask queue drains, so a pending handler can run. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** A host wired to a window stub and a restart the test drives. */
function harness(restartSidecar: () => Promise<void>) {
  const reloads: string[] = []
  let destroyed = false
  const win = {
    isDestroyed: () => destroyed,
    webContents: { reload: () => { reloads.push('reload') } },
  }
  let current: typeof win | undefined = win

  const handler = createDesktopHost({
    getWindow: () => current as never,
    // Preferences are not exercised here; a fresh directory keeps the store
    // from reading or writing anything a real run owns.
    settings: new DesktopSettingsStore(mkdtempSync(join(tmpdir(), 'dsh-host-'))),
    harnessVersion: 'test',
    updatable: false,
    titleBarMergeable: true,
    canPositionWindow: true,
    toggleAcceleratorActive: () => true,
    checkForUpdates: async () => ({ state: 'up-to-date' as const, message: 'test' }),
    usage: () => ({
      since: 0,
      daily: {},
      dailySubagent: {},
      hourly: Array.from({ length: 24 }, () => 0),
      hourlySubagent: Array.from({ length: 24 }, () => 0),
      totals: { turns: 0, subagentTurns: 0, activeMs: 0, days: 0 },
    }),
    resetUsage: () => {},
    restartSidecar,
  })

  return {
    reloads,
    /** The window disappears, as a close or a quit makes it. */
    loseWindow: () => { current = undefined },
    /** The window is gone but still handed out, as it is mid-teardown. */
    destroyWindow: () => { destroyed = true },
    post: async (action: string): Promise<Response> => await handler(
      new Request(`dsh://app/__desktop-host/${action}`, { method: 'POST' }),
      `/__desktop-host/${action}`,
    ),
  }
}

describe('market/restart', () => {
  it('waits for the new process before reloading the page', async () => {
    // The served index.html bakes window.__DSH_BOOT__ in, so the reload is
    // what makes an install visible — but a reload issued during the gap hits
    // a socket with nothing behind it.
    let release = (): void => {}
    const restarted = new Promise<void>((resolve) => { release = () => { resolve() } })
    const h = harness(() => restarted)

    const pending = h.post('market/restart')
    await settle()
    expect(h.reloads).toEqual([])

    release()
    const res = await pending
    expect(res.status).toBe(204)
    expect(h.reloads).toEqual(['reload'])
  })

  it('reports a failed restart instead of reloading onto a dead socket', async () => {
    const h = harness(async () => { throw new Error('boot.js is missing') })
    const res = await h.post('market/restart')
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('boot.js is missing')
    expect(h.reloads).toEqual([])
  })

  it('does not reload a window that went away during the restart', async () => {
    // A restart takes seconds and the window can be closed inside them, so the
    // handle read before the await is stale by the time the reload happens.
    const gone = harness(async () => { gone.loseWindow() })
    expect((await gone.post('market/restart')).status).toBe(409)
    expect(gone.reloads).toEqual([])

    const dead = harness(async () => { dead.destroyWindow() })
    expect((await dead.post('market/restart')).status).toBe(409)
    expect(dead.reloads).toEqual([])
  })

  it('is answered after the window check, unlike the settings actions', async () => {
    // Restarting for a page that is not there drops the session for nothing;
    // the settings section, by contrast, is asked for during load and has to
    // answer before a window exists.
    const restarts: string[] = []
    const h = harness(async () => { restarts.push('restart') })
    h.loseWindow()

    expect((await h.post('market/restart')).status).toBe(409)
    expect(restarts).toEqual([])
    expect((await h.post('settings/read')).status).toBe(200)
  })

  it('claims only the one action under its prefix', async () => {
    // Anything this switch claims never reaches the sidecar, so an unknown
    // market route must 404 rather than be black-holed.
    const h = harness(async () => {})
    expect((await h.post('market/install')).status).toBe(404)
  })

  it('leaves overlapping requests to the supervisor to coalesce', async () => {
    // Two clicks arrive as two requests. Nothing serialises them here because
    // Sidecar.restart() shares one in-flight restart (pinned in
    // sidecar.spec.ts); what this pins is that each request still waits for
    // that restart before answering, so neither reports success off a
    // half-finished one.
    let release = (): void => {}
    const restarted = new Promise<void>((resolve) => { release = () => { resolve() } })
    const h = harness(() => restarted)

    const both = Promise.all([h.post('market/restart'), h.post('market/restart')])
    await settle()
    expect(h.reloads).toEqual([])

    release()
    expect((await both).map((res) => res.status)).toEqual([204, 204])
  })
})
