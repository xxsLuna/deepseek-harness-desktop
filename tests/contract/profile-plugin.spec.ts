/**
 * A plugin installed into the profile actually loads at the next boot.
 *
 * This is the assertion the suite was missing, and its absence shipped a broken
 * install path. Everything around it was covered — the catalog parsed, the
 * download verified, the package landed in
 * `$DSH_HOME/profiles/desktop/node_modules`, the manifest recorded it, the tab
 * said "restart to apply" — and then the restart could not import it at all.
 *
 * The mechanism, because the failure is entirely invisible from the code:
 * `cordis-plugin-loader` imports a row three ways. With Node's internal ESM
 * loader in hand it calls `internal.import(name, ctx.baseUrl)`, which resolves
 * against the desktop profile and is the whole point of booting from a profile.
 * Without it, a bare specifier becomes a plain `import(name)` resolved from the
 * LOADER's own file, which never walks into `$DSH_HOME`. It reaches that
 * internal loader through `node-addon-require-builtin`, and on Electron 43 /
 * Node 24.18 that addon loads and then refuses with
 * `unsupported: Unsupported/no-realm` — while stock Node 22 has no trouble at
 * all. So the app ran on the one runtime where the mechanism was off, every
 * installed plugin failed with `Cannot find package`, safe mode disabled the
 * lot, and the window opened looking perfectly healthy.
 *
 * `src/sidecar.ts` passes `--expose-internals`, which is the loader's own first
 * strategy for finding that internal loader. This test is what stops that flag
 * from being tidied away, and what turns a future Electron or loader change
 * back into a named failure instead of a plugin that quietly never loads.
 *
 * Requires a staged harness (npm run stage).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Sidecar } from '../../dist/sidecar.js'
// @ts-expect-error — plain JS module shipped inside the market package
import { addInstalled } from '../../packages/market/lib/registry.js'

const root = join(import.meta.dirname, '..', '..')
const entry = join(root, 'build', 'harness', 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js')
const electronBinary = createRequire(import.meta.url)('electron') as string
const token = 'profile-plugin-token'

/** The fixture's package name, which is also its row id and its directory. */
const FIXTURE = 'dsh-plugin-contract-fixture'

interface Installed {
  entries: { name: string, kind: string, active: boolean }[]
  failed: string[]
  restartRequired: boolean
}

describe.skipIf(!existsSync(entry) || !existsSync(join(root, 'dist', 'sidecar.js')))('a profile-installed plugin', () => {
  let sidecar: Sidecar | undefined
  let home: string
  let socketDir: string
  let socketPath: string
  let bootLog = ''
  let previousHome: string | undefined

  function request(path: string): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        socketPath,
        path,
        method: path.startsWith('/api/') ? 'POST' : 'GET',
        headers: {
          host: '127.0.0.1',
          authorization: `Bearer ${token}`,
          ...path.startsWith('/api/') ? { 'content-type': 'application/json' } : {},
        },
      }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
      })
      req.setTimeout(30_000, () => { req.destroy(); reject(new Error(`timeout: ${path}`)) })
      req.on('error', reject)
      req.end(path.startsWith('/api/')
        ? JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: path.slice(5), payload: {} })
        : undefined)
    })
  }

  /**
   * Boot through the LAUNCHER's own Sidecar, not a hand-rolled spawn.
   *
   * This is the difference between a test that pins the behaviour and one that
   * merely restates it. A copy of the argv here would go on passing after
   * someone deleted `--expose-internals` from `src/sidecar.ts` — which is
   * precisely the regression this file exists to catch — so the process under
   * test has to be the one the app actually starts.
   */
  async function boot(): Promise<void> {
    bootLog = ''
    sidecar = new Sidecar({
      harnessRoot: join(root, 'build', 'harness'),
      address: { socketPath, token },
      titleBand: { height: 0, lead: 0, menuButton: false },
      path: undefined,
      cwd: home,
      onLog: (line: string) => { bootLog += `${line}\n` },
      onUnexpectedExit: (code: number | null) => { bootLog += `[sidecar exited ${String(code)}]\n` },
      // The ONE thing swapped: the binary. In the app `process.execPath` is
      // Electron; under the test runner it is whatever Node started vitest, and
      // booting on that would exercise the runtime where this bug does not
      // exist. The args are left exactly as the launcher built them, because
      // they are what is under test — `--expose-internals` among them. The env
      // is passed through untouched so DSH_HOME below reaches the child.
      spawn: (_command, args, options) => spawn(electronBinary, args, options),
    })
    await sidecar.start(150_000)
  }

  async function stop(): Promise<void> {
    await sidecar?.stop()
    sidecar = undefined
  }

  /**
   * Write the fixture exactly where an install leaves it, and record it exactly
   * as the installer records it.
   *
   * Placed by hand rather than downloaded: what is under test is whether a
   * package sitting in the profile can be RESOLVED and composed, and a network
   * fetch in front of that would only add a way for the test to fail for
   * reasons that are not the point.
   */
  /** Where the fixture's apply() records that it ran. */
  function markerPath(): string {
    return join(home, 'fixture-applied.txt')
  }

  function installFixture(): void {
    const profileDir = join(home, 'profiles', 'desktop')
    const pkgDir = join(profileDir, 'node_modules', FIXTURE)
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: FIXTURE,
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'lib/index.js',
      exports: { '.': './lib/index.js', './package.json': './package.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2), 'utf8')
    // A function plugin in the form the loader accepts: named exports, and no
    // default export (a default is unwrapped to the bare function and the row
    // then dies for want of its `inject`).
    //
    // apply() writes a marker. Composition is otherwise only inferrable from
    // the ABSENCE of a safe-mode boot, and "nothing went wrong" is exactly the
    // shape a plugin that never loaded also has. The marker is positive proof
    // that this package was imported and its apply ran in the harness process.
    writeFileSync(join(pkgDir, 'lib', 'index.js'), [
      "import { writeFileSync } from 'node:fs'",
      `export const name = '${FIXTURE}'`,
      'export function apply() {',
      `  writeFileSync(${JSON.stringify(markerPath())}, 'applied', 'utf8')`,
      '}',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(pkgDir, 'cordis.patch.yml'),
      `- insert:\n    - id: ${FIXTURE}\n      name: ${FIXTURE}\n`, 'utf8')

    // The manifest edit the installer makes, through the installer's own
    // function, so a change to how a bundle is recorded reaches this test
    // instead of leaving it asserting a shape the app no longer writes.
    const manifestPath = join(profileDir, 'package.json')
    const manifest: unknown = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8'))
      : {}
    writeFileSync(manifestPath, `${JSON.stringify(addInstalled(manifest, FIXTURE, '1.0.0'), null, 2)}\n`, 'utf8')
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-profile-home-'))
    socketDir = mkdtempSync(join(tmpdir(), 'dsh-profile-sock-'))
    socketPath = process.platform === 'win32'
      ? `${'\\'.repeat(2)}.${'\\'}pipe${'\\'}dsh-profile-${Date.now()}-${process.pid}`
      : join(socketDir, 's')
    // Sidecar inherits the launcher's environment rather than being told where
    // $DSH_HOME is, so the runner's own environment is what carries it here.
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    // First boot creates the profile; the fixture goes in afterwards, which is
    // the real order — a plugin is installed into a profile that already exists.
    await boot()
  }, 180_000)

  afterAll(async () => {
    await stop()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    rmSync(socketDir, { recursive: true, force: true, maxRetries: 3 })
  }, 60_000)

  it('composes at the next boot, rather than failing to resolve', async () => {
    installFixture()
    await stop()
    await boot()

    const answer = await request('/market/installed')
    expect(answer.status).toBe(200)
    const view = JSON.parse(answer.body) as Installed

    // The failure this exists for. `failed` is only ever populated by a
    // safe-mode boot, which is what happens when the tree will not load — and
    // an unresolvable plugin is the most likely reason for that.
    expect(
      view.failed,
      `safe mode disabled the fixture, so the profile is not on the loader's resolution path.\n${bootLog}`,
    ).toEqual([])

    // The assertion a plugin merely sitting on disk cannot satisfy: its code
    // was imported and ran inside the harness process.
    expect(
      existsSync(markerPath()),
      `the fixture was never imported, so the profile is not on the loader's resolution path.\n${bootLog}`,
    ).toBe(true)

    const row = view.entries.find((one) => one.name === FIXTURE)
    expect(row, `the fixture is not listed at all:\n${bootLog}`).toBeDefined()
    expect(row?.kind).toBe('dsh')
    expect(row?.active, 'the fixture is on disk but was not composed into the running tree').toBe(true)
    expect(view.restartRequired, 'the tree matches the disk, so nothing should be pending').toBe(false)

    // The precise symptom, asserted on the log as well as the state: this is
    // the string a future regression will print, and naming it here is what
    // makes the cause obvious instead of "the plugin does nothing".
    expect(bootLog).not.toContain(`Cannot find package '${FIXTURE}'`)
  }, 180_000)
})
