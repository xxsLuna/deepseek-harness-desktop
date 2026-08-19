// Derive every shipped icon from assets/icon.png, so the window, the tray and
// the installer all show the same mark. Run after changing the app icon:
//
//   node scripts/make-icons.mjs
//
// Two shapes come out of the one source:
//
//   icon.ico    the whole tile, at the sizes Windows asks a window for. A
//               window icon must BE 16x16 and 32x32: handed one large bitmap
//               for both, the shell rejects it and falls back to the window
//               class icon, which in a dev run is electron.exe's (measured).
//   tray*.png   just the mark. The tile is a white rounded square — the right
//               shape for a Dock or Start tile, unreadable in a 16px tray
//               slot. The mark is the only blue in the image, so it is
//               separated by hue, cropped to its own bounds and rescaled:
//               coloured for the Windows and Linux trays, and as a pure-alpha
//               silhouette for the macOS template image the menu bar recolours.
//
// The codecs are written out here rather than pulled in: the repo has no image
// dependency, and this reads one fixed format (8-bit RGBA PNG) and writes two.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

const ASSETS = join(import.meta.dirname, '..', 'assets')

/**
 * Decode an 8-bit RGBA PNG.
 * @param {string} file - path to the PNG.
 * @returns {{ width: number, height: number, pixels: Buffer }} the image.
 */
function decode(file) {
  const data = readFileSync(file)
  const at = data.indexOf('IHDR') + 4
  const width = data.readUInt32BE(at)
  const height = data.readUInt32BE(at + 4)
  if (data.readUInt8(at + 8) !== 8 || data.readUInt8(at + 9) !== 6) {
    throw new Error(`${file}: expected 8-bit RGBA`)
  }
  const parts = []
  for (let i = 8; i < data.byteLength;) {
    const length = data.readUInt32BE(i)
    if (data.subarray(i + 4, i + 8).toString('latin1') === 'IDAT') {
      parts.push(data.subarray(i + 8, i + 8 + length))
    }
    i += 12 + length
  }
  const raw = inflateSync(Buffer.concat(parts))

  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prior = y === 0 ? Buffer.alloc(stride) : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? out[x - 4] : 0
      const up = prior[x]
      const upLeft = x >= 4 ? prior[x - 4] : 0
      const value = line[x]
      if (filter === 0) out[x] = value
      else if (filter === 1) out[x] = (value + left) & 0xFF
      else if (filter === 2) out[x] = (value + up) & 0xFF
      else if (filter === 3) out[x] = (value + ((left + up) >> 1)) & 0xFF
      else if (filter === 4) {
        const p = left + up - upLeft
        const dl = Math.abs(p - left)
        const du = Math.abs(p - up)
        const dul = Math.abs(p - upLeft)
        out[x] = (value + (dl <= du && dl <= dul ? left : du <= dul ? up : upLeft)) & 0xFF
      } else throw new Error(`${file}: unhandled PNG filter ${String(filter)}`)
    }
  }
  return { width, height, pixels }
}

/**
 * CRC-32 over a buffer, per the PNG spec.
 * @param {Buffer} buffer - bytes to sum.
 * @returns {number} the checksum.
 */
function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

/**
 * Frame one PNG chunk.
 * @param {string} type - the four-character chunk type.
 * @param {Buffer} data - the chunk payload.
 * @returns {Buffer} length + type + data + CRC.
 */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.byteLength)
  out.writeUInt32BE(data.byteLength, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return out
}

/**
 * Write an 8-bit RGBA PNG, one unfiltered scanline per row.
 * @param {string} file - path to write.
 * @param {{ width: number, height: number, pixels: Buffer }} image - the image.
 */
function encode(file, { width, height, pixels }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(6, 9)
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

/**
 * Keep only the blue mark, dropping the white tile it sits on.
 * @param {{ width: number, height: number, pixels: Buffer }} image - the app icon.
 * @returns {{ width: number, height: number, pixels: Buffer }} the mark alone.
 */
function isolateMark({ width, height, pixels }) {
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4
    const [r, g, b, a] = [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]]
    if (a > 8 && b > r + 40 && b > g + 40) {
      out[at] = r
      out[at + 1] = g
      out[at + 2] = b
      out[at + 3] = a
    }
  }
  return { width, height, pixels: out }
}

/**
 * The smallest square covering everything visible, centred on it. Square, so
 * rescaling to a square canvas never distorts the mark.
 * @param {{ width: number, height: number, pixels: Buffer }} image - the source.
 * @returns {{ x: number, y: number, side: number }} the crop.
 */
function markSquare({ width, height, pixels }) {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] <= 8) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  const side = Math.max(right - left + 1, bottom - top + 1)
  return {
    x: Math.round((left + right) / 2 - side / 2),
    y: Math.round((top + bottom) / 2 - side / 2),
    side,
  }
}

/**
 * Box-filter a square source region down to size×size. Colour is weighted by
 * alpha, or the transparent pixels around the mark would drag its edges toward
 * black; the result is written straight (not premultiplied).
 * @param {{ width: number, height: number, pixels: Buffer }} image - the source.
 * @param {{ x: number, y: number, side: number }} crop - the region to take.
 * @param {number} size - the output edge.
 * @returns {{ width: number, height: number, pixels: Buffer }} the scaled image.
 */
function rescale({ width, height, pixels }, crop, size) {
  const out = Buffer.alloc(size * size * 4)
  const step = crop.side / size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, alpha = 0, count = 0
      const y0 = Math.round(crop.y + y * step), y1 = Math.round(crop.y + (y + 1) * step)
      const x0 = Math.round(crop.x + x * step), x1 = Math.round(crop.x + (x + 1) * step)
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          count += 1
          if (sy < 0 || sy >= height || sx < 0 || sx >= width) continue
          const at = (sy * width + sx) * 4
          const weight = pixels[at + 3] / 255
          r += pixels[at] * weight
          g += pixels[at + 1] * weight
          b += pixels[at + 2] * weight
          alpha += pixels[at + 3]
        }
      }
      const at = (y * size + x) * 4
      const opacity = alpha / count / 255
      out[at] = opacity === 0 ? 0 : Math.round(r / count / opacity)
      out[at + 1] = opacity === 0 ? 0 : Math.round(g / count / opacity)
      out[at + 2] = opacity === 0 ? 0 : Math.round(b / count / opacity)
      out[at + 3] = Math.round(alpha / count)
    }
  }
  return { width: size, height: size, pixels: out }
}

/**
 * Centre an image on a larger transparent canvas.
 * @param {{ width: number, height: number, pixels: Buffer }} image - the glyph.
 * @param {number} size - the canvas edge.
 * @returns {{ width: number, height: number, pixels: Buffer }} the padded image.
 */
function centre({ width, height, pixels }, size) {
  const out = Buffer.alloc(size * size * 4)
  const dx = Math.round((size - width) / 2)
  const dy = Math.round((size - height) / 2)
  for (let y = 0; y < height; y += 1) {
    const from = y * width * 4
    pixels.copy(out, ((y + dy) * size + dx) * 4, from, from + width * 4)
  }
  return { width: size, height: size, pixels: out }
}

/**
 * Drop all colour, keeping the shape in alpha — what macOS reads a template
 * image from.
 * @param {{ width: number, height: number, pixels: Buffer }} image - the glyph.
 * @returns {{ width: number, height: number, pixels: Buffer }} the silhouette.
 */
function silhouette({ width, height, pixels }) {
  const out = Buffer.from(pixels)
  for (let i = 0; i < width * height; i += 1) {
    out[i * 4] = 0
    out[i * 4 + 1] = 0
    out[i * 4 + 2] = 0
  }
  return { width, height, pixels: out }
}

/**
 * One icon directory entry's image, as a 32-bit bottom-up DIB with the 1-bit
 * AND mask the format still requires. Alpha carries the transparency, so the
 * mask is all zeros — but it must be present and row-padded to 4 bytes, or the
 * entry decodes as garbage.
 * @param {{ width: number, height: number, pixels: Buffer }} image - the frame.
 * @returns {Buffer} BITMAPINFOHEADER + XOR bits + AND mask.
 */
function dib({ width, height, pixels }) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height * 2, 8) // XOR and AND stacked
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)

  const xor = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((height - 1 - y) * width + x) * 4 // bottom-up
      const to = (y * width + x) * 4
      xor[to] = pixels[from + 2] // BGRA
      xor[to + 1] = pixels[from + 1]
      xor[to + 2] = pixels[from]
      xor[to + 3] = pixels[from + 3]
    }
  }
  return Buffer.concat([header, xor, Buffer.alloc((((width + 31) >> 5) << 2) * height)])
}

/**
 * Write a Windows .ico holding one frame per size.
 * @param {string} file - path to write.
 * @param {{ width: number, height: number, pixels: Buffer }[]} frames - the frames.
 */
function encodeIco(file, frames) {
  const directory = Buffer.alloc(6 + frames.length * 16)
  directory.writeUInt16LE(1, 2) // 1 = icon
  directory.writeUInt16LE(frames.length, 4)

  const bodies = frames.map(dib)
  let offset = directory.byteLength
  frames.forEach((frame, index) => {
    const at = 6 + index * 16
    // 256 is stored as 0: the field is one byte.
    directory.writeUInt8(frame.width === 256 ? 0 : frame.width, at)
    directory.writeUInt8(frame.height === 256 ? 0 : frame.height, at + 1)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(bodies[index].byteLength, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += bodies[index].byteLength
  })
  writeFileSync(file, Buffer.concat([directory, ...bodies]))
}

const icon = decode(join(ASSETS, 'icon.png'))
const mark = isolateMark(icon)
const crop = markSquare(mark)

// The window icon, and — because it sits in buildResources under the name
// electron-builder looks for — the icon it writes into the .exe as well.
//
// 16 and 32 are the two sizes Windows actually asks a WINDOW for (SM_CXSMICON
// / SM_CXICON) and the reason this file exists at all. 256 is here for
// electron-builder, which refuses an app icon smaller than that; dropping it
// fails packaging, not runtime, so tests/unit pins it.
const tile = { x: 0, y: 0, side: icon.width }
encodeIco(join(ASSETS, 'icon.ico'), [16, 24, 32, 48, 64, 128, 256].map((size) => rescale(icon, tile, size)))

// Windows and Linux trays: the mark in colour, filling the tray box. The @2x
// sibling is picked up by nativeImage for high-DPI screens.
encode(join(ASSETS, 'tray.png'), rescale(mark, crop, 16))
encode(join(ASSETS, 'tray@2x.png'), rescale(mark, crop, 32))

// macOS: an 18px glyph on the 22px canvas the menu bar expects, shape in alpha.
encode(join(ASSETS, 'trayTemplate.png'), centre(silhouette(rescale(mark, crop, 18)), 22))
encode(join(ASSETS, 'trayTemplate@2x.png'), centre(silhouette(rescale(mark, crop, 36)), 44))

console.log('wrote icon.ico, tray.png, tray@2x.png, trayTemplate.png, trayTemplate@2x.png')
