/**
 * The dev/installed split of $DSH_HOME. The rule looks like housekeeping and
 * is not: `~/.dsh` is shared by the installed app, this checkout and the CLI,
 * and the harness migrates what it finds there in place. A checkout on a newer
 * pin therefore rewrites the installed build's state into a layout that build
 * cannot parse, and the symptom is a boot loop with no message anywhere.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { launchDshHome } from '../../src/dsh-home.js'

const HOME = join('C:', 'Users', 'someone')

describe('launchDshHome', () => {
  it('leaves a packaged launch on the shared home', () => {
    expect(launchDshHome(true, {}, HOME)).toBeUndefined()
  })

  it('gives a dev launch its own home', () => {
    expect(launchDshHome(false, {}, HOME)).toBe(join(HOME, '.dsh-dev'))
  })

  it('never returns the shared home for a dev launch', () => {
    // The whole point: a dev run must not land on ~/.dsh by default, whatever
    // else changes about the path.
    expect(launchDshHome(false, {}, HOME)).not.toBe(join(HOME, '.dsh'))
  })

  it('yields to an explicit DSH_HOME in both modes', () => {
    // How a dev run opts back into the real profile: deliberately, not by
    // default. A packaged launch was already leaving it alone.
    expect(launchDshHome(false, { DSH_HOME: join(HOME, '.dsh') }, HOME)).toBeUndefined()
    expect(launchDshHome(true, { DSH_HOME: join(HOME, '.dsh') }, HOME)).toBeUndefined()
  })

  it('treats an empty DSH_HOME as unset', () => {
    // An empty string is what a shell exports for an unset variable it still
    // names; resolveDshHome already reads it that way, so this must agree.
    expect(launchDshHome(false, { DSH_HOME: '' }, HOME)).toBe(join(HOME, '.dsh-dev'))
  })
})
