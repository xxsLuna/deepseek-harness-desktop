// @ts-check
/**
 * The rules for turning Claude Code plugin content into harness skills.
 *
 * Everything here is pure. It takes already-parsed frontmatter and bodies and
 * returns candidates and refusals; it never reads the disk, and it imports no
 * upstream package. That is deliberate on both counts — CLAUDE.md asks for
 * pure, testable functions wherever there is a rule, and keeping every
 * `@deepseek-ai/*` import in `index.js` means these rules can be unit-tested
 * with no staged harness present.
 *
 * Three rules live here. Each one exists because the alternative fails
 * silently, which is the failure class this repo cares about most:
 *
 * 1. **Collision.** Two plugins can ship the same skill name — `access` and
 *    `configure` really do collide across shipped Claude plugins. Upstream
 *    resolves a same-name duplicate inside one registry layer by keeping the
 *    lowest rank and logging `skill "x" ... ignored because a higher-priority
 *    skill already exists` to the harness log, which no user reads. So the
 *    loser is renamed here instead, and the rename is reported so the UI can
 *    say what happened.
 *
 * 2. **`allowed-tools`.** A Claude skill may declare which tools it is allowed
 *    to use. The harness has no counterpart — `SkillDefinition` carries name,
 *    description, invocation, content and metadata, and nothing else — so a
 *    skill written against a five-tool allowlist would run with the agent's
 *    entire toolset. Widening a skill's access without saying so is the exact
 *    failure this rule exists to prevent, so such a skill is withheld from the
 *    candidate list with a machine-readable reason rather than published wider
 *    than its author wrote it.
 *
 * 3. **Argument substitution.** Claude commands interpolate `$ARGUMENTS`,
 *    `$1`..`$9`, `` !`cmd` `` and `@file` before the body reaches the model.
 *    The harness does no substitution at all: `renderSkillContent` embeds the
 *    body verbatim. Those tokens would therefore land in the prompt as literal
 *    text, and a command that half-works is worse than one that is absent,
 *    because the user cannot tell which they have. Refused, with the forms
 *    found.
 *
 * @module @dsh-desktop/claude-plugins/policy
 */

/**
 * Upstream's skill-name grammar, `@deepseek-ai/dsh-skill`'s `SKILL_NAME`.
 *
 * Copied rather than imported so this module stays free of upstream: the unit
 * suite cross-checks it against the staged `isSkillName` when a staged tree is
 * present, so a grammar change upstream fails by name there instead of at a
 * user's first boot. Note there is no `:` in it — namespacing a colliding
 * skill by prefix is the only option the grammar leaves.
 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * The rank every candidate from this provider carries.
 *
 * Upstream's ranks are LOWER-wins (`compareIndexedCandidates` subtracts, and
 * the doc comment on `SkillCandidate.rank` says so). The first-party ladder in
 * `@deepseek-ai/dsh-skill-filesystem` runs project-dsh 100, project-agents 200,
 * runtime 250, custom 300, user-dsh 400, user-agents 500, bundled 600. Sitting
 * above all of them means a marketplace plugin can never shadow a first-party
 * skill of the same name — it loses the tie and is renamed instead. The
 * direction is worth stating because it is the counter-intuitive one: a HIGHER
 * number here is LESS trusted.
 *
 * Rank only decides duplicates within one registry layer; across layers the
 * nearest layer wins outright. This provider registers into the global layer,
 * so a preset-scoped first-party skill already beats it regardless of rank.
 */
export const CLAUDE_PLUGIN_RANK = 700

/** The `SkillSource` bucket every candidate from this provider reports. */
export const CLAUDE_PLUGIN_SOURCE = 'claude-plugin'

/** Longest synthesized command description. Upstream truncates its catalog too. */
const MAX_SYNTHESIZED_DESCRIPTION = 200

/**
 * Frontmatter keys that declare a tool restriction the harness cannot honour.
 *
 * Both spellings of both directions: Claude's documented keys are kebab-case,
 * but camelCase copies exist in the wild and a skill that meant to be
 * restricted must not be published wide because its author typed the other
 * one. `disallowed-tools` is the same hole from the other side — the harness
 * would happily hand the skill the very tools it named.
 */
const TOOL_RESTRICTION_KEYS = ['allowed-tools', 'allowedTools', 'disallowed-tools', 'disallowedTools']

/**
 * @typedef {object} PluginRef
 * @property {string} id - `<source>/<name>`; stable across version bumps.
 * @property {string} source - the marketplace or source directory it arrived under.
 * @property {string} name - the plugin directory name.
 * @property {string} version - from `.claude-plugin/plugin.json`, or empty.
 * @property {string} root - absolute path of the plugin directory.
 * @property {string} [title] - display name from `.claude-plugin/plugin.json`, when it had one.
 */

/**
 * One markdown file discovery found, before any rule has been applied to it.
 * @typedef {object} FoundEntry
 * @property {'skill' | 'command'} kind - which directory it came out of.
 * @property {PluginRef} plugin - the plugin that ships it.
 * @property {string} slug - the skill directory name, or the command's path under `commands/` joined with `/`.
 * @property {string} path - absolute path of the markdown file.
 * @property {string} directory - directory that relative resources resolve against.
 * @property {Record<string, unknown>} frontmatter - the parsed YAML frontmatter.
 * @property {string} body - the markdown body, frontmatter already removed.
 */

/**
 * A candidate that passed every rule, in this provider's own shape.
 * @typedef {object} PolicySkill
 * @property {string} name - the final, in-grammar skill name.
 * @property {string} description - non-empty; upstream rejects a candidate without one.
 * @property {string} [whenToUse] - extra routing guidance, when the file carried it.
 * @property {{ modelInvocable: boolean, userInvocable: boolean }} invocation - resolved policy.
 * @property {number} rank - see {@link CLAUDE_PLUGIN_RANK}.
 * @property {'skill' | 'command'} kind - which directory it came out of.
 * @property {PluginRef} plugin - the plugin that ships it.
 * @property {string} slug - the skill directory name, or the command's path under `commands/`.
 * @property {string} path - absolute path of the markdown file.
 * @property {string} directory - resource base for relative references inside the body.
 * @property {Record<string, unknown>} metadata - the file's own metadata plus `claudePlugin` provenance.
 * @property {string} [renamedFrom] - the bare name it lost to a collision, when it was renamed.
 */

/**
 * A machine-readable reason one file did not become a candidate.
 * @typedef {object} PolicyRefusal
 * @property {'allowed-tools' | 'argument-substitution' | 'no-description' | 'unusable-name'} code - the rule that refused it.
 * @property {string} plugin - the plugin id, so the UI can group by plugin.
 * @property {'skill' | 'command'} kind - which directory it came out of.
 * @property {string} path - absolute path of the refused file.
 * @property {string} [name] - the name it would have been published under.
 * @property {string[]} [keys] - `allowed-tools`: the restriction keys actually present.
 * @property {Placeholder[]} [placeholders] - `argument-substitution`: the forms found.
 * @property {string} message - one sentence, already renderable.
 */

/**
 * One argument-substitution form found in a command body.
 * @typedef {object} Placeholder
 * @property {'arguments' | 'positional' | 'bash' | 'file'} form - which of the four.
 * @property {string} sample - the first literal occurrence, for the message.
 */

/**
 * Whether a name is one upstream will accept.
 * @param {string} name - candidate skill name.
 * @returns {boolean} whether it matches the grammar.
 */
export function isSkillName(name) {
  return SKILL_NAME.test(name)
}

/**
 * Force an arbitrary string into the skill-name grammar.
 *
 * Claude skill directories are kebab-case already, so this is usually the
 * identity. It is not decoration: `validateCandidate` THROWS on an
 * out-of-grammar name, and a throw from `list()` is caught one level up and
 * turned into `skill provider "..." skipped`, which drops EVERY skill this
 * provider found — one badly named directory would silently take the whole
 * marketplace offline. Normalizing is what keeps one bad file to itself.
 * @param {string} raw - the directory name or frontmatter name.
 * @returns {string | undefined} the normalized name, or undefined when nothing usable is left.
 */
export function normalizeSkillName(raw) {
  const name = raw
    .normalize('NFKD')
    .toLowerCase()
    // Anything outside the grammar becomes a separator rather than vanishing,
    // so `read_file` and `read file` do not both collapse onto `readfile`.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return name.length === 0 ? undefined : name
}

/**
 * Namespace a skill name by its plugin, for a collision loser.
 *
 * The grammar has no `:`, so a prefix is the only namespacing available. The
 * result is re-normalized rather than concatenated, because the plugin name is
 * a directory name and need not be in-grammar itself.
 * @param {string} pluginName - the plugin directory name.
 * @param {string} name - the already-normalized skill name.
 * @returns {string | undefined} the qualified name, or undefined when the plugin name yields nothing.
 */
export function qualifySkillName(pluginName, name) {
  const prefix = normalizeSkillName(pluginName)
  return prefix === undefined ? undefined : `${prefix}-${name}`
}

/**
 * Which tool-restriction keys a file declares.
 *
 * Presence of the key is the test, not its value: `allowed-tools:` with an
 * empty value still says "not the whole toolset", and publishing it anyway
 * would be exactly the silent widening this rule exists to stop. Erring toward
 * withholding is the safe direction — a withheld skill is visible in the UI
 * with its reason, whereas a wrongly widened one is invisible.
 * @param {Record<string, unknown>} frontmatter - the parsed frontmatter.
 * @returns {string[]} the restriction keys present, in a stable order.
 */
export function toolRestrictionKeys(frontmatter) {
  return TOOL_RESTRICTION_KEYS.filter((key) => Object.hasOwn(frontmatter, key))
}

/**
 * Which argument-substitution forms a command body contains.
 *
 * Fenced code blocks are NOT exempt: Claude substitutes inside them too, so a
 * token there is a real interpolation and not documentation of one.
 *
 * The `@file` probe is the only inexact one. A bare `@` followed by a word
 * matches far too much — `@media`, `@param`, an email address, a handle — so a
 * match must additionally look like a path: it must contain a `/`, or end in
 * something shaped like a file extension. That under-refuses a lone `@README`
 * and over-refuses almost nothing, and under-refusing is the direction to err
 * in for a rule whose false positives delete working commands.
 * @param {string} body - the command's markdown body.
 * @returns {Placeholder[]} one entry per form found, in a fixed order.
 */
export function argumentPlaceholders(body) {
  /** @type {Placeholder[]} */
  const found = []

  const args = /\$ARGUMENTS/.exec(body)
  if (args !== null) found.push({ form: 'arguments', sample: args[0] })

  // `$1`..`$9`. `$10` matches on its `$1` and is refused too, correctly: it is
  // still a positional the harness will not fill in.
  const positional = /\$[1-9]/.exec(body)
  if (positional !== null) found.push({ form: 'positional', sample: positional[0] })

  // Claude's pre-execution shell hook: !`command`. The backtick pair is what
  // distinguishes it from a plain exclamation mark.
  const bash = /!`[^`\n]*`/.exec(body)
  if (bash !== null) found.push({ form: 'bash', sample: bash[0] })

  const file = fileReference(body)
  if (file !== undefined) found.push({ form: 'file', sample: file })

  return found
}

/**
 * The one variable a Claude plugin may write into its own body.
 *
 * It exists because a plugin's files move: the same plugin lives under a
 * different absolute path on every machine, so a skill that ships a script can
 * only reference it relative to wherever the plugin landed. Every other
 * placeholder in these files is refused by `argumentPlaceholders` for being
 * something the harness cannot fill in; this one is the exception precisely
 * because we CAN fill it in, and know the value exactly.
 */
export const PLUGIN_ROOT_VARIABLE = 'CLAUDE_PLUGIN_ROOT'

/** `${CLAUDE_PLUGIN_ROOT}` and the bare `$CLAUDE_PLUGIN_ROOT`, not part of a longer name. */
const PLUGIN_ROOT_PATTERN = new RegExp(
  String.raw`\$\{${PLUGIN_ROOT_VARIABLE}\}|\$${PLUGIN_ROOT_VARIABLE}(?![A-Za-z0-9_])`,
  'g',
)

/**
 * Substitute the plugin root into a body.
 *
 * Done rather than refused, and done here rather than left to the model: an
 * unsubstituted `${CLAUDE_PLUGIN_ROOT}` reaches the prompt as literal text, and
 * a model that reads it will either invent a path or run the string as written.
 * Both are worse than the answer we already have.
 *
 * The value is inserted verbatim, in the platform's own separators, because
 * that is the path the shell actually needs. It is NOT quoted: the author
 * writes the quoting around the variable, exactly as they would in a shell, and
 * a quote added here would land inside theirs.
 * @param {string} body - the markdown body as written.
 * @param {string} root - absolute path of the plugin directory.
 * @returns {string} the body with every occurrence replaced.
 */
export function expandPluginRoot(body, root) {
  // `$&`, `$1` and friends are meaningful in a replacement string, and a
  // Windows path can hold anything; the function form takes the value as data.
  return body.replace(PLUGIN_ROOT_PATTERN, () => root)
}

/**
 * First `@path` file reference in a body, if any.
 * @param {string} body - the command's markdown body.
 * @returns {string | undefined} the literal occurrence, for the refusal message.
 */
function fileReference(body) {
  // Anchored on start-of-input or whitespace so `luna@example.com` — where a
  // word character precedes the `@` — is not a match.
  const pattern = /(?:^|\s)(@[^\s@]+)/g
  for (const match of body.matchAll(pattern)) {
    const token = match[1]
    if (token === undefined) continue
    const rest = token.slice(1)
    if (rest.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(rest)) return token
  }
  return undefined
}

/**
 * Apply every rule to a discovery result.
 *
 * The input is sorted into a total order first, so the names this returns are
 * a function of what is installed and nothing else. Directory read order is
 * not stable across platforms or filesystems, and a name that depended on it
 * would move between boots on the same machine.
 *
 * Skills are ordered before commands within one plugin because a `SKILL.md` is
 * the plugin's primary contribution and a `commands/*.md` its shorthand; when
 * one plugin ships both under one name, the skill is the one that should keep
 * the bare name.
 * @param {readonly FoundEntry[]} found - everything discovery could parse.
 * @param {{ rank?: number }} [options] - rank override; defaults to {@link CLAUDE_PLUGIN_RANK}.
 * @returns {{ skills: PolicySkill[], refused: PolicyRefusal[] }} the candidates, and why the rest are absent.
 */
export function planSkills(found, options = {}) {
  /** @type {PolicySkill[]} */
  const skills = []
  /** @type {PolicyRefusal[]} */
  const refused = []
  /** @type {Set<string>} */
  const taken = new Set()

  for (const entry of [...found].sort(compareFoundEntries)) {
    const planned = planEntry(entry, options)
    if (planned.ok === false) {
      refused.push(planned.refusal)
      continue
    }
    const bare = planned.skill.name
    const name = claim(taken, bare, entry.plugin.name)
    skills.push(name === bare ? planned.skill : {
      ...planned.skill,
      name,
      renamedFrom: bare,
      metadata: provenance(entry, bare),
    })
  }

  return { skills, refused }
}

/**
 * Apply every rule that concerns one file on its own.
 *
 * Collision is the one rule that is NOT here, because it is a fact about the
 * whole install set rather than about one file; `planSkills` layers it on top.
 * Splitting it out is what lets `get()` re-check a single skill against the
 * current bytes without re-walking the disk — the check that stops a file
 * which gained an `allowed-tools` line after listing from being loaded anyway.
 * @param {FoundEntry} entry - the parsed file.
 * @param {{ rank?: number }} [options] - rank override; defaults to {@link CLAUDE_PLUGIN_RANK}.
 * @returns {{ ok: true, skill: PolicySkill } | { ok: false, refusal: PolicyRefusal }} the candidate under its unqualified name, or why there is none.
 */
export function planEntry(entry, options = {}) {
  const refusal = refuse(entry)
  if (refusal !== undefined) return { ok: false, refusal }

  const name = normalizeSkillName(stringField(entry.frontmatter, 'name') ?? entry.slug)
  if (name === undefined) {
    return {
      ok: false,
      refusal: {
        code: 'unusable-name',
        plugin: entry.plugin.id,
        kind: entry.kind,
        path: entry.path,
        message: `"${entry.slug}" leaves no usable skill name once reduced to the harness grammar.`,
      },
    }
  }

  const description = describe(entry)
  if (description === undefined) {
    return {
      ok: false,
      refusal: {
        code: 'no-description',
        plugin: entry.plugin.id,
        kind: entry.kind,
        path: entry.path,
        name,
        message: `"${name}" declares no description, and the harness rejects a skill without one.`,
      },
    }
  }

  const whenToUse = stringField(entry.frontmatter, 'whenToUse')
  return {
    ok: true,
    skill: {
      name,
      description,
      ...whenToUse === undefined ? {} : { whenToUse },
      invocation: invocationOf(entry),
      rank: options.rank ?? CLAUDE_PLUGIN_RANK,
      kind: entry.kind,
      plugin: entry.plugin,
      slug: entry.slug,
      path: entry.path,
      directory: entry.directory,
      metadata: provenance(entry, undefined),
    },
  }
}

/**
 * Reserve a name, renaming around anything already taken.
 * @param {Set<string>} taken - names already claimed in this plan.
 * @param {string} bare - the name this entry would prefer.
 * @param {string} pluginName - the plugin directory name, for the prefix.
 * @returns {string} the reserved name.
 */
function claim(taken, bare, pluginName) {
  const qualified = qualifySkillName(pluginName, bare)
  for (const candidate of [bare, qualified]) {
    if (candidate === undefined || taken.has(candidate)) continue
    taken.add(candidate)
    return candidate
  }
  // Two plugins whose names normalize the same, or a plugin whose own name
  // already appears as another plugin's prefix, both reach here. A numeric
  // tail keeps the result inside the grammar (digits are legal segments) and
  // terminates, which a second prefix would not.
  const base = qualified ?? bare
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (taken.has(candidate)) continue
    taken.add(candidate)
    return candidate
  }
}

/**
 * Apply the two withholding rules.
 * @param {FoundEntry} entry - the parsed file.
 * @returns {PolicyRefusal | undefined} the reason, or undefined when it passes.
 */
function refuse(entry) {
  const keys = toolRestrictionKeys(entry.frontmatter)
  if (keys.length > 0) {
    return {
      code: 'allowed-tools',
      plugin: entry.plugin.id,
      kind: entry.kind,
      path: entry.path,
      name: entry.slug,
      keys,
      message: `"${entry.slug}" declares ${keys.join(' and ')}, which the harness cannot enforce; publishing it would run it with the agent's whole toolset.`,
    }
  }

  // Skills are prose the model reads and acts on through its own tools; only a
  // command is interpolated before it is sent, so only a command can be broken
  // by the absence of interpolation.
  if (entry.kind !== 'command') return undefined
  const placeholders = argumentPlaceholders(entry.body)
  if (placeholders.length === 0) return undefined
  return {
    code: 'argument-substitution',
    plugin: entry.plugin.id,
    kind: entry.kind,
    path: entry.path,
    name: entry.slug,
    placeholders,
    message: `"${entry.slug}" uses ${placeholders.map((placeholder) => placeholder.sample).join(', ')}, which the harness does not substitute; it would reach the model as literal text.`,
  }
}

/**
 * The description a candidate publishes.
 *
 * A skill must carry its own — that is Claude's format, and upstream's
 * filesystem provider drops a skill without one too. A command's frontmatter
 * description is optional in Claude, so the first line of the body stands in:
 * the harness makes description mandatory, and a command with a usable body
 * and no frontmatter at all is a real and common shape.
 * @param {FoundEntry} entry - the parsed file.
 * @returns {string | undefined} the description, or undefined when there is none to be had.
 */
function describe(entry) {
  const declared = stringField(entry.frontmatter, 'description')
  if (declared !== undefined) return declared
  if (entry.kind !== 'command') return undefined
  for (const line of entry.body.split('\n')) {
    const text = line.replace(/^#+\s*/, '').trim()
    if (text.length === 0) continue
    return text.length > MAX_SYNTHESIZED_DESCRIPTION
      ? `${text.slice(0, MAX_SYNTHESIZED_DESCRIPTION - 1).trimEnd()}…`
      : text
  }
  return undefined
}

/**
 * Resolve the invocation policy.
 *
 * A command becomes a user-invocable, non-model-invocable skill: that is what
 * a slash command IS. Leaving it model-invocable would put every command into
 * the model's catalog, where it competes with the skills that were written to
 * be chosen automatically.
 *
 * A skill reads Claude's own frontmatter keys, coerced the way upstream's
 * `frontmatterBoolean` coerces them, so a SKILL.md that behaves one way under
 * the filesystem provider behaves the same way here.
 * @param {FoundEntry} entry - the parsed file.
 * @returns {{ modelInvocable: boolean, userInvocable: boolean }} the resolved policy.
 */
function invocationOf(entry) {
  if (entry.kind === 'command') return { modelInvocable: false, userInvocable: true }
  return {
    modelInvocable: frontmatterBoolean(entry.frontmatter, 'disable-model-invocation') !== true,
    userInvocable: frontmatterBoolean(entry.frontmatter, 'user-invocable') !== false,
  }
}

/**
 * The provenance a candidate carries.
 *
 * Namespaced under one `claudePlugin` key and written LAST, so a plugin's own
 * `metadata:` block cannot overwrite the record of where it came from.
 * @param {FoundEntry} entry - the parsed file.
 * @param {string | undefined} renamedFrom - the bare name it lost, when it was renamed.
 * @returns {Record<string, unknown>} the metadata object.
 */
function provenance(entry, renamedFrom) {
  const own = entry.frontmatter.metadata
  const base = typeof own === 'object' && own !== null && !Array.isArray(own)
    ? /** @type {Record<string, unknown>} */ ({ ...own })
    : {}
  return {
    ...base,
    claudePlugin: {
      id: entry.plugin.id,
      source: entry.plugin.source,
      name: entry.plugin.name,
      version: entry.plugin.version,
      kind: entry.kind,
      slug: entry.slug,
      ...renamedFrom === undefined ? {} : { renamedFrom },
    },
  }
}

/**
 * Total order over discovered entries, so naming is reproducible.
 * @param {FoundEntry} left - one entry.
 * @param {FoundEntry} right - the other.
 * @returns {number} negative, zero or positive.
 */
function compareFoundEntries(left, right) {
  return compareText(left.plugin.id, right.plugin.id)
    || compareText(kindOrder(left.kind), kindOrder(right.kind))
    || compareText(left.slug, right.slug)
}

/**
 * Sort key placing skills before commands.
 * @param {'skill' | 'command'} kind - the entry kind.
 * @returns {string} the sort key.
 */
function kindOrder(kind) {
  return kind === 'skill' ? '0' : '1'
}

/**
 * Compare by code point, matching upstream's own catalog ordering.
 * @param {string} left - one string.
 * @param {string} right - the other.
 * @returns {number} negative, zero or positive.
 */
function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Read a non-empty string field, the way upstream's `stringField` does.
 * @param {Record<string, unknown>} data - the parsed frontmatter.
 * @param {string} key - the field name.
 * @returns {string | undefined} the value, or undefined when absent or empty.
 */
function stringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Coerce a frontmatter boolean the way upstream's `frontmatterBoolean` does.
 *
 * Matched deliberately, including the `yes`/`on`/`1` spellings: a SKILL.md
 * moved between the two providers must not change meaning. Upstream throws on
 * an uncoercible value and drops the whole file; here it reads as absent,
 * because the safe default for both keys is the permissive one the harness
 * already applies when the key is missing.
 * @param {Record<string, unknown>} data - the parsed frontmatter.
 * @param {string} key - the field name.
 * @returns {boolean | undefined} the value, or undefined when absent or uncoercible.
 */
function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value !== 'string') return undefined
  switch (value.toLowerCase()) {
    case 'true': case 'yes': case 'on': return true
    case 'false': case 'no': case 'off': return false
    default: return undefined
  }
}
