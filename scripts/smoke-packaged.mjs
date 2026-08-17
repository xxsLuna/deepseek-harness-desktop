// Run the packaged app's built-in smoke (DSH_DESKTOP_SMOKE=1) against a
// throwaway DSH_HOME and assert ALL-PASS. Locates the unpacked build in out/.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const candidates = process.platform === 'darwin'
  ? [
      join('out', 'mac-arm64', 'DeepSeek Harness Desktop.app', 'Contents', 'MacOS', 'DeepSeek Harness Desktop'),
      join('out', 'mac', 'DeepSeek Harness Desktop.app', 'Contents', 'MacOS', 'DeepSeek Harness Desktop'),
    ]
  : process.platform === 'win32'
    ? [join('out', 'win-unpacked', 'DeepSeek Harness Desktop.exe')]
    : [join('out', 'linux-unpacked', 'deepseek-harness-desktop'), join('out', 'linux-arm64-unpacked', 'deepseek-harness-desktop')]

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
  console.log(pass ? 'packaged smoke: PASS' : `packaged smoke: FAIL (exit ${String(code)})`)
  process.exit(pass ? 0 : 1)
})
