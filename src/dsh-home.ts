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
