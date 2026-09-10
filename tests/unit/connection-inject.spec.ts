/**
 * Where the carrier override lands in the served document.
 *
 * The position is the whole design. Upstream reads
 * `globalThis.__DSH_TRANSPORT__` from its own connection plugin and states
 * where a shell should install it — "before plugin boot" — and this package
 * satisfies that by going in ahead of every row upstream injects, rather than
 * by an argument about when a client module evaluates. The previous shape of
 * this package made that argument and was wrong, so the ordering is asserted
 * here rather than reasoned about.
 *
 * `injectTransport` is pure and takes the block as an argument, so this states
 * a document instead of staging an environment; the built script it would
 * normally read is covered by `client-externals.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import { injectTransport, TRANSPORT_MARKER } from '../../packages/connection/lib/inject.js'

/** The head rows upstream's boot protocol injects, in the order it emits them. */
const UPSTREAM_HEAD = '<script>window.__ModuleLoader__={mode:"queue"}</script>'
  + '<link rel="modulepreload" href="/plugins/bundle/app.js">'
  + '<script src="/plugins/bundle/bootstrap.js"></script>'
  + '<script>globalThis["__DSH_BOOT__"] = {}</script>'

const BLOCK = `<script ${TRANSPORT_MARKER}>globalThis.__DSH_TRANSPORT__={}</script>`

describe('injectTransport', () => {
  it('puts the transport ahead of every upstream boot row', () => {
    const html = `<!doctype html><html><head><meta charset="utf-8">${UPSTREAM_HEAD}</head><body></body></html>`
    const out = injectTransport(html, BLOCK)
    // The assertion that matters: not merely present, but FIRST. A block that
    // lands after the bootstrap batch is the failure this package exists to
    // avoid, and it looks identical in a `toContain`.
    expect(out.indexOf(TRANSPORT_MARKER)).toBeLessThan(out.indexOf('__ModuleLoader__'))
    expect(out.indexOf(TRANSPORT_MARKER)).toBeLessThan(out.indexOf('bootstrap.js'))
    expect(out.indexOf(TRANSPORT_MARKER)).toBeLessThan(out.indexOf('__DSH_BOOT__'))
  })

  it('goes inside head, not before it', () => {
    // Content before <head> is reparented by the HTML parser, which would move
    // the script somewhere this file no longer controls.
    const out = injectTransport('<html><head></head><body></body></html>', BLOCK)
    expect(out.startsWith('<html><head>')).toBe(true)
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf(TRANSPORT_MARKER))
  })

  it('survives a head tag carrying attributes', () => {
    const out = injectTransport('<html><head lang="en" data-x><title>t</title></head></html>', BLOCK)
    expect(out).toContain(`<head lang="en" data-x><script ${TRANSPORT_MARKER}>`)
    expect(out.indexOf(TRANSPORT_MARKER)).toBeLessThan(out.indexOf('<title>'))
  })

  it('injects exactly once', () => {
    const out = injectTransport('<html><head></head><body><head></head></body></html>', BLOCK)
    expect(out.split(TRANSPORT_MARKER)).toHaveLength(2)
  })

  it('prepends when the document has no head', () => {
    // No upstream row could have run either way; a served index with no head
    // is a broken build, not a case to serve differently.
    const out = injectTransport('<div>fragment</div>', BLOCK)
    expect(out.startsWith(BLOCK)).toBe(true)
  })

  it('leaves the rest of the document untouched', () => {
    const html = '<html><head></head><body><p>body</p></body></html>'
    expect(injectTransport(html, BLOCK).replace(BLOCK, '')).toBe(html)
  })
})
