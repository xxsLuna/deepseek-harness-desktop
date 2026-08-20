/**
 * The rule the sidecar's spawn wrapper applies.
 *
 * The wrapper itself lives in `packages/bundle/lib/boot.js` and runs before the
 * harness composes, so it cannot be imported here without booting a sidecar.
 * What is testable — and what actually matters — is the decision it makes about
 * each call's options, so that decision is reproduced here exactly. If the two
 * drift, the failure this prevents is invisible: a console window flashing on
 * Windows for every shell the harness runs.
 *
 * Why a wrapper at all is in boot.js's own comment: upstream's
 * `dsh-subprocess-local` spawns without `windowsHide`, which is harmless when a
 * terminal hosts the harness and visible when a GUI process does.
 */
import { describe, expect, it } from 'vitest'

/**
 * Decide the options one spawn call should be made with.
 *
 * Mirrors `hideConsoleWindowsForSpawnedShells` in packages/bundle/lib/boot.js.
 * @param options - whatever the caller passed as the third spawn argument.
 * @param platform - the host platform.
 * @returns the options the wrapper would forward.
 */
function forwarded(options: unknown, platform: string): unknown {
  if (platform !== 'win32') return options
  if (options === undefined || options === null) return { windowsHide: true }
  if (typeof options !== 'object' || Array.isArray(options)) return options
  if ((options as { windowsHide?: unknown }).windowsHide !== undefined) return options
  return { ...(options as object), windowsHide: true }
}

describe('the sidecar spawn wrapper', () => {
  it('hides the console for a caller that said nothing', () => {
    // This is upstream's actual shape, from dsh-subprocess-local: cwd, env,
    // stdio and detached, with no windowsHide — the case that flashes.
    const upstream = { cwd: 'C:\\work', env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
    expect(forwarded(upstream, 'win32')).toEqual({ ...upstream, windowsHide: true })
    // And the no-options overload, which Node also accepts.
    expect(forwarded(undefined, 'win32')).toEqual({ windowsHide: true })
    expect(forwarded(null, 'win32')).toEqual({ windowsHide: true })
  })

  it('never overrides a caller that decided for itself', () => {
    // An explicit false is a deliberate request for a window. Upstream passes
    // windowsHide: true in dsh-native-command and the native directory picker,
    // and those must pass through untouched rather than be re-wrapped.
    expect(forwarded({ windowsHide: false }, 'win32')).toEqual({ windowsHide: false })
    expect(forwarded({ windowsHide: true }, 'win32')).toEqual({ windowsHide: true })
  })

  it('does nothing off Windows', () => {
    // The whole problem is a Win32 console-allocation rule; there is nothing to
    // fix elsewhere, and `windowsHide` is meaningless there.
    const options = { cwd: '/work', detached: true }
    expect(forwarded(options, 'darwin')).toBe(options)
    expect(forwarded(options, 'linux')).toBe(options)
    expect(forwarded(undefined, 'linux')).toBeUndefined()
  })

  it('leaves a non-object third argument alone', () => {
    // Spreading a string or an array into spawn options would silently corrupt
    // the call; better to forward whatever it was and let Node reject it.
    expect(forwarded('nonsense', 'win32')).toBe('nonsense')
    expect(forwarded(['a'], 'win32')).toEqual(['a'])
  })

  it('preserves every other option it passes through', () => {
    // The wrapper adds one key and must not drop or reorder the rest — the spec
    // it is wrapping carries cwd, env, stdio and detached, and losing any of
    // them would break command execution outright rather than cosmetically.
    const upstream = { cwd: 'C:\\work', env: { PATH: 'x' }, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
    const result = forwarded(upstream, 'win32') as Record<string, unknown>
    expect(result.cwd).toBe(upstream.cwd)
    expect(result.env).toBe(upstream.env)
    expect(result.stdio).toBe(upstream.stdio)
    expect(result.detached).toBe(false)
  })
})
