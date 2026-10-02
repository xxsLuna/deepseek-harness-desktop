/**
 * The services upstream's own rows are GATED on.
 *
 * A `cordis.patch.yml` row may carry `!!js` expressions, and upstream uses them
 * to compose a row only when some service is already there:
 *
 *     - id: settings
 *       name: '@deepseek-ai/dsh-settings'
 *       disabled: !!js "!ctx.get('profileContext')"
 *
 * A gate like that fails in the worst way available to this app. The row is not
 * renamed and not missing, so `upstream-rows.spec.ts` stays green. The boot
 * succeeds, so `sidecar.spec.ts` starts. Nothing is logged, because nothing
 * went wrong — the composition did exactly what it was told. The app opens
 * looking healthy and simply has no settings service, and the first anyone
 * hears of it is the Models page answering `settings service is absent`.
 *
 * That shipped, as `0.1.7-desktop-alpha0.2.0`. Upstream 0.1.7 introduced
 * `profileContext`, which its own profile boot provides — and that boot is the
 * entry this surface replaces, so the app inherited the gate without the thing
 * it gates on. Four rows went off together (`settings`, `config-editor`,
 * `plugin-manager`, `hmr`), `ui-sidebar-browser` went off on the web-app side,
 * and `deepseek-account` came up with a null platform.
 *
 * So this file pins the one thing a version bump must not change quietly: the
 * set of service names upstream gates on. Each has to be a name this app has
 * already answered. A new one fails HERE, naming the service and pointing at
 * the row to go and read — instead of at a user's Models page.
 *
 * Parsed with the loader's own js-yaml, and for the same reasons
 * `upstream-rows.spec.ts` gives: a gate that moves into a nested `insert:`
 * group is still found, a match inside a comment is not, and the `!!js` tag has
 * to be declared or the first one throws.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const harnessRoot = join(import.meta.dirname, '..', '..', 'build', 'harness')
const modules = join(harnessRoot, 'node_modules')

/** The upstream patch files this app composes under its own overlay. */
const UPSTREAM_PATCHES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * Service names this app has an answer for, and what answers them.
 *
 * Adding a name here is a decision, not a formality: it says someone opened the
 * row, worked out what the gate is protecting, and either provided the service
 * or accepted what being without it costs.
 */
const ANSWERED: Record<string, string> = {
  // Provided by `prepare` in packages/bundle/lib/boot.js, inside the profile
  // guard — the comment there carries the whole reason.
  profileContext: '@dsh-desktop/bundle provides it from boot.js',
}

/**
 * Every `!!js` expression in one patch file, following `insert:` groups.
 * @param file - path to a cordis.patch.yml.
 * @returns the expression sources it carries.
 */
function expressions(file: string): string[] {
  const require = createRequire(join(modules, 'index.js'))
  const yaml = require('js-yaml') as {
    load: (source: string, options?: { schema: unknown }) => unknown
    Type: new (tag: string, options: Record<string, unknown>) => unknown
    JSON_SCHEMA: { extend: (type: unknown) => unknown }
  }
  const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data: unknown) => typeof data === 'string',
    construct: (data: unknown) => ({ __jsExpr: data }),
  }))
  const found: string[] = []
  // Every value, not just `disabled:` — `deepseek-account` reads the same
  // service from inside a `config:` block, and a gate is a gate wherever the
  // expression sits.
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    const expr = (node as { __jsExpr?: unknown }).__jsExpr
    if (typeof expr === 'string') {
      found.push(expr)
      return
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(yaml.load(readFileSync(file, 'utf8'), { schema }))
  return found
}

/** `ctx.get('x')` service names inside one expression. */
function gatedOn(expression: string): string[] {
  return [...expression.matchAll(/ctx\.get\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
}

describe.skipIf(!existsSync(modules))('upstream row gates', () => {
  const files = UPSTREAM_PATCHES
    .map((pkg) => join(modules, ...pkg.split('/'), 'cordis.patch.yml'))
    .filter((file) => existsSync(file))
  const sources = files.flatMap((file) => expressions(file))

  it('reads the upstream patch files at all', () => {
    // Without this the assertion below passes by finding nothing, which is the
    // same shape as the bug it exists to catch.
    expect(files).toHaveLength(UPSTREAM_PATCHES.length)
    expect(sources.length).toBeGreaterThan(0)
  })

  it('gates every row on a service this app has answered', () => {
    const names = [...new Set(sources.flatMap(gatedOn))].sort()
    for (const name of names) {
      expect(
        ANSWERED,
        `upstream now gates a row on ctx.get('${name}'). Find the row in the patch files above, `
        + 'work out what it is protecting, and either provide the service from boot.js or record '
        + 'here what being without it costs. A gate nothing answers disables its row in silence.',
      ).toHaveProperty(name)
    }
  })
})
