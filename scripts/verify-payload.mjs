// Post-package assertions: the unpacked app directory must carry a complete,
// executable payload. Run after electron-builder with the platform dir:
//   node scripts/verify-payload.mjs out/mac-arm64/DeepSeek\ Harness\ Desktop.app/Contents/Resources
//   node scripts/verify-payload.mjs out/win-unpacked/resources
//   node scripts/verify-payload.mjs out/linux-unpacked/resources
//
// Pass --platform/--arch to also assert the payload's platform-specific packages
// were chosen for the target rather than for the build host. See
// ./platform-packages.mjs for the bug that makes that worth checking.
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { globSync } from 'node:fs'
import { unsatisfiedBy } from './platform-packages.mjs'

// Flags first, then whatever is left is the positional resources dir. Written
// this way so the dir may contain spaces ("DeepSeek Harness.app") and may sit
// before or after the flags.
const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let at = 0; at < argv.length; at += 1) {
  const arg = argv[at]
  if (arg.startsWith('--')) {
    flags[arg.slice(2)] = argv[at + 1]
    at += 1
  } else {
    positional.push(arg)
  }
}
const [resources] = positional
if (resources === undefined || !existsSync(resources)) {
  console.error('usage: verify-payload.mjs <app resources dir> [--platform <p> --arch <a>]')
  process.exit(2)
}

const failures = []
const assertExists = (path, label) => {
  if (!existsSync(path)) failures.push(`${label}: missing ${path}`)
}
const assertExecutable = (path, label) => {
  if (!existsSync(path)) {
    failures.push(`${label}: missing ${path}`)
    return
  }
  if (process.platform === 'win32') return
  try {
    accessSync(path, constants.X_OK)
  } catch {
    failures.push(`${label}: not executable ${path}`)
  }
}

// 1. the shell's own asar
assertExists(join(resources, 'app.asar'), 'shell')

// 2. no bundled Node runtime: the harness runs on the app's own Electron binary
// under ELECTRON_RUN_AS_NODE. A stray one means afterPack regressed and the
// installer grew 89MB again.
if (existsSync(join(resources, 'node'))) {
  failures.push(`node runtime: unexpected ${join(resources, 'node')} — the harness runs on Electron's own Node`)
}

// 3. the staged harness: entry, our packages, and the pinned version
const harness = join(resources, 'harness')
assertExists(join(harness, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'harness')
assertExists(join(harness, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js'), 'desktop bundle')
// Every package declaring `dsh.client` must ship the bundle its exports promise.
// Upstream's client-module registry resolves `exports['./client']` at boot and
// throws MissingClientBundleError when the file is absent — so a packaged build
// that skipped build-client.mjs does not degrade, it refuses to start. Asserting
// it here names the missing bundle instead.
for (const pkg of ['connection', 'settings', 'market']) {
  assertExists(join(harness, 'node_modules', '@dsh-desktop', pkg, 'lib', 'client.js'), `${pkg} client bundle`)
}
// The band ships as page assets read at request time, so a missing one is only
// found when a window opens; assert them here instead.
for (const asset of ['index.js', 'block.js', 'desktop-chrome.css', 'desktop-chrome.js']) {
  assertExists(join(harness, 'node_modules', '@dsh-desktop', 'chrome', 'lib', asset), 'desktop chrome')
}
// Tripwire: a copied resolution symlink here points back into this tree and
// turns the payload into an infinite directory cycle.
if (existsSync(join(harness, 'node_modules', '@dsh-desktop', 'connection', 'node_modules'))) {
  failures.push('desktop client: staged connection package carries a node_modules (directory cycle)')
}
const pin = JSON.parse(readFileSync(new URL('../harness.json', import.meta.url), 'utf8'))
const staged = JSON.parse(readFileSync(join(harness, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
if (staged.version !== pin.harness) failures.push(`harness: staged ${staged.version} != pinned ${pin.harness}`)

// 4. spawned binaries kept their executable bits through packaging
for (const pattern of [
  'node_modules/@vscode/ripgrep/bin/rg',
  'node_modules/@vscode/ripgrep*/bin/rg',
  'node_modules/node-pty/prebuilds/*/spawn-helper',
  'node_modules/node-pty/build/Release/spawn-helper',
  'node_modules/@deepseek-ai/node-addon-landlock-run-*/bin/landlock-run',
]) {
  // glob patterns use forward slashes even on Windows (backslash escapes).
  for (const hit of globSync(`${harness.replaceAll('\\', '/')}/${pattern}`)) {
    if (statSync(hit).isFile()) assertExecutable(hit, 'spawned binary')
  }
}

// 5. every platform-specific package was chosen for the TARGET, not the host.
// Only checked when the caller says what the target is — the payload cannot say
// it, and guessing from the runner is what produced the bug in the first place.
if (flags.platform !== undefined && flags.arch !== undefined) {
  const target = { platform: flags.platform, arch: flags.arch }
  const modules = join(harness, 'node_modules')
  /**
   * Every package directory, one level into scopes.
   * @param dir - a node_modules directory.
   * @returns package directory paths.
   */
  const packageDirs = (dir) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isDirectory()) return []
      const path = join(dir, entry.name)
      return entry.name.startsWith('@') ? packageDirs(path) : [path]
    })
  }
  for (const dir of packageDirs(modules)) {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const reason = unsatisfiedBy(manifest, target)
    if (reason !== undefined) failures.push(`platform package: ${reason}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log('payload verified')
