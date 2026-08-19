/**
 * Desktop notifications: main subscribes to the same two SSE streams the
 * renderer consumes and surfaces approval requests, questions, and finished
 * turns as OS notifications (turn completion only while the window is
 * unfocused). The pending-approval count feeds the dock/taskbar badge.
 */
import { app, Notification, type BrowserWindow } from 'electron'
import { request as httpRequest } from 'node:http'
import type { SidecarAddress } from './socket-path.js'
import type { DesktopSettings } from './desktop-settings.js'

interface SseSubscription {
  stop(): void
}

/** Subscribe to one SSE path over the socket, invoking onFrame per data line. */
function subscribeSse(
  address: SidecarAddress,
  path: string,
  onFrame: (payload: Record<string, unknown>) => void,
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
 * Start notification subscriptions for one window.
 *
 * The subscriptions themselves are unconditional — the approval badge counts
 * whether or not the user wants a toast for it, and a stream torn down and
 * rebuilt on a preference change would drop events in between. Only the toast
 * is gated, read per event so a change takes effect immediately.
 * @param address - the sidecar socket address.
 * @param win - the window to focus on notification click.
 * @param settings - reads the desktop preferences in force.
 * @returns disposer stopping both subscriptions.
 */
export function startNotifications(
  address: SidecarAddress,
  win: BrowserWindow,
  settings: () => DesktopSettings,
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
  const runningSessions = new Set<string>()
  console.log('[notifications] watching approvals, questions, and finished turns')
  const host = subscribeSse(address, '/api/events.host', (frame) => {
    if (frame.type !== 'host/session-status' || typeof frame.sessionId !== 'string') return
    if (frame.running === true) {
      runningSessions.add(frame.sessionId)
      return
    }
    if (!runningSessions.delete(frame.sessionId)) return
    if (!win.isFocused() && settings().notifyTurns) notify('Turn finished', 'The agent finished its turn.')
  })

  return () => {
    mux.stop()
    host.stop()
  }
}
