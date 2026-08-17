// Post-package assertions: the unpacked app directory must carry a complete,
// executable payload. Run after electron-builder with the platform dir:
//   node scripts/verify-payload.mjs out/mac-arm64/DeepSeek\ Harness\ Desktop.app/Contents/Resources
//   node scripts/verify-payload.mjs out/win-unpacked/resources
//   node scripts/verify-payload.mjs out/linux-unpacked/resources
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { globSync } from 'node:fs'

const resources = process.argv[2]
if (resources === undefined || !existsSync(resources)) {
  console.error('usage: verify-payload.mjs <app resources dir>')
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

// 2. the bundled Node runtime
const nodeBinary = join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
assertExecutable(nodeBinary, 'node runtime')

// 3. the staged harness: entry, our packages, and the pinned version
const harness = join(resources, 'harness')
assertExists(join(harness, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'harness')
assertExists(join(harness, 'node_modules', '@dsh-desktop', 'bundle', 'lib', 'boot.js'), 'desktop bundle')
assertExists(join(harness, 'node_modules', '@dsh-desktop', 'connection', 'lib', 'client.js'), 'desktop client bundle')
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

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log('payload verified')
