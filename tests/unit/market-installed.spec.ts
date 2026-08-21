/**
 * The record of installed Claude plugins.
 *
 * `installed.json` is a file a user can open and edit, and its three string
 * fields become directory names under `$DSH_HOME`. So every test here is one
 * of four things: a broken document still yields an answer, a value that could
 * escape the directory is refused loudly, an edit is the smallest one that
 * records the fact, or a key this module knows nothing about survives being
 * written through.
 *
 * The last group is the one that silently costs the user something. A row can
 * carry an install timestamp, a catalog integrity string, a title — none of
 * which this module names — and dropping them on the next install is data loss
 * nobody notices until the tab renders blank fields.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import {
  CLAUDE_PLUGINS_DIR,
  DEFAULT_KIND,
  INSTALLED_FILE,
  addInstalled,
  installPath,
  isSafeSegment,
  parseInstalled,
  removeInstalled,
} from '../../packages/market/lib/installed.js'

/** A record as two installs would have left it. */
const DOC = {
  version: 1,
  plugins: [
    {
      name: 'code-review',
      version: '1.2.0',
      source: 'anthropics',
      kind: 'plugin',
      path: 'claude-plugins/anthropics/code-review/1.2.0',
    },
    {
      name: 'sql-lens',
      version: '0.3.1',
      source: 'acme',
      kind: 'plugin',
      path: 'claude-plugins/acme/sql-lens/0.3.1',
    },
  ],
} as const

/** The document as JSON, for asserting the input came back untouched. */
const frozen = (value: unknown): string => JSON.stringify(value)

/** One well-formed entry, for the tests that vary a single field. */
const ENTRY = { name: 'sql-lens', version: '0.3.1', source: 'acme' }

describe('installPath', () => {
  it('puts a plugin under source and name, relative to $DSH_HOME', () => {
    // Segments, not a joined string: the caller joins with its own separator,
    // so nothing here has an opinion about `/` versus `\`.
    expect(installPath('acme', 'sql-lens')).toEqual([CLAUDE_PLUGINS_DIR, 'acme', 'sql-lens'])
    expect(CLAUDE_PLUGINS_DIR).toBe('claude-plugins')
  })

  it('is the same path whatever the version', () => {
    // The version is deliberately NOT a path level: it would drag semver's
    // charset into a path rule, and `1.5.0+g6927fc3` is an ordinary version
    // whose `+` never reaches the filesystem. An upgrade therefore lands on
    // the same directory, and the installer closes that window by renaming the
    // old tree aside before renaming the new one in.
    expect(installPath('acme', 'sql-lens')).toEqual(installPath('acme', 'sql-lens'))
  })

  it('refuses every segment that could steer the join off the tree', () => {
    // Each of these becomes a directory name under $DSH_HOME, so a separator
    // or a dot-relative segment is a traversal primitive, not a typo.
    for (const bad of [
      '..', '.', '../evil', './evil', '/etc/passwd', 'C:\\evil', 'a\\b', 'a/b',
      '@acme/tool', '', '.hidden', '_hidden', 'node_modules', 'Upper', 'has space',
      'has%2e%2e', 'x'.repeat(215),
    ]) {
      expect(() => installPath(bad, 'sql-lens'), `source ${bad}`).toThrow(/not a safe path segment/)
      expect(() => installPath('acme', bad), `name ${bad}`).toThrow(/not a safe path segment/)
    }
    for (const bad of [undefined, null, 42, {}, ['acme']]) {
      expect(() => installPath(bad, 'sql-lens'), String(bad)).toThrow(/not a safe path segment/)
    }
  })

  it('refuses a source spelled like the record file itself', () => {
    // `claude-plugins/installed.json` is already the record; a source id of
    // that name needs a directory exactly where the file is.
    expect(() => installPath(INSTALLED_FILE, 'sql-lens')).toThrow(/not a safe path segment/)
    expect(isSafeSegment(INSTALLED_FILE)).toBe(false)
  })

  it('accepts the shapes a catalog really publishes', () => {
    for (const good of ['acme', 'code-review', 'sql-lens', '0.3.1', '1.0.0-rc.8', 'a', 'x'.repeat(214)]) {
      expect(isSafeSegment(good), good).toBe(true)
    }
  })
})

describe('parseInstalled', () => {
  it('reads the rows and says how many the document held', () => {
    const view = parseInstalled(DOC)
    expect(view.total).toBe(2)
    expect(view.entries.map((e: { name: string }) => e.name)).toEqual(['code-review', 'sql-lens'])
    expect(view.entries[0]).toMatchObject({ version: '1.2.0', source: 'anthropics', kind: 'plugin' })
  })

  it('survives anything the file could hold', () => {
    // A half-written or hand-edited record must not stop the tab rendering, so
    // every one of these is an empty answer rather than a throw.
    const shapes: unknown[] = [
      undefined, null, 42, 'plugins', true, [], {},
      { plugins: null }, { plugins: 'sql-lens' }, { plugins: 42 }, { plugins: { 0: {} } },
      { version: 99 }, { version: 99, plugins: null },
    ]
    for (const doc of shapes) {
      expect(parseInstalled(doc), JSON.stringify(doc)).toEqual({ entries: [], total: 0 })
    }
  })

  it('reads a document whose envelope version it does not know', () => {
    // Local state, not remote content: refusing to read because of a number in
    // the file would strand every install the user has. `fetch.js` throws on an
    // unknown catalog version for the opposite reason, and that is deliberate.
    expect(parseInstalled({ version: 7, plugins: [{ name: 'sql-lens' }] }).entries).toHaveLength(1)
  })

  it('counts the rows it cannot read, so a caller can say so', () => {
    const view = parseInstalled({
      plugins: ['sql-lens', 42, null, ['sql-lens'], {}, { name: '' }, { name: 'ok' }, { name: 'ok' }],
    })
    // Eight rows in the file, one usable: a name is the row's identity, and a
    // row nothing can name is a row nothing can remove. A repeat goes too —
    // two rows with one name are two directories claiming one plugin.
    expect(view.total).toBe(8)
    expect(view.entries.map((e: { name: string }) => e.name)).toEqual(['ok'])
  })

  it('fills only the fields that are missing, and defaults kind', () => {
    const [entry] = parseInstalled({ plugins: [{ name: 'sql-lens', version: 7 }] }).entries
    expect(entry).toEqual({
      name: 'sql-lens', version: '', source: '', kind: DEFAULT_KIND, path: '',
    })
    expect(DEFAULT_KIND).toBe('plugin')
  })

  it('reports a value it would refuse to write', () => {
    // Deliberate, and the same call `registry.js` makes: hiding a hand-edited
    // row would make the tab claim nothing is installed while a directory sits
    // on disk. The recorded path is a record, never an instruction.
    const handEdited = { plugins: [{ name: 'evil', version: '..', source: '..', path: '../../..' }] }
    const [entry] = parseInstalled(handEdited).entries
    expect(entry.path).toBe('../../..')
    expect(entry.source).toBe('..')
    expect(isSafeSegment(entry.source)).toBe(false)
    expect(() => installPath(entry.source, entry.name)).toThrow()
  })

  it('carries keys it knows nothing about through the read', () => {
    const [entry] = parseInstalled({
      plugins: [{ name: 'sql-lens', installedAt: '2026-08-21T00:00:00Z', integrity: 'sha512-abc' }],
    }).entries
    expect(entry.installedAt).toBe('2026-08-21T00:00:00Z')
    expect(entry.integrity).toBe('sha512-abc')
  })

  it('never mutates the document it was given', () => {
    const before = frozen(DOC)
    parseInstalled(DOC)
    expect(frozen(DOC)).toBe(before)
  })
})

describe('addInstalled', () => {
  it('records the entry with the path it will actually land at', () => {
    const next = addInstalled({}, { name: 'sql-lens', version: '0.3.1', source: 'acme' })
    expect(next).toEqual({
      version: 1,
      plugins: [{
        name: 'sql-lens',
        version: '0.3.1',
        source: 'acme',
        kind: 'plugin',
        path: 'claude-plugins/acme/sql-lens',
      }],
    })
  })

  it('computes the path itself, POSIX-separated, ignoring any the caller sent', () => {
    // The record and the directory cannot be allowed to disagree, and a caller
    // must not be able to smuggle a path past installPath's checks.
    const next = addInstalled({}, { ...ENTRY, path: '../../anywhere' })
    expect(next.plugins[0].path).toBe(installPath('acme', 'sql-lens').join('/'))
    expect(next.plugins[0].path).not.toContain('\\')
  })

  it('replaces a re-install in place instead of duplicating it', () => {
    const next = addInstalled(DOC, { name: 'code-review', version: '2.0.0', source: 'anthropics' })
    expect(next.plugins).toHaveLength(2)
    // In place, not appended: the order the tab shows must not shuffle every
    // time something upgrades.
    expect(next.plugins[0]).toMatchObject({ name: 'code-review', version: '2.0.0' })
    expect(next.plugins[1]).toMatchObject({ name: 'sql-lens', version: '0.3.1' })
    expect(next.plugins[0].path).toBe('claude-plugins/anthropics/code-review')
    expect(parseInstalled(next).total).toBe(2)
  })

  it('appends a name that is not recorded yet', () => {
    const next = addInstalled(DOC, { name: 'sql-lens-2', version: '1.0.0', source: 'acme' })
    expect(next.plugins.map((p: { name: string }) => p.name)).toEqual(['code-review', 'sql-lens', 'sql-lens-2'])
  })

  it('carries the caller\'s own keys into the record', () => {
    const next = addInstalled({}, { ...ENTRY, installedAt: '2026-08-21T00:00:00Z', title: 'SQL Lens' })
    expect(next.plugins[0]).toMatchObject({ installedAt: '2026-08-21T00:00:00Z', title: 'SQL Lens' })
  })

  it('takes a kind when given one, and defaults it when not', () => {
    // A `.claude-plugin` marketplace lists more than plugins, and a reader
    // should not have to open the tree to find out what a row is.
    expect(addInstalled({}, { ...ENTRY, kind: 'mcp-server' }).plugins[0].kind).toBe('mcp-server')
    expect(addInstalled({}, ENTRY).plugins[0].kind).toBe(DEFAULT_KIND)
    expect(() => addInstalled({}, { ...ENTRY, kind: 'a\nb' })).toThrow(/not a safe segment/)
    expect(() => addInstalled({}, { ...ENTRY, kind: '' })).toThrow(/not a safe segment/)
  })

  it('refuses loudly rather than leaving a tree with nothing pointing at it', () => {
    // A write is our own code recording a directory it just unpacked, so a
    // value we will not record is a bug or a hostile catalog row.
    for (const bad of ['..', '../evil', '/etc/passwd', 'a/b', 'C:\\evil', '', 'node_modules']) {
      expect(() => addInstalled(DOC, { ...ENTRY, name: bad }), `name ${bad}`).toThrow(/not a safe path segment/)
      expect(() => addInstalled(DOC, { ...ENTRY, source: bad }), `source ${bad}`).toThrow(/not a safe path segment/)
    }
    // A version is held to a different rule now, because it is no longer a path
    // segment: short, printable, single-line, and that is all. `..` is merely an
    // odd label here — it is displayed, never joined onto a directory.
    for (const bad of ['', 'x'.repeat(129), 'has\nnewline', 'has\u0000nul', undefined, 42]) {
      expect(() => addInstalled(DOC, { ...ENTRY, version: bad }), `version ${JSON.stringify(bad)}`)
        .toThrow(/as an install version/)
    }
    // Build metadata is the case that motivated the split: an ordinary SemVer
    // string whose `+` a path rule has no business adjudicating.
    const withBuild = addInstalled(DOC, { ...ENTRY, version: '1.5.0+g6927fc3' })
    expect(withBuild.plugins.find((p: { name: string }) => p.name === ENTRY.name)?.version)
      .toBe('1.5.0+g6927fc3')
    for (const bad of [undefined, null, 42, 'sql-lens', []]) {
      expect(() => addInstalled(DOC, bad), String(bad)).toThrow(/not a safe path segment/)
    }
  })

  it('leaves rows it did not touch exactly as it found them', () => {
    // Recording one install must not quietly rewrite every other row into this
    // module's idea of the shape, and a row we cannot read is not a row we may
    // drop on the user's behalf.
    const messy = { plugins: [42, { name: 'kept', extra: { deep: true } }, null], someFutureKey: ['keep me'] }
    const next = addInstalled(messy, ENTRY)
    expect(next.plugins.slice(0, 3)).toEqual([42, { name: 'kept', extra: { deep: true } }, null])
    expect(next.someFutureKey).toEqual(['keep me'])
    expect(next.plugins[3]).toMatchObject({ name: 'sql-lens' })
  })

  it('replaces a plugins value that cannot hold rows', () => {
    // A non-array holds nothing to keep, so recording an install has to put a
    // real list there.
    expect(addInstalled({ plugins: 'nope' }, ENTRY).plugins).toHaveLength(1)
  })

  it('never mutates the document it was given', () => {
    const before = frozen(DOC)
    addInstalled(DOC, { name: 'code-review', version: '2.0.0', source: 'anthropics' })
    expect(frozen(DOC)).toBe(before)
  })

  it('survives a round trip through the file', () => {
    // The caller's write is JSON.stringify and its read is JSON.parse, so
    // nothing returned here may be unserialisable or depend on identity.
    const added = addInstalled(DOC, { name: 'notes', version: '1.0.0', source: 'acme', kind: 'skill' })
    const reread = JSON.parse(`${JSON.stringify(added, undefined, 2)}\n`)
    expect(parseInstalled(reread).entries).toEqual(parseInstalled(added).entries)
    expect(removeInstalled(reread, 'notes')).toEqual(JSON.parse(frozen(DOC)))
  })
})

describe('removeInstalled', () => {
  it('drops the row and keeps the order of the survivors', () => {
    const next = removeInstalled(DOC, 'code-review')
    expect(next.plugins.map((p: { name: string }) => p.name)).toEqual(['sql-lens'])
    expect(next.version).toBe(1)
  })

  it('is a no-op for a name that is not recorded', () => {
    expect(removeInstalled(DOC, 'nothing-like-this')).toEqual(JSON.parse(frozen(DOC)))
  })

  it('invents nothing it did not find', () => {
    // A removal attempt on a document with neither field must not leave an
    // empty array and a version stamp behind.
    expect(removeInstalled({}, 'sql-lens')).toEqual({})
    expect(removeInstalled({ other: 1 }, 'sql-lens')).toEqual({ other: 1 })
    expect(removeInstalled({ plugins: 'nope' }, 'sql-lens')).toEqual({ plugins: 'nope' })
  })

  it('removes a row no add would have written', () => {
    // Validation guards what we write, not what we retract: a row a hand-edit
    // put in the file is exactly the one a user needs to take back out.
    const handEdited = { plugins: [{ name: '../../evil', path: '../../..' }, { name: 'sql-lens' }] }
    expect(removeInstalled(handEdited, '../../evil').plugins).toEqual([{ name: 'sql-lens' }])
  })

  it('never mutates the document it was given', () => {
    const before = frozen(DOC)
    removeInstalled(DOC, 'code-review')
    expect(frozen(DOC)).toBe(before)
  })

  it('leaves keys it does not own alone', () => {
    const doc = { version: 1, plugins: [{ name: 'sql-lens' }], lastChecked: 'yesterday' }
    expect(removeInstalled(doc, 'sql-lens')).toEqual({ version: 1, plugins: [], lastChecked: 'yesterday' })
  })
})
