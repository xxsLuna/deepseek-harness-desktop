/**
 * Downloads started by the page.
 *
 * The web UI exports a session log with an `<a download>` click
 * (dsh-session-log-export's client half). A browser turns that into a file; an
 * Electron renderer only fires `will-download` on its session, and with no
 * handler the download is abandoned silently — the user clicks Export and
 * nothing happens. This asks where to save, with the dialog owned by the app
 * window, and reports the outcome.
 */
import { dialog, type BrowserWindow, type Session } from 'electron'
import { basename } from 'node:path'

/**
 * Install the download handler for one session.
 * @param session - the window's session.
 * @param win - the window save dialogs are modal to.
 * @returns a stop function removing the handler.
 */
export function installDownloads(session: Session, win: BrowserWindow): () => void {
  const onWillDownload = (
    _event: Electron.Event,
    item: Electron.DownloadItem,
  ): void => {
    const suggested = item.getFilename()
    console.log(`[download] requested: ${suggested}`)
    // Pause while the dialog is up: the item starts transferring immediately,
    // and a save path can only be set before the transfer completes.
    item.pause()
    void dialog.showSaveDialog(win, {
      title: 'Save Export',
      defaultPath: suggested,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    }).then((result) => {
      if (result.canceled || result.filePath === undefined) {
        item.cancel()
        console.log('[download] canceled')
        return
      }
      item.setSavePath(result.filePath)
      item.once('done', (_doneEvent, state) => {
        if (state === 'completed') console.log(`[download] saved ${basename(result.filePath)}`)
        else console.warn(`[download] ${basename(result.filePath)} ended as ${state}`)
      })
      item.resume()
    }, (error: unknown) => {
      console.error('[download] save dialog failed:', error)
      item.cancel()
    })
  }

  session.on('will-download', onWillDownload)
  return () => session.off('will-download', onWillDownload)
}
