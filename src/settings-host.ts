/**
 * The Desktop Settings back channel: the launcher half of
 * `@dsh-desktop/settings`.
 *
 * The plugin draws the section and owns its copy; every value it shows lives
 * here, because every one of them is something only this process can read or
 * act on — the tray, what closing the window does, which events are worth an
 * OS notification, whether the title bar was merged, whether the app updates
 * itself. The page reaches this the same way the band's controls do: a POST to
 * a route the protocol handler answers before the socket proxy sees it.
 *
 * Writes apply immediately where the launcher can (tray, notifications,
 * updater) and are reported as needing a restart where it cannot (the title
 * bar is a window-construction option).
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_DESKTOP_SETTINGS,
  mergeDesktopSettings,
  parseDesktopSettings,
  type DesktopSettings,
} from './desktop-settings.js'
import { type UpdateMode } from './update-gate.js'
import { DEFAULT_TOGGLE_ACCELERATOR } from './shortcuts.js'

/** Fields the launcher can only honour at startup. */
const RESTART_REQUIRED: readonly (keyof DesktopSettings)[] = ['mergedTitleBar']

/** What the settings section renders, beyond the settings themselves. */
export interface DesktopSettingsView {
  settings: DesktopSettings
  /** App and bundled-harness versions, for the update row. */
  version: string
  harnessVersion: string
  /**
   * How this build updates. Not a boolean: 'auto' installs, 'notify-only' can
   * only point at the releases page, and the section says which — a single
   * "updatable" flag told unsigned macOS builds they install updates.
   */
  updates: UpdateMode
  /** Fields changed since launch that only a restart will apply. */
  pendingRestart: readonly string[]
  /** Whether this platform merges the title bar at all (Linux does not). */
  titleBarMergeable: boolean
  /**
   * Whether this session can position its own window.
   *
   * False under Wayland, where the compositor owns placement. The Shortcuts and
   * Window pages say so rather than offering a switch that does nothing.
   */
  canPositionWindow: boolean
  /** The chord the app falls back to, so the page can offer "restore default". */
  defaultToggleAccelerator: string
  /**
   * Whether the toggle accelerator is actually held right now.
   *
   * Registration is best-effort: another application may already own the chord,
   * and that is an environment fact rather than a misconfiguration. Reporting it
   * is the difference between a shortcut that looks set and does nothing, and
   * one the page can say is taken.
   */
  toggleAcceleratorActive: boolean
}

/**
 * Read, write and apply the desktop preferences.
 *
 * The file is the source of truth and is read once at construction: the app
 * is single-instance, so nothing else writes it while this runs.
 */
export class DesktopSettingsStore {
  private readonly path: string
  private current: DesktopSettings
  /** The values this launch actually booted with, for restart-required. */
  private readonly booted: DesktopSettings
  private readonly listeners = new Set<(settings: DesktopSettings) => void>()

  constructor(userDataPath: string = app.getPath('userData')) {
    this.path = join(userDataPath, 'desktop-settings.json')
    this.current = parseDesktopSettings(this.readFile())
    this.booted = this.current
  }

  /** @returns the file's content, or undefined when it is absent or unreadable. */
  private readFile(): string | undefined {
    try {
      return readFileSync(this.path, 'utf8')
    } catch {
      return undefined
    }
  }

  /** @returns the settings in force. */
  get(): DesktopSettings {
    return this.current
  }

  /**
   * Observe every change, including the one that caused it.
   * @param listener - called with the new settings after each write.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: (settings: DesktopSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Apply a patch from the settings UI and persist it.
   * @param patch - the incoming JSON body, of unknown shape.
   * @returns the settings now in force.
   */
  write(patch: unknown): DesktopSettings {
    const next = mergeDesktopSettings(patch, this.current)
    if (next === this.current) return this.current
    this.current = next
    try {
      writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      // A preference that cannot be persisted still applies to this run: the
      // user asked for it, and refusing the change outright is worse.
      console.warn('[settings] could not persist desktop-settings.json:', error)
    }
    for (const listener of this.listeners) listener(next)
    return next
  }

  /**
   * Which fields changed since launch in a way only a restart applies.
   * @returns the field names, empty when the running window matches the file.
   */
  pendingRestart(): readonly string[] {
    return RESTART_REQUIRED.filter((key) => this.current[key] !== this.booted[key])
  }

  /** @returns the settings the window was actually built with. */
  bootedWith(): DesktopSettings {
    return this.booted
  }
}

/** Everything the section needs in one read. */
export interface DesktopSettingsViewInput {
  store: DesktopSettingsStore
  harnessVersion: string
  updates: UpdateMode
  titleBarMergeable: boolean
  canPositionWindow: boolean
  /** Reads whether the global shortcut is currently registered. */
  toggleAcceleratorActive: () => boolean
}

/**
 * Project the store into what the settings section renders.
 * @param input - the store plus the launch facts the section shows.
 * @returns the view.
 */
export function desktopSettingsView(input: DesktopSettingsViewInput): DesktopSettingsView {
  return {
    settings: input.store.get(),
    version: app.getVersion(),
    harnessVersion: input.harnessVersion,
    updates: input.updates,
    pendingRestart: input.store.pendingRestart(),
    titleBarMergeable: input.titleBarMergeable,
    canPositionWindow: input.canPositionWindow,
    defaultToggleAccelerator: DEFAULT_TOGGLE_ACCELERATOR,
    toggleAcceleratorActive: input.toggleAcceleratorActive(),
  }
}

/** The shipped defaults, re-exported so the section can offer a reset. */
export { DEFAULT_DESKTOP_SETTINGS }
