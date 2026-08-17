// electron-builder afterPack hook: copy the staged harness tree and the stock
// Node runtime into the app's resources. Done here (not via extraResources)
// because the builder's file matcher hard-excludes node_modules paths, and
// the harness tree IS a node_modules tree.
import { cpSync } from 'node:fs'
import { join } from 'node:path'

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const resources = electronPlatformName === 'darwin'
    ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(appOutDir, 'resources')
  const root = join(import.meta.dirname, '..')
  console.log(`  • copying harness + node runtime into ${resources}`)
  cpSync(join(root, 'build', 'harness'), join(resources, 'harness'), { recursive: true })
  cpSync(join(root, 'build', 'node'), join(resources, 'node'), { recursive: true })
}
