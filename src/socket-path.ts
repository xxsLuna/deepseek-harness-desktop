/**
 * Socket address + bearer token generation. Pure: takes platform facts,
 * returns the address the sidecar binds and the launcher connects to.
 * POSIX sockets live in a fresh 0700 tmp directory (the carrier chmods the
 * socket itself 0600); Windows uses a named pipe whose 32-hex name is
 * unguessable, with the token as the second factor on every request.
 */
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

export interface SidecarAddress {
  /** What the carrier binds and node:http connects to. */
  readonly socketPath: string
  /** Bearer token required on every request. */
  readonly token: string
}

/**
 * Generate a fresh address for one app run.
 * @param platform - process.platform.
 * @param tmpdir - os.tmpdir() on POSIX (unused on Windows).
 * @returns socket path and token.
 */
export function createSidecarAddress(platform: NodeJS.Platform, tmpdir: string): SidecarAddress {
  const token = randomBytes(32).toString('hex')
  if (platform === 'win32') {
    return { socketPath: `\\\\.\\pipe\\dsh-${randomBytes(16).toString('hex')}`, token }
  }
  // Keep the path well under the POSIX sun_path limit (~104 bytes on macOS).
  // posix.join keeps the function pure on any host (join() would inject
  // host-flavored separators into a POSIX-only path).
  return { socketPath: posix.join(tmpdir, `dsh-${randomBytes(4).toString('hex')}`, 's'), token }
}
