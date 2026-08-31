/**
 * The Harness home this app shares with the dsh CLI: $DSH_HOME, else ~/.dsh.
 * Mirrors the sidecar's own resolution so "Open Data Folder" and diagnostics
 * point at the directory the harness actually writes.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Resolve the harness home for this process's environment. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured !== '' ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * The harness home a launch should claim, or undefined to leave the
 * environment alone.
 *
 * A dev run gets its own, for the same reason APP_USER_MODEL_ID branches on
 * `isPackaged`: a checkout is not the installed application. The cost here is
 * higher than a wrong taskbar icon, because the harness MIGRATES the state it
 * finds — upstream 0.1.1 rewrites `.credentials.yaml` from the flat layout to
 * `version: 1` + `refs:` on first read, in place, in the shared `~/.dsh`.
 *
 * Since this checkout tracks a newer pin than whatever is installed, one dev
 * run bricks the installed build: 0.1.0-rc.8's parser wants every top-level
 * key to be a credential ref with a string value, sees the `version` number,
 * throws, and one failed entry rejects the whole plugin tree. The launcher
 * then restarts the sidecar forever, the window shows a white page or a
 * hanging spinner, and the reason is on a stdout a packaged GUI app has
 * nowhere to print. Measured, not hypothetical — six days of boot loop.
 *
 * An explicit DSH_HOME still wins, which is how a dev run opts back into the
 * real profile deliberately rather than by default.
 * @param packaged - app.isPackaged.
 * @param env - the launcher's environment.
 * @param home - os.homedir().
 * @returns the home to set, or undefined to inherit unchanged.
 */
export function launchDshHome(
  packaged: boolean,
  env: NodeJS.ProcessEnv,
  home: string,
): string | undefined {
  if (packaged) return undefined
  const configured = env.DSH_HOME
  if (configured !== undefined && configured !== '') return undefined
  return join(home, '.dsh-dev')
}
