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
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const harnessRoot = join(import.meta.dirname, '..', '..', 'build', 'harness')
const modules = join(harnessRoot, 'node_modules')
const require = createRequire(join(modules, 'x.js'))

/**
 * Names on upstream's WebServer prototype that a provider does NOT have to
 * mirror.
 *
 * An EXCLUSION list, deliberately, and the polarity is the whole point: a
 * method upstream adds tomorrow defaults to "the carrier must provide this"
 * rather than to being silently ignored. Anything added here needs a reason
 * written next to it.
 */
const NOT_A_PROVIDER_CONCERN: ReadonlySet<string> = new Set([
  'constructor',
  // Upstream's internal route dispatch, declared `private`. Ours is `_match`;
  // a provider is free to route however it likes so long as the public
  // methods behave.
  'match',
])

/** Load a module by absolute path, on a platform whose separators are not URL-safe. */
async function importFile(path: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(path).href) as Record<string, unknown>
}

describe.skipIf(!existsSync(harnessRoot))('the webServer surface', () => {
  it('is provided in full by the carrier, method for method', async () => {
    // Compared against upstream's RUNTIME prototype rather than its declaration
    // file. Two reasons, and the first is not a preference: `prune-payload`
    // strips every `.d.ts` from the shipped tree, and CI prunes before running
    // this suite, so a test that reads the declaration passes locally and fails
    // on the tree the installer actually contains. The second is that the
    // prototype is what upstream's callers reach for; the declaration is what
    // upstream intends.
    const upstreamPath = join(modules, '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js')
    const version = (require(join(modules, '@deepseek-ai', 'dsh-host-webserver', 'package.json')) as { version: string }).version
    const upstream = (await importFile(upstreamPath)).WebServer as { prototype: object }
    const carrier = ((await importFile(join(modules, '@dsh-desktop', 'carrier', 'lib', 'index.js')))
      .DesktopCarrier as { prototype: object })

    const required = Object.getOwnPropertyNames(upstream.prototype)
      .filter((name) => !NOT_A_PROVIDER_CONCERN.has(name))
    // Sanity: if this ever comes back near-empty the comparison is vacuous.
    expect(required.length).toBeGreaterThan(5)

    for (const name of required) {
      const theirs = Object.getOwnPropertyDescriptor(upstream.prototype, name)
      const ours = Object.getOwnPropertyDescriptor(carrier.prototype, name)
      expect(ours, `@dsh-desktop/carrier is missing ${name}, which upstream ${version} has`).toBeDefined()
      // An accessor upstream exposes has to stay an accessor here: `port` and
      // `host` are read as properties by upstream callers, not called.
      if (theirs?.get !== undefined) {
        expect(typeof ours?.get, `${name} must be an accessor on the carrier too`).toBe('function')
      } else {
        expect(typeof ours?.value, `${name} must be a method on the carrier`).toBe('function')
      }
    }
  })

  it('implements the service init symbol cordis calls to bind the socket', async () => {
    const carrier = ((await importFile(join(modules, '@dsh-desktop', 'carrier', 'lib', 'index.js')))
      .DesktopCarrier as { prototype: object })
    const init = Object.getOwnPropertySymbols(carrier.prototype)
      .find((symbol) => symbol.description === 'cordis.init')
    expect(init, 'the carrier no longer implements [Service.init]').toBeDefined()
  })

  it('renders structured rows before the raw taps, in that order', async () => {
    // The order is upstream's and it is observable: a tap that rewrites markup
    // a row produced only works if rows render first. Asserted against the
    // carrier's own renderIndex with a stub context, so this holds without
    // booting the harness.
    const carrier = (await importFile(join(modules, '@dsh-desktop', 'carrier', 'lib', 'index.js'))) as {
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
