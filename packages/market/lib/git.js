// @ts-check
/**
 * The git transport: fetching one plugin's tree out of a git repository.
 *
 * A `.claude-plugin/marketplace.json` names most of its plugins as git
 * sources, so this sits beside `fetch.js`'s tarball transport rather than
 * inside it — same layer, same refusal vocabulary (`MarketError` and a stable
 * `code`), different wire.
 *
 * **Why we shell out to `git` instead of building an archive URL.** Every
 * forge offers a tarball endpoint, and using one would need no child process
 * at all. It would also need us to grow credential handling: a private
 * self-hosted GitLab answers that endpoint with a login page unless we carry a
 * token, and then we own token storage, token scope and token expiry for every
 * forge anyone might host. Invoking `git` instead means the fetch **inherits
 * the user's own credential helper** — Git Credential Manager, an
 * `osxkeychain` entry, a `.git-credentials` file, an in-house helper — and a
 * private repo simply works with no secret of ours anywhere.
 *
 * That property is the entire justification for the child process, and it is
 * load-bearing in a way that is easy to destroy by accident:
 *
 * - **The environment is inherited, not scrubbed.** A helper is configured in
 *   the user's git config and often reached through `HOME`, `PATH` or a
 *   helper-specific variable. Passing a constructed env, or clearing
 *   `GIT_CONFIG_NOSYSTEM`-adjacent state, would silently turn every private
 *   source into an authentication failure. The one variable added is
 *   `GIT_TERMINAL_PROMPT=0`, and that is the opposite of scrubbing: without
 *   it, a repo with no usable helper leaves `git` blocked on a username prompt
 *   that a GUI app has no console to answer, and the install hangs until the
 *   timeout instead of failing.
 * - **`git` has to be findable.** A Finder/Dock/Start-Menu launch inherits a
 *   minimal environment with no `git` on `PATH`, which is exactly the defect
 *   `src/login-path.ts` exists to fix: the launcher probes the user's login
 *   shell and hands the sidecar the real PATH. This module is downstream of
 *   that. When `git` is still missing it says so **by name** — see
 *   `ERR_MARKET_GIT_MISSING` — because a raw `ENOENT` from a spawn is the
 *   least actionable error a user can be shown.
 *
 * The dangerous part of this file is not the network, it is the checkout:
 * see {@link GIT_SAFETY_ARGS}.
 *
 * Runs inside the harness sidecar (plain Node, no Electron). The child process
 * runner is injectable — the same seam `fetch.js` gives `fetchImpl` — so the
 * argv, the sha override and every failure path are testable without a
 * network. A fake runner agreeing with a wrong argv proves nothing, so
 * `tests/unit/market-git.spec.ts` also clones a real repository.
 */
import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MarketError, requireHttps } from './fetch.js'

/**
 * Ceiling on the whole operation — every git invocation shares one budget, so
 * a source that stalls after `init` cannot buy itself a fresh timeout at each
 * step. Two minutes is far more than a plugin-sized shallow clone needs and
 * short enough that a hung install is a failed install rather than a spinner
 * nobody can cancel.
 */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Cap on captured git output. Only `rev-parse` output is ever read. */
const MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * Configuration forced off for every invocation, because a checkout of
 * untrusted content is code execution unless it is argued out of it.
 *
 * **This is the security-relevant part of the file.** A cloned repository is
 * content an attacker publishes, and git's own defaults hand that content
 * several ways to run a command on this machine:
 *
 * - `core.hooksPath` — a hook is an executable git runs on its own. A clone
 *   does not carry the remote's hooks, but it does run the hooks in the new
 *   repository, and those come from a template directory. Both halves are
 *   closed: `--template=` (below) stops any template being copied in, and
 *   pointing `core.hooksPath` at `.git/no-hooks` overrides a `core.hooksPath`
 *   in the *user's* config — a husky or lefthook setup — from supplying them
 *   instead. That target is chosen because git refuses to check out any path
 *   under `.git`, so the fetched tree provably cannot create it.
 * - `core.fsmonitor` — a config value git executes as a command, automatically,
 *   as part of ordinary index work.
 * - `protocol.ext.allow` — an `ext::` URL *is* a command line. Nothing here
 *   fetches one at the top level (the scheme check refuses it), but a
 *   submodule can carry one, so the transport is turned off outright rather
 *   than relying on the recursion staying off. `protocol.file.allow` is
 *   deliberately left at git's default of `user`: that default is what closed
 *   CVE-2022-39253 for submodules while still permitting a user-initiated
 *   `file://` clone, and forcing it to `always` would reopen the hole.
 * - `core.symlinks` — with it off, a symlink in the tree is written as a plain
 *   file holding its target text. A plugin tree is walked and copied by other
 *   code afterwards, and a symlink pointing at `../../../` or an absolute
 *   system path is how that walk is turned into a read or a write somewhere
 *   else. `tar.js` audits entry paths for the same reason; this is the git
 *   equivalent, and it is cheaper because git does the refusing.
 * - `core.autocrlf` — not a security setting, a correctness one, and Windows
 *   only. Git for Windows defaults it on, which rewrites line endings on
 *   checkout: a plugin's shell script arrives with CRLF and fails at `#!` with
 *   an error naming neither git nor us. The bytes we want are the bytes that
 *   were committed.
 *
 * What is **not** closed, stated plainly rather than left to be discovered: a
 * repository's own `.gitattributes` can *select* a clean/smudge filter, and
 * filters run during checkout. It cannot *define* one — the command lives in
 * config the repository does not control — so the residual case is a filter
 * the user has already configured (git-lfs is the common one) being invoked on
 * files the repository marks. Closing that would mean ignoring the user's git
 * config, which is the same config that holds the credential helper this whole
 * approach exists to reuse. The trade is deliberate.
 */
export const GIT_SAFETY_ARGS = Object.freeze([
  '-c', 'core.hooksPath=.git/no-hooks',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.symlinks=false',
  '-c', 'core.autocrlf=false',
  '-c', 'protocol.ext.allow=never',
])

/** `owner/name`, with both halves starting alphanumeric so `..` is unspellable. */
const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * A branch or tag we will pass to git.
 *
 * Leading character alphanumeric is the load-bearing part: a ref beginning
 * `-` is an option, and while `--branch <ref>` consumes the next argv element
 * whatever it looks like, the fallback path passes a ref as a plain `fetch`
 * argument where it would not be. The rest tracks `git check-ref-format`
 * closely enough to refuse what git would refuse anyway.
 */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** A full object name, sha-1 or the sha-256 object format. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * One segment of a `git-subdir` path.
 *
 * Deliberately narrower than what a filesystem allows. This string comes out of
 * a document fetched over the network and is joined onto a directory we then
 * empty, so the two things it must never be able to name are somewhere above
 * the checkout and somewhere with a different meaning to the shell. Requiring
 * each segment to start with an alphanumeric makes `.`, `..` and a leading dash
 * unrepresentable rather than filtered — the same construction the repo string
 * uses, for the same reason.
 */
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * A plugin source as a catalog spells it.
 * @typedef {object} GitSource
 * @property {string} source - `github`, `url`/`git`, or `git-subdir`.
 * @property {string} [url] - the repository URL, for a `url` source.
 * @property {string} [repo] - `owner/name`, for a `github` source.
 * @property {string} [path] - directory inside the repository, for `git-subdir`.
 * @property {string} [ref] - branch or tag to check out.
 * @property {string} [sha] - the exact commit; authoritative over `ref`.
 */

/**
 * A source reduced to what the transport actually needs.
 * @typedef {object} ResolvedGitSource
 * @property {string} url - the repository URL to hand to git.
 * @property {string | undefined} ref - the branch or tag, when one was named.
 * @property {string | undefined} sha - the exact commit, lowercased.
 * @property {string | undefined} path - the subdirectory to promote, when the
 * plugin is not the repository root.
 */

/**
 * @typedef {object} GitRunOptions
 * @property {string} cwd - directory to run in; always the destination.
 * @property {number} timeoutMs - what is left of the operation's budget.
 */

/**
 * A git invocation. Resolves with stdout, rejects on a non-zero exit.
 * @typedef {(args: string[], options: GitRunOptions) => Promise<string>} GitRunner
 */

/**
 * @typedef {object} FetchGitOptions
 * @property {GitRunner} [run] - runner seam; defaults to spawning `git`.
 * @property {number} [timeoutMs] - budget for the whole operation.
 */

/**
 * What was actually fetched.
 * @typedef {object} GitCheckout
 * @property {string} url - the repository the tree came from.
 * @property {string | undefined} ref - the ref asked for, if any.
 * @property {string} sha - the commit `HEAD` really is, verified.
 */

/**
 * Reduce a catalog's source descriptor to a URL, a ref and a sha.
 *
 * Pure, and every refusal is named, so the whole shape rule is testable
 * without a child process — the same split `fetch.js` makes between policy and
 * I/O.
 * @param {unknown} source - the source object from a catalog row.
 * @returns {ResolvedGitSource} the resolved source.
 * @throws {MarketError} when the descriptor is not one we can fetch.
 */
export function resolveGitSource(source) {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new MarketError('market: git source is not an object', 'ERR_MARKET_GIT_SOURCE')
  }
  const record = /** @type {Record<string, unknown>} */ (source)
  const kind = record.source
  let url
  if (kind === 'git-subdir') {
    // One repository, many plugins — which is the layout a marketplace repo
    // naturally has, and the reason this type exists in the format at all.
    // Either spelling of the location is accepted, because `git-subdir` in the
    // standard carries whichever of `repo` and `url` the publisher has.
    url = typeof record.repo === 'string'
      ? githubUrl(record.repo)
      : requireRepositoryUrl(record.url)
  } else if (kind === 'github') {
    const repo = record.repo
    if (typeof repo !== 'string' || !GITHUB_REPO.test(repo)) {
      throw new MarketError(
        `market: github source needs a repo of the form owner/name, got ${JSON.stringify(repo)}`,
        'ERR_MARKET_GIT_SOURCE',
      )
    }
    url = githubUrl(repo)
    // `git` and `url` are the two spellings the same thing appears under.
  } else if (kind === 'url' || kind === 'git') {
    url = requireRepositoryUrl(record.url)
  } else {
    throw new MarketError(
      `market: ${JSON.stringify(kind)} is not a git source kind (github, url, git-subdir)`,
      'ERR_MARKET_GIT_SOURCE',
    )
  }
  const path = requireSubdirectory(record.path, kind === 'git-subdir')
  const ref = record.ref
  if (ref !== undefined && (typeof ref !== 'string' || ref.length > 255 || !REF.test(ref)
    || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock'))) {
    throw new MarketError(`market: ${JSON.stringify(ref)} is not a usable git ref`, 'ERR_MARKET_GIT_REF')
  }
  const sha = record.sha
  if (sha !== undefined && (typeof sha !== 'string' || !OBJECT_ID.test(sha))) {
    throw new MarketError(`market: ${JSON.stringify(sha)} is not a git object name`, 'ERR_MARKET_GIT_SHA')
  }
  return {
    url,
    ref: typeof ref === 'string' ? ref : undefined,
    // Lowercased here so the verification below is a plain string comparison
    // against what `rev-parse` prints, which is always lowercase.
    sha: typeof sha === 'string' ? sha.toLowerCase() : undefined,
    path,
  }
}

/**
 * The clone URL for an `owner/name` repository.
 * @param {unknown} repo - the repo string from the row.
 * @returns {string} the https clone URL.
 * @throws {MarketError} when it is not `owner/name`.
 */
function githubUrl(repo) {
  if (typeof repo !== 'string' || !GITHUB_REPO.test(repo)) {
    throw new MarketError(
      `market: github source needs a repo of the form owner/name, got ${JSON.stringify(repo)}`,
      'ERR_MARKET_GIT_SOURCE',
    )
  }
  // `.git` is appended only when absent: `owner/name.git.git` is a 404, and a
  // repo legitimately ending in `.git` is a name a forge does allow.
  return `https://github.com/${repo.endsWith('.git') ? repo : `${repo}.git`}`
}

/**
 * Check a `git-subdir` path and return it in posix form.
 *
 * Required for `git-subdir` and refused on every other kind, rather than
 * ignored: a `path` on a whole-repository source is a publisher who believes
 * only part of the tree will be installed, and silently installing all of it is
 * the wrong way to be wrong.
 *
 * Validation is by segment against `PATH_SEGMENT`, so `..`, an absolute path, a
 * UNC path, a drive letter and a trailing separator are all simply not
 * expressible — there is no filtering step to get wrong. A backslash is refused
 * outright rather than translated: it is a legal character in a POSIX file name,
 * so treating it as a separator would let one repository mean two things
 * depending on which platform installed it.
 * @param {unknown} value - the row's `path`.
 * @param {boolean} required - whether this kind must carry one.
 * @returns {string | undefined} the normalised path, or undefined.
 * @throws {MarketError} when present and unusable, or absent and required.
 */
function requireSubdirectory(value, required) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined
    throw new MarketError('market: a git-subdir source needs a path', 'ERR_MARKET_GIT_PATH')
  }
  if (!required) {
    throw new MarketError(
      'market: only a git-subdir source may carry a path',
      'ERR_MARKET_GIT_PATH',
    )
  }
  if (typeof value !== 'string' || value.length > 255 || value.includes('\\')) {
    throw new MarketError(`market: ${JSON.stringify(value)} is not a usable subdirectory`, 'ERR_MARKET_GIT_PATH')
  }
  const segments = value.replace(/\/+$/, '').split('/')
  if (segments.length === 0 || segments.length > 8 || !segments.every((one) => PATH_SEGMENT.test(one))) {
    throw new MarketError(`market: ${JSON.stringify(value)} is not a usable subdirectory`, 'ERR_MARKET_GIT_PATH')
  }
  return segments.join('/')
}

/**
 * Check a repository URL and return it unchanged.
 *
 * The https rule — parses as a URL, is https, carries no credentials — is
 * `fetch.js`'s `requireHttps`, called rather than restated. Two spellings of
 * one scheme check is precisely where a hole opens, since only one of them
 * ever gets updated; `fetch.js` exports it for that reason and this is the
 * second caller. Only the refusal is re-clothed, so a caller switching on
 * `ERR_MARKET_GIT_*` does not have to know that one branch of it came from the
 * http transport.
 *
 * `file:` is the one scheme this transport adds. A local repository is not a
 * network hop — no on-path attacker, no credential, no host to be lied about —
 * so the rule that exists to stop a plaintext hop has nothing to say about it,
 * and it is what makes a real clone testable with no network at all. Every
 * other scheme goes to `requireHttps` and is refused there: `git:` is
 * unauthenticated and unencrypted, `ssh:` would reach a different credential
 * path (agent keys) than the helper this module is built around, and `ext::`
 * is a command line. Which sources may be *listed* remains the catalog
 * layer's decision; this is the transport's own floor.
 * @param {unknown} value - the candidate URL.
 * @returns {string} the URL.
 * @throws {MarketError} when it is not one this transport will fetch.
 */
function requireRepositoryUrl(value) {
  if (typeof value !== 'string' || value === '') {
    throw new MarketError('market: git source has no url', 'ERR_MARKET_GIT_URL')
  }
  try {
    if (new URL(value).protocol === 'file:') return value
  } catch {
    throw new MarketError(`market: git source is not a URL: ${value}`, 'ERR_MARKET_GIT_URL')
  }
  try {
    requireHttps(value, 'git source')
  } catch (error) {
    throw new MarketError(error instanceof Error ? error.message : String(error), 'ERR_MARKET_GIT_URL')
  }
  return value
}

/**
 * The subcommand in an argv, for a message a person can act on.
 *
 * Skips the leading `-c key=value` pairs so the answer is `clone` rather than
 * `-c`, which is all an operator reading a timeout wants to know.
 * @param {string[]} args - argv after the program name.
 * @returns {string} the subcommand, or an empty string.
 */
function subcommand(args) {
  let at = 0
  while (args[at] === '-c') at += 2
  return args[at] ?? ''
}

/**
 * Spawn `git`, translating the failures worth naming.
 * @param {string[]} args - argv after the program name.
 * @param {GitRunOptions} options - where and for how long.
 * @returns {Promise<string>} stdout.
 */
function spawnGit(args, options) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      // A console child with no console to inherit gets a fresh VISIBLE one on
      // Windows; AGENTS.md has the whole story. The sidecar attaches a hidden
      // console at startup, so this is belt and braces — but a flashing window
      // per install is exactly the class of defect that note exists for.
      windowsHide: true,
      // Inherited, not constructed: see the module note. The credential helper
      // is reached through this environment, so the only edit is the one that
      // stops git blocking on a prompt no GUI process can answer.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(String(stdout))
        return
      }
      const failure = /** @type {NodeJS.ErrnoException & { killed?: boolean }} */ (error)
      if (failure.code === 'ENOENT') {
        reject(new MarketError(
          'market: git is not on PATH, so only archive sources can be installed',
          'ERR_MARKET_GIT_MISSING',
        ))
        return
      }
      if (failure.killed === true) {
        reject(new MarketError(
          `market: git ${subcommand(args)} timed out after ${options.timeoutMs}ms`,
          'ERR_MARKET_GIT_TIMEOUT',
        ))
        return
      }
      // stderr is where git says what went wrong; the Error's own message is
      // just the command line, which tells an operator nothing.
      const detail = String(stderr).trim() || failure.message
      reject(new MarketError(`market: git failed: ${detail}`, 'ERR_MARKET_GIT_FAILED'))
    })
  })
}

/**
 * Fetch a plugin's tree out of a git repository, into `dest`.
 *
 * `dest` is created if missing and must otherwise be empty — git refuses to
 * clone into a directory that is not.
 *
 * **A `sha` overrides `ref`.** A shallow clone of a branch contains that
 * branch's tip and nothing else, so checking out an arbitrary commit
 * afterwards fails: the object is simply not there. Naming a commit therefore
 * takes a different route — `init`, `remote add`, then `fetch --depth 1 origin
 * <sha>`, git's fetch-by-object-name form, which asks the server for that one
 * commit. Servers may refuse it (`uploadpack.allowReachableSHA1InWant` is off
 * by default in stock git, though GitHub and GitLab both enable it), so a
 * refusal falls back to a full fetch of the ref and a checkout of the commit
 * from that history. Either way `HEAD` is read back and compared: a sha that
 * was asked for and not got is the failure this must not have, because it is
 * the failure that silently installs different code from the one the catalog
 * pinned.
 * @param {unknown} source - the source object from a catalog row.
 * @param {string} dest - directory to check the tree out into.
 * @param {FetchGitOptions} [options] - runner seam and time budget.
 * @returns {Promise<GitCheckout>} what was actually checked out.
 * @throws {MarketError} on every refusal; `code` is the stable part.
 */
export async function fetchGit(source, dest, options = {}) {
  const resolved = resolveGitSource(source)
  const run = options.run ?? spawnGit
  const budget = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + budget
  /**
   * One git command, against what is left of the operation's budget.
   * @param {string[]} args - argv after the program name.
   * @returns {Promise<string>} stdout.
   */
  const git = async (args) => {
    const timeoutMs = deadline - Date.now()
    if (timeoutMs <= 0) {
      throw new MarketError(`market: git took longer than ${budget}ms`, 'ERR_MARKET_GIT_TIMEOUT')
    }
    return await run([...GIT_SAFETY_ARGS, ...args], { cwd: dest, timeoutMs })
  }

  mkdirSync(dest, { recursive: true })
  if (resolved.sha === undefined) {
    // `--template=` with no value: no template directory is copied in, so the
    // new repository has no hooks to run at all. `--depth 1` implies
    // `--single-branch`; `--no-tags` and `--no-recurse-submodules` keep the
    // fetch to the one tree we came for. `.` is the destination because the
    // runner already runs there, which keeps every argv free of an absolute
    // path a test would have to normalise.
    await git([
      'clone', '--quiet', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--template=',
      ...(resolved.ref === undefined ? [] : ['--branch', resolved.ref]),
      resolved.url, '.',
    ])
  } else {
    await git(['init', '--quiet', '--template=', '.'])
    await git(['remote', 'add', 'origin', resolved.url])
    try {
      await git(['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', resolved.sha])
      await git(['checkout', '--quiet', '--detach', '--force', 'FETCH_HEAD'])
    } catch (error) {
      // A server that will not serve one commit by name is a configuration we
      // cannot change from here, so pay for the history instead of failing.
      // Not retried when git is absent or the clock has run out: neither gets
      // better on a second attempt, and retrying a timeout doubles the wait.
      const code = error instanceof MarketError ? error.code : ''
      if (code === 'ERR_MARKET_GIT_MISSING' || code === 'ERR_MARKET_GIT_TIMEOUT') throw error
      await git(['fetch', '--quiet', '--no-tags', 'origin', ...(resolved.ref === undefined ? [] : [resolved.ref])])
      await git(['checkout', '--quiet', '--detach', '--force', resolved.sha])
    }
  }

  const head = (await git(['rev-parse', 'HEAD'])).trim().toLowerCase()
  if (!OBJECT_ID.test(head)) {
    throw new MarketError(`market: git did not report a commit for HEAD: ${JSON.stringify(head)}`, 'ERR_MARKET_GIT_HEAD')
  }
  if (resolved.sha !== undefined && head !== resolved.sha) {
    // The whole reason the sha path exists. Refusing here is what stops a
    // fallback, a redirected remote or a rewritten ref from installing a
    // different commit under the pinned one's name.
    throw new MarketError(
      `market: asked for ${resolved.sha} but checked out ${head}`,
      'ERR_MARKET_GIT_SHA_MISMATCH',
    )
  }

  // We want the tree, not a working repository. `.git` left behind is a remote
  // and a set of credentials-adjacent config sitting inside plugin content,
  // and it invites some later tool to make a network call from a directory
  // that is supposed to be inert. Removed after the verification, because the
  // verification is the last thing that needs it.
  rmSync(join(dest, '.git'), { recursive: true, force: true })
  if (resolved.path !== undefined) promoteSubdirectory(dest, resolved.path)
  return { url: resolved.url, ref: resolved.ref, sha: head }
}

/**
 * Make one directory inside the checkout the whole of it.
 *
 * The caller asked for a plugin, not for the repository that carries it, and
 * everything downstream — the kind gate, the install path, the skill walk —
 * treats `dest` as the plugin root. Doing this here rather than downstream
 * keeps `git-subdir` a fact about the transport, so nothing after this point
 * has to know a plugin can arrive as part of a larger tree.
 *
 * The move is done by rename into a sibling and back, not by copying: it is one
 * directory entry each way, so a large repository costs nothing extra, and the
 * old tree is deleted only after the wanted subtree is already out of it.
 * @param {string} dest - the checkout, which becomes the subtree.
 * @param {string} path - posix-form subdirectory, already validated.
 * @throws {MarketError} when the path is not a real directory in the checkout.
 */
function promoteSubdirectory(dest, path) {
  const inner = join(dest, ...path.split('/'))
  // `lstat`, so a symlink is seen as a symlink. Clones run with
  // `core.symlinks=false`, which writes a link as a plain file holding its
  // target text and makes an escape unrepresentable rather than merely
  // unlikely — this is the assertion that the setting held.
  let stats
  try {
    stats = lstatSync(inner)
  } catch {
    throw new MarketError(`market: the repository has no ${path}`, 'ERR_MARKET_GIT_PATH')
  }
  if (!stats.isDirectory()) {
    throw new MarketError(`market: ${path} is not a directory in the repository`, 'ERR_MARKET_GIT_PATH')
  }
  const held = `${dest}.subdir`
  rmSync(held, { recursive: true, force: true })
  renameSync(inner, held)
  rmSync(dest, { recursive: true, force: true })
  renameSync(held, dest)
}
