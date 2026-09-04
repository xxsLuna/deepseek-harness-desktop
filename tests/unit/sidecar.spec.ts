/**
 * Sidecar supervision rules. Each of these fails silently in the app — a crash
 * that is never reported looks like an app that is merely broken, and two
 * harnesses against one $DSH_HOME look like corrupted state — so they are
 * pinned against a stub process rather than a real harness boot.
 */
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Sidecar, type SidecarProcess, type SidecarSpawn } from '../../src/sidecar.js'

/** A stand-in for the harness process, driven by the test. */
class FakeChild extends EventEmitter implements SidecarProcess {
  readonly stdout = null
  readonly stderr = null
  exitCode: number | null = null
  readonly signals: NodeJS.Signals[] = []

  /** SIGTERM ends it, as it ends the real harness under stop(). */
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal)
    if (this.exitCode === null) this.exit(0)
  }

  /** Emit an exit for the supervisor to classify as crash or shutdown. */
  exit(code: number | null): void {
    this.exitCode = code
    this.emit('exit', code)
  }
}

interface HarnessOptions {
  /** Readiness answer; the default is an immediate yes. */
  readonly probe?: () => Promise<boolean>
  /** Runs on every spawn, to arrange what the new process does. */
  readonly onSpawn?: (child: FakeChild) => void
  /** Payload probe; the default says the staged tree is intact. */
  readonly exists?: (path: string) => boolean
}

/** A Sidecar wired to stub processes and a stub readiness probe. */
function harness(options: HarnessOptions = {}) {
  const children: FakeChild[] = []
  const launches: { command: string, args: string[], env: NodeJS.ProcessEnv }[] = []
  const exits: (number | null)[] = []
  const logs: string[] = []

  const spawn: SidecarSpawn = (command, args, spawnOptions) => {
    launches.push({ command, args, env: spawnOptions.env ?? {} })
    const child = new FakeChild()
    children.push(child)
    options.onSpawn?.(child)
    return child
  }

  const sidecar = new Sidecar({
    harnessRoot: join('/opt', 'harness'),
    address: { socketPath: '/tmp/dsh-test/s', token: 'token' },
    titleBand: { height: 36, lead: 0, menuButton: true },
    path: undefined,
    cwd: '/home/user',
    onLog: (line) => logs.push(line),
    onUnexpectedExit: (code) => exits.push(code),
    spawn,
    // The real probe HEADs the socket. Answering at once keeps start() out of
    // its 250ms poll sleep, so the passing tests below are instant.
    probe: options.probe ?? (async () => true),
    // harnessRoot above is a fixture, not a tree on disk, so the payload
    // preflight has to be told the files are there. Overridden by the one test
    // that checks what happens when they are not.
    exists: options.exists ?? (() => true),
  })

  return { sidecar, children, launches, exits, logs }
}

/**
 * A harness whose every process dies shortly after spawning, the way a broken
 * staged tree does. Scheduled rather than immediate: a real process cannot
 * exit before the supervisor has attached its listeners.
 */
function dyingHarness() {
  return harness({
    probe: async () => false,
    onSpawn: (child) => { setTimeout(() => child.exit(3), 0) },
  })
}

describe('Sidecar.start', () => {
  it('runs the bundle boot entry on this binary in node mode', async () => {
    // All three are silent couplings: a wrong entry path is a missing module at
    // first launch, a missing ELECTRON_RUN_AS_NODE boots a second Electron GUI
    // instead of the harness, and a missing --expose-internals leaves the
    // plugin loader unable to resolve anything installed into the profile —
    // every dsh plugin then fails to load and safe mode disables them all,
    // with the app opening as though nothing were wrong.
    const h = harness()
    await h.sidecar.start()
    expect(h.launches).toHaveLength(1)
    expect(h.launches[0]!.command).toBe(process.execPath)
    expect(h.launches[0]!.args).toEqual([
      '--expose-internals',
      join('/opt', 'harness', 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js'),
    ])
    expect(h.launches[0]!.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('reports a crash so main can bring the harness back', async () => {
    const h = harness()
    await h.sidecar.start()
    h.children[0]!.exit(1)
    expect(h.exits).toEqual([1])
  })

  it('rejects when the process dies before answering', async () => {
    const h = dyingHarness()
    await expect(h.sidecar.start()).rejects.toThrow('exited during startup')
    // A death during startup is still a crash, so it is reported too.
    expect(h.exits).toEqual([3])
  })

  it('says the payload is missing instead of spawning into MODULE_NOT_FOUND', async () => {
    // What a tree emptied through a junction looks like from here. Before the
    // preflight this spawned, Node reported MODULE_NOT_FOUND for a path inside
    // the app's own installation, and the error on screen pointed at the build
    // rather than at the deletion that had caused it.
    const h = harness({ exists: () => false })
    await expect(h.sidecar.start()).rejects.toThrow('harness files are missing')
    // And it did not waste a spawn, or a restart cycle, finding that out.
    expect(h.launches).toEqual([])
  })
})

describe('Sidecar.stop', () => {
  it('terminates without reporting a crash', async () => {
    const h = harness()
    await h.sidecar.start()
    await h.sidecar.stop()
    expect(h.children[0]!.signals).toEqual(['SIGTERM'])
    expect(h.exits).toEqual([])
  })

  it('still reports a crash after one stop/start cycle', async () => {
    // The regression this exists for: `stopping` was set by stop() and never
    // reset, so after the first cycle every later exit read as intentional and
    // the crash recovery in main was dead for the rest of the app's life. It
    // cost nothing while shutdown was the only caller of stop(); restart() is
    // the second one.
    const h = harness()
    await h.sidecar.start()
    await h.sidecar.stop()
    await h.sidecar.start()
    h.children[1]!.exit(1)
    expect(h.exits).toEqual([1])
  })
})

describe('Sidecar.restart', () => {
  it('replaces the process without it reading as a crash', async () => {
    const h = harness()
    await h.sidecar.start()
    await h.sidecar.restart()
    expect(h.children).toHaveLength(2)
    expect(h.children[0]!.signals).toEqual(['SIGTERM'])
    expect(h.exits).toEqual([])
  })

  it('leaves crash recovery working on the new process', async () => {
    const h = harness()
    await h.sidecar.start()
    await h.sidecar.restart()
    h.children[1]!.exit(2)
    expect(h.exits).toEqual([2])
  })

  it('starts one when nothing is running', async () => {
    // main's crash handler goes through restart(), and by then the process is
    // already gone — so this path has to behave exactly like start().
    const h = harness()
    await h.sidecar.restart()
    expect(h.children).toHaveLength(1)
  })

  it('coalesces overlapping restarts onto one process', async () => {
    // Two clicks in the marketplace, or a crash landing on top of a requested
    // restart. Two live harnesses against one $DSH_HOME is the failure guarded
    // here, and that state has exactly one writer by design.
    const h = harness()
    await h.sidecar.start()
    await Promise.all([h.sidecar.restart(), h.sidecar.restart()])
    expect(h.children).toHaveLength(2)
    expect(h.children[0]!.signals).toEqual(['SIGTERM'])
  })

  it('does not coalesce a later ask onto a finished restart', async () => {
    // A second install is a second reason to restart, so the sharing must last
    // only as long as the restart does.
    const h = harness()
    await h.sidecar.start()
    await h.sidecar.restart()
    await h.sidecar.restart()
    expect(h.children).toHaveLength(3)
  })

  it('clears the shared restart when it fails', async () => {
    // Otherwise every later restart returns the same rejected promise and the
    // app can never recover without a relaunch.
    const h = dyingHarness()
    await expect(h.sidecar.restart()).rejects.toThrow('exited during startup')
    await expect(h.sidecar.restart()).rejects.toThrow('exited during startup')
    expect(h.children).toHaveLength(2)
  })
})
