/**
 * Desktop notifications: main subscribes to the same two SSE streams the
 * renderer consumes and surfaces approval requests, questions, and finished
 * turns as OS notifications (turn completion only while the window is
 * unfocused). The pending-approval count feeds the dock/taskbar badge.
 *
 * It is also where the usage record is fed from, because the turn boundaries a
 * heatmap is drawn from are the very frames this file already parses, and
 * opening a second subscription to count them would double the work and add a
 * second thing that can silently stop arriving.
 */
import { app, Notification, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { SidecarAddress } from './socket-path.js'
import type { DesktopSettings } from './desktop-settings.js'
import type { UsageStore } from './usage-store.js'

interface SseSubscription {
  stop(): void
}

/** Subscribe to one SSE path over the socket, invoking onFrame per data line. */
function subscribeSse(
  address: SidecarAddress,
  path: string,
  onFrame: (payload: Record<string, unknown>) => void,
  onOpen?: () => void,
): SseSubscription {
  let stopped = false
  let req: ReturnType<typeof httpRequest> | undefined

  const connect = (): void => {
    if (stopped) return
    req = httpRequest({
      socketPath: address.socketPath,
      path,
      method: 'GET',
      headers: { host: '127.0.0.1', authorization: `Bearer ${address.token}`, accept: 'text/event-stream' },
    }, (res) => {
      // Inside connect, so a reconnect re-runs it. The stream replays nothing
      // on open, so whatever this seeds has to be seeded again every time.
      onOpen?.()
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const at = buffer.indexOf('\n\n')
          if (at === -1) break
          const event = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          for (const line of event.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              const envelope: unknown = JSON.parse(line.slice(6))
              const payload = (envelope as { payload?: unknown }).payload
              if (typeof payload === 'object' && payload !== null) onFrame(payload as Record<string, unknown>)
            } catch { /* a malformed frame is dropped; the stream continues */ }
          }
        }
      })
      res.on('end', () => {
        if (!stopped) setTimeout(connect, 2_000)
      })
    })
    req.on('error', () => {
      if (!stopped) setTimeout(connect, 2_000)
    })
    req.end()
  }
  connect()
  return {
    stop: () => {
      stopped = true
      req?.destroy()
    },
  }
}

/**
 * Call one harness RPC over the socket.
 *
 * The same envelope the browser client uses; there is no client library on this
 * side of the process, and one round trip on stream open does not justify one.
 * @param address - the sidecar socket address.
 * @param method - RPC name.
 * @returns the parsed `result`, or undefined if the call failed in any way.
 */
async function rpc(address: SidecarAddress, method: string): Promise<unknown> {
  return await new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: {} })
    const req = httpRequest({
      socketPath: address.socketPath,
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        host: '127.0.0.1',
        authorization: `Bearer ${address.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        try {
          resolve((JSON.parse(text) as { result?: unknown }).result)
        } catch {
          resolve(undefined)
        }
      })
    })
    req.on('error', () => { resolve(undefined) })
    req.setTimeout(10_000, () => {
      req.destroy()
      resolve(undefined)
    })
    req.end(body)
  })
}

/** Pull the subagent session ids out of a session.list result. */
function subagentIdsFrom(result: unknown): string[] {
  const value = (result as { value?: { items?: unknown } } | undefined)?.value?.items
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is { sessionId: string, origin: string } =>
      typeof item === 'object' && item !== null
      && typeof (item as { sessionId?: unknown }).sessionId === 'string'
      && (item as { origin?: unknown }).origin === 'subagent')
    .map((item) => item.sessionId)
}

/** Everything the notification subscriptions write to besides the OS. */
export interface NotificationSinks {
  /** Counts turns and running time for the Usage page; absent in tests. */
  usage?: UsageStore
}

/**
 * Start notification subscriptions for one window.
 *
 * The subscriptions themselves are unconditional — the approval badge counts
 * whether or not the user wants a toast for it, the usage record is kept
 * whether or not the page is open, and a stream torn down and rebuilt on a
 * preference change would drop events in between. Only the toast is gated, read
 * per event so a change takes effect immediately.
 * @param address - the sidecar socket address.
 * @param win - the window to focus on notification click.
 * @param settings - reads the desktop preferences in force.
 * @param sinks - optional recorders fed from the same frames.
 * @returns disposer stopping both subscriptions.
 */
export function startNotifications(
  address: SidecarAddress,
  win: BrowserWindow,
  settings: () => DesktopSettings,
  sinks: NotificationSinks = {},
): () => void {
  const pendingApprovals = new Set<string>()
  const updateBadge = (): void => {
    if (process.platform !== 'win32') app.setBadgeCount(pendingApprovals.size)
  }
  const notify = (title: string, body: string): void => {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body, silent: false })
    notification.on('click', () => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    notification.show()
  }

  const mux = subscribeSse(address, '/api/events.mux', (frame) => {
    switch (frame.type) {
      case 'approval/requested': {
        if (typeof frame.approvalId === 'string') pendingApprovals.add(frame.approvalId)
        updateBadge()
        if (!win.isFocused() && settings().notifyApprovals) notify('Approval requested', 'The agent is waiting for your approval.')
        break
      }
      case 'approval/resolved': {
        if (typeof frame.approvalId === 'string') pendingApprovals.delete(frame.approvalId)
        updateBadge()
        break
      }
      case 'question/requested': {
        if (!win.isFocused() && settings().notifyQuestions) notify('Question', 'The agent asked you a question.')
        break
      }
      default:
    }
  })

  // A turn-finished notice only makes sense after a run actually started;
  // session-status fires running:false at creation too, so track transitions.
  const runningSessions = new Map<string, number>()
  /**
   * Sessions a subagent owns.
   *
   * `host/session-status` carries only a sessionId and a boolean — upstream
   * emits it from `agent/status` for every agent alike — so this is the only
   * thing that tells the two apart, and without it every subagent finishing
   * raised a toast that read as "your turn is done".
   *
   * Fed from `host/session-added`, which announces a session before it can run,
   * and seeded from session.list on every connect: the host stream replays
   * nothing on open, so a subagent already attached when the launcher subscribes
   * would otherwise be indistinguishable from the user's own session.
   */
  const subagentSessions = new Set<string>()

  console.log('[notifications] watching approvals, questions, and finished turns')
  const host = subscribeSse(address, '/api/events.host', (frame) => {
    if (frame.type === 'host/session-added') {
      if (typeof frame.sessionId === 'string' && frame.origin === 'subagent') subagentSessions.add(frame.sessionId)
      return
    }
    if (frame.type === 'host/session-removed') {
      if (typeof frame.sessionId !== 'string') return
      runningSessions.delete(frame.sessionId)
      subagentSessions.delete(frame.sessionId)
      return
    }
    if (frame.type !== 'host/session-status' || typeof frame.sessionId !== 'string') return
    const subagent = subagentSessions.has(frame.sessionId)
    if (frame.running === true) {
      runningSessions.set(frame.sessionId, Date.now())
      // Counted at the start, not the end: a turn belongs to the moment it was
      // asked for, which is what keeps the graph aligned with when the machine
      // was actually being used.
      sinks.usage?.recordTurn(Date.now(), subagent)
      return
    }
    const startedAt = runningSessions.get(frame.sessionId)
    if (startedAt === undefined) return
    runningSessions.delete(frame.sessionId)
    sinks.usage?.recordSpan(startedAt, Date.now())
    if (subagent && !settings().notifySubagentTurns) return
    if (!win.isFocused() && settings().notifyTurns) notify('Turn finished', 'The agent finished its turn.')
  }, () => {
    // Merge, never replace: a subagent added while this request is in flight
    // arrives on the stream and must not be dropped by a stale snapshot.
    void rpc(address, 'session.list').then((result) => {
      for (const sessionId of subagentIdsFrom(result)) subagentSessions.add(sessionId)
    })
  })

  return () => {
    // Close every open span rather than losing it: the stream replays nothing,
    // so a run still going at shutdown can never be resumed and completed later.
    const now = Date.now()
    for (const startedAt of runningSessions.values()) sinks.usage?.recordSpan(startedAt, now)
    runningSessions.clear()
    mux.stop()
    host.stop()
  }
}
