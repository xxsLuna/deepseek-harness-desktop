/**
 * The page served when the harness cannot be brought up.
 *
 * Everything on it is text the launcher did not write: an exception message
 * and raw sidecar output. The old inline version interpolated `String(error)`
 * into `<pre>` unescaped, which is how a stack trace containing markup would
 * have silently truncated the very message the page exists to show.
 */
import { describe, expect, it } from 'vitest'
import { escapeHtml, failurePage, failureResponse } from '../../src/failure-page.js'

const report = {
  summary: 'The harness keeps exiting during startup.',
  detail: 'TypeError: the value for "version" must be a string',
  logPath: 'C:\\Users\\someone\\AppData\\Roaming\\App\\logs\\sidecar.log',
  tail: ['boot: starting', 'boot: failed'],
}

describe('escapeHtml', () => {
  it('escapes every markup-significant character', () => {
    expect(escapeHtml('<a href="x">&\'</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('escapes the ampersand first, so escapes are not double-escaped', () => {
    // Replacing `<` before `&` would turn `<` into `&lt;` and then into
    // `&amp;lt;`, printing the escape instead of the character.
    expect(escapeHtml('<')).toBe('&lt;')
  })
})

describe('failurePage', () => {
  it('names the reason, the log, and the tail', () => {
    const html = failurePage(report)
    expect(html).toContain(report.summary)
    expect(html).toContain('version')
    expect(html).toContain('sidecar.log')
    expect(html).toContain('boot: failed')
  })

  it('escapes the error text rather than rendering it', () => {
    const html = failurePage({ ...report, detail: '<script>x</script>' })
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>x</script>')
  })

  it('escapes the log tail too', () => {
    const html = failurePage({ ...report, tail: ['<img onerror=1>'] })
    expect(html).toContain('&lt;img onerror=1&gt;')
    expect(html).not.toContain('<img onerror=1>')
  })

  it('says so when there was no output at all', () => {
    // The white-window case: the sidecar died before writing a line, and an
    // empty <pre> would read as "nothing went wrong".
    expect(failurePage({ ...report, tail: [] })).toContain('No output was captured')
  })

  it('is self-contained, because the harness that serves assets is the thing that failed', () => {
    const html = failurePage(report)
    expect(html).not.toMatch(/<link\b/)
    expect(html).not.toMatch(/<script\b/)
  })
})

describe('failureResponse', () => {
  it('answers 503 with html', () => {
    // Not 200: this is the app's own origin saying it has nothing to serve,
    // and a retry must not mistake the page for the app.
    const response = failureResponse(report)
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('text/html')
  })
})
