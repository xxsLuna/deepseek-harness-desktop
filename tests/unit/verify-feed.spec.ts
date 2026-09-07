/**
 * The gate that would have caught a year of broken auto-update.
 *
 * `productName` is "DeepSeek Harness", with a space, and three parties disagree
 * about what a space becomes: electron-builder writes the file with it, writes
 * the URL-safe form (space -> hyphen) into `latest*.yml`, and GitHub renames the
 * uploaded asset's spaces to dots. So every feed named a file that did not
 * exist, every download 404'd, and the only evidence was a line in one user's
 * log months later.
 *
 * Asserted against the output DIRECTORY rather than against a rule about names,
 * because the invariant that matters is "the feed names a file this build
 * produced" — which stays true if someone changes an artifact name for a good
 * reason, and false the moment the two drift apart.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS build script, imported for its pure helpers
import { missingFrom, referencedFiles, verifyFeeds } from '../../scripts/verify-feed.mjs'

/** A `latest.yml` of the shape electron-builder writes for the NSIS target. */
const WINDOWS_FEED = `version: 0.1.1-desktop-v0.2.5
files:
  - url: DeepSeek-Harness-Setup-0.1.1-desktop-v0.2.5.exe
    sha512: abc==
    size: 123
path: DeepSeek-Harness-Setup-0.1.1-desktop-v0.2.5.exe
sha512: abc==
releaseDate: '2026-09-05T09:59:05.000Z'
`

/** An output directory holding the given file names. */
function out(names: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feed-'))
  for (const name of names) writeFileSync(join(dir, name), 'x')
  return dir
}

describe('referencedFiles', () => {
  it('collects both the url list and the download path', () => {
    // They can differ, and a feed whose path resolves while its url list does
    // not still breaks the differential download.
    expect(referencedFiles(WINDOWS_FEED)).toEqual(['DeepSeek-Harness-Setup-0.1.1-desktop-v0.2.5.exe'])
  })

  it('reads a mac feed naming more than one artifact', () => {
    const feed = `version: 1.0.0
files:
  - url: App-1.0.0-arm64-mac.zip
  - url: App-1.0.0-arm64.dmg
path: App-1.0.0-arm64-mac.zip
`
    expect(referencedFiles(feed)).toEqual(['App-1.0.0-arm64-mac.zip', 'App-1.0.0-arm64.dmg'])
  })

  it('ignores the other scalars in the file', () => {
    // sha512 and releaseDate are not file names, and neither is the version.
    expect(referencedFiles('version: 1.0.0\nsha512: abc==\nreleaseDate: x\n')).toEqual([])
  })

  it('strips quotes the yml added, which are not part of the name', () => {
    expect(referencedFiles("path: 'App 1.0.0.exe'\n")).toEqual(['App 1.0.0.exe'])
  })
})

describe('missingFrom', () => {
  it('is empty when every name is present', () => {
    expect(missingFrom(['a.exe'], ['a.exe', 'latest.yml'])).toEqual([])
  })

  it('names what is absent, in the order the feed named it', () => {
    expect(missingFrom(['a.exe', 'b.dmg'], ['b.dmg'])).toEqual(['a.exe'])
  })
})

describe('verifyFeeds', () => {
  it('passes a build whose feed and files agree', () => {
    const dir = out(['latest.yml', 'DeepSeek-Harness-Setup-0.1.1-desktop-v0.2.5.exe'])
    writeFileSync(join(dir, 'latest.yml'), WINDOWS_FEED)
    expect(verifyFeeds(dir)).toEqual([])
  })

  it('catches the release that shipped: a hyphenated feed beside a spaced file', () => {
    // Exactly what v0.2.3, v0.2.4 and v0.2.5 all did. Note this is visible
    // BEFORE the upload — GitHub's rename only turns a wrong name into a
    // differently wrong one, so the gate needs no network.
    const dir = out(['latest.yml', 'DeepSeek Harness Setup 0.1.1-desktop-v0.2.5.exe'])
    writeFileSync(join(dir, 'latest.yml'), WINDOWS_FEED)
    const problems = (verifyFeeds(dir) as string[]).join('\n')
    // And it names the cause, because "points at a file that does not exist"
    // sends the reader looking for a lost artifact instead of at a space.
    expect(problems).toContain('DeepSeek Harness Setup 0.1.1-desktop-v0.2.5.exe')
    expect(problems).toContain('a space is the only difference')
  })

  it('reports a genuinely absent artifact as absent, not as a space', () => {
    // The other half of the same message: when nothing beside it explains the
    // gap, saying "a space" would be a guess.
    const dir = out(['latest.yml'])
    writeFileSync(join(dir, 'latest.yml'), WINDOWS_FEED)
    const problems = (verifyFeeds(dir) as string[]).join('\n')
    expect(problems).toContain('which this build did not produce')
    expect(problems).not.toContain('a space is the only difference')
  })

  it('ignores a spaced leftover from an earlier build that no feed names', () => {
    // A dev machine's `out` accumulates artifacts. Sweeping the directory for
    // spaces would make the gate cry wolf about files this build never touched,
    // and a gate that cries wolf gets bypassed.
    const dir = out(['latest.yml', 'DeepSeek-Harness-Setup-0.1.1-desktop-v0.2.5.exe', 'DeepSeek Harness Setup 0.1.0-rc.6-2.exe'])
    writeFileSync(join(dir, 'latest.yml'), WINDOWS_FEED)
    expect(verifyFeeds(dir)).toEqual([])
  })

  it('says so rather than passing when there is no feed to check', () => {
    // A silent pass here would be the worst outcome: the gate would report
    // green on a build that published nothing for it to read.
    expect((verifyFeeds(out(['DeepSeek-Harness-Setup-1.0.0.exe'])) as string[]).join('\n'))
      .toContain('no latest*.yml')
  })

  it('does not mistake a directory for a missing artifact', () => {
    const dir = out(['latest.yml', 'DeepSeek-Harness-Setup-0.1.1-desktop-v0.2.5.exe'])
    writeFileSync(join(dir, 'latest.yml'), WINDOWS_FEED)
    mkdirSync(join(dir, 'win-unpacked'))
    expect(verifyFeeds(dir)).toEqual([])
  })
})
