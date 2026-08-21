/**
 * The upstream patch rows this app patches by id.
 *
 * The failure this guards is the quietest one in the project. Upstream's applier
 * **warns and skips** an id it cannot find — `warn("patch: entry %C not found")`
 * in `dsh-app-boot` — it does not throw, and the warning does not reach the app
 * log. So a renamed row leaves our patch a no-op and the upstream row at its
 * default, which for these is *on*: `webserver` binds a real TCP port,
 * `connection` mounts a WebSocket carrier the app scheme cannot serve,
 * `directory-picker` restores an OS chooser this process cannot bring to the
 * front. Nothing errors. The app simply stops being the app.
 *
 * `boot.js` now refuses to boot when one is missing, so the sidecar suite would
 * fail too — but it would fail as "the sidecar did not start". This file names
 * the row instead, which is the difference between a bump that takes an hour and
 * one that takes a morning.
 *
 * Parsed with the same js-yaml the loader uses, rather than grepping for `id:`,
 * so a row that moves into a nested `insert:` group is still found and a match
 * inside a comment or a string is not. That means declaring the `!!js` tag too:
 * upstream's dialect carries 17 of them and a plain `load` throws on the first.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const harnessRoot = join(import.meta.dirname, '..', '..', 'build', 'harness')
const modules = join(harnessRoot, 'node_modules')

/** Patch files whose rows this app targets, and what it does to them. */
const UPSTREAM_PATCHES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * Every row id in one patch file, following `insert:` groups.
 * @param file - path to a cordis.patch.yml.
 * @returns the ids it declares.
 */
function rowIds(file: string): string[] {
  const require = createRequire(join(modules, 'index.js'))
  const yaml = require('js-yaml') as {
    load: (source: string, options?: { schema: unknown }) => unknown
    Type: new (tag: string, options: Record<string, unknown>) => unknown
    JSON_SCHEMA: { extend: (type: unknown) => unknown }
  }
  // The same dialect dsh-app-boot mounts: `!!js` scalars are expressions it
  // evaluates later. Nothing here cares what they evaluate to — only that the
  // document parses far enough to reach the ids below it.
  const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data: unknown) => typeof data === 'string',
    construct: (data: unknown) => ({ __jsExpr: data }),
  }))
  const parsed = yaml.load(readFileSync(file, 'utf8'), { schema })
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const ids: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    const row = node as { id?: unknown, insert?: unknown }
    if (typeof row.id === 'string') ids.push(row.id)
    if (row.insert !== undefined) walk(row.insert)
  }
  walk(entries)
  return ids
}

describe.skipIf(!existsSync(modules))('upstream patch rows', () => {
  const declared = new Set(UPSTREAM_PATCHES.flatMap((pkg) => {
    const file = join(modules, ...pkg.split('/'), 'cordis.patch.yml')
    return existsSync(file) ? rowIds(file) : []
  }))

  it('finds the upstream patch files at all', () => {
    // If this fails, every assertion below would pass vacuously.
    for (const pkg of UPSTREAM_PATCHES) {
      expect(existsSync(join(modules, ...pkg.split('/'), 'cordis.patch.yml')), pkg).toBe(true)
    }
    expect(declared.size).toBeGreaterThan(50)
  })

  it.each([
    // Disabled, and the app is built on their being off.
    ['web-startup', 'the desktop bundle supplies its own startup'],
    ['webserver', 'would bind a real TCP port'],
    ['web-runtime', 'replaced by the desktop runtime row'],
    ['connection', 'would mount a WebSocket carrier the app scheme cannot serve'],
    ['client-hmr', 'dev-only, and it 404s against the app scheme'],
    ['directory-picker', 'replaced by the launcher-backed picker'],
    // Reconfigured rather than disabled.
    ['agent-presets', 'repointed at the presets inside the dsh package'],
    ['session-telemetry-otel', 'what DSH_TELEMETRY_DISABLED turns off'],
  ])('still declares %s (%s)', (id) => {
    expect(declared.has(id)).toBe(true)
  })
})
