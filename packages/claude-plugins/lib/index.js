// @ts-check
/**
 * @dsh-desktop/claude-plugins — Claude Code plugins already on disk, exposed to
 * the harness as skills.
 *
 * It installs nothing and downloads nothing. `@dsh-desktop/market` is what
 * fetches and unpacks a plugin, and the two packages deliberately do not
 * import each other: the contract between them is the on-disk layout
 *
 * ```
 * $DSH_HOME/claude-plugins/<source>/<name>/<version>/
 *     .claude-plugin/plugin.json
 *     skills/<skill-name>/SKILL.md      (+ references/ scripts/ assets/ beside it)
 *     commands/*.md
 * ```
 *
 * and nothing else. That is the whole reason this stands alone rather than
 * living inside the marketplace: **a plugin a user copied in by hand must work
 * exactly as well as one the marketplace installed.** The moment discovery
 * knows how the bytes arrived, the hand-copied case becomes the second-class
 * one that nobody tests, and it is the case a user reaches for first.
 *
 * That the harness can host these at all is measured, not assumed: the
 * harness's skill format IS Claude's skill format. A real Claude plugin's
 * `skills/` directory mounted unmodified produced four working skills —
 * `<root>/<name>/SKILL.md`, YAML frontmatter, sibling `references/`,
 * `scripts/` and `assets/` reachable through `resourceBase`.
 *
 * The seam is `ctx.skills.registerProvider`, NOT the filesystem provider's
 * `customSkillDirs`. That option is read once in
 * `dsh-skill-filesystem`'s constructor, so pointing it at this root would mean
 * editing an upstream patch row per install — which CLAUDE.md's first
 * commitment forbids outright, and which could not follow an install anyway.
 *
 * Everything with a rule in it lives in `policy.js` (pure) and everything that
 * touches the disk lives in `discover.js`. This file is the only one that
 * imports an upstream package, which is what lets the other two be unit-tested
 * with no staged harness.
 */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import { discoverPlugins, readEntry } from './discover.js'
import { CLAUDE_PLUGIN_RANK, CLAUDE_PLUGIN_SOURCE, expandPluginRoot, planEntry, planSkills } from './policy.js'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/**
 * Type-only import that loads `@deepseek-ai/dsh-skill`'s module augmentation.
 *
 * `ctx.skills` reaches `Context` by `declare module '@deepseek-ai/cordis'`
 * inside that package, so the plain cordis `Context` does not carry it until
 * those types are loaded. Same trick `@dsh-desktop/market` uses for
 * `webServer`.
 * @typedef {typeof import('@deepseek-ai/dsh-skill')} _LoadSkillAugmentation
 */
/** @typedef {import('@deepseek-ai/dsh-skill').SkillCandidate} SkillCandidate */
/** @typedef {import('@deepseek-ai/dsh-skill').SkillDefinition} SkillDefinition */
/** @typedef {import('@deepseek-ai/dsh-skill').SkillLookupOptions} SkillLookupOptions */
/** @typedef {import('@deepseek-ai/dsh-skill').SkillProviderControl} SkillProviderControl */
/** @typedef {import('./policy.js').FoundEntry} FoundEntry */
/** @typedef {import('./policy.js').PolicySkill} PolicySkill */

/**
 * Stable Cordis plugin name.
 *
 * Function-plugin form: `name` / `inject` / `apply` as named exports, and NO
 * default export. `unwrapExports` takes `default ?? namespace`, so adding
 * `export default apply` hands the Loader the bare function and discards
 * these — the row then dies with `cannot get property "skills" without
 * inject`, which names the symptom and not the cause.
 * `@dsh-desktop/market` documents the same trap and `@dsh-desktop/picker` its
 * mirror image for the service-class form.
 */
export const name = 'desktop-claude-plugins'

/**
 * `skills` is a REQUIRED injection, not an optional one.
 *
 * The distinction is real and this row is on the required side of it.
 * `@dsh-desktop/market` reaches `settings` through `ctx.inject([...], cb)`
 * because its routes must mount whether or not a settings service exists — it
 * has work to do either way. This row has exactly one job: put a provider on
 * `ctx.skills`. With no registry there is nothing for it to do at all, so a
 * static `inject` is right, and it is what upstream's own provider
 * (`@deepseek-ai/dsh-skill-filesystem`) uses for the same reason.
 *
 * The registry is present in this composition: `dsh-base` composes the `skill`
 * row and `dsh-web-app` does not disable it — it disables only
 * `skill-filesystem` and `tool-skill`, and its comment says the registry
 * "stays in the host plane" precisely so deployment-level providers like this
 * one can register into its global layer.
 *
 * The consequence to know: `claudePlugins` below is provided from inside
 * `apply`, so a composition without `dsh-skill` provides no refresh service
 * either. That is deliberate — a refresh with no registry to refresh is not a
 * service worth pretending to have — but it means a sibling must reach it with
 * the optional form, `ctx.inject(['claudePlugins'], cb)`, and keep working if
 * the callback never fires.
 */
export const inject = ['skills']

/**
 * This row's config.
 *
 * `root` exists so the launcher stays the single place the location is
 * decided, per CLAUDE.md — a row can pass `!!js process.env.X`. Left empty it
 * falls back to `$DSH_HOME/claude-plugins`, which is what the marketplace
 * writes to.
 *
 * `rank` is exposed but should almost never move; see `CLAUDE_PLUGIN_RANK` for
 * why 700 and why higher means less trusted.
 */
export const Config = z.object({
  root: z.string().default('').description('Install root. Empty uses $DSH_HOME/claude-plugins.'),
  rank: z.number().default(CLAUDE_PLUGIN_RANK).description('Duplicate-name precedence. LOWER wins; first-party skills sit at 100-600.'),
})

/** Provider name in the `ctx.skills` registry. Duplicates in one layer throw. */
const PROVIDER = 'claude-plugins'

/**
 * A candidate's opaque locator, handed straight back to `get()`.
 *
 * It carries the resolved name because the registry compares
 * `definition.name !== candidate.name` and treats a mismatch as a stale entry:
 * it drops the load and invalidates. The name was decided across the whole
 * install set (collisions are resolved between plugins), so `get()` cannot
 * recompute it from one file and must be told.
 * @typedef {object} Locator
 * @property {'skill' | 'command'} kind - which directory it came out of.
 * @property {string} name - the resolved skill name, collisions already settled.
 * @property {string} path - absolute path of the markdown file.
 * @property {string} directory - resource base for its relative references.
 * @property {import('./policy.js').PluginRef} plugin - the plugin that ships it.
 * @property {string} slug - the skill directory name or command path.
 */

/**
 * What `claudePlugins.inventory()` answers with.
 * @typedef {object} Inventory
 * @property {string} root - the install root that was walked.
 * @property {import('./policy.js').PluginRef[]} plugins - one per installed plugin.
 * @property {{ name: string, kind: 'skill' | 'command', plugin: string, renamedFrom?: string }[]} skills - what is published.
 * @property {import('./policy.js').PolicyRefusal[]} refused - what was withheld, and why.
 * @property {import('./discover.js').DiscoveryError[]} errors - files present but unusable.
 */

/**
 * The service a sibling uses to make an install visible.
 *
 * The contract, in full:
 *
 * - `refresh()` invalidates the harness's cached skill catalogs and emits
 *   `skills/change`. Call it after writing into the install root; the next
 *   catalog read re-walks the disk. It is synchronous and cannot fail — a call
 *   after this row is disposed is a no-op, because `control.invalidate()` is
 *   documented to act "only while the exact registration remains active".
 * - `inventory()` re-walks the root and answers with everything found,
 *   including what was withheld and why. It is the only channel that carries
 *   provenance to a UI; see the note on `metadata` below for why the skill
 *   catalog cannot.
 *
 * Reach it with the optional form — `ctx.inject(['claudePlugins'], cb)` — for
 * the reason given on `inject` above.
 * @typedef {object} ClaudePluginsService
 * @property {() => void} refresh - invalidate the catalog after an install or removal.
 * @property {() => Promise<Inventory>} inventory - a fresh walk, for the UI.
 */

/**
 * Register the provider and the refresh service.
 * @param {Context} ctx - plugin context.
 * @param {{ root: string, rank: number }} config - this row's config.
 */
export function apply(ctx, config) {
  const root = config.root.length > 0 ? config.root : join(resolveDshHome(), 'claude-plugins')
  const rank = config.rank

  /**
   * Walk the root and apply every rule to what is there.
   *
   * Deliberately uncached. Upstream's own filesystem provider re-reads every
   * SKILL.md on each `list()` and leans on the registry's per-revision cache
   * rather than one of its own, so this has the cost profile users already
   * have; a cache here would instead be a second staleness window, and the
   * whole point of the hand-copied case is that a directory appearing on disk
   * shows up without anyone being told to press anything.
   * @param {AbortSignal} [signal] - cancels the walk between filesystem calls.
   * @returns {Promise<{ plan: ReturnType<typeof planSkills>, discovery: Awaited<ReturnType<typeof discoverPlugins>> }>} the walk and the plan over it.
   */
  async function survey(signal) {
    const discovery = await discoverPlugins(root, { parseYaml, ...signal === undefined ? {} : { signal } })
    return { plan: planSkills(discovery.entries, { rank }), discovery }
  }

  /**
   * Report what one walk withheld or could not read.
   *
   * A withheld skill is a decision this row made on the user's behalf, and one
   * the user did not ask for; saying so is the difference between a rule and a
   * disappearance. The UI gets the same list through `inventory()`, but the
   * log is what is there when nobody thought to look at the UI.
   * @param {Awaited<ReturnType<typeof survey>>} surveyed - the walk and its plan.
   */
  function report(surveyed) {
    for (const refusal of surveyed.plan.refused) {
      ctx.logger.warn(`claude-plugins: ${refusal.plugin} withheld ${refusal.message}`)
    }
    for (const error of surveyed.discovery.errors) {
      ctx.logger.warn(`claude-plugins: ${error.path} ${error.message}`)
    }
  }

  /**
   * This registration's lifecycle handle, captured from the factory.
   *
   * `registerProvider` hands it to a factory it calls synchronously, so it is
   * set before `apply` returns; the alternative — providing the service from
   * inside that factory — would publish `claudePlugins` before registration
   * had actually succeeded.
   * @type {SkillProviderControl | undefined}
   */
  let control

  ctx.skills.registerProvider((registration) => {
    control = registration

    return {
      name: PROVIDER,

      /**
       * Discover every publishable skill under the install root.
       *
       * `cwd` is ignored: these plugins are installed for the user, not for a
       * project, so the catalog is the same in every workspace. That is the
       * one place this provider differs in kind from the filesystem one.
       * @param {SkillLookupOptions} options - lookup options; `signal` cancels the walk.
       * @returns {Promise<SkillCandidate[]>} the candidates.
       */
      list: async (options) => {
        registration.signal.throwIfAborted()
        const surveyed = await survey(options.signal)
        report(surveyed)
        return surveyed.plan.skills.map((skill) => toCandidate(skill))
      },

      /**
       * Load one skill body, re-checking the rules against the current file.
       *
       * The re-check is the point. A candidate is listed from a snapshot that
       * may be seconds old, and the file may since have gained an
       * `allowed-tools` line — publishing the body anyway would widen its
       * access exactly as the listing rule exists to prevent, only later and
       * more quietly. Returning `undefined` is the documented way to say "no
       * longer loadable".
       * @param {SkillCandidate} candidate - the winning candidate this provider listed.
       * @param {SkillLookupOptions} options - lookup options; `signal` cancels the read.
       * @returns {Promise<SkillDefinition | undefined>} the full skill, or undefined.
       */
      get: async (candidate, options) => {
        registration.signal.throwIfAborted()
        const locator = /** @type {Locator} */ (candidate.locator)
        const read = await readEntry(locator, { parseYaml, ...options.signal === undefined ? {} : { signal: options.signal } })
        if (read.entry === undefined) return undefined
        const planned = planEntry(read.entry, { rank })
        if (planned.ok === false) {
          ctx.logger.warn(`claude-plugins: ${planned.refusal.plugin} withheld ${planned.refusal.message}`)
          return undefined
        }

        return {
          // The candidate's name, never the freshly computed one: the registry
          // rejects a definition whose name moved, and a rename decided across
          // the whole install set is not reproducible from one file.
          name: locator.name,
          description: planned.skill.description,
          ...planned.skill.whenToUse === undefined ? {} : { whenToUse: planned.skill.whenToUse },
          invocation: planned.skill.invocation,
          source: CLAUDE_PLUGIN_SOURCE,
          provider: PROVIDER,
          resourceBase: { kind: 'directory', path: locator.directory },
          path: locator.path,
          metadata: planned.skill.metadata,
          // The one variable these files may use, resolved on the way out
          // rather than stored resolved: the plugin's absolute path is a fact
          // about this machine, and baking it into the tree at install time
          // would strand the plugin the moment $DSH_HOME moved.
          content: expandPluginRoot(read.entry.body, locator.plugin.root),
        }
      },
    }
  })

  /** @type {ClaudePluginsService} */
  const service = {
    refresh: () => {
      control?.invalidate()
    },
    inventory: async () => {
      const { plan, discovery } = await survey(control?.signal)
      return {
        root,
        plugins: discovery.plugins,
        skills: plan.skills.map((skill) => ({
          name: skill.name,
          kind: skill.kind,
          plugin: skill.plugin.id,
          ...skill.renamedFrom === undefined ? {} : { renamedFrom: skill.renamedFrom },
        })),
        refused: plan.refused,
        errors: discovery.errors,
      }
    },
  }
  ctx.provide('claudePlugins', service)
}

/**
 * Turn a planned skill into a registry candidate.
 *
 * On `metadata` and provenance, measured rather than assumed: it does NOT
 * reach any list surface. `toSummary` in `@deepseek-ai/dsh-skill` projects a
 * candidate down to name / description / whenToUse / invocation / source /
 * provider / resourceBase, dropping `metadata` and `path`, so
 * `ctx.skills.list()` never carries it. The `skill.list` remote strips more
 * still, to name / description / whenToUse / modelInvocable, and the
 * model-facing catalog in `dsh-tool-skill` reduces to name / description
 * alone. What `metadata` DOES survive to is `ctx.skills.get()`, which returns
 * the provider's definition verbatim. So this is worth setting — an in-process
 * consumer that loads a skill can see where it came from — but a UI wanting
 * provenance must ask `claudePlugins.inventory()`, not the skill catalog.
 * @param {PolicySkill} skill - one planned skill.
 * @returns {SkillCandidate} the candidate.
 */
function toCandidate(skill) {
  /** @type {Locator} */
  const locator = {
    kind: skill.kind,
    name: skill.name,
    path: skill.path,
    directory: skill.directory,
    plugin: skill.plugin,
    slug: skill.slug,
  }
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    invocation: skill.invocation,
    source: CLAUDE_PLUGIN_SOURCE,
    provider: PROVIDER,
    rank: skill.rank,
    locator,
    resourceBase: { kind: 'directory', path: skill.directory },
    path: skill.path,
    metadata: skill.metadata,
  }
}
