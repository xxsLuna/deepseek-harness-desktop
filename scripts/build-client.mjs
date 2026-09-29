// Build this repo's browser bundles from `src/`, in one of two forms.
//
// `module` is the default: a bundle wrapped in the module-host factory form
// (window.__ModuleLoader__.load) that upstream's client module system executes,
// written to `lib/client.js`. What stays external matters here and the split is
// not a size decision: React and the upstream client packages MUST be required
// at runtime, because a second copy of React (or of a plugin's module instance)
// is a different runtime than the page's — hooks fail and services do not
// match. Upstream's own client bundles keep exactly these external.
//
// `page` is for code that is not a client plugin at all: a plain IIFE the node
// half injects into the served document. It takes no externals, because there
// is no module host answering a require at the point it runs.
//
// **An external is only answerable if the package it names is a MOUNTED loader
// row.** `dsh-client-modules` builds the browser module table from
// `ctx.loader.entries()` and skips `entry.disabled`, so externalising a package
// whose row this app disables produces a bundle that builds clean, unit-tests
// clean, and throws "missed the module table" at every user on boot. That
// shipped once, as `0.1.5-desktop-alpha0.1.0`. `tests/unit/client-externals.spec.ts`
// is what makes the drift fail here instead.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const staged = join(root, 'build', 'harness', 'node_modules')

/**
 * @type {{
 *   dir: string,
 *   id: string,
 *   entry: string,
 *   external: string[],
 *   form?: 'module' | 'page',
 *   out?: string,
 * }[]}
 */
const BUNDLES = [
  {
    // Not a client plugin: upstream's carrier-override seam is a page global,
    // and this builds the script that sets it. `@dsh-desktop/connection`'s node
    // half injects the result at the top of `<head>`, which is what "before
    // plugin boot" means in a document.
    //
    // Nothing is external, and nothing needs to be — the source imports only a
    // type. The previous shape re-exported upstream's client `apply` with
    // `@deepseek-ai/*` external, which is the drift the header describes.
    dir: 'connection',
    id: '@dsh-desktop/connection',
    entry: 'transport.ts',
    external: [],
    form: 'page',
    out: 'transport.js',
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
  const page = bundle.form === 'page'
  const outfile = join(pkg, 'lib', bundle.out ?? 'client.js')

  const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(bundle.id)}, factory: (require) => {`
    + '\nvar module = { exports: {} }; var exports = module.exports;'

  await build({
    entryPoints: [join(pkg, 'src', bundle.entry)],
    outfile,
    bundle: true,
    format: page ? 'iife' : 'cjs',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    external: bundle.external,
    // The page's React, reached through the module host's require.
    jsx: 'automatic',
    // Resolve @deepseek-ai/* from the staged harness tree.
    nodePaths: [staged],
    ...page ? {} : {
      banner: { js: banner },
      footer: { js: 'return module.exports; } });' },
    },
  })
  console.log(`built ${bundle.id} -> packages/${bundle.dir}/lib/${bundle.out ?? 'client.js'}`)
}
