// Run the packaged app's built-in smoke (DSH_DESKTOP_SMOKE=1) against a
// throwaway DSH_HOME and assert ALL-PASS. Locates the unpacked build in out/.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Derive the names from the manifest, never spell them here: a productName
// change would otherwise leave this gate looking for a bundle that no longer
// exists and reporting "no packaged binary" instead of a real result.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const product = manifest.productName ?? manifest.name
const linuxName = manifest.name

const candidates = process.platform === 'darwin'
  ? ['mac-arm64', 'mac', 'mac-universal'].map((dir) => join('out', dir, `${product}.app`, 'Contents', 'MacOS', product))
  : process.platform === 'win32'
    ? [join('out', 'win-unpacked', `${product}.exe`)]
    : ['linux-unpacked', 'linux-arm64-unpacked'].map((dir) => join('out', dir, linuxName))

const binary = candidates.find((path) => existsSync(path))
if (binary === undefined) {
  console.error(`no packaged binary found; looked at:\n  ${candidates.join('\n  ')}`)
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-home-'))
console.log(`smoking ${binary}`)
const child = spawn(binary, [], {
  env: { ...process.env, DSH_HOME: home, DSH_DESKTOP_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
const forward = (chunk) => {
  output += chunk.toString()
  process.stdout.write(chunk)
}
child.stdout.on('data', forward)
child.stderr.on('data', forward)

const timer = setTimeout(() => {
  console.error('smoke timed out after 180s')
  child.kill('SIGKILL')
}, 180_000)

child.on('exit', (code) => {
  clearTimeout(timer)
  rmSync(home, { recursive: true, force: true })
  const pass = code === 0 && output.includes('SUMMARY ALL-PASS')
  if (!pass && output.trim() === '') {
    // The single-instance lock makes a second copy quit before it prints
    // anything — the usual cause of a silent failure on a dev machine.
    console.error('the app exited without output; another instance may hold the single-instance lock')
  }
  console.log(pass ? 'packaged smoke: PASS' : `packaged smoke: FAIL (exit ${String(code)})`)
  process.exit(pass ? 0 : 1)
})
