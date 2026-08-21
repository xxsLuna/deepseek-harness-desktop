import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain JS module shipped inside the market package
import { readTarball, tarballFiles, TarError } from '../../packages/market/lib/tar.js'

interface TarEntry {
  path: string
  mode: number
  bytes: Buffer
}

const read = readTarball as (gzipped: Buffer, options?: { maxTotalBytes?: number, maxEntries?: number }) => TarEntry[]
const files = tarballFiles as (gzipped: Buffer, options?: object) => Map<string, Buffer>

const BLOCK = 512

/** Fields a fixture header sets; everything else is written as npm writes it. */
interface HeaderFields {
  name: string
  size?: number
  mode?: number
  typeflag?: string
  linkname?: string
  prefix?: string
  /** Overwrite the magic, to build a pre-POSIX v7 header. */
  magic?: string
  /** Replace the computed checksum, to build a corrupt header. */
  checksum?: string
}

/**
 * Write one 512-byte ustar header. The checksum is computed rather than stated,
 * so a fixture cannot accidentally test the parser against a header no real
 * writer would produce.
 */
function header(fields: HeaderFields): Buffer {
  const block = Buffer.alloc(BLOCK)
  const put = (offset: number, text: string): void => {
    block.write(text, offset, 'utf8')
  }
  const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`

  put(0, fields.name)
  put(100, octal(fields.mode ?? 0o644, 8))
  put(108, octal(0, 8)) // uid
  put(116, octal(0, 8)) // gid
  put(124, octal(fields.size ?? 0, 12))
  put(136, octal(0, 12)) // mtime
  put(156, fields.typeflag ?? '0')
  if (fields.linkname !== undefined) put(157, fields.linkname)
  put(257, fields.magic ?? 'ustar\0' + '00')
  if (fields.prefix !== undefined) put(345, fields.prefix)

  if (fields.checksum !== undefined) {
    put(148, fields.checksum)
    return block
  }
  return reseal(block)
}

/**
 * Recompute a header's checksum in place. Needed after any test pokes at a
 * field by hand, or the checksum error fires first and hides what was meant to
 * be under test.
 */
function reseal(block: Buffer): Buffer {
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')} \0`, 148, 'utf8')
  return block
}

/** Header plus its data, padded out to a block boundary. */
function entry(fields: Omit<HeaderFields, 'size'>, data: Buffer | string = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const padding = Buffer.alloc((BLOCK - (bytes.length % BLOCK)) % BLOCK)
  return Buffer.concat([header({ ...fields, size: bytes.length }), bytes, padding])
}

/** A pax extension record run: `"<len> <key>=<value>\n"`, len counting itself. */
function paxRecords(records: Record<string, string>): Buffer {
  return Buffer.concat(Object.entries(records).map(([key, value]) => {
    const body = `${key}=${value}\n`
    // The length field counts its own digits, so it has to be solved for.
    let length = body.length + 2
    while (`${String(length)} `.length + body.length !== length) length = `${String(length)} `.length + body.length
    return Buffer.from(`${String(length)} ${body}`, 'utf8')
  }))
}

/** Blocks plus the two-zero-block end marker, gzipped. */
function tarball(...blocks: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]))
}

/** Assert a rejection carries the exact code, not just any failure. */
function expectCode(code: string, run: () => unknown): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown, `expected ${code}, nothing was thrown`).toBeInstanceOf(TarError)
  expect((thrown as { code: string }).code).toBe(code)
}

describe('readTarball, on a hand-built archive', () => {
  it('strips the package/ root and keeps modes and bytes', () => {
    const entries = read(tarball(
      entry({ name: 'package/package.json' }, '{"name":"x"}'),
      entry({ name: 'package/lib/run.sh', mode: 0o755 }, 'echo hi\n'),
    ))
    expect(entries.map((one) => one.path)).toEqual(['package.json', 'lib/run.sh'])
    expect(entries[0]?.bytes.toString('utf8')).toBe('{"name":"x"}')
    expect(entries[1]?.mode).toBe(0o755)
    expect(entries[0]?.mode).toBe(0o644)
  })

  it('joins the ustar prefix field, which is how npm writes a long path', () => {
    const deep = 'package/lib/' + 'd'.repeat(40) + '/' + 'e'.repeat(40) + '/' + 'f'.repeat(40)
    const entries = read(tarball(entry({ name: 'leaf.js', prefix: deep }, 'x')))
    expect(entries[0]?.path).toBe(`${deep.slice('package/'.length)}/leaf.js`)
  })

  it('skips directory entries, and a regular entry named like one', () => {
    const entries = read(tarball(
      entry({ name: 'package/lib/', typeflag: '5' }),
      // Pre-ustar writers spelled a directory as a `0` entry with a trailing
      // slash, and GNU tar still reads it as one.
      entry({ name: 'package/docs/', typeflag: '0' }),
      entry({ name: 'package/lib/a.js' }, 'a'),
    ))
    expect(entries.map((one) => one.path)).toEqual(['lib/a.js'])
  })

  it('drops setuid, setgid and the sticky bit', () => {
    // A file inside a downloaded plugin has no business asking for any of them,
    // and this reader is the last place that can say no.
    const entries = read(tarball(entry({ name: 'package/s', mode: 0o6755 }, 'x')))
    expect(entries[0]?.mode).toBe(0o755)
  })

  it('exposes the same read as a Map', () => {
    const map = files(tarball(entry({ name: 'package/package.json' }, '{}')))
    expect([...map.keys()]).toEqual(['package.json'])
    expect(map.get('package.json')?.toString('utf8')).toBe('{}')
  })
})

describe('readTarball path-escape defence', () => {
  // Each of these is a way out of the extraction directory. They are the whole
  // reason this reader exists rather than a shell-out to `tar -x`.
  const unsafe: Array<[string, string]> = [
    ['POSIX absolute', '/etc/passwd'],
    ['UNC share', '//attacker/share/evil.js'],
    ['drive-qualified', 'C:/Windows/System32/evil.dll'],
    ['drive-relative', 'C:evil.js'],
    ['parent walk', 'package/../../evil.js'],
    ['leading parent walk', '../evil.js'],
    ['backslash parent walk', 'package\\..\\..\\evil.js'],
    ['NTFS alternate data stream', 'package/ok.js:hidden'],
    ['dot component', 'package/./ok.js'],
    ['empty component', 'package//ok.js'],
  ]

  for (const [label, path] of unsafe) {
    it(`rejects a ${label} path`, () => {
      expectCode('ERR_TAR_UNSAFE_PATH', () => read(tarball(entry({ name: path }, 'x'))))
    })
  }

  it('folds backslashes before checking, so a Windows-authored name cannot slip past', () => {
    // Written with backslashes only, this never matches a `/`-based check.
    expectCode('ERR_TAR_UNSAFE_PATH', () => read(tarball(entry({ name: 'package\\lib\\..\\..\\evil.js' }, 'x'))))
  })

  it('rejects a parent walk arriving through the prefix field', () => {
    expectCode('ERR_TAR_UNSAFE_PATH', () => read(tarball(entry({ name: 'evil.js', prefix: 'package/..' }, 'x'))))
  })

  it('rejects an embedded NUL, which only a pax record can carry', () => {
    // The ustar `name` field is NUL-terminated, so a NUL there simply ends the
    // name and smuggles nothing. A pax value is length-delimited, so it is the
    // one place a NUL survives into the path — where it would truncate the name
    // inside any C-level syscall and make the audit and the OS disagree.
    expect(read(tarball(entry({ name: 'package/ok.js\0.png' }, 'x')))[0]?.path).toBe('ok.js')
    expectCode('ERR_TAR_UNSAFE_PATH', () => read(tarball(
      entry({ name: 'PaxHeader/x', typeflag: 'x' }, paxRecords({ path: 'package/ok.js\0.png' })),
      entry({ name: 'package/innocent.js' }, 'x'),
    )))
  })

  it('rejects a parent walk arriving through a pax path record', () => {
    // The pax record wins over name/prefix, so the audit has to run after it.
    expectCode('ERR_TAR_UNSAFE_PATH', () => read(tarball(
      entry({ name: 'PaxHeader/x', typeflag: 'x' }, paxRecords({ path: 'package/../../evil.js' })),
      entry({ name: 'package/innocent.js' }, 'x'),
    )))
  })

  it('rejects content outside package/', () => {
    expectCode('ERR_TAR_OUTSIDE_PACKAGE', () => read(tarball(entry({ name: 'other/thing.js' }, 'x'))))
    expectCode('ERR_TAR_OUTSIDE_PACKAGE', () => read(tarball(entry({ name: 'Package/thing.js' }, 'x'))))
    expectCode('ERR_TAR_OUTSIDE_PACKAGE', () => read(tarball(entry({ name: 'packageish/thing.js' }, 'x'))))
  })

  it('rejects a bare package entry with nothing under it', () => {
    expectCode('ERR_TAR_UNSAFE_PATH', () => read(tarball(entry({ name: 'package' }, 'x'))))
  })
})

describe('readTarball link and entry-type handling', () => {
  it('rejects a symlink, naming its target', () => {
    let message = ''
    try {
      read(tarball(entry({ name: 'package/link.js', typeflag: '2', linkname: '../../../etc/passwd' })))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('symlink')
    expect(message).toContain('etc/passwd')
  })

  it('rejects a symlink and a hardlink by code', () => {
    expectCode('ERR_TAR_LINK', () => read(tarball(entry({ name: 'package/a', typeflag: '2', linkname: 'b' }))))
    expectCode('ERR_TAR_LINK', () => read(tarball(entry({ name: 'package/a', typeflag: '1', linkname: 'b' }))))
  })

  it('rejects a fifo, a device node and a contiguous file rather than guessing', () => {
    for (const typeflag of ['6', '3', '4', '7']) {
      expectCode('ERR_TAR_UNSUPPORTED_ENTRY', () => read(tarball(entry({ name: 'package/odd', typeflag }))))
    }
  })

  it('rejects two entries claiming one path', () => {
    // Whichever lands depends on extraction order — the classic way to show a
    // reviewer one file and write another.
    expectCode('ERR_TAR_DUPLICATE_PATH', () => read(tarball(
      entry({ name: 'package/index.js' }, 'good'),
      entry({ name: 'package/index.js' }, 'evil'),
    )))
  })
})

describe('readTarball extension records', () => {
  it('applies a pax path record over name and prefix', () => {
    const long = `lib/${'z'.repeat(120)}.js`
    const entries = read(tarball(
      entry({ name: 'PaxHeader/truncated', typeflag: 'x' }, paxRecords({ path: `package/${long}`, mtime: '499162500' })),
      entry({ name: 'z'.repeat(99), prefix: 'package/lib' }, 'body'),
    ))
    expect(entries.map((one) => one.path)).toEqual([long])
    expect(entries[0]?.bytes.toString('utf8')).toBe('body')
  })

  it('applies a pax record to the next entry only', () => {
    const entries = read(tarball(
      entry({ name: 'PaxHeader/a', typeflag: 'x' }, paxRecords({ path: 'package/renamed.js' })),
      entry({ name: 'package/first.js' }, 'a'),
      entry({ name: 'package/second.js' }, 'b'),
    ))
    expect(entries.map((one) => one.path)).toEqual(['renamed.js', 'second.js'])
  })

  it('applies a global pax record to every following entry', () => {
    const entries = read(tarball(
      entry({ name: 'GlobalHead', typeflag: 'g' }, paxRecords({ path: 'package/global.js' })),
      entry({ name: 'package/ignored.js' }, 'a'),
    ))
    expect(entries.map((one) => one.path)).toEqual(['global.js'])
  })

  it('applies a GNU long-name record', () => {
    const entries = read(tarball(
      entry({ name: '././@LongLink', typeflag: 'L' }, `package/lib/${'q'.repeat(120)}.js\0`),
      entry({ name: 'q'.repeat(99) }, 'body'),
    ))
    expect(entries[0]?.path).toBe(`lib/${'q'.repeat(120)}.js`)
  })

  it('consumes a GNU long-link record and still rejects the link it names', () => {
    expectCode('ERR_TAR_LINK', () => read(tarball(
      entry({ name: '././@LongLink', typeflag: 'K' }, `${'../'.repeat(40)}etc/passwd\0`),
      entry({ name: 'package/link', typeflag: '2', linkname: 'truncated' }),
    )))
  })

  it('rejects a pax size that disagrees with the header', () => {
    // Two parsers reading different data lengths out of one archive is not a
    // thing to accommodate.
    expectCode('ERR_TAR_BAD_SIZE', () => read(tarball(
      entry({ name: 'PaxHeader/x', typeflag: 'x' }, paxRecords({ size: '99' })),
      entry({ name: 'package/a.js' }, 'four'),
    )))
  })

  it('accepts a pax size that agrees with the header', () => {
    // This is what `npm pack` actually emits — redundantly, and identically.
    const entries = read(tarball(
      entry({ name: 'PaxHeader/x', typeflag: 'x' }, paxRecords({ size: '4', mtime: '499162500' })),
      entry({ name: 'package/a.js' }, 'four'),
    ))
    expect(entries[0]?.bytes.toString('utf8')).toBe('four')
  })

  it('rejects sparse-file records, which change what the data blocks mean', () => {
    expectCode('ERR_TAR_PAX', () => read(tarball(
      entry({ name: 'PaxHeader/x', typeflag: 'x' }, paxRecords({ 'GNU.sparse.major': '1' })),
      entry({ name: 'package/a.js' }, 'x'),
    )))
  })

  it('rejects a malformed pax record rather than skipping it', () => {
    expectCode('ERR_TAR_PAX', () => read(tarball(
      entry({ name: 'PaxHeader/x', typeflag: 'x' }, '999 path=package/a.js\n'),
      entry({ name: 'package/a.js' }, 'x'),
    )))
    expectCode('ERR_TAR_PAX', () => read(tarball(
      entry({ name: 'PaxHeader/x', typeflag: 'x' }, '22 path=package/a.js!'),
      entry({ name: 'package/a.js' }, 'x'),
    )))
    expectCode('ERR_TAR_PAX', () => read(tarball(
      entry({ name: 'PaxHeader/x', typeflag: 'x' }, '13 nokeyvalue\n'),
      entry({ name: 'package/a.js' }, 'x'),
    )))
  })
})

describe('readTarball structural validation', () => {
  it('rejects input that is not gzip', () => {
    expectCode('ERR_TAR_GUNZIP', () => read(Buffer.from('not gzip at all', 'utf8')))
  })

  it('rejects a corrupt header checksum before trusting its size field', () => {
    expectCode('ERR_TAR_HEADER_CHECKSUM', () => read(tarball(
      entry({ name: 'package/a.js', checksum: '000000 \0' }, 'x'),
    )))
  })

  it('rejects a pre-POSIX v7 header, whose prefix bytes are not a prefix', () => {
    expectCode('ERR_TAR_NOT_USTAR', () => read(tarball(entry({ name: 'package/a.js', magic: '\0'.repeat(8) }, 'x'))))
  })

  it('accepts the GNU spelling of the magic', () => {
    expect(read(tarball(entry({ name: 'package/a.js', magic: 'ustar  \0' }, 'x')))[0]?.path).toBe('a.js')
  })

  it('rejects a base-256 size field instead of reading it as octal', () => {
    // GNU flags the encoding with the high bit of the first byte; read as octal
    // the same bytes give a wildly wrong jump.
    const block = header({ name: 'package/a.js', size: 1 })
    block[124] = 0x80
    expectCode('ERR_TAR_UNSUPPORTED_ENTRY', () => read(tarball(reseal(block), Buffer.alloc(BLOCK))))
  })

  it('rejects a non-octal size field', () => {
    const block = header({ name: 'package/a.js', size: 1 })
    block.write('0000009xx\0\0\0', 124, 'utf8')
    expectCode('ERR_TAR_BAD_SIZE', () => read(tarball(reseal(block), Buffer.alloc(BLOCK))))
  })

  it('rejects an archive whose header runs past the end', () => {
    expectCode('ERR_TAR_TRUNCATED', () => read(gzipSync(header({ name: 'package/a.js', size: 4 }).subarray(0, 300))))
  })

  it('rejects an archive whose data runs past the end', () => {
    // The header claims two blocks of payload; only one is there.
    expectCode('ERR_TAR_TRUNCATED', () => read(gzipSync(Buffer.concat([
      header({ name: 'package/a.js', size: BLOCK * 2 }),
      Buffer.alloc(BLOCK, 0xaa),
    ]))))
  })

  it('rejects an archive with no end-of-archive marker', () => {
    // A download cut off exactly on a block boundary is otherwise a silent
    // short read — the file list just ends early.
    expectCode('ERR_TAR_TRUNCATED', () => read(gzipSync(entry({ name: 'package/a.js' }, 'x'))))
    expectCode('ERR_TAR_TRUNCATED', () => read(gzipSync(Buffer.concat([
      entry({ name: 'package/a.js' }, 'x'),
      Buffer.alloc(BLOCK),
    ]))))
  })

  it('rejects data hidden after the end-of-archive marker', () => {
    // A parser that stops at the marker and one that keeps reading see two
    // different archives; that disagreement is how content gets past a scanner.
    expectCode('ERR_TAR_TRAILING_DATA', () => read(gzipSync(Buffer.concat([
      entry({ name: 'package/a.js' }, 'x'),
      Buffer.alloc(BLOCK * 2),
      entry({ name: 'package/hidden.js' }, 'evil'),
    ]))))
  })

  it('accepts zero padding after the marker, which is what tar writes', () => {
    const entries = read(gzipSync(Buffer.concat([
      entry({ name: 'package/a.js' }, 'x'),
      Buffer.alloc(BLOCK * 20),
    ])))
    expect(entries.map((one) => one.path)).toEqual(['a.js'])
  })
})

describe('readTarball bounds', () => {
  it('refuses a gzip bomb while inflating, not after', () => {
    // zlib enforces maxOutputLength during inflation, so the memory is never
    // committed. Checking the total afterwards would be too late to matter.
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(64 * 1024)
    expectCode('ERR_TAR_TOO_LARGE', () => read(bomb, { maxTotalBytes: 64 * 1024 }))
  })

  it('defaults the ceiling below what a plugin needs but above what it uses', () => {
    // 32 MiB: no published dsh plugin is close, and the default must hold for a
    // caller that passes no options at all.
    const oversize = gzipSync(Buffer.alloc(33 * 1024 * 1024))
    expectCode('ERR_TAR_TOO_LARGE', () => read(oversize))
  })

  it('refuses more entries than the ceiling allows', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry({ name: `package/f${String(i)}.js` }, 'x'))
    expect(read(tarball(...many), { maxEntries: 12 })).toHaveLength(12)
    expectCode('ERR_TAR_TOO_MANY_ENTRIES', () => read(tarball(...many), { maxEntries: 11 }))
  })

  it('counts records rather than surviving files, so padding entries also count', () => {
    // A tarball stuffed with directory entries costs the same walk as one
    // stuffed with files.
    const dirs = Array.from({ length: 10 }, (_, i) => entry({ name: `package/d${String(i)}/`, typeflag: '5' }))
    expectCode('ERR_TAR_TOO_MANY_ENTRIES', () => read(tarball(...dirs), { maxEntries: 5 }))
  })
})

describe('readTarball against real `npm pack` output', () => {
  // A hand-built fixture can agree with a wrong parser, so at least one archive
  // has to come from the thing that actually produces them. npm 10 was measured
  // to use three different encodings for a path depending on its length: the
  // `name` field, `prefix` + `name`, and a pax `path` record.
  const root = fileURLToPath(new URL('../..', import.meta.url))
  let workDir = ''

  /**
   * `npm pack` a directory and return the tarball bytes. `--offline` keeps the
   * unit suite off the network; the filename comes from npm's own `--json`
   * report rather than being guessed from the version.
   */
  const pack = (source: string): Buffer => {
    const report = execFileSync(
      'npm',
      ['pack', source, '--pack-destination', workDir, '--offline', '--ignore-scripts', '--json'],
      { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: true },
    )
    const packed = JSON.parse(report) as Array<{ filename?: string }>
    const filename = packed[0]?.filename
    if (filename === undefined) throw new Error(`npm pack reported no filename: ${report}`)
    // npm scopes the id but writes the file with the scope flattened.
    return readFileSync(join(workDir, filename.replace('@', '').replace('/', '-')))
  }

  /** Write a throwaway package with one file at `relative`, and pack it. */
  const scaffold = (dir: string, relative: string, body: string): Buffer => {
    const base = join(workDir, dir)
    const target = join(base, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
    writeFileSync(join(base, 'package.json'), `{"name":"${dir}","version":"1.0.0","private":true}\n`, 'utf8')
    return pack(base)
  }

  let picker: Buffer
  let deep: Buffer
  let paxed: Buffer

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'dsh-market-tar-'))
    picker = pack(join(root, 'packages', 'picker'))
    // Long enough that npm splits the path across `prefix` and `name`.
    deep = scaffold('deeppkg', `lib/${'d'.repeat(30)}/${'e'.repeat(30)}/${'f'.repeat(30)}/leaf.js`, 'export const d = 1\n')
    // A single component over 100 bytes leaves npm no choice but a pax header.
    paxed = scaffold('paxpkg', `lib/${'z'.repeat(120)}.js`, 'export const z = 2\n')
  }, 180_000)

  afterAll(() => {
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true })
  })

  it('reads this repo\'s own packed package', () => {
    const map = files(picker)
    expect([...map.keys()].sort()).toEqual(['lib/index.js', 'package.json'])
    const manifest = JSON.parse(map.get('package.json')?.toString('utf8') ?? '{}') as { name?: string }
    expect(manifest.name).toBe('@dsh-desktop/picker')
    expect(map.get('lib/index.js')?.toString('utf8')).toContain('DesktopDirectoryPicker')
  })

  it('preserves the real archive\'s modes', () => {
    for (const one of read(picker)) expect(one.mode).toBe(0o644)
  })

  it('reads a path npm split across prefix and name', () => {
    const paths = [...files(deep).keys()]
    expect(paths).toContain(`lib/${'d'.repeat(30)}/${'e'.repeat(30)}/${'f'.repeat(30)}/leaf.js`)
  })

  it('reads a path npm could only express as a pax record', () => {
    const paths = [...files(paxed).keys()]
    expect(paths).toContain(`lib/${'z'.repeat(120)}.js`)
    expect(files(paxed).get(`lib/${'z'.repeat(120)}.js`)?.toString('utf8')).toBe('export const z = 2\n')
  })
})
