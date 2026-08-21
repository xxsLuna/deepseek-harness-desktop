// @ts-check
/**
 * Reader for npm-style gzipped tarballs, with no dependencies at all.
 *
 * The packaged app ships **no package manager** — no npm, no pnpm, and not
 * even a stock Node payload any more (the harness runs on the app's own
 * Electron binary under `ELECTRON_RUN_AS_NODE`). So when the marketplace
 * downloads a plugin tarball, this process has to open it itself.
 *
 * We deliberately do not shell out to `tar`:
 *
 * - It would be a **new platform assumption**. This runs on end-user machines,
 *   and bsdtar is not something we can claim is present — Windows has shipped
 *   one since 1809 but a user on an older build, a stripped image or a locked
 *   down PATH would get a marketplace that fails with a spawn error.
 * - It would **not remove any of the work**. `tar -x` happily writes a symlink
 *   or an absolute path unless argued out of it, so we would be auditing entry
 *   paths ourselves either way — and auditing them *after* an external process
 *   already touched the disk is the wrong order.
 *
 * `node:zlib` plus ~200 lines of ustar walking removes the platform dependency
 * entirely, and puts the path audit in front of the first byte written.
 *
 * Nothing here touches the filesystem: the input is bytes and the output is
 * bytes. Writing them out is the caller's job, and is what lets this be tested
 * without a temp directory.
 */
import { gunzipSync } from 'node:zlib'

/** Every tar structure is a multiple of this. */
const BLOCK = 512

/**
 * Default ceiling on the *decompressed* size. The published `dsh` plugins are
 * a few hundred KiB; 32 MiB is generous enough that a legitimate package with
 * bundled assets fits, and small enough that a gzip bomb cannot make the
 * sidecar the reason the machine starts swapping.
 */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024

/**
 * Default ceiling on header records walked. Counted per *record*, not per
 * surviving file, so a tarball padded out with a million directory entries
 * trips it too — the point is to bound the loop, not the result.
 */
const MAX_ENTRIES = 16384

/** Every npm tarball roots its content in this one directory. */
const ROOT = 'package'

/**
 * A tarball this reader refuses. `code` is the stable part — messages are for
 * humans and may be reworded, so tests and callers should switch on the code.
 */
export class TarError extends Error {
  /**
   * @param {string} code - stable `ERR_TAR_*` discriminator.
   * @param {string} message - what was wrong, and where possible what to do.
   */
  constructor(code, message) {
    super(message)
    this.name = 'TarError'
    this.code = code
  }
}

/**
 * One regular file recovered from the archive.
 * @typedef {object} TarEntry
 * @property {string} path - relative POSIX path, already stripped of the
 *   leading `package/`. Guaranteed safe to join onto a target directory.
 * @property {number} mode - permission bits only (`& 0o777`).
 * @property {Buffer} bytes - the file contents. A view onto the decompressed
 *   buffer rather than a copy, so holding one entry holds the whole archive
 *   alive; callers that keep a single file long-term should copy it.
 */

/**
 * @typedef {object} ReadTarballOptions
 * @property {number} [maxTotalBytes] - ceiling on decompressed bytes.
 * @property {number} [maxEntries] - ceiling on header records walked.
 */

/**
 * Read every regular file out of a gzipped npm tarball.
 *
 * Rejects rather than repairs. A tarball that is not exactly what `npm pack`
 * produces is not something to guess at — silently mis-parsing one is the only
 * outcome worse than refusing it.
 *
 * @param {Buffer | Uint8Array} gzipped - the downloaded `.tgz` bytes.
 * @param {ReadTarballOptions} [options] - bounds; defaults are documented above.
 * @returns {TarEntry[]} the archive's regular files, in archive order.
 * @throws {TarError} on anything unsafe, unsupported or malformed.
 */
export function readTarball(gzipped, options = {}) {
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const buffer = inflate(gzipped, maxTotalBytes)

  /** @type {TarEntry[]} */
  const entries = []
  /** @type {Set<string>} */
  const seen = new Set()
  /** Pax records that apply to the next entry only, or a GNU long name. */
  /** @type {Record<string, string>} */
  let nextOverrides = {}
  /** Pax records that apply to every following entry. */
  /** @type {Record<string, string>} */
  let globalOverrides = {}
  let records = 0
  let zeroBlocks = 0
  let sawEnd = false
  let offset = 0

  while (offset < buffer.length) {
    if (offset + BLOCK > buffer.length) {
      throw new TarError('ERR_TAR_TRUNCATED', `tarball ends mid-header at byte ${String(offset)}`)
    }
    const header = buffer.subarray(offset, offset + BLOCK)
    offset += BLOCK

    if (isBlank(header)) {
      zeroBlocks += 1
      // Two consecutive zero blocks are the end-of-archive marker. Everything
      // after it is padding, and it must *be* padding: a parser that stops
      // here without looking sees a different archive than one that keeps
      // reading, and that disagreement is how content gets smuggled past a
      // scanner. So the tail is checked, not skipped.
      if (zeroBlocks === 2) {
        sawEnd = true
        const tail = buffer.subarray(offset)
        if (!isBlank(tail)) {
          throw new TarError('ERR_TAR_TRAILING_DATA', 'tarball carries data after the end-of-archive marker')
        }
        break
      }
      continue
    }
    zeroBlocks = 0

    records += 1
    if (records > maxEntries) {
      throw new TarError('ERR_TAR_TOO_MANY_ENTRIES', `tarball has more than ${String(maxEntries)} entries`)
    }

    // The checksum is validated before any other field is trusted, because the
    // field this guards is the one that decides how far the walk jumps next.
    const stated = parseOctal(header.subarray(148, 156))
    const { unsigned, signed } = checksums(header)
    if (stated === null || (stated !== unsigned && stated !== signed)) {
      throw new TarError('ERR_TAR_HEADER_CHECKSUM', `corrupt tar header at byte ${String(offset - BLOCK)}`)
    }

    // Only ustar. The `prefix` field this reader relies on for long paths does
    // not exist in pre-POSIX v7 tar, where those bytes are padding — reading
    // one as the other would invent a directory out of noise. Both spellings
    // are accepted: POSIX writes `ustar\0`, GNU writes `ustar  `.
    if (header.subarray(257, 262).toString('latin1') !== 'ustar') {
      throw new TarError('ERR_TAR_NOT_USTAR', 'not a ustar archive; npm tarballs always are')
    }

    const size = readSize(header, offset - BLOCK)
    const padded = Math.ceil(size / BLOCK) * BLOCK
    if (offset + padded > buffer.length) {
      throw new TarError('ERR_TAR_TRUNCATED', `tarball ends mid-entry at byte ${String(offset)}`)
    }
    const data = buffer.subarray(offset, offset + size)
    offset += padded

    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(/** @type {number} */ (header[156]))

    // Extension records carry metadata for what follows rather than content of
    // their own. `npm pack` emits these for real: a filename over 100 bytes
    // gets a pax `x` header (measured against npm 10, which also puts long
    // *directory* paths in `prefix` instead). Handling them is a few lines;
    // guessing at them would mean reading a pax payload as file content.
    if (typeflag === 'x') {
      nextOverrides = { ...nextOverrides, ...parsePax(data) }
      continue
    }
    if (typeflag === 'g') {
      globalOverrides = { ...globalOverrides, ...parsePax(data) }
      continue
    }
    if (typeflag === 'L') {
      nextOverrides = { ...nextOverrides, path: trimNul(data.toString('utf8')) }
      continue
    }
    if (typeflag === 'K') {
      // A GNU long *link* name. The entry it describes is a link, which the
      // next iteration rejects anyway, so the payload is simply consumed.
      continue
    }

    const overrides = { ...globalOverrides, ...nextOverrides }
    nextOverrides = {}

    // A pax `size` record overrides the header's, which is how files over 8 GiB
    // are expressed. npm emits it redundantly and identically, so a disagreement
    // means either corruption or a deliberate attempt to make two parsers see
    // different data lengths. Neither is worth accommodating.
    if (overrides.size !== undefined && String(size) !== overrides.size) {
      throw new TarError('ERR_TAR_BAD_SIZE', `pax size ${overrides.size} disagrees with the header's ${String(size)}`)
    }

    const rawPath = overrides.path ?? joinUstarName(header)

    if (typeflag === '1' || typeflag === '2') {
      const target = trimNul(header.subarray(157, 257).toString('utf8'))
      throw new TarError(
        'ERR_TAR_LINK',
        `refusing ${typeflag === '2' ? 'symlink' : 'hardlink'} ${JSON.stringify(rawPath)} -> ${JSON.stringify(target)};`
          + ' a plugin package has no reason to ship one, and a symlink is a path-escape primitive',
      )
    }
    if (typeflag === '5') continue
    // A trailing slash on a `0` entry is the pre-ustar way of writing a
    // directory, and GNU tar still reads it as one. Treat it the same rather
    // than creating a file whose name ends in a separator.
    if (typeflag === '0' && rawPath.replace(/\\/g, '/').endsWith('/')) continue
    if (typeflag !== '0') {
      throw new TarError(
        'ERR_TAR_UNSUPPORTED_ENTRY',
        `unsupported tar entry type ${JSON.stringify(typeflag)} for ${JSON.stringify(rawPath)};`
          + ' only regular files, directories and pax/GNU name records are accepted',
      )
    }

    const path = safeRelativePath(rawPath)
    if (seen.has(path)) {
      // Two entries with one path means the result depends on who extracts it
      // and in what order — the classic way to show a reviewer one file and
      // land another. npm never produces it.
      throw new TarError('ERR_TAR_DUPLICATE_PATH', `tarball contains ${JSON.stringify(path)} twice`)
    }
    seen.add(path)
    entries.push({ path, mode: readMode(header), bytes: data })
  }

  if (!sawEnd) {
    throw new TarError('ERR_TAR_TRUNCATED', 'tarball has no end-of-archive marker; the download is incomplete')
  }
  return entries
}

/**
 * The same read, as a lookup table — for callers that only want to *read* out
 * of the archive (the manifest, say) and never write it to disk.
 * @param {Buffer | Uint8Array} gzipped - the downloaded `.tgz` bytes.
 * @param {ReadTarballOptions} [options] - bounds, as `readTarball`.
 * @returns {Map<string, Buffer>} path (sans `package/`) to contents.
 * @throws {TarError} on anything `readTarball` rejects.
 */
export function tarballFiles(gzipped, options) {
  return new Map(readTarball(gzipped, options).map((entry) => [entry.path, entry.bytes]))
}

/**
 * Gunzip under a hard output ceiling.
 *
 * The bound belongs *here* rather than on the sum of entry sizes: zlib enforces
 * `maxOutputLength` while inflating, so a bomb is refused before the memory is
 * committed. Checking afterwards would mean the allocation already happened.
 * @param {Buffer | Uint8Array} gzipped - compressed input.
 * @param {number} maxTotalBytes - ceiling on the decompressed result.
 * @returns {Buffer} the decompressed archive.
 */
function inflate(gzipped, maxTotalBytes) {
  try {
    // A short or ragged stream is not checked for here on purpose: the walk's
    // own bounds checks catch it and name the offset, so there is one mechanism
    // for truncation rather than two that could disagree.
    return gunzipSync(gzipped, { maxOutputLength: maxTotalBytes })
  } catch (error) {
    const code = /** @type {{ code?: unknown }} */ (error).code
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new TarError('ERR_TAR_TOO_LARGE', `tarball expands beyond the ${String(maxTotalBytes)} byte limit`)
    }
    throw new TarError('ERR_TAR_GUNZIP', `not a gzip stream: ${describe(error)}`)
  }
}

/**
 * Reduce a tarball path to a relative path that cannot escape its target, and
 * strip the `package/` root every npm tarball has.
 *
 * **This is the security-critical function in this file.** Every entry path
 * reaches the filesystem through it, and each rejection below is a way out of
 * the extraction directory:
 *
 * - a leading `/` (or `//host/share`) makes the join absolute;
 * - a `C:` prefix does the same on Windows, and `C:foo` is drive-*relative*,
 *   which resolves against a working directory we do not control;
 * - a `..` component walks up out of the directory;
 * - an embedded NUL truncates the path inside any C-level syscall, so what the
 *   check sees and what the OS opens differ;
 * - a `:` inside a component names an NTFS alternate data stream, which writes
 *   bytes nothing later reads back.
 *
 * Backslashes are folded to `/` **first**, so a Windows-authored `..\..\evil`
 * cannot walk past checks written against `/`.
 *
 * Nothing here normalises: `a/./b` and `a//b` are refused rather than cleaned
 * up. Two extractors that normalise slightly differently is precisely where
 * path-escape bugs live, and no npm tarball needs it.
 * @param {string} raw - the entry path exactly as the archive spells it.
 * @returns {string} the path relative to `package/`.
 * @throws {TarError} if the path is unsafe, or outside `package/`.
 */
function safeRelativePath(raw) {
  const path = raw.replace(/\\/g, '/')
  /** @param {string} why - the specific rule that refused it. */
  const refuse = (why) => {
    throw new TarError('ERR_TAR_UNSAFE_PATH', `refusing tar entry ${JSON.stringify(raw)}: ${why}`)
  }
  if (path.length === 0) refuse('empty path')
  if (path.includes('\0')) refuse('embedded NUL')
  if (path.startsWith('/')) refuse('absolute path')
  if (/^[A-Za-z]:/.test(path)) refuse('Windows drive-qualified path')

  const parts = path.split('/')
  for (const part of parts) {
    if (part === '..') refuse('`..` component')
    if (part === '.') refuse('`.` component')
    if (part === '') refuse('empty path component')
    if (part.includes(':')) refuse('`:` in a component (NTFS alternate data stream)')
  }

  // A tarball with content outside `package/` is not an npm package, whatever
  // else it might be.
  if (parts[0] !== ROOT) {
    throw new TarError(
      'ERR_TAR_OUTSIDE_PACKAGE',
      `tar entry ${JSON.stringify(raw)} is not under ${ROOT}/; this is not an npm package tarball`,
    )
  }
  if (parts.length === 1) refuse(`nothing under ${ROOT}/`)
  return parts.slice(1).join('/')
}

/**
 * The entry path as the ustar header spells it: `prefix` + `/` + `name`, which
 * is how npm writes any path over 100 bytes whose split lands on a separator.
 * @param {Buffer} header - the 512-byte header block.
 * @returns {string} the joined path.
 */
function joinUstarName(header) {
  const name = trimNul(header.subarray(0, 100).toString('utf8'))
  const prefix = trimNul(header.subarray(345, 500).toString('utf8'))
  return prefix.length > 0 ? `${prefix}/${name}` : name
}

/**
 * Read the entry's data length.
 * @param {Buffer} header - the 512-byte header block.
 * @param {number} at - byte offset of the header, for the message.
 * @returns {number} the length in bytes.
 * @throws {TarError} on a base-256 or malformed field.
 */
function readSize(header, at) {
  const field = header.subarray(124, 136)
  // GNU's base-256 encoding flags itself with the high bit of the first byte.
  // npm never emits one (it needs a >8 GiB member), and reading one as octal
  // yields a wildly wrong jump — so refuse instead of guessing.
  if (((field[0] ?? 0) & 0x80) !== 0) {
    throw new TarError('ERR_TAR_UNSUPPORTED_ENTRY', `base-256 size field at byte ${String(at)} is not supported`)
  }
  if (isBlank(field)) return 0
  const size = parseOctal(field)
  if (size === null) {
    throw new TarError('ERR_TAR_BAD_SIZE', `unreadable size field at byte ${String(at)}`)
  }
  return size
}

/**
 * Read the permission bits.
 *
 * Masked to `0o777`: setuid, setgid and the sticky bit are dropped rather than
 * carried through, because a file inside a downloaded plugin has no business
 * asking for any of them and this reader is the last place that can say no.
 *
 * This is the one field that falls back instead of failing. A blank field means
 * the tar was written without modes, and an unreadable one cannot make an entry
 * unsafe once masked — unlike the size and the path, where a wrong guess decides
 * what gets read and where it lands. 0644 is what npm writes for a plain file.
 * @param {Buffer} header - the 512-byte header block.
 * @returns {number} permission bits.
 */
function readMode(header) {
  const field = header.subarray(100, 108)
  if (isBlank(field)) return 0o644
  return (parseOctal(field) ?? 0o644) & 0o777
}

/**
 * Parse a pax extended-header payload: a run of
 * `"<decimal length> <key>=<value>\n"` records, where the length counts the
 * whole record including its own digits.
 * @param {Buffer} data - the pax entry's payload.
 * @returns {Record<string, string>} the records, last of a repeated key wins.
 * @throws {TarError} on a malformed record, or one we must not silently ignore.
 */
function parsePax(data) {
  /** @type {Record<string, string>} */
  const records = {}
  let pos = 0
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos)
    const length = space === -1 ? null : parseDecimal(data.subarray(pos, space))
    if (length === null || length < space - pos + 2 || pos + length > data.length) {
      throw new TarError('ERR_TAR_PAX', `malformed pax record at byte ${String(pos)} of the extended header`)
    }
    if (data[pos + length - 1] !== 0x0a) {
      throw new TarError('ERR_TAR_PAX', `pax record at byte ${String(pos)} is not newline-terminated`)
    }
    const text = data.subarray(space + 1, pos + length - 1).toString('utf8')
    const eq = text.indexOf('=')
    if (eq <= 0) {
      throw new TarError('ERR_TAR_PAX', `pax record at byte ${String(pos)} has no key=value`)
    }
    const key = text.slice(0, eq)
    // Sparse-file records change what the data blocks *mean*, so ignoring them
    // the way we ignore `mtime` would hand back scrambled file contents.
    if (key.startsWith('GNU.sparse')) {
      throw new TarError(
        'ERR_TAR_PAX',
        'sparse-file tarballs are not supported; repack the plugin with `npm pack`',
      )
    }
    records[key] = text.slice(eq + 1)
    pos += length
  }
  return records
}

/**
 * Both readings of the ustar header checksum: the field is summed as unsigned
 * bytes by POSIX, but historic tars signed them, so a valid archive may match
 * either. Its own eight bytes count as spaces.
 * @param {Buffer} header - the 512-byte header block.
 * @returns {{ unsigned: number, signed: number }} the two sums.
 */
function checksums(header) {
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0)
    unsigned += byte
    signed += byte < 0x80 ? byte : byte - 0x100
  }
  return { unsigned, signed }
}

/**
 * @param {Uint8Array} field - bytes to test.
 * @returns {boolean} true when every byte is NUL or space.
 */
function isBlank(field) {
  return field.every((byte) => byte === 0 || byte === 0x20)
}

/**
 * @param {Uint8Array} field - a NUL/space-terminated octal ASCII field.
 * @returns {number | null} the value, or null if it is not readable as one.
 */
function parseOctal(field) {
  const text = Buffer.from(field).toString('latin1').replace(/\0[\s\S]*$/, '').trim()
  if (!/^[0-7]+$/.test(text)) return null
  const value = Number.parseInt(text, 8)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * @param {Uint8Array} field - decimal ASCII digits.
 * @returns {number | null} the value, or null if it is not readable as one.
 */
function parseDecimal(field) {
  const text = Buffer.from(field).toString('latin1')
  if (!/^[0-9]+$/.test(text)) return null
  const value = Number.parseInt(text, 10)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * @param {string} text - a fixed-width field decoded whole.
 * @returns {string} the text up to its first NUL.
 */
function trimNul(text) {
  const nul = text.indexOf('\0')
  return nul === -1 ? text : text.slice(0, nul)
}

/**
 * @param {unknown} error - a thrown value of unknown shape.
 * @returns {string} something safe to put in a message.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
