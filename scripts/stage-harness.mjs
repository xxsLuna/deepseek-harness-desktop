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

  // npm is npm.cmd on Windows, which spawnSync only resolves through a shell.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-fund', '--no-audit', '--loglevel=error'], {
    cwd: stageDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
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

// The staged harness decides which Node it needs; fail loud on a mismatch
// with the Node major this repo pins for bundling.
if (!localOnly) {
  const dshManifest = JSON.parse(readFileSync(join(stageDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  const engines = dshManifest.engines?.node ?? '(unspecified)'
  console.log(`staged dsh ${dshManifest.version}; engines.node: ${engines}; bundling Node ${pin.node}.x`)
  if (dshManifest.version !== pin.harness) {
    throw new Error(`staged version ${dshManifest.version} does not match pin ${pin.harness}`)
  }
}
