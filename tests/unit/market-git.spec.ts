/**
 * The marketplace's git transport.
 *
 * Two halves, and they check different things. The injected-runner half pins
 * the exact argv, because every safety property of this module is a flag: drop
 * `--template=` and a clone runs a hook, drop the sha route and a pin installs
 * whatever the branch tip happens to be. The real-repository half exists
 * because a fake runner agreeing with a wrong argv proves nothing — it clones
 * a repository made with `git init`, over `file://`, with no network at all,
 * and it proves the hook defence by first showing the hook running when the
 * flag is absent.
 *
 * The failure paths are here for the same reason as `market-fetch.spec.ts`'s:
 * each one fails silently if the rule is wrong. A sha that was asked for and
 * not got still produces a working plugin directory — of different code.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import { MarketError } from '../../packages/market/lib/fetch.js'
// @ts-expect-error — plain JS module shipped inside the market package
import { DEFAULT_TIMEOUT_MS, GIT_SAFETY_ARGS, fetchGit, resolveGitSource } from '../../packages/market/lib/git.js'

/** A commit id the fake runner reports for HEAD. */
const SHA = 'deadbeef'.repeat(5)

/** A different one, for the mismatch that must never pass. */
const OTHER_SHA = 'abadcafe'.repeat(5)

const temporary: string[] = []

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

/** A scratch directory that is cleaned up afterwards. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-market-git-${prefix}-`))
  temporary.push(dir)
  return dir
}

interface Call { args: string[], cwd: string, timeoutMs: number }

/** A runner that records what it was asked to run and answers with a script. */
function recorder(reply: (args: string[]) => string = () => ''): { calls: Call[], run: (args: string[], options: { cwd: string, timeoutMs: number }) => Promise<string> } {
  const calls: Call[] = []
  return {
    calls,
    run: async (args, options) => {
      calls.push({ args, cwd: options.cwd, timeoutMs: options.timeoutMs })
      // Every route ends in `rev-parse HEAD`, and a checkout that reports no
      // commit is its own refusal, so the default answer is a plausible one.
      return args[args.length - 1] === 'HEAD' ? `${SHA}\n` : reply(args)
    },
  }
}

/** The subcommand of a recorded invocation, past the leading `-c` pairs. */
const subcommand = (call: Call): string => call.args[GIT_SAFETY_ARGS.length] ?? ''

/**
 * The `code` a refusal carried, or why there was none.
 *
 * Refusals are asserted on the code rather than the message throughout: the
 * module says the code is the stable part, and a test that pins the wording
 * makes rewording a message look like a regression.
 */
function refusal(act: () => unknown): string {
  try {
    act()
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code'
  }
  return 'no refusal'
}

describe('resolveGitSource', () => {
  it('turns a github repo into a clone URL', () => {
    expect(resolveGitSource({ source: 'github', repo: 'anthropics/claude-code' }))
      .toEqual({ url: 'https://github.com/anthropics/claude-code.git', ref: undefined, sha: undefined })
    // `.git` is appended only when absent — `name.git.git` is a 404.
    expect(resolveGitSource({ source: 'github', repo: 'acme/tool.git' }).url)
      .toBe('https://github.com/acme/tool.git')
  })

  it('takes a url source as written, under both spellings', () => {
    const url = 'https://gitlab.example/team/plugin.git'
    expect(resolveGitSource({ source: 'url', url }).url).toBe(url)
    expect(resolveGitSource({ source: 'git', url }).url).toBe(url)
  })

  it('carries the ref and lowercases the sha', () => {
    // Lowercased so the HEAD verification is a plain comparison against what
    // `rev-parse` prints, which is always lowercase.
    const resolved = resolveGitSource({ source: 'github', repo: 'acme/tool', ref: 'v2.0.0', sha: SHA.toUpperCase() })
    expect(resolved).toEqual({ url: 'https://github.com/acme/tool.git', ref: 'v2.0.0', sha: SHA })
  })

  it('refuses a descriptor that is not a git source', () => {
    for (const source of [undefined, null, 42, 'github', [], {}, { source: 'npm' }, { source: 'archive' }]) {
      expect(refusal(() => resolveGitSource(source)), JSON.stringify(source)).toBe('ERR_MARKET_GIT_SOURCE')
    }
  })

  it('refuses a github repo that is not owner/name', () => {
    // The repo goes straight into a URL path, so `..` and an extra segment are
    // how a fetch is pointed somewhere else on the forge.
    for (const repo of [
      '..', '../evil', 'owner', 'owner/', '/name', 'owner/name/extra', '.hidden/x', 'a b/c',
      'owner/../../evil', 'https://evil/x', '', 42,
    ]) {
      expect(refusal(() => resolveGitSource({ source: 'github', repo })), String(repo)).toBe('ERR_MARKET_GIT_SOURCE')
    }
  })

  it('refuses every scheme but https and file', () => {
    // `git:` is plaintext, `ssh:` reaches a different credential path than the
    // helper this module is built around, and `ext::` is a command line.
    for (const url of [
      'http://gitlab.example/team/plugin.git',
      'git://gitlab.example/team/plugin.git',
      'ssh://git@gitlab.example/team/plugin.git',
      'ext::sh -c whoami',
      'git@github.com:acme/tool.git',
      '/srv/git/plugin.git',
      'C:\\repos\\plugin',
      '', 42, undefined,
    ]) {
      expect(refusal(() => resolveGitSource({ source: 'url', url })), String(url)).toBe('ERR_MARKET_GIT_URL')
    }
    expect(resolveGitSource({ source: 'url', url: 'file:///srv/git/plugin' }).url).toBe('file:///srv/git/plugin')
  })

  it('refuses credentials embedded in the URL', () => {
    // A secret in every log line that quotes the source, and the
    // `good.com@evil.com` trick besides. The credential helper is the path.
    expect(refusal(() => resolveGitSource({ source: 'url', url: 'https://user:token@gitlab.example/t/p.git' })))
      .toBe('ERR_MARKET_GIT_URL')
  })

  it('refuses a ref git itself would refuse, and one that is an option', () => {
    // A leading `-` matters: the fallback route passes a ref as a plain
    // `fetch` argument, where an option is exactly what it would become.
    for (const ref of [
      '-f', '--upload-pack=whoami', 'a..b', 'a//b', 'refs/heads/', '.hidden', 'x.lock',
      'has space', 'a\\b', 'a^b', 'a:b', 'a~1', 'x'.repeat(256), 42,
    ]) {
      expect(refusal(() => resolveGitSource({ source: 'github', repo: 'a/b', ref })), String(ref))
        .toBe('ERR_MARKET_GIT_REF')
    }
    expect(resolveGitSource({ source: 'github', repo: 'a/b', ref: 'feature/x-1.0' }).ref).toBe('feature/x-1.0')
  })

  it('refuses anything that is not a full object name', () => {
    // An abbreviation cannot be compared against `rev-parse HEAD` without
    // deciding how many characters are enough, and the answer to that keeps
    // changing. A full name is unambiguous.
    for (const sha of ['deadbeef', 'z'.repeat(40), `${SHA}0`, SHA.slice(1), 'HEAD', '', 42]) {
      expect(refusal(() => resolveGitSource({ source: 'github', repo: 'a/b', sha })), String(sha))
        .toBe('ERR_MARKET_GIT_SHA')
    }
    // The sha-256 object format is a real thing and is 64 characters.
    expect(resolveGitSource({ source: 'github', repo: 'a/b', sha: 'ab'.repeat(32) }).sha).toBe('ab'.repeat(32))
  })
})

describe('resolveGitSource: git-subdir', () => {
  it('accepts either spelling of the repository, with the path', () => {
    expect(resolveGitSource({ source: 'git-subdir', repo: 'owner/many', path: 'plugins/one' }))
      .toEqual({ url: 'https://github.com/owner/many.git', ref: undefined, sha: undefined, path: 'plugins/one' })
    expect(resolveGitSource({ source: 'git-subdir', url: 'https://h/many.git', path: 'p', ref: 'main' }))
      .toEqual({ url: 'https://h/many.git', ref: 'main', sha: undefined, path: 'p' })
  })

  it('refuses a path on a source that installs the whole repository', () => {
    // Ignoring it would install everything under a row that described one
    // directory — the publisher is wrong either way, but only one of the two
    // ways puts unreviewed files on a user's disk.
    expect(refusal(() => resolveGitSource({ source: 'github', repo: 'owner/many', path: 'plugins/one' })))
      .toBe('ERR_MARKET_GIT_PATH')
  })

  it('refuses a git-subdir with no path, and paths that could climb out', () => {
    const cases: unknown[] = [
      { source: 'git-subdir', repo: 'owner/many' },
      { source: 'git-subdir', repo: 'owner/many', path: '' },
      { source: 'git-subdir', repo: 'owner/many', path: '../out' },
      { source: 'git-subdir', repo: 'owner/many', path: '/etc' },
      { source: 'git-subdir', repo: 'owner/many', path: 'a/../../b' },
      { source: 'git-subdir', repo: 'owner/many', path: `a${String.fromCharCode(92)}b` },
      { source: 'git-subdir', repo: 'owner/many', path: 42 },
    ]
    for (const one of cases) {
      expect(refusal(() => resolveGitSource(one)), JSON.stringify(one)).toBe('ERR_MARKET_GIT_PATH')
    }
  })

  it('drops a trailing slash rather than refusing it', () => {
    // The one repair, because a trailing separator changes nothing about which
    // directory is named and refusing it would be pedantry with a real cost.
    expect(resolveGitSource({ source: 'git-subdir', repo: 'o/m', path: 'plugins/one/' }).path)
      .toBe('plugins/one')
  })
})

describe('fetchGit argv', () => {
  it('shallow-clones the default branch and reads HEAD back', async () => {
    const dest = scratch('argv')
    const { calls, run } = recorder()
    const result = await fetchGit({ source: 'url', url: 'https://gitlab.example/t/p.git' }, dest, { run })
    expect(calls.map((c) => c.args)).toEqual([
      [...GIT_SAFETY_ARGS, 'clone', '--quiet', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--template=',
        'https://gitlab.example/t/p.git', '.'],
      [...GIT_SAFETY_ARGS, 'rev-parse', 'HEAD'],
    ])
    // `.` as the destination, because the runner already runs there.
    expect(calls.every((c) => c.cwd === dest)).toBe(true)
    expect(result).toEqual({ url: 'https://gitlab.example/t/p.git', ref: undefined, sha: SHA })
  })

  it('passes a ref as --branch', async () => {
    const dest = scratch('branch')
    const { calls, run } = recorder()
    await fetchGit({ source: 'github', repo: 'acme/tool', ref: 'v2.0.0' }, dest, { run })
    expect(calls[0].args).toContain('--branch')
    expect(calls[0].args[calls[0].args.indexOf('--branch') + 1]).toBe('v2.0.0')
  })

  it('carries the safety configuration on every single invocation', async () => {
    // Each of these is a way a checkout of untrusted content runs a command,
    // so "on most invocations" is not a property worth having.
    const dest = scratch('safety')
    const { calls, run } = recorder()
    await fetchGit({ source: 'github', repo: 'acme/tool', sha: SHA }, dest, { run })
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) expect(call.args.slice(0, GIT_SAFETY_ARGS.length)).toEqual([...GIT_SAFETY_ARGS])
    expect(GIT_SAFETY_ARGS).toContain('core.hooksPath=.git/no-hooks')
    expect(GIT_SAFETY_ARGS).toContain('core.symlinks=false')
    expect(GIT_SAFETY_ARGS).toContain('protocol.ext.allow=never')
    // Left at git's default of `user`, which is what closed CVE-2022-39253 for
    // submodules; forcing it to `always` would reopen it.
    expect(GIT_SAFETY_ARGS.join(' ')).not.toContain('protocol.file.allow')
  })

  it('fetches one exact commit rather than cloning a branch, when a sha is given', async () => {
    // A shallow clone of a branch holds that branch's tip and nothing else, so
    // checking out an arbitrary commit afterwards fails: the object is not
    // there. `fetch --depth 1 origin <sha>` asks the server for that one commit.
    const dest = scratch('sha')
    const { calls, run } = recorder()
    const result = await fetchGit({ source: 'github', repo: 'acme/tool', sha: SHA }, dest, { run })
    expect(calls.map((c) => c.args.slice(GIT_SAFETY_ARGS.length))).toEqual([
      ['init', '--quiet', '--template=', '.'],
      ['remote', 'add', 'origin', 'https://github.com/acme/tool.git'],
      ['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', SHA],
      ['checkout', '--quiet', '--detach', '--force', 'FETCH_HEAD'],
      ['rev-parse', 'HEAD'],
    ])
    expect(result.sha).toBe(SHA)
  })

  it('lets the sha override the ref entirely', async () => {
    // The catalog names both; only one of them identifies code.
    const dest = scratch('override')
    const { calls, run } = recorder()
    const result = await fetchGit({ source: 'github', repo: 'acme/tool', ref: 'main', sha: SHA }, dest, { run })
    expect(calls.map(subcommand)).toEqual(['init', 'remote', 'fetch', 'checkout', 'rev-parse'])
    expect(calls.some((c) => c.args.includes('--branch'))).toBe(false)
    expect(result.ref).toBe('main')
    expect(result.sha).toBe(SHA)
  })

  it('pays for the history when a server will not serve one commit by name', async () => {
    // `uploadpack.allowReachableSHA1InWant` is off in stock git, so a
    // self-hosted remote can refuse the shallow form. Failing there would make
    // pinned plugins uninstallable from exactly those hosts.
    const dest = scratch('fallback')
    const { calls, run } = recorder((args) => {
      if (args.includes('--depth')) throw new Error('upload-pack: not our ref')
      return ''
    })
    await fetchGit({ source: 'github', repo: 'acme/tool', ref: 'main', sha: SHA }, dest, { run })
    expect(calls.map((c) => c.args.slice(GIT_SAFETY_ARGS.length))).toEqual([
      ['init', '--quiet', '--template=', '.'],
      ['remote', 'add', 'origin', 'https://github.com/acme/tool.git'],
      ['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', SHA],
      ['fetch', '--quiet', '--no-tags', 'origin', 'main'],
      // The commit by name, not FETCH_HEAD: the ref's tip is not what we want.
      ['checkout', '--quiet', '--detach', '--force', SHA],
      ['rev-parse', 'HEAD'],
    ])
  })

  it('deletes the .git directory, leaving a tree and not a repository', async () => {
    const dest = scratch('dotgit')
    mkdirSync(join(dest, '.git', 'objects'), { recursive: true })
    writeFileSync(join(dest, '.git', 'config'), '[remote "origin"]\n')
    const { run } = recorder()
    await fetchGit({ source: 'github', repo: 'acme/tool' }, dest, { run })
    expect(existsSync(join(dest, '.git'))).toBe(false)
  })
})

describe('fetchGit refusals', () => {
  it('refuses when HEAD is not the commit that was asked for', async () => {
    // The whole reason the sha route exists. A fallback, a redirected remote or
    // a rewritten ref must not be able to install different code under a
    // pinned commit's name.
    const dest = scratch('mismatch')
    const run = async (args: string[]): Promise<string> => (args[args.length - 1] === 'HEAD' ? `${OTHER_SHA}\n` : '')
    await expect(fetchGit({ source: 'github', repo: 'acme/tool', sha: SHA }, dest, { run }))
      .rejects.toMatchObject({ code: 'ERR_MARKET_GIT_SHA_MISMATCH' })
  })

  it('refuses when git reports no commit at all', async () => {
    const dest = scratch('nohead')
    const run = async (): Promise<string> => 'HEAD\n'
    await expect(fetchGit({ source: 'github', repo: 'acme/tool' }, dest, { run }))
      .rejects.toMatchObject({ code: 'ERR_MARKET_GIT_HEAD' })
  })

  it('bounds the whole operation, not each command', async () => {
    // One budget shared across every invocation, so a source that stalls after
    // `init` cannot buy itself a fresh timeout at each step.
    const dest = scratch('budget')
    const { calls, run } = recorder()
    const slow = async (args: string[], options: { cwd: string, timeoutMs: number }): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return await run(args, options)
    }
    await fetchGit({ source: 'github', repo: 'acme/tool', sha: SHA }, dest, { run: slow, timeoutMs: 5_000 })
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(5_000)
    expect(calls[calls.length - 1].timeoutMs).toBeLessThan(calls[0].timeoutMs)
  })

  it('refuses cleanly once the budget is gone', async () => {
    const dest = scratch('spent')
    const { calls, run } = recorder()
    await expect(fetchGit({ source: 'github', repo: 'acme/tool' }, dest, { run, timeoutMs: 0 }))
      .rejects.toMatchObject({ code: 'ERR_MARKET_GIT_TIMEOUT' })
    expect(calls).toEqual([])
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('does not retry the fallback for a failure a retry cannot fix', async () => {
    // Retrying a timeout doubles the wait, and a missing binary does not
    // appear on the second attempt.
    for (const code of ['ERR_MARKET_GIT_TIMEOUT', 'ERR_MARKET_GIT_MISSING']) {
      const dest = scratch('noretry')
      const calls: string[][] = []
      const run = async (args: string[]): Promise<string> => {
        calls.push(args)
        if (!args.includes('--depth')) return args[args.length - 1] === 'HEAD' ? `${SHA}\n` : ''
        throw new MarketError('stop', code)
      }
      await expect(fetchGit({ source: 'github', repo: 'acme/tool', ref: 'main', sha: SHA }, dest, { run }))
        .rejects.toMatchObject({ code })
      expect(calls.filter((args) => args.includes('fetch')), code).toHaveLength(1)
    }
  })

  it('names a missing git rather than throwing a raw ENOENT', async () => {
    // A GUI launch inherits no login-shell PATH — the defect src/login-path.ts
    // exists to fix — so "git is not installed" is a state real users reach,
    // and `spawn git ENOENT` tells them nothing about what to do.
    const dest = scratch('nogit')
    const path = process.env.PATH
    process.env.PATH = scratch('emptypath')
    try {
      await expect(fetchGit({ source: 'url', url: 'https://gitlab.example/t/p.git' }, dest))
        .rejects.toMatchObject({ code: 'ERR_MARKET_GIT_MISSING', message: /only archive sources/ })
    } finally {
      process.env.PATH = path
    }
  })
})

const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

it('has git on PATH, so the real-clone tests below can run', () => {
  // Not a silent skip: a skipped clone test is indistinguishable from a passing
  // one in exactly the situation it exists for.
  expect(hasGit).toBe(true)
})

const withGit = hasGit ? describe : describe.skip

withGit('a real repository', () => {
  /** Run git in a fixture, with the developer's own identity and signing kept out of it. */
  const git = (args: string[], cwd: string): string =>
    execFileSync('git', ['-c', 'user.email=t@example', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  // A repository with two commits, the first of them tagged, so a ref and a
  // sha select visibly different trees.
  const origin = scratch('origin')
  git(['init', '--quiet', '--initial-branch=main', '.'], origin)
  writeFileSync(join(origin, 'a.txt'), 'hello\n')
  mkdirSync(join(origin, 'sub'))
  writeFileSync(join(origin, 'sub', 'b.txt'), 'two\n')
  git(['add', '-A'], origin)
  git(['commit', '--quiet', '-m', 'one'], origin)
  git(['tag', 'v1.0.0'], origin)
  const first = git(['rev-parse', 'HEAD'], origin).trim()
  writeFileSync(join(origin, 'c.txt'), 'later\n')
  git(['add', '-A'], origin)
  git(['commit', '--quiet', '-m', 'two'], origin)
  const second = git(['rev-parse', 'HEAD'], origin).trim()
  const url = pathToFileURL(origin).href

  // A template directory whose post-checkout hook writes a file. Git installs a
  // template's hooks into every repository it creates, and GIT_TEMPLATE_DIR is
  // one of the three places that directory can come from.
  const template = scratch('template')
  mkdirSync(join(template, 'hooks'))
  const hook = join(template, 'hooks', 'post-checkout')
  writeFileSync(hook, '#!/bin/sh\necho PWNED > "$(git rev-parse --show-toplevel)/pwned.txt"\n')
  chmodSync(hook, 0o755)

  it('clones the default branch and leaves a tree, not a repository', async () => {
    const dest = join(scratch('clone'), 'tree')
    const result = await fetchGit({ source: 'url', url }, dest)
    expect(result).toEqual({ url, ref: undefined, sha: second })
    expect(readdirSync(dest).sort()).toEqual(['a.txt', 'c.txt', 'sub'])
    expect(existsSync(join(dest, '.git'))).toBe(false)
    // The bytes that were committed. Git for Windows defaults core.autocrlf on,
    // which would hand a plugin's shell script back with CRLF and break it at
    // the shebang, naming neither git nor us in the error.
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('promotes a git-subdir path so the plugin, not the repository, is the tree', async () => {
    // The whole reason the type exists: one repository, many plugins. What
    // lands must be the subdirectory's own contents at the root, with the rest
    // of the repository gone — anything else and the kind gate, the install
    // path and the skill walk are all looking one level too high.
    const dest = join(scratch('subdir'), 'tree')
    const result = await fetchGit({ source: 'git-subdir', url, path: 'sub' }, dest)
    expect(result.sha).toBe(second)
    expect(readdirSync(dest).sort()).toEqual(['b.txt'])
    expect(readFileSync(join(dest, 'b.txt'), 'utf8')).toBe('two\n')
    expect(existsSync(join(dest, 'a.txt'))).toBe(false)
    expect(existsSync(`${dest}.subdir`), 'the holding directory was left behind').toBe(false)
  })

  it('leaves a neighbour named after the checkout alone', async () => {
    // The promotion used to move the subtree through `${dest}.subdir` and
    // delete that path first. A real directory already sitting there — a plugin
    // literally called `<something>.subdir`, or any scratch dir a caller keeps
    // beside its checkouts — was destroyed. The holding directory is an
    // mkdtemp now, which cannot name something that already exists.
    const base = scratch('neighbour')
    const bystander = join(base, 'tree.subdir')
    mkdirSync(bystander, { recursive: true })
    writeFileSync(join(bystander, 'IMPORTANT.txt'), 'not ours\n')

    const dest = join(base, 'tree')
    await fetchGit({ source: 'git-subdir', url, path: 'sub' }, dest)

    expect(readdirSync(dest).sort()).toEqual(['b.txt'])
    expect(existsSync(join(bystander, 'IMPORTANT.txt')), 'the neighbour was deleted').toBe(true)
  })

  it('promotes correctly when the destination carries a trailing separator', async () => {
    // `${dest}.subdir` on a path ending in a separator names a child INSIDE the
    // checkout, so the holding directory was deleted along with the tree it was
    // holding and the final rename failed ENOENT — losing everything. The path
    // is resolved before anything is derived from it now.
    const base = scratch('trailing')
    mkdirSync(base, { recursive: true })
    const dest = join(base, 'tree')
    await fetchGit({ source: 'git-subdir', url, path: 'sub' }, `${dest}${sep}`)

    expect(readdirSync(dest).sort()).toEqual(['b.txt'])
    // No holding directory survives beside it.
    expect(readdirSync(base).sort()).toEqual(['tree'])
  })

  it('refuses a git-subdir path the repository does not have', async () => {
    // Named rather than installed empty: an empty plugin directory would fail
    // the kind gate with "neither a Claude nor a dsh plugin", which points the
    // publisher at the wrong problem entirely.
    const dest = join(scratch('nosubdir'), 'tree')
    const failure = await fetchGit({ source: 'git-subdir', url, path: 'nope' }, dest)
      .then(() => undefined, (error: MarketError) => error)
    expect(failure?.code).toBe('ERR_MARKET_GIT_PATH')
    expect(failure?.message).toContain('nope')
  })

  it('refuses a git-subdir path that is a file', async () => {
    const dest = join(scratch('filesubdir'), 'tree')
    const failure = await fetchGit({ source: 'git-subdir', url, path: 'a.txt' }, dest)
      .then(() => undefined, (error: MarketError) => error)
    expect(failure?.code).toBe('ERR_MARKET_GIT_PATH')
  })

  it('checks out the ref it was given', async () => {
    const dest = join(scratch('reftree'), 'tree')
    const result = await fetchGit({ source: 'url', url, ref: 'v1.0.0' }, dest)
    expect(result.sha).toBe(first)
    expect(readdirSync(dest).sort()).toEqual(['a.txt', 'sub'])
  })

  it('fetches the exact commit a sha names, over the ref beside it', async () => {
    // `main` is the second commit; the sha names the first. A shallow clone of
    // main could not produce this tree at all, which is why the sha takes a
    // different route.
    const dest = join(scratch('shatree'), 'tree')
    const result = await fetchGit({ source: 'url', url, ref: 'main', sha: first }, dest)
    expect(result.sha).toBe(first)
    expect(readdirSync(dest).sort()).toEqual(['a.txt', 'sub'])
  })

  it('refuses a commit the repository does not have', async () => {
    const dest = join(scratch('missing'), 'tree')
    await expect(fetchGit({ source: 'url', url, sha: '0'.repeat(40) }, dest))
      .rejects.toMatchObject({ code: 'ERR_MARKET_GIT_FAILED' })
  })

  it('runs no hook, where an unguarded clone runs one', async () => {
    const before = process.env.GIT_TEMPLATE_DIR
    process.env.GIT_TEMPLATE_DIR = template
    try {
      // The control: this is what a clone does without the flags, and without
      // it a green test below would only prove the hook never worked.
      const control = join(scratch('hooked'), 'tree')
      mkdirSync(control, { recursive: true })
      execFileSync('git', ['clone', '--quiet', '--depth', '1', url, '.'], { cwd: control, stdio: 'ignore' })
      expect(readdirSync(control)).toContain('pwned.txt')

      const dest = join(scratch('unhooked'), 'tree')
      await fetchGit({ source: 'url', url }, dest)
      expect(readdirSync(dest)).not.toContain('pwned.txt')
    } finally {
      if (before === undefined) delete process.env.GIT_TEMPLATE_DIR
      else process.env.GIT_TEMPLATE_DIR = before
    }
  })
})
