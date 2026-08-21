/**
 * Walking the Claude-plugin install root.
 *
 * The layout is the entire contract with `@dsh-desktop/market` — the two
 * packages do not import each other — so these tests build real directories on
 * disk and read them, rather than mocking a filesystem. A plugin a user
 * unzipped in by hand has to work exactly as well as one the marketplace
 * installed, and the only way to test that claim is to write the bytes.
 *
 * The other half of the job is being TOTAL. A broken plugin must cost its
 * owner and nobody else: a throw out of `list()` is caught by the registry as
 * `skill provider "..." skipped`, which drops every skill the walk found. So
 * each malformed shape below is asserted to yield an `errors` entry AND to
 * leave its neighbours intact.
 *
 * The YAML parser is injected, which is why it is a stub here for the
 * structural cases: `discover.js` deliberately does not import `yaml`, because
 * `yaml` lives in the staged tree and importing it would make this file need a
 * staged harness. The last block runs the real staged parser when there is
 * one, and asserts its absence when there is not.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the claude-plugins package
import { discoverPlugins, readEntry, splitFrontmatter } from '../../packages/claude-plugins/lib/discover.js'

interface FoundEntry {
  kind: 'skill' | 'command'
  plugin: { id: string; source: string; name: string; version: string; root: string; title?: string }
  slug: string
  path: string
  directory: string
  frontmatter: Record<string, unknown>
  body: string
}

interface Discovery {
  plugins: { id: string; source: string; name: string; version: string; root: string; title?: string }[]
  entries: FoundEntry[]
  superseded: { id: string; version: string }[]
  errors: { path: string; message: string }[]
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The `node` condition of yaml's exports map, which is the file the sidecar
// itself loads. Reached by path rather than by specifier because this file
// resolves from the repo root, where `yaml` is not a dependency at all.
const stagedYaml = join(repoRoot, 'build', 'harness', 'node_modules', 'yaml', 'dist', 'index.js')

/**
 * A deliberately tiny YAML stand-in: flat `key: value`, `key: [a, b]`, `key:`.
 *
 * Enough for the shapes these tests need, and small enough that a failure here
 * is a failure of the walk rather than of a parser. The real parser is
 * exercised in the staged block at the bottom.
 * @param text - the frontmatter block.
 * @returns the parsed mapping.
 */
const stubYaml = (text: string): unknown => {
  if (text.includes('\t')) throw new Error('tabs are not allowed in YAML indentation')
  const data: Record<string, unknown> = {}
  for (const line of text.split('\n')) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 0) throw new Error(`unparseable line: ${line}`)
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    if (raw.length === 0) data[key] = null
    else if (raw === 'true' || raw === 'false') data[key] = raw === 'true'
    else if (raw.startsWith('[')) data[key] = raw.slice(1, -1).split(',').map((part) => part.trim()).filter((part) => part.length > 0)
    else data[key] = raw.replace(/^["']|["']$/g, '')
  }
  return data
}

const roots: string[] = []

/** @returns a fresh, empty install root that is cleaned up after the run. */
const newRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-claude-plugins-'))
  roots.push(root)
  return root
}

/**
 * Write one file, creating its directories.
 * @param path - absolute file path.
 * @param content - the bytes.
 */
const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/**
 * Give a plugin a manifest declaring its version, unless it already has one.
 *
 * The version is not a path level — a plugin's tree IS its directory — so this
 * is the only place a version can come from. Written only when absent, so a
 * test that authors its own manifest keeps it.
 * @param root - the install root.
 * @param at - source and plugin name.
 * @param version - what the manifest should declare.
 */
const declareVersion = (root: string, at: { source: string; plugin: string }, version: string | undefined): void => {
  if (version === undefined) return
  const path = join(root, at.source, at.plugin, '.claude-plugin', 'plugin.json')
  if (!existsSync(path)) write(path, JSON.stringify({ version }))
}

/**
 * Write one skill into a plugin.
 * @param root - the install root.
 * @param at - source / plugin / skill slug, and the version to declare.
 * @param content - the SKILL.md text.
 */
const writeSkill = (root: string, at: { source: string; plugin: string; version?: string; slug: string }, content: string): void => {
  write(join(root, at.source, at.plugin, 'skills', at.slug, 'SKILL.md'), content)
  declareVersion(root, at, at.version)
}

/**
 * Write one command into a plugin.
 * @param root - the install root.
 * @param at - source / plugin / command path under commands/, and the version.
 * @param content - the markdown text.
 */
const writeCommand = (root: string, at: { source: string; plugin: string; version?: string; slug: string }, content: string): void => {
  write(join(root, at.source, at.plugin, 'commands', `${at.slug}.md`), content)
  declareVersion(root, at, at.version)
}

const skillFile = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\nThe ${name} body.\n`

const walk = async (root: string, parseYaml: (text: string) => unknown = stubYaml): Promise<Discovery> =>
  await discoverPlugins(root, { parseYaml }) as Discovery

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('splitFrontmatter', () => {
  it('splits on the two fence lines', () => {
    expect(splitFrontmatter('---\nname: a\n---\nbody\n')).toEqual({ yaml: 'name: a\n', body: 'body\n' })
  })

  it('tolerates CRLF, because a file written on Windows still has to load', () => {
    // Upstream's own parser strips a trailing \r from the fence lines; this
    // one matches it exactly so a SKILL.md cannot be readable by one provider
    // and invisible to the other.
    expect(splitFrontmatter('---\r\nname: a\r\n---\r\nbody\r\n')).toEqual({ yaml: 'name: a\r\n', body: 'body\r\n' })
  })

  it('answers undefined when there is no frontmatter to find', () => {
    for (const raw of ['', 'no fences here', '# Title\n\nbody', '--\nname: a\n--\n', '---\nname: a\nbody with no closing fence']) {
      expect(splitFrontmatter(raw), JSON.stringify(raw)).toBeUndefined()
    }
  })

  it('handles an empty frontmatter block and an empty body', () => {
    expect(splitFrontmatter('---\n---\n')).toEqual({ yaml: '', body: '' })
    expect(splitFrontmatter('---\nname: a\n---')).toEqual({ yaml: 'name: a\n', body: '' })
  })

  it('closes on the FIRST fence line, not the last', () => {
    const split = splitFrontmatter('---\nname: a\n---\nbody\n---\nmore\n')
    expect(split?.yaml).toBe('name: a\n')
    expect(split?.body).toBe('body\n---\nmore\n')
  })
})

describe('discoverPlugins', () => {
  it('answers empty for a root that does not exist', async () => {
    // A fresh profile has no install root at all; that is the normal case, not
    // a fault, so it must not produce an error the UI would show.
    const result = await walk(join(newRoot(), 'never-created'))
    expect(result).toEqual({ plugins: [], entries: [], errors: [] })
  })

  it('reads source / name / version / skills / SKILL.md', async () => {
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'open the thing'))
    const result = await walk(root)

    expect(result.errors).toEqual([])
    // No manifest was written, so there is no version and no title to report:
    // a plugin is its files, and the manifest is a label on top of them.
    expect(result.plugins).toEqual([{
      id: 'acme/notes', source: 'acme', name: 'notes', version: '',
      root: join(root, 'acme', 'notes'),
    }])
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      kind: 'skill',
      slug: 'access',
      frontmatter: { name: 'access', description: 'open the thing' },
      body: 'The access body.',
      path: join(root, 'acme', 'notes', 'skills', 'access', 'SKILL.md'),
      directory: join(root, 'acme', 'notes', 'skills', 'access'),
    })
  })

  it('points the resource base at the skill directory, not the file', async () => {
    // This is what makes a real Claude plugin work unmodified: references/,
    // scripts/ and assets/ sit beside SKILL.md and are reached relative to it.
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'x'))
    write(join(root, 'acme', 'notes', 'skills', 'access', 'references', 'guide.md'), 'guide')
    const [entry] = (await walk(root)).entries
    expect(existsSync(join(entry!.directory, 'references', 'guide.md'))).toBe(true)
  })

  it('reads commands, including the ones Claude namespaces by subdirectory', async () => {
    const root = newRoot()
    writeCommand(root, { source: 'acme', plugin: 'notes', slug: 'tidy' }, '---\ndescription: tidy up\n---\nTidy it.\n')
    writeCommand(root, { source: 'acme', plugin: 'notes', slug: join('git', 'sync') }, '---\ndescription: sync\n---\nSync it.\n')
    const result = await walk(root)

    expect(result.errors).toEqual([])
    expect(result.entries.map((entry) => entry.slug).sort()).toEqual(['git/sync', 'tidy'])
    for (const entry of result.entries) expect(entry.kind).toBe('command')
  })

  it('accepts a command with no frontmatter at all', async () => {
    // Claude makes a command's frontmatter optional, so this is a real shape.
    // policy.js is what synthesizes the description the harness insists on.
    const root = newRoot()
    writeCommand(root, { source: 'acme', plugin: 'notes', slug: 'tidy' }, '# Tidy\n\nTidy the tree.\n')
    const result = await walk(root)
    expect(result.errors).toEqual([])
    expect(result.entries[0]).toMatchObject({ kind: 'command', frontmatter: {}, body: '# Tidy\n\nTidy the tree.' })
  })

  it('reads the plugin title from .claude-plugin/plugin.json when it is there', async () => {
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'x'))
    write(join(root, 'acme', 'notes', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Acme Notes' }))
    expect((await walk(root)).plugins[0]?.title).toBe('Acme Notes')
  })

  it('yields the skills anyway when the manifest is missing or broken', async () => {
    // The DIRECTORY LAYOUT is the contract, not the manifest. A hand-copied
    // plugin whose plugin.json never existed must not be a second-class one.
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'nomanifest', slug: 'access' }, skillFile('access', 'x'))
    writeSkill(root, { source: 'acme', plugin: 'badmanifest', slug: 'browse' }, skillFile('browse', 'x'))
    write(join(root, 'acme', 'badmanifest', '.claude-plugin', 'plugin.json'), '{ not json')
    const result = await walk(root)

    expect(result.entries.map((entry) => entry.slug).sort()).toEqual(['access', 'browse'])
    expect(result.plugins.every((plugin) => plugin.title === undefined)).toBe(true)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('not valid JSON')
  })
})

describe('discoverPlugins: staying total', () => {
  it('keeps the good plugins when one has invalid YAML', async () => {
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'good', slug: 'access' }, skillFile('access', 'x'))
    writeSkill(root, { source: 'acme', plugin: 'bad', slug: 'broken' }, '---\n\tname: broken\n---\nbody\n')
    const result = await walk(root)

    expect(result.entries.map((entry) => entry.slug)).toEqual(['access'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('invalid YAML frontmatter')
  })

  it('reports a SKILL.md with no frontmatter, and keeps going', async () => {
    const root = newRoot()
    write(join(root, 'acme', 'notes', 'skills', 'bare', 'SKILL.md'), '# Bare\n\nNo frontmatter.\n')
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'x'))
    const result = await walk(root)

    expect(result.entries.map((entry) => entry.slug)).toEqual(['access'])
    expect(result.errors[0]?.message).toContain('no YAML frontmatter')
  })

  it('reports a skill directory with no SKILL.md in it', async () => {
    const root = newRoot()
    mkdirSync(join(root, 'acme', 'notes', 'skills', 'empty'), { recursive: true })
    const result = await walk(root)
    expect(result.entries).toEqual([])
    expect(result.errors[0]?.message).toContain('is missing')
  })

  it('reports frontmatter that is not a mapping', async () => {
    const root = newRoot()
    write(join(root, 'acme', 'notes', 'skills', 'listy', 'SKILL.md'), '---\nname: a\n---\nbody\n')
    const result = await walk(root, () => ['not', 'a', 'mapping'])
    expect(result.entries).toEqual([])
    expect(result.errors[0]?.message).toContain('not a mapping')
  })

  it('takes an empty plugin directory as a plugin with nothing in it', async () => {
    // There is no version level to be missing any more: a plugin's tree IS its
    // directory. An empty one is a plugin that publishes nothing, which is odd
    // but not an error the UI should shout about — the install that made it is
    // what would have failed loudly.
    const root = newRoot()
    mkdirSync(join(root, 'acme', 'notes'), { recursive: true })
    const result = await walk(root)
    expect(result.plugins.map((p) => p.id)).toEqual(['acme/notes'])
    expect(result.entries).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('does not treat an absent skills/ or commands/ as a fault', async () => {
    // Most plugins ship one of the two, so the absence of the other is the
    // ordinary case and must not fill the UI with errors.
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'skillsonly', slug: 'access' }, skillFile('access', 'x'))
    writeCommand(root, { source: 'acme', plugin: 'commandsonly', slug: 'tidy' }, '---\ndescription: x\n---\nTidy.\n')
    const result = await walk(root)
    expect(result.errors).toEqual([])
    expect(result.entries).toHaveLength(2)
  })
})

describe('discoverPlugins: the version level', () => {
  it('takes the version from the manifest, not from anywhere on the path', async () => {
    // With no version level there is nothing to pick between, and no chance of
    // the directory name and the manifest disagreeing about what is installed.
    // Build metadata rides through untouched — it never reaches a path rule.
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'x'))
    write(join(root, 'acme', 'notes', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'notes', version: '1.10.0+g6927fc3' }))
    const result = await walk(root)

    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]?.version).toBe('1.10.0+g6927fc3')
    expect(result.entries).toHaveLength(1)
  })

  it('honours a version pick supplied by the caller', async () => {
    const root = newRoot()
    for (const version of ['1.0.0', '2.0.0']) {
      writeSkill(root, { source: 'acme', plugin: 'notes', version, slug: 'access' }, skillFile('access', `v${version}`))
    }
    const result = await discoverPlugins(root, { parseYaml: stubYaml, selectVersion: () => '1.0.0' }) as Discovery
    expect(result.plugins[0]?.version).toBe('1.0.0')
  })
})

describe('discoverPlugins: what it refuses to look at', () => {
  it('skips dot-prefixed directories at every layout level', async () => {
    // This is where a half-written install lives: the marketplace unpacks into
    // a mkdtemp-named sibling and renames it into place, so publishing skills
    // out of one mid-write would be a race with no error.
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'x'))
    writeSkill(root, { source: '.market-tmp', plugin: 'notes', slug: 'half' }, skillFile('half', 'x'))
    writeSkill(root, { source: 'acme', plugin: '.half', slug: 'half' }, skillFile('half', 'x'))
    const result = await walk(root)

    expect(result.entries.map((entry) => entry.slug)).toEqual(['access'])
    expect(result.errors).toEqual([])
  })

  it('ignores loose files where a directory belongs', async () => {
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'x'))
    write(join(root, 'README.md'), 'not a source')
    write(join(root, 'acme', 'notes', 'skills', 'loose.md'), skillFile('loose', 'x'))
    const result = await walk(root)

    expect(result.entries.map((entry) => entry.slug)).toEqual(['access'])
    expect(result.errors).toEqual([])
  })

  it('ignores non-markdown files under commands/', async () => {
    const root = newRoot()
    writeCommand(root, { source: 'acme', plugin: 'notes', slug: 'tidy' }, '---\ndescription: x\n---\nTidy.\n')
    write(join(root, 'acme', 'notes', 'commands', 'helper.sh'), '#!/bin/sh\n')
    expect((await walk(root)).entries.map((entry) => entry.slug)).toEqual(['tidy'])
  })

  it('caps how deep the commands walk goes', async () => {
    const root = newRoot()
    writeCommand(root, { source: 'acme', plugin: 'notes', slug: join('a', 'b', 'c', 'd', 'e', 'deep') }, '---\ndescription: x\n---\nDeep.\n')
    const result = await walk(root)
    expect(result.entries).toEqual([])
    expect(result.errors[0]?.message).toContain('nested deeper than')
  })
})

describe('readEntry', () => {
  it('re-reads and re-parses one file, which is how get() re-checks a candidate', async () => {
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'first'))
    const [listed] = (await walk(root)).entries
    expect(listed?.frontmatter.description).toBe('first')

    // The file changes after listing. get() must see the new bytes, because
    // that is the only thing standing between a skill that gained an
    // allowed-tools line and one that is loaded wide anyway.
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'second'))
    const reread = await readEntry(listed!, { parseYaml: stubYaml }) as { entry?: FoundEntry; errors: { message: string }[] }
    expect(reread.entry?.frontmatter.description).toBe('second')
  })

  it('answers with no entry when the file has since gone', async () => {
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, skillFile('access', 'x'))
    const [listed] = (await walk(root)).entries
    rmSync(listed!.path)
    const reread = await readEntry(listed!, { parseYaml: stubYaml }) as { entry?: FoundEntry }
    expect(reread.entry).toBeUndefined()
  })
})

describe('against the staged harness', () => {
  it('parses a real SKILL.md with the yaml the app actually ships', async () => {
    if (!existsSync(stagedYaml)) {
      // No staged tree: assert the absence rather than skip, so a staged tree
      // whose yaml has moved fails here instead of quietly passing. `yaml` is
      // hoisted from @deepseek-ai/dsh-skill-filesystem rather than declared by
      // this repo, so its top-level presence is exactly the kind of coupling
      // AGENTS.md says a green build must not be read as proof of.
      expect(existsSync(stagedYaml)).toBe(false)
      return
    }
    // A CommonJS module, so the named export may only be on `default`.
    const loaded = await import(pathToFileURL(stagedYaml).href) as { parse?: (text: string) => unknown; default?: { parse: (text: string) => unknown } }
    const parse = loaded.parse ?? loaded.default?.parse
    expect(typeof parse).toBe('function')
    const root = newRoot()
    writeSkill(root, { source: 'acme', plugin: 'notes', slug: 'access' }, [
      '---',
      'name: access',
      'description: >-',
      '  A folded description that spans',
      '  two source lines.',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      'disable-model-invocation: true',
      'metadata:',
      '  author: someone',
      '---',
      '',
      'The body.',
      '',
    ].join('\n'))

    const result = await walk(root, parse!)
    expect(result.errors).toEqual([])
    expect(result.entries[0]?.frontmatter).toMatchObject({
      name: 'access',
      description: 'A folded description that spans two source lines.',
      'allowed-tools': ['Read', 'Bash'],
      'disable-model-invocation': true,
      metadata: { author: 'someone' },
    })
    expect(result.entries[0]?.body).toBe('The body.')
  })
})
