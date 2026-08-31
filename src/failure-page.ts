/**
 * The page the window gets when the harness cannot be brought up.
 *
 * This exists because the alternative was nothing: a boot failure reached the
 * user as a white window or a spinner that never resolved, with the reason on
 * a stdout a packaged GUI app has nowhere to print. The page's whole job is to
 * name the error, say where the log is, and show enough of the tail that a bug
 * report is possible without a terminal.
 *
 * Pure so the escaping is testable — the text interpolated here is an error
 * message and a log tail, both of which routinely carry `<` and `&`.
 */

export interface FailureReport {
  /** One-line summary: what the launcher was doing when it gave up. */
  readonly summary: string
  /** The error text, as thrown. */
  readonly detail: string
  /** Absolute path of the sidecar log. */
  readonly logPath: string
  /** Last lines of sidecar output, oldest first. */
  readonly tail: readonly string[]
}

/**
 * Escape text for interpolation into HTML element content.
 * @param text - untrusted text.
 * @returns the text with the five markup-significant characters replaced.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render the failure page.
 *
 * Styled inline and offline — it is served in place of the harness, so it can
 * assume none of the app's own assets resolve.
 * @param report - what to tell the user.
 * @returns a complete HTML document.
 */
export function failurePage(report: FailureReport): string {
  const tail = report.tail.length === 0
    ? 'No output was captured before the harness exited.'
    : report.tail.map(escapeHtml).join('\n')
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>DeepSeek Harness could not start</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; padding: 48px 40px; background: #111; color: #e6e6e6;
         font: 14px/1.6 ui-sans-serif, system-ui, sans-serif }
  h1 { font-size: 20px; margin: 0 0 8px }
  p { margin: 0 0 16px; color: #a8a8a8 }
  code { color: #e6e6e6 }
  pre { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 6px;
        padding: 12px 14px; overflow-x: auto; white-space: pre-wrap;
        word-break: break-word; font: 12px/1.5 ui-monospace, monospace }
  .detail { color: #ff8f8f }
</style>
</head>
<body>
  <h1>DeepSeek Harness could not start</h1>
  <p>${escapeHtml(report.summary)}</p>
  <pre class="detail">${escapeHtml(report.detail)}</pre>
  <p>Full output: <code>${escapeHtml(report.logPath)}</code></p>
  <pre>${tail}</pre>
</body>
</html>
`
}

/**
 * The failure page as an HTTP response.
 *
 * 503 rather than 200: this is the harness's own origin answering that it has
 * nothing to serve, and a wrong 200 would let a retry treat the page as the app.
 * @param report - what to tell the user.
 * @returns the response to hand the renderer.
 */
export function failureResponse(report: FailureReport): Response {
  return new Response(failurePage(report), {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
