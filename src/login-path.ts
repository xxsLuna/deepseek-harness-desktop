/**
 * The user's real PATH.
 *
 * A Finder, Dock, or Start-Menu launch is not a shell launch: the app inherits
 * the session manager's minimal environment, so `git`, `node`, `python`, `rg`,
 * `docker` and everything else installed through a shell profile are absent.
 * The agent's shell tools then fail to find binaries that plainly work in the
 * user's terminal — the same class of defect as a dialog that never fronts.
 *
 * So ask the user's own login shell once, at startup, and hand the result to
 * the sidecar. A terminal launch already has the right PATH and is left alone.
 */
import { execFileSync } from 'node:child_process'

/** Bound on the login-shell probe; a slow profile must not delay the window. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * Read PATH from the user's login shell.
 *
 * `-ilc` runs it interactive+login so both profile files are sourced, which is
 * where version managers (nvm, asdf, rbenv, Homebrew) put their entries. The
 * marker frames the value because a profile is free to print banners.
 * @param shell - the user's shell (`$SHELL`).
 * @param run - command runner seam for tests.
 * @returns the reported PATH, or undefined when the probe fails or adds nothing.
 */
export function readLoginPath(
  shell: string | undefined,
  run: (file: string, args: string[]) => string = (file, args) =>
    execFileSync(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }),
): string | undefined {
  if (shell === undefined || shell === '') return undefined
  try {
    const out = run(shell, ['-ilc', 'printf "__DSH_PATH__%s__DSH_END__" "$PATH"'])
    const match = /__DSH_PATH__(.*)__DSH_END__/s.exec(out)
    const value = match?.[1]?.trim()
    return value === undefined || value === '' ? undefined : value
  } catch {
    // A shell that refuses -ilc, times out, or is not a POSIX shell: keep the
    // inherited PATH rather than failing the launch.
    return undefined
  }
}

/**
 * Resolve the PATH the sidecar should run with.
 *
 * Entries already present are kept ahead of the login-shell ones, so a launch
 * that DID inherit a good environment is never reordered.
 * @param platform - process.platform.
 * @param inherited - the launcher's own PATH.
 * @param login - the login-shell PATH, when one was read.
 * @returns the PATH to pass, or undefined to inherit unchanged.
 */
export function mergePath(
  platform: NodeJS.Platform,
  inherited: string | undefined,
  login: string | undefined,
): string | undefined {
  // Windows services the app's PATH from the registry at launch, and cmd has no
  // login-shell concept, so there is nothing to recover there.
  if (platform === 'win32' || login === undefined) return undefined
  const separator = ':'
  const seen = new Set<string>()
  const merged: string[] = []
  for (const entry of [...(inherited ?? '').split(separator), ...login.split(separator)]) {
    if (entry === '' || seen.has(entry)) continue
    seen.add(entry)
    merged.push(entry)
  }
  const value = merged.join(separator)
  return value === inherited ? undefined : value
}

/**
 * The PATH for this launch, probing the login shell when needed.
 * @param env - the launcher's environment.
 * @param platform - process.platform.
 * @returns the PATH to pass to the sidecar, or undefined to inherit unchanged.
 */
export function resolveSidecarPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') return undefined
  return mergePath(platform, env.PATH, readLoginPath(env.SHELL))
}
