// Every file an update feed names must be a file this build produced.
//
// The gate exists because auto-update was broken on every platform and every
// release, and nothing anywhere said so. `productName` has a space in it;
// electron-builder writes the artifact with the space and the URL-safe form
// (space -> hyphen) into `latest*.yml`, while GitHub renames an uploaded asset's
// spaces to dots. Three spellings, no two alike, so `latest.yml` pointed at a
// filename that did not exist and every download 404'd. The only signal was a
// 404 in a user's log, months later.
//
// Checked here rather than after publishing, because a published release cannot
// be repaired without cutting another one — and checked against the DISK rather
// than against a rule about names, so it also catches a target whose artifact
// name someone changes without changing the feed's view of it.
//
// This does not need GitHub to be reachable. The mismatch is already visible
// locally: the yml says `DeepSeek-Harness-Setup-….exe` while the file beside it
// is `DeepSeek Harness Setup ….exe`. GitHub's rename only turns a wrong name
// into a differently wrong one.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The artifact names one update feed points at.
 *
 * Hand-parsed rather than through a YAML dependency: the fields wanted are two
 * flat scalars in a file electron-builder writes to a fixed shape, and this
 * script runs in the packaging step where adding a runtime dependency to read
 * three lines is the wrong trade.
 *
 * Both `url` (every file in the release) and `path` (the one the updater
 * downloads) are collected — they can differ, and a feed whose `path` is right
 * and whose `url` list is wrong still breaks the differential download.
 * @param source - the yml file's contents.
 * @returns every distinct artifact name it references.
 */
export function referencedFiles(source) {
  /** @type {Set<string>} */
  const names = new Set()
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    // Quoted when the name needs it; the quotes are the yml's, not the file's.
    names.add(match[1].replace(/^['"]|['"]$/g, ''))
  }
  return [...names]
}

/**
 * Names a feed points at that the build did not produce.
 * @param names - artifact names from one feed.
 * @param present - the file names sitting in the output directory.
 * @returns the missing ones, in the order the feed named them.
 */
export function missingFrom(names, present) {
  const have = new Set(present)
  return names.filter((name) => !have.has(name))
}

/**
 * Check every feed in an output directory.
 * @param outDir - electron-builder's output directory.
 * @returns one line per problem; empty when every feed resolves.
 */
export function verifyFeeds(outDir) {
  const entries = readdirSync(outDir, { withFileTypes: true })
  const present = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const feeds = present.filter((name) => /^latest.*\.yml$/.test(name))
  if (feeds.length === 0) return ['no latest*.yml in the output directory; nothing was published to check']

  /** @type {string[]} */
  const problems = []
  for (const feed of feeds) {
    const names = referencedFiles(readFileSync(join(outDir, feed), 'utf8'))
    for (const missing of missingFrom(names, present)) {
      // Name the CAUSE when it is there to be named. "points at a file that
      // does not exist" sends the reader looking for a lost artifact; pointing
      // at the spaced file sitting beside it ends the search immediately.
      const spaced = present.find((name) => name.replaceAll(' ', '-') === missing)
      problems.push(spaced === undefined
        ? `${feed} points at ${JSON.stringify(missing)}, which this build did not produce`
        : `${feed} points at ${JSON.stringify(missing)} but the build produced ${JSON.stringify(spaced)} — `
          + 'a space is the only difference, and GitHub turns it into a dot on upload, so all three disagree')
    }
  }
  // Deliberately NOT a sweep for spaces across the directory: a dev machine's
  // `out` keeps artifacts from earlier builds, and flagging those would make
  // the gate cry wolf about files this build never touched. A spaced name only
  // matters when a feed points at it, and that is what is checked above.
  return problems
}

// The `C:\...` caveat from prune-payload.mjs applies here too: comparing raw
// strings would go silently false on Windows and turn this into a no-op import.
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const outDir = process.argv[2] ?? 'out'
  if (!existsSync(outDir)) {
    console.error(`verify-feed: ${outDir} does not exist; run electron-builder first`)
    process.exit(2)
  }
  const problems = verifyFeeds(outDir)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify-feed: ${problem}`)
    console.error('verify-feed: auto-update would 404 for these; see the note in electron-builder.yml')
    process.exit(1)
  }
  console.log('update feed verified')
}
