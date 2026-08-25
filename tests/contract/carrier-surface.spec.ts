/**
 * The `webServer` service surface, as upstream calls it and as our carrier
 * provides it.
 *
 * `@dsh-desktop/carrier` stands in for upstream's `webserver` row, which the
 * patch disables — the whole point of the app is that the harness talks over a
 * socket rather than a TCP port. That makes the service interface a coupling in
 * the direction tests usually miss: upstream may ADD a method, every upstream
 * caller starts using it, and our provider does not have it. Nothing fails at
 * boot. The failure arrives on the first request that reaches the new call.
 *
 * That is not hypothetical. Upstream 0.1.1-rc.1 added a structured index
 * injection layer — `collectIndexInjections` and `renderIndex` — and moved the
 * SPA fallback from calling `applyIndexTaps` to calling `renderIndex`. Against
 * a carrier without it, every single page load threw inside the handler and the
 * server answered a bare, bodiless error. The app booted, reported ready, and
 * served nothing.
 *
 * So this compares the two surfaces directly rather than exercising a request:
 * a request-level test can only tell you that today's callers are satisfied,
 * while this names a method the day it appears.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const harnessRoot = join(import.meta.dirname, '..', '..', 'build', 'harness')
const modules = join(harnessRoot, 'node_modules')
const require = createRequire(join(modules, 'x.js'))

/**
 * Methods of upstream's own WebServer that a provider has to implement.
 *
 * Read off the class prototype rather than the declaration file, because the
 * declaration is what upstream INTENDS and the prototype is what its callers
 * actually reach for. `port` and `host` are accessors and land on the prototype
 * too, so they are included deliberately.
 */
const PROVIDER_SURFACE: readonly string[] = [
  'register', 'registerUpgrade', 'registerFallback',
  'tapIndex', 'applyIndexTaps', 'collectIndexInjections', 'renderIndex',
]

describe.skipIf(!existsSync(harnessRoot))('the webServer surface', () => {
  it('is provided in full by the carrier', async () => {
    const upstream = require(join(modules, '@deepseek-ai', 'dsh-host-webserver', 'package.json')) as { version: string }
    const carrier = await import(
      `file://${join(modules, '@dsh-desktop', 'carrier', 'lib', 'index.js').replaceAll('\\', '/')}`) as {
        DesktopCarrier: new (...args: never[]) => unknown
      }
    const provided = carrier.DesktopCarrier.prototype as Record<string, unknown>

    for (const method of PROVIDER_SURFACE) {
      expect(typeof provided[method], `@dsh-desktop/carrier is missing ${method}(), which upstream ${upstream.version} callers use`)
        .toBe('function')
    }
  })

  it('names every method upstream declares, so a new one cannot slip in', () => {
    // The list above is ours; this is the check that it is still complete.
    // Upstream's declaration file is the source: anything public on it that a
    // provider must satisfy has to appear in PROVIDER_SURFACE, or the previous
    // assertion is only testing the methods we already thought of.
    const declaration = join(modules, '@deepseek-ai', 'dsh-host-webserver', 'lib', 'types', 'index.d.ts')
    expect(existsSync(declaration), 'upstream moved its webServer declaration').toBe(true)
    const source = require('node:fs').readFileSync(declaration, 'utf8') as string

    // Method signatures at one level of indentation inside the class body,
    // excluding the private ones and the Service.init symbol.
    // `constructor` is how the class is built, not part of the surface a
    // provider satisfies — ours extends cordis's Service and takes its own
    // config. `[Service.init]()` and `private match;` are excluded by the
    // pattern itself.
    const declared = [...source.matchAll(/^ {4}([a-z][A-Za-z]*)\(/gm)]
      .map((match) => match[1] as string)
      .filter((name) => name !== 'constructor')
    const missing = declared.filter((name) => !PROVIDER_SURFACE.includes(name))
    expect(missing, `upstream declares webServer method(s) the carrier does not implement: ${missing.join(', ')}`)
      .toEqual([])
  })

  it('renders structured rows before the raw taps, in that order', async () => {
    // The order is upstream's and it is observable: a tap that rewrites markup
    // a row produced only works if rows render first. Asserted against the
    // carrier's own renderIndex with a stub context, so this holds without
    // booting the harness.
    const carrier = await import(
      `file://${join(modules, '@dsh-desktop', 'carrier', 'lib', 'index.js').replaceAll('\\', '/')}`) as {
        DesktopCarrier: { prototype: Record<string, (...args: never[]) => unknown> }
      }
    const seen: string[] = []
    const self = {
      ctx: {
        emit: (name: string, table: unknown[]) => {
          seen.push(`emit:${name}`)
          ;(table as { kind: string, name: string, value: unknown }[]).push({ kind: 'global', name: 'PROBE', value: 1 })
        },
      },
      _indexTaps: [(html: string) => { seen.push('tap'); return `${html}<!--tapped-->` }],
      applyIndexTaps: carrier.DesktopCarrier.prototype.applyIndexTaps,
      collectIndexInjections: carrier.DesktopCarrier.prototype.collectIndexInjections,
    }
    const out = carrier.DesktopCarrier.prototype.renderIndex.call(
      self as never, '<html><head></head><body></body></html>' as never) as unknown as string

    expect(seen).toEqual(['emit:webserver/index-inject', 'tap'])
    expect(out).toContain('globalThis["PROBE"] = 1')
    expect(out.endsWith('<!--tapped-->'), out).toBe(true)
    expect(out.indexOf('globalThis["PROBE"]')).toBeLessThan(out.indexOf('<!--tapped-->'))
  })
})
