// Download the stock Node.js runtime that ships beside the harness.
// Resolves the newest release of the pinned major from nodejs.org, verifies
// the archive against SHASUMS256.txt, and extracts only the node binary into
// build/node/. Usage: node scripts/fetch-node.mjs [--platform darwin|linux|win32] [--arch x64|arm64]
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pin = JSON.parse(readFileSync(join(root, 'harness.json'), 'utf8'))

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at !== -1 ? args[at + 1] : fallback
}
const platform = argOf('--platform', process.platform)
const arch = argOf('--arch', process.arch)

const index = await (await fetch('https://nodejs.org/dist/index.json')).json()
const release = index.find((r) => r.version.startsWith(`v${pin.node}.`))
if (release === undefined) throw new Error(`no Node ${pin.node}.x release found in nodejs.org index`)
const version = release.version

const slug = platform === 'win32' ? `node-${version}-win-${arch}` : `node-${version}-${platform}-${arch}`
const archiveName = platform === 'win32' ? `${slug}.zip` : `${slug}.tar.gz`
const base = `https://nodejs.org/dist/${version}`

console.log(`fetching ${archiveName}`)
const [archive, shasums] = await Promise.all([
  fetch(`${base}/${archiveName}`).then(async (r) => {
    if (!r.ok) throw new Error(`download failed: ${r.status} ${archiveName}`)
    return Buffer.from(await r.arrayBuffer())
  }),
  fetch(`${base}/SHASUMS256.txt`).then((r) => r.text()),
])

const expected = shasums.split('\n').find((line) => line.endsWith(archiveName))?.split(/\s+/)[0]
if (expected === undefined) throw new Error(`${archiveName} not present in SHASUMS256.txt`)
const actual = createHash('sha256').update(archive).digest('hex')
if (actual !== expected) throw new Error(`checksum mismatch for ${archiveName}: ${actual} != ${expected}`)
console.log(`checksum verified: ${expected}`)

const workDir = join(root, 'build', 'node-extract')
const outDir = join(root, 'build', 'node')
rmSync(workDir, { recursive: true, force: true })
rmSync(outDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

const archivePath = join(workDir, archiveName)
writeFileSync(archivePath, archive)
// bsdtar (preinstalled on macOS, Linux runners, and Windows 10+) reads both formats
execFileSync('tar', ['-xf', archivePath, '-C', workDir], { stdio: 'inherit' })

const binaryName = platform === 'win32' ? 'node.exe' : 'node'
const extractedBinary = platform === 'win32' ? join(workDir, slug, binaryName) : join(workDir, slug, 'bin', binaryName)
const outBinary = join(outDir, binaryName)
writeFileSync(outBinary, readFileSync(extractedBinary))
if (platform !== 'win32') chmodSync(outBinary, 0o755)
writeFileSync(join(outDir, 'VERSION'), `${version}\n`)
rmSync(workDir, { recursive: true, force: true })

console.log(`staged ${binaryName} ${version} (${platform}-${arch}) -> build/node/`)
