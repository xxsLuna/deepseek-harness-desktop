---
name: bump-channel
description: Take a release channel of deepseek-harness-desktop (stable/main, develop/dev, alpha — or all three) to the newest upstream @deepseek-ai/dsh version its dist-tag allows, diagnose and fix whatever the contract suite reports broken, and carry it through to a published GitHub release. Use this whenever the user asks to update, bump, refit, or release a channel; mentions a new upstream version; asks "are we on the latest?", "업스트림 최신으로 올려줘", "채널 올려줘", "릴리스까지 해줘"; or asks to fix a version bump that is failing. Also use it when an automated upstream-bump PR is open and needs the refit it cannot carry itself.
---

# Bumping a channel to the latest upstream

This repo tracks a moving upstream. A bump is rarely just a version string: a
version that moved usually moved a seam with it, and the job is to find each
one, fix it at the seam, and ship. The contract suite exists to name those
seams — trust it over reasoning about what *should* still work.

Read `AGENTS.md` (procedures, the release scheme, the per-version seam records)
and `CLAUDE.md` (architecture rules) before changing anything. They carry
decisions that look arbitrary until you know the measurement behind them.

## What the channels mean

| channel | identifier | branch | follows dist-tag | may carry |
| --- | --- | --- | --- | --- |
| stable | `desktop-v` | `main` | nothing automatic | `rc` |
| develop | `desktop-dev` | `dev` | `latest` | `rc` |
| alpha | `desktop-alpha` | `alpha` | `alpha` | `alpha` |

Two rules follow, and both have bitten before:

- **Stable has no watch row on purpose.** `main` moves when a person decides to
  stand behind a pin. If the user asks to bump stable, that decision is theirs —
  it is the whole meaning of the channel, and a nightly job doing it is the one
  thing stable exists to prevent.
- **A channel may only carry its own stage.** `STAGE_FOR_CHANNEL` in
  `scripts/release-version.mjs` refuses the rest. If the newest version on a
  line is an `rc` and the user wants it on alpha, that is not a thing to work
  around quietly — say so and let them choose, because the alternatives
  (relax the table, or wait for an alpha of that line) have different costs.

Start by reading what upstream actually publishes rather than assuming:

```bash
npm view '@deepseek-ai/dsh' dist-tags --json
```

## The loop

### 1. Set the pin

```bash
node scripts/release-version.mjs <upstream-version> <v|dev|alpha>
npm install --package-lock-only --no-audit --no-fund
npm run stage:relock          # regenerates harness-lock.json for the new pin
```

`release-version.mjs` writes `harness.json`, `package.json` and the channel's
`PUBLISHED_*` list together. Use it rather than editing by hand — it enforces
the stage table and the scheme, and refuses a version that does not outrank
what the channel already ships.

**Exception: when only the build counter moves.** A new build of the *same*
upstream pin is a hand cut — `release-version.mjs` derives versions for an
upstream bump and would reset the counter. Edit `package.json` and
`package-lock.json` (it carries the root version too, and is the one that gets
forgotten), then record it:

```bash
node --input-type=module -e "
import { appendPublished } from './scripts/release-version.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
const p = 'tests/unit/version-scheme.spec.ts'
writeFileSync(p, appendPublished(readFileSync(p,'utf8'), '<version>', '<channel>'))
"
```

### 2. Let the suite name what broke

```bash
npm run build && npm run typecheck
npm test
npm run test:contract
```

Run these from **PowerShell**, not Git Bash: Git Bash's `git` rejects the
`file:///C:/…` URLs `tests/unit/market-git.spec.ts` builds, and you get nine
failures that are the shell rather than the tree.

A red contract test is the deliverable of this step, not a problem with it.
Read the failure as a map: it names the seam, and the seam is where the fix
belongs.

### 3. Fix at the seam

`CLAUDE.md` has the rule and it is the most important thing in this skill:
**provide a value upstream asks for → call a function it exports → and only
then think about a class it exports.** If the only way through is to mirror
upstream's internals, the seam is missing — say so rather than writing the
copy, because the copy becomes load-bearing and undocumented the day it drifts.

Four shapes recur. `references/seam-patterns.md` has the worked examples from
past bumps, with the symptom each one produced — read it when a failure does
not immediately say what moved.

- a function was renamed or lost arguments
- a service's registry was replaced by a different model entirely
- a declaration became a list where it used to be a single value
- a row id changed, or a row's config options were removed

**A dead overlay is still worth reading before deleting.** More than once the
code was provably doing nothing while the *claim in its comment* was true and
untested. Delete the code; turn the claim into a test. That is what caught the
preset-registry break on 0.1.7.

### 4. Verify on the real thing

Green tests are necessary and not sufficient. Boot the app:

```bash
$env:DSH_DESKTOP_SMOKE = "1"
& "node_modules\.bin\electron.cmd" . --user-data-dir="<a scratch dir>"
```

Expect `SUMMARY ALL-PASS`, a plausible boot-entry count, and zero console
errors. The separate `--user-data-dir` matters: the user's installed app holds
the single-instance lock, and without it this exits immediately having handed
off to their window.

For UI work the launcher has a live-tuning loop in dev builds —
`dev-overrides.css`, `dev-eval.js`, `dev-capture.request`, `dev-click.request`
at the repo root. `AGENTS.md` describes it. Derive click coordinates from the
DOM, never from a screenshot.

### 5. Electron, when the bump needs it

`harness.json`'s `node` field is a constraint on **Electron's** Node, not a
binary to fetch — the harness runs on the app's own Electron under
`ELECTRON_RUN_AS_NODE`. Since 0.1.7 upstream reaches Node's internals through
`node-addon-require-builtin`, which fingerprints the **exact V8 build** and
accepts only a few. `references/electron-pin.md` has the table, how to read it,
and why the pin must be exact rather than a caret.

Never bump Electron on reasoning alone. `tests/contract/native-tools.spec.ts`
exists for this question and boots every fragile thing under the real binary.

### 6. Ship it

```bash
# PR, CI (five targets), merge
gh pr create --base <branch> --head <your-branch> --title "…" --body-file <file>
gh pr merge <n> --rebase --delete-branch

# tag on the channel's own branch, then push to trigger the release build
git tag -a v<version> origin/<branch> -F <message-file>
git merge-base --is-ancestor v<version> origin/<branch>   # must pass
git push origin refs/tags/v<version>
```

A tag push builds five targets and leaves a **draft**. Publishing is separate
and is where the care goes:

```bash
gh release view v<version> --json isDraft,assets
```

Check **13 assets and all four feeds** — `latest.yml`, `latest-mac.yml`,
`latest-linux.yml`, `latest-linux-arm64.yml`. A partial draft once shipped
without the Windows feed and broke update checks for everyone on that channel.

Then publish, and keep the Latest badge on stable explicitly rather than
letting publish order decide it:

```bash
gh release edit v<version> --draft=false --latest=false   # dev, alpha
gh release edit v<version> --draft=false --latest         # stable only
```

Finally, fetch the feed and HEAD the installer it names. `productName` has a
space in it and three parties disagreed about what a space becomes, so every
download 404'd on every platform for several releases while the builds were
green.

## Before tagging: check fix parity

Each channel runs its own CI over its own tree, so a missing fix is a test that
is simply **not present** — green says the code on that branch works, never
that it is complete. The alpha channel's first release shipped missing three
fixes this way.

Compare trees rather than trusting history, because a cherry-pick replays under
a new SHA:

```bash
git diff --stat origin/<other-branch> HEAD -- . `
  ':!package.json' ':!package-lock.json' ':!harness.json' `
  ':!harness-lock.json' ':!tests/unit/version-scheme.spec.ts'
```

Carrying a fix between channels is a **cherry-pick or a merge, never a rebase**:
a released tag lives in each channel's history and rebasing orphans it.

## Record what you learned

When a bump teaches something — a seam that moved, a platform fact found the
hard way — write it into `AGENTS.md` under a heading that names the version,
and pin it in a test. The repo's own standard: silent breakage is the enemy,
and a green build is not proof. A note in a commit message is not enough,
because the next person reads `AGENTS.md`.

## Scope and consent

Merging a PR and publishing a release are outward-facing. Publishing a stable
release pushes an update to every installed stable user. Confirm before
publishing unless the user has already said to carry it through — and when
they have, still show them what the draft contains before it goes out.
