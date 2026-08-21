/**
 * Vitest scope. The only reason this file exists is to anchor it.
 *
 * There was no config, so the default `include` applied:
 * `**\/*.{test,spec}.?(c|m)[jt]s?(x)` — unanchored, matching a spec file
 * anywhere under the project root. Isolated subagents create full repo copies in
 * `.claude/worktrees/`, so `npm test` started collecting every worktree's copy of
 * every spec alongside the real ones: 65 files and 485 tests where there are 16
 * and 95, and four failures belonging to another checkout's work in progress.
 *
 * `.gitignore` does not help — it governs git, not vitest's globs.
 *
 * CI never saw this (a fresh checkout has no worktrees), which is the worst shape
 * for a problem like it: the local suite silently stopped being a gate while
 * still printing a number that looked like one.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Anchored at the root, so a spec inside a nested checkout cannot match.
    include: ['tests/unit/**/*.spec.ts', 'tests/contract/**/*.spec.ts'],
    // Belt and braces: were `include` ever loosened, these stay out.
    exclude: ['**/node_modules/**', '.claude/**', 'build/**', 'out/**', 'dist/**'],
  },
})
