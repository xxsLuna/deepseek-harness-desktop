// Stage the pinned harness into build/harness: a production-only npm install
// of the official @deepseek-ai/dsh package, plus this repo's desktop plugin
// packages copied in beside it. The staged tree is what ships as an Electron
// extraResource and what the contract tests boot.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pin = JSON.parse(readFileSync(join(root, 'harness.json'), 'utf8'))
const stageDir = join(root, 'build', 'harness')

// --local-only refreshes just this repo's packages inside an existing stage.
const localOnly = process.argv.includes('--local-only')
if (localOnly && !existsSync(join(stageDir, 'node_modules', '@deepseek-ai', 'dsh'))) {
  throw new Error('--local-only requires an existing stage; run without the flag first')
}

if (!localOnly) {
  console.log(`staging @deepseek-ai/dsh@${pin.harness} -> build/harness`)
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })
  writeFileSync(join(stageDir, 'package.json'), JSON.stringify({
    name: 'harness-stage',
    private: true,
    dependencies: { '@deepseek-ai/dsh': pin.harness },
  }, null, 2))

  // The registry occasionally serves a 404 for a tarball its own metadata
  // still points at (seen on @tanstack/virtual-core, a transitive dependency of
  // the harness). That is not something this repo can fix, and a one-shot
  // install turns it into a red build, so retry with a cleared cache before
  // giving up.
  //
  // The heap ceiling is not defensive tuning. Upstream declares its ~500-package
  // closure with caret ranges and this stage installs without a lockfile, so npm
  // resolves the whole search space every time — and on the hosted macOS runners
  // (about half the memory of the Linux ones) it died three times over with
  // "JavaScript heap out of memory" while Linux passed. V8 sizes its default old
  // space from available memory, so the same install fits on one runner and not
  // the other. A lockfile would remove the search rather than widen the room for
  // it; until then, this is what keeps the mac targets green.
  const installEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=4096`.trim(),
  }
  const attempts = 3
  for (let attempt = 1; ; attempt += 1) {
    try {
      // npm is npm.cmd on Windows, which spawnSync only resolves through a shell.
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-fund', '--no-audit', '--loglevel=error'], {
        cwd: stageDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: installEnv,
      })
      break
    } catch (error) {
      // Retrying an out-of-memory death is not a retry, it is the same failure
      // three times: it cost 14 minutes per macOS job before anyone saw the
      // reason. Only the transient registry case is worth another attempt.
      const output = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}${String(error.message ?? '')}`
      if (/heap out of memory|Reached heap limit/i.test(output)) {
        throw new Error(
          'stage-harness: npm ran out of heap resolving the harness tree. Raise --max-old-space-size '
          + 'above 4096 in this script, or give the stage a lockfile so npm stops re-resolving the '
          + 'caret ranges. Retrying would just fail the same way.',
          { cause: error },
        )
      }
      if (attempt === attempts) throw error
      console.warn(`stage-harness: install attempt ${attempt} of ${attempts} failed; retrying`)
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['cache', 'clean', '--force', '--loglevel=error'], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
      })
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000))
    }
  }
}

// Copy this repo's desktop plugin packages into the staged node_modules.
// Their @deepseek-ai/* imports resolve upward into the staged tree.
const packagesDir = join(root, 'packages')
if (existsSync(packagesDir)) {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgJsonPath = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    const pkgName = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).name
    const dest = join(stageDir, 'node_modules', ...pkgName.split('/'))
    const sourceDir = join(packagesDir, entry.name)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(sourceDir, dest, {
      recursive: true,
      // Exclude the package's own node_modules (a resolution symlink back
      // into this staged tree — copying it creates a cycle). Compared on
      // normalized separators: on Windows the paths carry backslashes.
      filter: (src) => {
        const rel = relative(sourceDir, src).split(sep).join('/')
        return rel !== 'node_modules' && !rel.startsWith('node_modules/') && !src.endsWith('.map')
      },
    })
    console.log(`staged local package ${pkgName}`)
  }
}

// The staged harness decides which Node it needs; report it against the major
// this repo pins, and fail loud on a version mismatch.
if (!localOnly) {
  const dshManifest = JSON.parse(readFileSync(join(stageDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  const engines = dshManifest.engines?.node ?? '(unspecified)'
  // The pin is no longer a Node binary to fetch: the harness runs on Electron's
  // own Node, so harness.json's `node` is a constraint on THAT, asserted in
  // tests/contract/native-tools.spec.ts.
  console.log(`staged dsh ${dshManifest.version}; engines.node: ${engines}; requires Node ${pin.node}.x (supplied by Electron)`)
  if (dshManifest.version !== pin.harness) {
    throw new Error(`staged version ${dshManifest.version} does not match pin ${pin.harness}`)
  }
}
