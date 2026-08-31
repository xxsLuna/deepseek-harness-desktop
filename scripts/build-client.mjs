// Build this repo's browser bundles: src/client.ts* → lib/client.js, wrapped in
// the module-host factory form (window.__ModuleLoader__.load) that the upstream
// client module system executes.
//
// What is bundled and what stays external differs per package, and the split
// matters: React and the upstream client packages MUST be required at runtime,
// because a second copy of React (or of a plugin's module instance) is a
// different runtime than the page's — hooks fail and services do not match.
// Upstream's own client bundles keep exactly these external.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const staged = join(root, 'build', 'harness', 'node_modules')

/** @type {{ dir: string, id: string, entry: string, external: string[] }[]} */
const BUNDLES = [
  {
    // The upstream apiproxy client code is bundled in (published as plain
    // ESM); nothing else is imported at runtime, so this one has no externals.
    dir: 'connection',
    id: '@dsh-desktop/connection',
    entry: 'client.ts',
    external: [],
  },
  {
    // A React component: everything it renders with belongs to the page.
    dir: 'settings',
    id: '@dsh-desktop/settings',
    entry: 'client.tsx',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  },
  {
    // Same as settings: a React tab, rendered by upstream's Plugins section.
    dir: 'market',
    id: '@dsh-desktop/market',
    entry: 'client.tsx',
    external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  },
  {
    // No React and no upstream imports: it reads the DOM and calls one method
    // on the injected `layout` service, so there is nothing to keep external.
    dir: 'layout-memory',
    id: '@dsh-desktop/layout-memory',
    entry: 'client.ts',
    external: [],
  },
]

for (const bundle of BUNDLES) {
  const pkg = join(root, 'packages', bundle.dir)

  const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(bundle.id)}, factory: (require) => {`
    + '\nvar module = { exports: {} }; var exports = module.exports;'

  await build({
    entryPoints: [join(pkg, 'src', bundle.entry)],
    outfile: join(pkg, 'lib', 'client.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    external: bundle.external,
    // The page's React, reached through the module host's require.
    jsx: 'automatic',
    // Resolve @deepseek-ai/* from the staged harness tree.
    nodePaths: [staged],
    banner: { js: banner },
    footer: { js: 'return module.exports; } });' },
  })
  console.log(`built ${bundle.id} -> packages/${bundle.dir}/lib/client.js`)
}
