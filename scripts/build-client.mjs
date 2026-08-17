// Build the desktop connection browser bundle: src/client.ts → lib/client.js,
// wrapped in the module-host factory form (window.__ModuleLoader__.load) that
// the upstream client module system executes. The upstream apiproxy client
// code is bundled in (published as plain ESM under lib/types); nothing else
// is imported at runtime, so the bundle has no externals.
import { build } from 'esbuild'
import { rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = join(root, 'packages', 'connection')
const id = '@dsh-desktop/connection'

// Node-style resolution for tsc and editors: the package's node_modules is a
// symlink into the staged harness tree (gitignored; skipped by staging).
// Recreated each build — a stale absolute link (moved repo, container mount)
// reads as absent to existsSync yet still blocks symlinkSync.
const link = join(pkg, 'node_modules')
rmSync(link, { recursive: true, force: true })
symlinkSync(join(root, 'build', 'harness', 'node_modules'), link, 'junction')

await build({
  entryPoints: [join(pkg, 'src', 'client.ts')],
  outfile: join(pkg, 'lib', 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  // Resolve @deepseek-ai/* from the staged harness tree.
  nodePaths: [join(root, 'build', 'harness', 'node_modules')],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})
console.log(`built ${id} -> packages/connection/lib/client.js`)
