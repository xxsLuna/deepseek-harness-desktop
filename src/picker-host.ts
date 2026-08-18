/**
 * Launcher half of the directory picker: subscribe to the sidecar's pick
 * requests over the carrier socket and answer each one with Electron's own
 * dialog, owned by and modal to the app window.
 *
 * This exists because a chooser spawned by the sidecar cannot come forward —
 * the sidecar is a background process with the app window in front. See
 * packages/picker/lib/index.js for the sidecar half and the route contract.
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { request as httpRequest } from 'node:http'
import type { SidecarAddress } from './socket-path.js'

const REQUESTS_PATH = '/desktop/picker/requests'
const ANSWER_PATH = '/desktop/picker/answer'
/** Delay before re-subscribing after the stream drops (sidecar restart). */
const RESUBSCRIBE_DELAY_MS = 1_000

/**
 * Post one pick outcome back to the sidecar.
 * @param address - socket path and bearer token.
 * @param body - the answer payload.
 */
function postAnswer(address: SidecarAddress, body: { id: string, path?: string, error?: string }): Promise<void> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({
      socketPath: address.socketPath,
      path: ANSWER_PATH,
      method: 'POST',
      headers: {
        host: '127.0.0.1',
        authorization: `Bearer ${address.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve())
    })
    // A failed answer only strands that one pick; the operator can retry.
    req.on('error', () => resolve())
    req.end(payload)
  })
}

/**
 * Show the directory chooser for one request and answer the sidecar.
 * @param address - socket path and bearer token.
 * @param win - the window the dialog is modal to.
 * @param id - the pick request id to answer.
 */
async function serve(address: SidecarAddress, win: BrowserWindow, id: string): Promise<void> {
  try {
    // A window-modal sheet on a hidden or unfocused parent reproduces the very
    // bug this replaces (drawn but never fronted). Closing the window hides it
    // to the tray, so restore and focus before presenting.
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.focus()
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Workspace Directory',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      buttonLabel: 'Select',
    })
    const path = result.canceled ? undefined : result.filePaths[0]
    console.log(`[picker] dialog closed: ${path ?? 'canceled'}`)
    await postAnswer(address, path === undefined ? { id } : { id, path })
  } catch (error) {
    console.error('[picker] dialog failed:', error)
    await postAnswer(address, { id, error: String(error) })
  }
}

/**
 * Keep a subscription to the sidecar's pick requests for the app's lifetime.
 * @param address - socket path and bearer token.
 * @param win - the window dialogs are modal to.
 * @returns a stop function that ends the subscription.
 */
export function startPickerHost(address: SidecarAddress, win: BrowserWindow): () => void {
  let stopped = false
  let active: ReturnType<typeof httpRequest> | undefined
  let timer: NodeJS.Timeout | undefined

  const subscribe = (): void => {
    if (stopped) return
    const req = httpRequest({
      socketPath: address.socketPath,
      path: REQUESTS_PATH,
      method: 'GET',
      headers: { host: '127.0.0.1', authorization: `Bearer ${address.token}`, accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[picker] subscribe got HTTP ${String(res.statusCode)}; retrying`)
        res.resume()
        retry()
        return
      }
      console.log('[picker] subscribed to sidecar pick requests')
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk: string) => {
        buffer += chunk
        // SSE frames are blank-line delimited; keep any partial tail.
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              const parsed: unknown = JSON.parse(line.slice(6))
              const id = (parsed as { id?: unknown }).id
              if (typeof id === 'string') {
                console.log(`[picker] pick requested (${id}); opening dialog`)
                void serve(address, win, id)
              }
            } catch {
              console.warn('[picker] dropped a malformed request frame')
            }
          }
        }
      })
      res.on('end', retry)
      res.on('close', retry)
    })
    req.on('error', retry)
    req.end()
    active = req
  }

  const retry = (): void => {
    if (stopped || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      subscribe()
    }, RESUBSCRIBE_DELAY_MS)
  }

  subscribe()
  return () => {
    stopped = true
    clearTimeout(timer)
    active?.destroy()
  }
}
