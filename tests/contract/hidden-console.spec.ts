/**
 * A process deep in the tree must join the console, not make one.
 *
 * `AllocConsole` CREATES a window and it is visible for the instant before
 * `ShowWindow` hides it. That is tolerable once, in the launcher, at startup.
 * It is not tolerable in the ACL runner, which is a fresh process for every
 * command the harness runs — that is a flash per command, and it is the bug
 * this file exists to keep closed.
 *
 * WHAT BROKE, AND WHY NO TEST SAW IT. `hide-console.mjs` attached to the
 * PARENT's console, which is a claim about the shape of the process tree. A
 * trace under a real GUI launch shows the claim is false:
 *
 *   pid 31400 ppid 46196 | attached to the parent console   (the sidecar)
 *   pid 28972 ppid 46696 | AttachConsole(parent) failed     (the ACL runner)
 *
 * 46696 is neither the sidecar nor anything that loads the helper: upstream
 * puts a short-lived process between the two, it owns no console, and the
 * runner therefore allocated one. Nothing in the suite could see that, because
 * every level of it was upstream's to change and none of it is reachable from
 * a unit test.
 *
 * So this reproduces the SHAPE rather than the harness: an owner with no
 * console of its own, an intermediate that never loads the helper, and a
 * grandchild that does. That is three processes and no sidecar, which is what
 * makes it a test rather than a manual reproduction — the previous fix was
 * verified by hand, twice, and was wrong both times because the hand check
 * could not produce this shape on demand.
 *
 * Windows only: consoles are the whole subject.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const harnessRoot = join(import.meta.dirname, '..', '..', 'build', 'harness')
const helper = join(
  harnessRoot, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'hide-console.mjs',
)
// The app's own binary. The console story differs by subsystem — node.exe is a
// console binary and Electron is a GUI one — so probing with a stray node would
// measure a program this app never runs.
const electronBinary = createRequire(import.meta.url)('electron') as string

const runnable = process.platform === 'win32'
  && existsSync(helper)
  && typeof electronBinary === 'string'
  && existsSync(electronBinary)

describe.skipIf(!runnable)('the hidden console survives an intermediate process', () => {
  it('has an owner that allocates, and a grandchild that joins instead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-console-'))
    const trace = join(dir, 'trace.txt')
    const helperUrl = pathToFileURL(helper).href
    const script = (name: string, body: string): string => {
      const path = join(dir, name)
      writeFileSync(path, body, 'utf8')
      return path
    }

    const grandchild = script('level2.mjs', `
      import { pathToFileURL } from 'node:url'
      await import(${JSON.stringify(helperUrl)})
      setTimeout(() => process.exit(0), 200)
    `)
    // The intermediate NEVER loads the helper, so it owns no console — which is
    // exactly what makes the parent attach fail one level below it. It still
    // passes the environment down, which is what the published owner rides on.
    const intermediate = script('level1.mjs', `
      import { spawn } from 'node:child_process'
      spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true }).unref()
      setTimeout(() => process.exit(0), 1200)
    `)
    const owner = script('level0.mjs', `
      await import(${JSON.stringify(helperUrl)})
      const { spawn } = await import('node:child_process')
      spawn(process.execPath, [${JSON.stringify(intermediate)}], { stdio: 'ignore', windowsHide: true }).unref()
      setTimeout(() => process.exit(0), 1800)
    `)

    // windowsHide denies the owner a console of its own, which is the launcher's
    // condition: a GUI process with nothing to inherit.
    execFileSync(electronBinary, [owner], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_DESKTOP_SPAWN_TRACE: trace },
      windowsHide: true,
      timeout: 60_000,
    })
    // The grandchild outlives its parent's exit by design; give it a moment.
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { timeout: 20_000 })

    const lines = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split(/\r?\n/) : []
    const forScript = (name: string): string[] => lines.filter((line) => line.includes(name))

    expect(forScript('level0.mjs').join(' '), 'the owner never took a console').toContain('console')
    const deepest = forScript('level2.mjs')
    expect(deepest.length, 'the grandchild never reported — the helper did not reach it').toBeGreaterThan(0)

    // The assertion. `allocated` here is the flash: a window created and hidden,
    // once per command in production. It must join the published owner instead,
    // and it cannot have done so through its parent — the intermediate has no
    // console to share.
    expect(
      deepest.join(' '),
      `the grandchild made its own console instead of joining one:\n${lines.join('\n')}`,
    ).not.toContain('allocated and hid a console')
    expect(deepest.join(' ')).toContain('published console owner')
    // Three processes, each waiting on the one below: well past vitest's 5s default.
  }, 60_000)
})
