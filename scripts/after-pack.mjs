// electron-builder afterPack hook: copy the staged harness tree into the app's
// resources. Done here (not via extraResources) because the builder's file
// matcher hard-excludes node_modules paths, and the harness tree IS a
// node_modules tree.
//
// No Node runtime is copied: the harness runs on this app's own Electron binary
// under ELECTRON_RUN_AS_NODE (see src/sidecar.ts). The staged tree still ships
// as ordinary files rather than inside the asar, so the prebuilds and spawned
// binaries it carries stay directly loadable and executable.
import { cpSync } from 'node:fs'
import { join } from 'node:path'

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const resources = electronPlatformName === 'darwin'
    ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(appOutDir, 'resources')
  const root = join(import.meta.dirname, '..')
  console.log(`  • copying harness into ${resources}`)
  cpSync(join(root, 'build', 'harness'), join(resources, 'harness'), { recursive: true })
}
