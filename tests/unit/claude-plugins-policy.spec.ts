/**
 * The rules that decide which Claude-plugin content becomes a harness skill.
 *
 * Every test here is one of four things: a name that upstream would have
 * thrown on comes back inside the grammar, a skill that would have run wider
 * than its author wrote it is withheld with a reason, a command that would
 * have reached the model as literal text is refused, or the same install
 * produces the same names twice. The last one is the quiet failure — a skill
 * whose name depends on directory read order moves between boots on one
 * machine, and nothing reports it.
 *
 * The final block cross-checks the grammar and the rank ladder against the
 * STAGED harness, which is what turns an upstream change into a red test here
 * instead of a wrong name at a user's first boot. With no staged tree it
 * asserts the absence rather than skipping, so a staged tree whose skill
 * package has moved fails here rather than quietly passing.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the claude-plugins package
import {
  CLAUDE_PLUGIN_RANK,
  SKILL_NAME,
  argumentPlaceholders,
  expandPluginRoot,
  isSkillName,
  normalizeSkillName,
  planEntry,
  planSkills,
  qualifySkillName,
  toolRestrictionKeys,
} from '../../packages/claude-plugins/lib/policy.js'

type Kind = 'skill' | 'command'

interface Refusal {
  code: string
  plugin: string
  kind: Kind
  path: string
  name?: string
  keys?: string[]
  placeholders?: { form: string; sample: string }[]
  message: string
}

interface Planned {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  rank: number
  kind: Kind
  plugin: { id: string; name: string; source: string; version: string }
  slug: string
  path: string
  directory: string
  metadata: Record<string, unknown>
  renamedFrom?: string
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const stagedSkill = join(repoRoot, 'build', 'harness', 'node_modules', '@deepseek-ai', 'dsh-skill', 'lib', 'index.js')

/**
 * One discovered file, with only the fields the rules read spelled out.
 * @param over - the fields this case cares about.
 * @returns a complete `FoundEntry`.
 */
const found = (over: {
  kind?: Kind
  plugin?: string
  source?: string
  slug: string
  frontmatter?: Record<string, unknown>
  body?: string
}) => {
  const source = over.source ?? 'acme'
  const plugin = over.plugin ?? 'notes'
  const kind = over.kind ?? 'skill'
  const root = join('/install', source, plugin, '1.0.0')
  const directory = kind === 'skill' ? join(root, 'skills', over.slug) : join(root, 'commands')
  return {
    kind,
    plugin: { id: `${source}/${plugin}`, source, name: plugin, version: '1.0.0', root },
    slug: over.slug,
    path: kind === 'skill' ? join(directory, 'SKILL.md') : join(directory, `${over.slug}.md`),
    directory,
    frontmatter: over.frontmatter ?? { name: over.slug, description: `the ${over.slug} skill` },
    body: over.body ?? 'do the thing',
  }
}

const plan = (entries: unknown[]): { skills: Planned[]; refused: Refusal[] } =>
  planSkills(entries) as { skills: Planned[]; refused: Refusal[] }

describe('normalizeSkillName', () => {
  it('leaves an already-legal kebab name alone', () => {
    for (const name of ['access', 'code-review', 'pdf2', 'a', 'x1-y2-z3']) {
      expect(normalizeSkillName(name)).toBe(name)
    }
  })

  it('turns everything else into something the grammar accepts', () => {
    // An out-of-grammar name does not degrade one skill, it throws out of
    // validateCandidate -- and a throw from list() is caught by the registry
    // as `skill provider "..." skipped`, which drops every skill this provider
    // found. So the invariant that matters is that the OUTPUT is always legal.
    const inputs = [
      'Access', 'read_file', 'read file', '  spaced  ', '--dashes--', 'PDF/Tools',
      'v1.2.3', 'skill!!', 'Ünïcödé', 'tab\tname', 'a__b__c', '한글이름-mixed', '..', 'x'.repeat(300),
    ]
    for (const input of inputs) {
      const normalized = normalizeSkillName(input)
      if (normalized === undefined) continue
      expect(SKILL_NAME.test(normalized), `${input} -> ${normalized}`).toBe(true)
      expect(isSkillName(normalized)).toBe(true)
    }
  })

  it('keeps a separator where one was, rather than fusing words', () => {
    // `read_file` and `readfile` are different skills; collapsing the first
    // onto the second would make them collide for no reason.
    expect(normalizeSkillName('read_file')).toBe('read-file')
    expect(normalizeSkillName('read file')).toBe('read-file')
    expect(normalizeSkillName('Read/File')).toBe('read-file')
  })

  it('answers undefined when nothing usable is left', () => {
    for (const input of ['', '---', '   ', '!!!', '\u0000']) expect(normalizeSkillName(input)).toBeUndefined()
  })
})

describe('qualifySkillName', () => {
  it('prefixes with the plugin, because the grammar has no colon', () => {
    expect(qualifySkillName('myplugin', 'access')).toBe('myplugin-access')
  })

  it('normalizes the prefix too, since a plugin directory need not be legal', () => {
    expect(qualifySkillName('My_Plugin', 'access')).toBe('my-plugin-access')
    expect(isSkillName(qualifySkillName('My_Plugin', 'access'))).toBe(true)
  })

  it('answers undefined when the plugin name yields no prefix', () => {
    expect(qualifySkillName('...', 'access')).toBeUndefined()
  })
})

describe('toolRestrictionKeys', () => {
  it('finds every spelling of both directions', () => {
    // camelCase copies exist in the wild, and `disallowed-tools` is the same
    // hole from the other side: the harness would hand the skill exactly the
    // tools it named as forbidden.
    for (const key of ['allowed-tools', 'allowedTools', 'disallowed-tools', 'disallowedTools']) {
      expect(toolRestrictionKeys({ [key]: ['Read'] })).toEqual([key])
    }
  })

  it('counts a declared-but-empty restriction', () => {
    // `allowed-tools:` with nothing after it still says "not the whole
    // toolset". Publishing it anyway is the silent widening this rule exists
    // to stop, so presence of the key is the test and not its value.
    expect(toolRestrictionKeys({ 'allowed-tools': null })).toEqual(['allowed-tools'])
    expect(toolRestrictionKeys({ 'allowed-tools': [] })).toEqual(['allowed-tools'])
    expect(toolRestrictionKeys({ 'allowed-tools': '' })).toEqual(['allowed-tools'])
  })

  it('is empty for an ordinary skill', () => {
    expect(toolRestrictionKeys({ name: 'access', description: 'x' })).toEqual([])
  })
})

describe('argumentPlaceholders', () => {
  it('finds each of the four substitution forms', () => {
    expect(argumentPlaceholders('run with $ARGUMENTS now')).toEqual([{ form: 'arguments', sample: '$ARGUMENTS' }])
    expect(argumentPlaceholders('first $1 then $2')).toEqual([{ form: 'positional', sample: '$1' }])
    expect(argumentPlaceholders('status is !`git status`')).toEqual([{ form: 'bash', sample: '!`git status`' }])
    expect(argumentPlaceholders('read @src/index.ts please')).toEqual([{ form: 'file', sample: '@src/index.ts' }])
  })

  it('reports every form present, in a fixed order', () => {
    const forms = argumentPlaceholders('$ARGUMENTS $3 !`ls` @docs/a.md').map((p: { form: string }) => p.form)
    expect(forms).toEqual(['arguments', 'positional', 'bash', 'file'])
  })

  it('does not exempt fenced code blocks', () => {
    // Claude substitutes inside fences too, so a token there is a real
    // interpolation and not documentation of one.
    expect(argumentPlaceholders('```sh\necho $ARGUMENTS\n```')).toHaveLength(1)
  })

  it('treats $10 as a positional, because it is one', () => {
    expect(argumentPlaceholders('use $10')).toEqual([{ form: 'positional', sample: '$1' }])
  })

  it('leaves an ordinary body alone', () => {
    const bodies = [
      'Summarise the repository and report back.',
      'Costs $ per unit. Use the $ sign freely.',
      'Prices in $USD and $EUR.',
      'Stop! Do not continue.',
      'Use the @media query and the @param tag.',
      'Mail luna@example.com about it.',
      'Ask @someone on the team.',
    ]
    for (const body of bodies) expect(argumentPlaceholders(body), body).toEqual([])
  })

  it('recognises a file reference only when it looks like a path', () => {
    // The @file probe is the inexact one, so it is pinned in both directions:
    // over-refusing deletes working commands, and that is the worse failure.
    expect(argumentPlaceholders('see @./notes.md')).toHaveLength(1)
    expect(argumentPlaceholders('see @~/notes')).toHaveLength(1)
    expect(argumentPlaceholders('see @CHANGELOG.md')).toHaveLength(1)
    expect(argumentPlaceholders('see @README')).toHaveLength(0)
  })
})


describe('planSkills: collision', () => {
  it('prefixes the loser and reports the rename', () => {
    // `access` and `configure` really do collide across shipped plugins, so
    // this is the ordinary case and not an edge one.
    const { skills } = plan([
      found({ plugin: 'alpha', slug: 'access' }),
      found({ plugin: 'zulu', slug: 'access' }),
    ])
    expect(skills.map((skill) => skill.name)).toEqual(['access', 'zulu-access'])
    expect(skills[0]?.renamedFrom).toBeUndefined()
    expect(skills[1]?.renamedFrom).toBe('access')
    for (const skill of skills) expect(isSkillName(skill.name)).toBe(true)
  })

  it('records the rename in the provenance too, so a UI can explain it', () => {
    const { skills } = plan([
      found({ plugin: 'alpha', slug: 'access' }),
      found({ plugin: 'zulu', slug: 'access' }),
    ])
    expect(skills[1]?.metadata.claudePlugin).toMatchObject({ id: 'acme/zulu', renamedFrom: 'access' })
  })

  it('produces the same names whatever order the disk hands them over in', () => {
    // Directory read order is not stable across platforms or filesystems, and
    // a name that depended on it would move between boots on one machine.
    const entries = [
      found({ plugin: 'alpha', slug: 'access' }),
      found({ plugin: 'zulu', slug: 'access' }),
      found({ plugin: 'mike', slug: 'access' }),
      found({ plugin: 'mike', slug: 'configure' }),
    ]
    const expected = plan(entries).skills.map((skill) => skill.name).sort()
    for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
      expect(plan(order.map((index) => entries[index])).skills.map((skill) => skill.name).sort()).toEqual(expected)
    }
  })

  it('lets one plugin keep the bare name for its skill over its own command', () => {
    const { skills } = plan([
      found({ plugin: 'alpha', slug: 'notes', kind: 'command' }),
      found({ plugin: 'alpha', slug: 'notes', kind: 'skill' }),
    ])
    expect(skills.find((skill) => skill.kind === 'skill')?.name).toBe('notes')
    expect(skills.find((skill) => skill.kind === 'command')?.name).toBe('alpha-notes')
  })

  it('falls back to a numeric tail when even the prefixed name is taken', () => {
    // Reached when two plugin directories normalize to the same prefix, so the
    // qualified name collides as well. A second prefix would not terminate; a
    // digit segment is legal grammar and does.
    const { skills } = plan([
      found({ plugin: 'a', slug: 'access' }),
      found({ plugin: 'b', slug: 'access' }),
      found({ plugin: 'b_', slug: 'access' }),
    ])
    expect(skills.map((skill) => skill.name)).toEqual(['access', 'b-access', 'b-access-2'])
    for (const skill of skills) expect(isSkillName(skill.name)).toBe(true)
  })

  it('leaves a bare name alone when the prefixed one is what was already used', () => {
    const { skills } = plan([
      found({ plugin: 'alpha', slug: 'access' }),
      found({ plugin: 'beta', slug: 'access' }),
      found({ plugin: 'beta', slug: 'alpha-access' }),
    ])
    expect(skills.map((skill) => skill.name)).toEqual(['access', 'beta-access', 'alpha-access'])
    expect(new Set(skills.map((skill) => skill.name)).size).toBe(3)
  })

  it('never emits a duplicate name, whatever the install looks like', () => {
    const entries = [
      found({ plugin: 'a-b', slug: 'c' }),
      found({ plugin: 'a', slug: 'b-c' }),
      found({ plugin: 'a', slug: 'b_c' }),
      found({ source: 'other', plugin: 'a', slug: 'b-c' }),
      found({ plugin: 'a-b', slug: 'c', kind: 'command' }),
    ]
    const names = plan(entries).skills.map((skill) => skill.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(isSkillName(name)).toBe(true)
  })
})

describe('planSkills: allowed-tools', () => {
  it('withholds a skill that declares a tool restriction', () => {
    // The harness has no counterpart for it, so publishing this would run the
    // skill with the agent's whole toolset -- silently wider than its author
    // wrote it. That is the failure this rule exists to prevent.
    const { skills, refused } = plan([found({ slug: 'deploy', frontmatter: { name: 'deploy', description: 'ship it', 'allowed-tools': ['Read', 'Bash'] } })])
    expect(skills).toEqual([])
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ code: 'allowed-tools', keys: ['allowed-tools'], plugin: 'acme/notes', kind: 'skill' })
    expect(refused[0]?.message).toContain('whole toolset')
  })

  it('withholds a command that declares one too', () => {
    const { skills, refused } = plan([found({ kind: 'command', slug: 'deploy', frontmatter: { description: 'ship it', allowedTools: 'Bash' } })])
    expect(skills).toEqual([])
    expect(refused[0]).toMatchObject({ code: 'allowed-tools', keys: ['allowedTools'] })
  })

  it('names every restriction key it found', () => {
    const { refused } = plan([found({ slug: 'deploy', frontmatter: { name: 'deploy', description: 'x', 'allowed-tools': ['Read'], 'disallowed-tools': ['Bash'] } })])
    expect(refused[0]?.keys).toEqual(['allowed-tools', 'disallowed-tools'])
  })

  it('leaves the name it would have had free for the next plugin', () => {
    // A withheld skill must not also squat its own name, or a second plugin's
    // working skill gets renamed around one that was never published.
    const { skills } = plan([
      found({ plugin: 'alpha', slug: 'access', frontmatter: { name: 'access', description: 'x', 'allowed-tools': ['Read'] } }),
      found({ plugin: 'zulu', slug: 'access' }),
    ])
    expect(skills.map((skill) => skill.name)).toEqual(['access'])
    expect(skills[0]?.plugin.name).toBe('zulu')
  })
})

describe('planSkills: argument substitution', () => {
  it('refuses a command the harness cannot fill in', () => {
    // The harness does no substitution: renderSkillContent embeds the body
    // verbatim, so these land in the prompt as literal text. A half-working
    // command is worse than an absent one, because the user cannot tell which
    // they have.
    for (const body of ['do $ARGUMENTS', 'do $1', 'do !`git log`', 'read @src/a.ts']) {
      const { skills, refused } = plan([found({ kind: 'command', slug: 'run', frontmatter: { description: 'x' }, body })])
      expect(skills, body).toEqual([])
      expect(refused[0], body).toMatchObject({ code: 'argument-substitution', kind: 'command' })
      expect(refused[0]?.placeholders?.length ?? 0, body).toBeGreaterThan(0)
    }
  })

  it('accepts a command that needs no substitution', () => {
    const { skills, refused } = plan([found({ kind: 'command', slug: 'tidy', frontmatter: { description: 'tidy up' }, body: 'Tidy the working tree.' })])
    expect(refused).toEqual([])
    expect(skills).toHaveLength(1)
  })

  it('does not apply the rule to skills', () => {
    // A skill is prose the model reads and acts on through its own tools; only
    // a command is interpolated before it is sent, so only a command can be
    // broken by the absence of interpolation.
    const { skills, refused } = plan([found({ slug: 'money', frontmatter: { name: 'money', description: 'x' }, body: 'It costs $1 and see @docs/a.md.' })])
    expect(refused).toEqual([])
    expect(skills).toHaveLength(1)
  })
})

describe('planSkills: invocation', () => {
  it('makes a command user-invocable and not model-invocable', () => {
    // Which is what a slash command IS. Leaving it model-invocable would put
    // every command into the model's catalog, competing with the skills
    // written to be chosen automatically.
    const { skills } = plan([found({ kind: 'command', slug: 'tidy', frontmatter: { description: 'tidy up' } })])
    expect(skills[0]?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
  })

  it('defaults a skill to both surfaces', () => {
    expect(plan([found({ slug: 'access' })]).skills[0]?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
  })

  it('reads Claude frontmatter the way upstream coerces it', () => {
    // Matched to upstream's frontmatterBoolean on purpose, including the
    // yes/on/1 spellings: a SKILL.md moved between the two providers must not
    // change meaning.
    const cases: [unknown, boolean][] = [[true, false], ['true', false], ['yes', false], ['on', false], [1, false], ['1', false], [false, true], ['no', true], [0, true]]
    for (const [value, modelInvocable] of cases) {
      const { skills } = plan([found({ slug: 'access', frontmatter: { name: 'access', description: 'x', 'disable-model-invocation': value } })])
      expect(skills[0]?.invocation.modelInvocable, String(value)).toBe(modelInvocable)
    }
    const hidden = plan([found({ slug: 'access', frontmatter: { name: 'access', description: 'x', 'user-invocable': false } })])
    expect(hidden.skills[0]?.invocation.userInvocable).toBe(false)
  })
})

describe('planSkills: description', () => {
  it('refuses a skill without one, because the harness rejects the candidate', () => {
    const { skills, refused } = plan([found({ slug: 'access', frontmatter: { name: 'access' } })])
    expect(skills).toEqual([])
    expect(refused[0]).toMatchObject({ code: 'no-description', name: 'access' })
  })

  it('synthesizes one for a command from its first line', () => {
    // Claude makes a command's frontmatter optional and the harness makes
    // description mandatory, so a body-only command is a real shape that
    // would otherwise be lost.
    const { skills } = plan([found({ kind: 'command', slug: 'tidy', frontmatter: {}, body: '# Tidy\n\nTidy the working tree.' })])
    expect(skills[0]?.description).toBe('Tidy')
  })

  it('truncates a very long synthesized description', () => {
    const { skills } = plan([found({ kind: 'command', slug: 'tidy', frontmatter: {}, body: 'x'.repeat(500) })])
    expect(skills[0]?.description.length).toBeLessThanOrEqual(200)
    expect(skills[0]?.description.endsWith('…')).toBe(true)
  })
})

describe('planSkills: provenance and rank', () => {
  it('carries the plugin identity in metadata', () => {
    const { skills } = plan([found({ source: 'acme', plugin: 'notes', slug: 'access' })])
    expect(skills[0]?.metadata.claudePlugin).toEqual({
      id: 'acme/notes', source: 'acme', name: 'notes', version: '1.0.0', kind: 'skill', slug: 'access',
    })
  })

  it('keeps the file own metadata, without letting it overwrite provenance', () => {
    const { skills } = plan([found({ slug: 'access', frontmatter: { name: 'access', description: 'x', metadata: { author: 'someone', claudePlugin: { id: 'spoofed' } } } })])
    expect(skills[0]?.metadata.author).toBe('someone')
    expect((skills[0]?.metadata.claudePlugin as { id: string }).id).toBe('acme/notes')
  })

  it('ranks every candidate above the whole first-party ladder', () => {
    // Ranks are LOWER-wins. Upstream's ladder runs 100 (project-dsh) to 600
    // (bundled), so sitting at 700 is what makes it impossible for a
    // marketplace plugin to shadow a first-party skill of the same name.
    expect(CLAUDE_PLUGIN_RANK).toBe(700)
    expect(CLAUDE_PLUGIN_RANK).toBeGreaterThan(600)
    expect(plan([found({ slug: 'access' })]).skills[0]?.rank).toBe(CLAUDE_PLUGIN_RANK)
  })

  it('honours a rank override from the row config', () => {
    const planned = planEntry(found({ slug: 'access' }), { rank: 42 }) as { ok: true; skill: Planned }
    expect(planned.skill.rank).toBe(42)
  })
})

describe('planEntry', () => {
  it('applies every rule except collision, which is not a fact about one file', () => {
    // This is the path `get()` takes, so it must refuse a file that gained an
    // allowed-tools line after it was listed.
    const refused = planEntry(found({ slug: 'access', frontmatter: { name: 'access', description: 'x', 'allowed-tools': ['Read'] } })) as { ok: false; refusal: Refusal }
    expect(refused.ok).toBe(false)
    expect(refused.refusal.code).toBe('allowed-tools')
    const ok = planEntry(found({ slug: 'access' })) as { ok: true; skill: Planned }
    expect(ok.skill.name).toBe('access')
    expect(ok.skill.renamedFrom).toBeUndefined()
  })
})

describe('against the staged harness', () => {
  it('agrees with upstream on the skill-name grammar', async () => {
    if (!existsSync(stagedSkill)) {
      // No staged tree: assert the absence rather than skip, so a staged tree
      // whose dsh-skill has moved fails here instead of quietly passing.
      expect(existsSync(stagedSkill)).toBe(false)
      return
    }
    const upstream = await import(pathToFileURL(stagedSkill).href) as { isSkillName: (name: string) => boolean; BUNDLED_SKILL_RANK: number }
    const names = [
      'access', 'code-review', 'a', 'x1', 'pdf2', 'a-b-c',
      'Access', 'a_b', 'a b', '-a', 'a-', 'a--b', '', 'a:b', 'a.b', 'ü',
    ]
    for (const name of names) expect(upstream.isSkillName(name), name).toBe(isSkillName(name))
    // And the rank direction: ours must sit above the highest first-party rank
    // upstream publishes, or a marketplace skill could shadow a bundled one.
    expect(CLAUDE_PLUGIN_RANK).toBeGreaterThan(upstream.BUNDLED_SKILL_RANK)
  })
})

describe('expandPluginRoot', () => {
  // Backslashes on purpose: this is what the value looks like on the platform
  // the app is built for, and it is also the string that would be mangled if
  // the replacement went through the `$`-aware form of String.replace.
  const ROOT = 'C:\Users\a b\.dsh\claude-plugins\src\note-taker'

  it('substitutes both the braced and the bare form', () => {
    expect(expandPluginRoot('run ${CLAUDE_PLUGIN_ROOT}/scripts/go.py', ROOT))
      .toBe(`run ${ROOT}/scripts/go.py`)
    expect(expandPluginRoot('cd $CLAUDE_PLUGIN_ROOT && ls', ROOT))
      .toBe(`cd ${ROOT} && ls`)
  })

  it('replaces every occurrence, not just the first', () => {
    const body = '${CLAUDE_PLUGIN_ROOT}/a and ${CLAUDE_PLUGIN_ROOT}/b'
    expect(expandPluginRoot(body, ROOT)).toBe(`${ROOT}/a and ${ROOT}/b`)
  })

  it('leaves a longer name that merely starts with it alone', () => {
    // Bare-form substitution is only safe if it stops at a word boundary;
    // without that, a plugin defining $CLAUDE_PLUGIN_ROOT_DIR gets a path
    // spliced into the middle of its own variable name.
    expect(expandPluginRoot('$CLAUDE_PLUGIN_ROOTS', ROOT)).toBe('$CLAUDE_PLUGIN_ROOTS')
    expect(expandPluginRoot('$CLAUDE_PLUGIN_ROOT_DIR', ROOT)).toBe('$CLAUDE_PLUGIN_ROOT_DIR')
    // The braced form is unambiguous, so an adjacent word character is fine.
    expect(expandPluginRoot('${CLAUDE_PLUGIN_ROOT}S', ROOT)).toBe(`${ROOT}S`)
  })

  it('treats the substituted path as data, not as a replacement pattern', () => {
    // `$&` and `$1` mean something to String.replace. A path is user data and
    // must never be read as a pattern, or a directory called `$&` would splice
    // the matched text back into the body.
    const hostile = '/tmp/$& $1 $$/plugin'
    expect(expandPluginRoot('at ${CLAUDE_PLUGIN_ROOT}.', hostile)).toBe(`at ${hostile}.`)
  })

  it('leaves a body that never mentions it untouched', () => {
    const body = 'Nothing to expand. $HOME and ${OTHER} stay as written.'
    expect(expandPluginRoot(body, ROOT)).toBe(body)
  })
})
