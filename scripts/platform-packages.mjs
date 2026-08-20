// Whether a package that constrains its own platform belongs in a payload built
// for a given target.
//
// This exists because of a bug that shipped. `npm install` picks which
// platform-specific optional dependencies to download from the *host's* os/cpu,
// not from what is being packaged — so cross-building the Intel macOS target on
// an Apple Silicon runner staged `@koromix/koffi-darwin-arm64`,
// `@vscode/ripgrep-darwin-arm64`, `@img/sharp-darwin-arm64` and
// `node-addon-require-builtin-darwin-arm64` into an x64 app. On an Intel Mac
// that is no FFI (five upstream packages use koffi), no ripgrep (the glob and
// grep tools spawn it) and no sharp.
//
// build.yml's own comment argued the cross build was safe because "the payload is
// stock prebuilds and no compiled-here code at all, so nothing is built against
// the host". True, and beside the point: nothing is *built*, but what gets
// *downloaded* is still chosen by the host.
//
// The rule reads each manifest's own `os`/`cpu` rather than parsing names.
// Names do not carry it reliably — `node-addon-require-builtin-win32-x64-msvc`
// has an ABI suffix, `@img/sharp-libvips-darwin-arm64` has a two-part prefix —
// and this is the same reasoning that makes prune-payload's guard
// manifest-derived instead of a pattern.

/**
 * Test one npm os/cpu list, which may use `!` to exclude.
 * @param list - the manifest's `os` or `cpu`, possibly absent or empty.
 * @param value - the target's `process.platform` or `process.arch`.
 * @returns true when the target satisfies the list (an absent list allows all).
 */
function satisfies(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true
  const denied = list.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))
  if (denied.includes(value)) return false
  const allowed = list.filter((entry) => !entry.startsWith('!'))
  // A list of nothing but exclusions allows everything it did not exclude.
  return allowed.length === 0 || allowed.includes(value)
}

/**
 * Why this package does not belong in a payload for `target`, if it does not.
 * @param manifest - the package's `name`, `os` and `cpu`.
 * @param target - the platform and arch being packaged.
 * @returns a reason, or undefined when the package is fine for this target.
 */
export function unsatisfiedBy(manifest, target) {
  const okPlatform = satisfies(manifest.os, target.platform)
  const okArch = satisfies(manifest.cpu, target.arch)
  if (okPlatform && okArch) return undefined
  const wanted = `${target.platform}/${target.arch}`
  const declares = [
    Array.isArray(manifest.os) && manifest.os.length > 0 ? `os ${manifest.os.join(',')}` : undefined,
    Array.isArray(manifest.cpu) && manifest.cpu.length > 0 ? `cpu ${manifest.cpu.join(',')}` : undefined,
  ].filter((part) => part !== undefined).join(' ')
  return `${manifest.name ?? '(unnamed)'} declares ${declares}, which does not include ${wanted}`
}
