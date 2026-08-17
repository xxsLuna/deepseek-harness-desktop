/**
 * dsh-app:// deep-link parsing. The OS-registered scheme is separate from the
 * internal dsh:// asset scheme. v1 recognizes one route — focus/open the app —
 * and ignores everything else rather than navigating anywhere.
 */
export const DEEP_LINK_SCHEME = 'dsh-app'

export type DeepLink = { kind: 'open' }

/**
 * Parse one candidate deep-link URL.
 * @param raw - a URL from open-url or a second instance's argv.
 * @returns the recognized action, or undefined for foreign/malformed input.
 */
export function parseDeepLink(raw: string): DeepLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return undefined
  return { kind: 'open' }
}

/**
 * Extract a deep link from a second instance's argv (Windows/Linux delivery).
 * @param argv - the second instance's full argv.
 * @returns the last recognized deep link, if any.
 */
export function deepLinkFromArgv(argv: readonly string[]): DeepLink | undefined {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i]
    if (arg !== undefined && arg.startsWith(`${DEEP_LINK_SCHEME}://`)) return parseDeepLink(arg)
  }
  return undefined
}
