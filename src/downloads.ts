/**
 * Downloads started by the page.
 *
 * The web UI exports a session log with an `<a download>` click
 * (dsh-session-log-export's client half). A browser saves a file; an Electron
 * renderer only fires `will-download`, and with no handler the download is
 * abandoned silently — the user clicks Export and nothing happens.
 *
 * The save path must be set SYNCHRONOUSLY inside the handler: the transfer is
 * already running, and awaiting a save dialog first loses the item. So the file
 * lands in the OS download folder under a non-colliding name, and the user is
 * told where it went — the same contract a browser gives.
 */
import { app, Notification, shell, type Session } from 'electron'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'

/**
 * A path in `dir` for `filename` that does not exist yet, by appending a
 * counter before the extension (`log.zip`, `log (2).zip`, …).
 * @param dir - target directory.
 * @param filename - the name the page asked for.
 * @returns an absolute non-colliding path.
 */
export function uniquePath(dir: string, filename: string): string {
  const ext = extname(filename)
  const stem = ext === '' ? filename : filename.slice(0, -ext.length)
  let candidate = join(dir, filename)
  for (let n = 2; existsSync(candidate); n += 1) candidate = join(dir, `${stem} (${String(n)})${ext}`)
  return candidate
}

/**
 * Install the download handler for one session.
 * @param session - the window's session.
 * @returns a stop function removing the handler.
 */
export function installDownloads(session: Session): () => void {
  const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
    const target = uniquePath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(target)
    item.once('done', (_doneEvent, state) => {
      if (state !== 'completed') {
        console.warn(`[download] ${item.getFilename()} ended as ${state}`)
        return
      }
      console.log(`[download] saved ${target}`)
      if (!Notification.isSupported()) return
      const notification = new Notification({
        title: 'Download complete',
        body: item.getFilename(),
      })
      // Clicking the notice reveals the file, which is the only way to reach it
      // without a download UI of our own.
      notification.on('click', () => shell.showItemInFolder(target))
      notification.show()
    })
  }

  session.on('will-download', onWillDownload)
  return () => session.off('will-download', onWillDownload)
}
