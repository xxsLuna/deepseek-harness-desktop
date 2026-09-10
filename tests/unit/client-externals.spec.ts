/**
 * What a client bundle requires at runtime has to be answerable at runtime.
 *
 * This is the guard for the break that shipped as `0.1.5-desktop-alpha0.1.0`,
 * and the shape of it is worth stating because nothing else in the suite could
 * see it. `@dsh-desktop/connection`'s bundle re-exported upstream's client
 * `apply` with `@deepseek-ai/*` external, so it emitted
 * `require("@deepseek-ai/dsh-client-connection/client")`. That require is
 * answered by the browser module table, and `dsh-client-modules` builds the
 * table from `ctx.loader.entries()` while skipping `entry.disabled` — and our
 * own patch disabled the `connection` row to make room for the stand-in. The
 * module could never be there. The build was clean, `npm test` was clean, the
 * contract suite was clean, and every user got "Failed to load plugins" with
 * `missed the module table` on the first launch after the update.
 *
 * So the invariant is: every specifier a built bundle requires is either a
 * platform seed word the module host answers itself, or a package this repo
 * DECLARES it needs — `dsh.client.inject` and `dsh.client.external` being the
 * two fields `arriveGraphRow` walks before materializing a factory. An
 * undeclared `@deepseek-ai/*` require is the drift, whatever else is true
 * about it.
 *
 * Declared is necessary, not sufficient: the row also has to be mounted, and
 * `tests/contract/sidecar.spec.ts` is where the served boot graph proves that.
 * This half needs no staged tree, only a build, which is what makes it the
 * half that fails first.
 *
 * The bundle assertions skip without a build, the repo's convention for a
 * suite that reads an artifact. That is not a hole at the gate: `build.yml`
 * runs `stage` and `build` before `npm test`, so they are live in CI, which is
 * what a release passes through.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const packagesDir = join(root, 'packages')

/**
 * Names the module host answers from its own seed table rather than from a
 * row. React is the page's, and a second copy would be a different runtime.
 */
const SEED_WORDS = new Set(['react', 'react-dom', 'react/jsx-runtime'])

interface Manifest {
  name: string
  exports?: Record<string, unknown>
  dsh?: { client?: { inject?: string[], external?: string[] } }
}

/** Every package directory, with its manifest. */
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    dir: entry.name,
    manifest: JSON.parse(
      readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8'),
    ) as Manifest,
  }))

/**
 * Runtime require specifiers a built bundle emits.
 *
 * Read off the built file rather than the source: what the loader has to
 * answer is what esbuild decided to leave external, and the source cannot say
 * which of its imports that was.
 * @param file - path to a built bundle.
 * @returns every distinct specifier it requires.
 */
function requiredSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const found = new Set<string>()
  for (const match of source.matchAll(/\brequire\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    if (match[1] !== undefined) found.add(match[1])
  }
  return [...found]
}

const built = packages
  .map((pkg) => ({ ...pkg, file: join(packagesDir, pkg.dir, 'lib', 'client.js') }))
  .filter((pkg) => existsSync(pkg.file))

describe.skipIf(built.length === 0)('built client bundles', () => {
  it.each(built.map((pkg) => [pkg.dir, pkg] as const))(
    '%s requires only seed words and specifiers its manifest declares',
    (_dir, pkg) => {
      const client = pkg.manifest.dsh?.client
      const declared = new Set([...client?.inject ?? [], ...client?.external ?? []])
      for (const specifier of requiredSpecifiers(pkg.file)) {
        if (SEED_WORDS.has(specifier)) continue
        // `<pkg>/client` aliases the bare package row, which is how upstream's
        // own bundles name each other; both spellings count as declaring it.
        const bare = specifier.replace(/\/client$/, '')
        expect(
          declared.has(specifier) || declared.has(bare),
          `${pkg.manifest.name} requires ${specifier} at runtime but declares neither it nor ${bare} `
          + 'in dsh.client.inject/external — the module host has nothing to answer it with',
        ).toBe(true)
      }
    },
  )
})

describe('the injected transport', () => {
  const file = join(packagesDir, 'connection', 'lib', 'transport.js')

  it.runIf(existsSync(file))('requires nothing at all', () => {
    // It runs from a <script> in the document, before the module system
    // exists. There is no `require` in scope, so an external here would be a
    // ReferenceError on the first page load rather than a table miss.
    expect(requiredSpecifiers(file)).toEqual([])
  })

  it.runIf(existsSync(file))('installs the hooks upstream reads', () => {
    const source = readFileSync(file, 'utf8')
    expect(source).toContain('__DSH_TRANSPORT__')
    expect(source).toContain('/__desktop/remote-stream')
  })

  it('is not a client module, and its package says so', () => {
    const manifest = packages.find((pkg) => pkg.dir === 'connection')?.manifest
    // Two fields, and the client-module scan needs BOTH: `dsh.client` to be
    // declared, and a `./client` export to load. Either one alone re-opens the
    // question the injection closed, so neither may come back by accident.
    expect(manifest?.dsh).toBeUndefined()
    expect(manifest?.exports?.['./client']).toBeUndefined()
  })

  it('is named by the manifest, so the prune cannot sweep it', () => {
    // `prune-payload.mjs` derives its keep-list from `main`, `bin` and
    // `exports`. Nothing imports `./transport` — the node half reads the file
    // off disk — so without this entry the script survives only because the
    // prune happens not to sweep plain `.js`, which is a property of the rules
    // rather than a guarantee about this file. Declaring it makes the
    // protection manifest-derived, which is the whole design of that guard.
    const manifest = packages.find((pkg) => pkg.dir === 'connection')?.manifest
    expect(manifest?.exports?.['./transport']).toBe('./lib/transport.js')
  })
})
