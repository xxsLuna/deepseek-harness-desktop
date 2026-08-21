// @ts-check
/**
 * The NODE_OPTIONS rule that carries the hidden-console preload into every Node
 * descendant on Windows.
 *
 * Its own module because `boot.js` boots the harness the moment it is imported,
 * so nothing can import it to test one string rule. This is the same split as
 * `@dsh-desktop/settings`'s `nav-divider`: the rule lives where a unit test can
 * reach it, and the module that has side effects just calls it.
 *
 * There is a rule here worth testing rather than assuming. NODE_OPTIONS is
 * space-delimited and inherited, so the value has to survive being appended to
 * an existing setting, must not grow once per process generation, and must carry
 * a path that contains spaces — the installed app lives under "DeepSeek Harness
 * Desktop". See `hide-console.mjs` for why the preload is needed at all.
 */

/** The flag itself. Node accepts `--import` in NODE_OPTIONS from 18.18 / 20.6. */
const IMPORT_FLAG = '--import'

/**
 * Add the preload to a NODE_OPTIONS value, once.
 *
 * The URL is expected to be a `file:` URL rather than a path: NODE_OPTIONS is
 * split on whitespace and cannot be quoted, so a raw Windows path under
 * "DeepSeek Harness Desktop" would arrive as three arguments. Percent-encoding
 * sidesteps quoting entirely, which is why the caller passes `pathToFileURL`'s
 * output and this function never tries to quote anything.
 * @param existing - the inherited NODE_OPTIONS, possibly undefined or empty.
 * @param preloadUrl - the preload module's `file:` URL.
 * @returns the value to set, or `existing` unchanged when it is already there.
 */
export function withPreload(existing, preloadUrl) {
  const current = (existing ?? '').trim()
  // Idempotent by the URL, not by the flag: another `--import` may legitimately
  // be present, and every descendant inherits this value and would otherwise
  // append again — once per generation, for the depth of the process tree.
  if (current.includes(preloadUrl)) return current
  return current === '' ? `${IMPORT_FLAG} ${preloadUrl}` : `${current} ${IMPORT_FLAG} ${preloadUrl}`
}
