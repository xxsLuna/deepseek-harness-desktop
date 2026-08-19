/**
 * Auto-update eligibility. Pure: macOS auto-update requires a signed build
 * (Squirrel.Mac verifies the signature), so unsigned macOS builds fall back
 * to a notify-only path. The signed flag is baked by the build config
 * (extraMetadata), not sniffed at runtime.
 */
export interface UpdateGateInput {
  platform: NodeJS.Platform
  packaged: boolean
  macUpdatesSigned: boolean
}

export type UpdateMode = 'auto' | 'notify-only' | 'disabled'

/**
 * Decide the update mode for this run.
 * @param input - platform and build facts.
 * @returns 'auto' (electron-updater), 'notify-only' (check + link), or 'disabled' (dev).
 */
export function updateMode(input: UpdateGateInput): UpdateMode {
  if (!input.packaged) return 'disabled'
  if (input.platform === 'darwin' && !input.macUpdatesSigned) return 'notify-only'
  return 'auto'
}

/**
 * Split a version into its numeric core and its pre-release identifiers.
 * @param version - a semver-ish string; build metadata is ignored.
 * @returns the three core numbers and the dot-separated pre-release parts.
 */
function parts(version: string): { core: number[], pre: string[] } {
  const [withoutBuild = ''] = version.trim().replace(/^v/, '').split('+')
  const dash = withoutBuild.indexOf('-')
  const core = (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)).split('.')
  const pre = dash === -1 ? [] : withoutBuild.slice(dash + 1).split('.')
  return { core: [0, 1, 2].map((at) => Number(core[at] ?? 0)), pre }
}

/**
 * Whether `remote` is a LATER version than `local`, by semver precedence.
 *
 * "Different" is not the question, and answering it that way is how an older
 * feed nags a newer build — which on the notify-only path means a modal dialog
 * at startup with nothing newer behind it.
 * @param remote - the version the update feed advertises.
 * @param local - the running app's version.
 * @returns true only when the feed is ahead.
 */
export function isNewerVersion(remote: string, local: string): boolean {
  if (remote.trim() === '') return false
  const a = parts(remote)
  const b = parts(local)
  for (const [at, value] of a.core.entries()) {
    const mine = b.core[at] ?? 0
    if (!Number.isFinite(value) || !Number.isFinite(mine)) return false
    if (value !== mine) return value > mine
  }
  // A release outranks any pre-release of the same core, and vice versa.
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length > 0
  for (let at = 0; at < Math.max(a.pre.length, b.pre.length); at += 1) {
    const left = a.pre[at]
    const right = b.pre[at]
    // Running out of identifiers first is lower precedence.
    if (left === undefined) return false
    if (right === undefined) return true
    if (left === right) continue
    const leftNumber = /^\d+$/.test(left)
    const rightNumber = /^\d+$/.test(right)
    // Numeric identifiers always rank below non-numeric ones.
    if (leftNumber !== rightNumber) return rightNumber
    return leftNumber ? Number(left) > Number(right) : left > right
  }
  return false
}
