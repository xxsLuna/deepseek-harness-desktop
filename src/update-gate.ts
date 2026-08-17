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
