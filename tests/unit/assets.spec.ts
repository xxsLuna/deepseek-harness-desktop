/**
 * The shipped image assets.
 *
 * Alpha is not cosmetic here. macOS derives a template image ENTIRELY from the
 * alpha channel, so an opaque tray PNG renders as a filled block instead of a
 * glyph; and an opaque app icon is a hard-edged square where every other app
 * shows a rounded one. Neither is colour: the platforms that draw the tray
 * image as given (Windows, Linux) need one that carries some, or the mark is a
 * black shape on a black taskbar. All of it is silent — nothing fails, it just
 * looks wrong — so it is asserted.
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const assets = join(import.meta.dirname, '..', '..', 'assets')

interface PngHeader {
  width: number
  height: number
  bitDepth: number
  colorType: number
}

/**
 * Read a PNG's IHDR.
 * @param file - asset filename under assets/.
 * @returns the header fields.
 */
function header(file: string): PngHeader {
  const data = readFileSync(join(assets, file))
  const at = data.indexOf('IHDR') + 4
  return {
    width: data.readUInt32BE(at),
    height: data.readUInt32BE(at + 4),
    bitDepth: data.readUInt8(at + 8),
    colorType: data.readUInt8(at + 9),
  }
}

/** PNG colour type 6 is truecolour with alpha. */
const RGBA = 6

/**
 * Decode one RGBA PNG far enough to sample alpha. Only the filters the writer
 * emits are handled; an unexpected one throws rather than reporting a wrong
 * pixel.
 * @param file - asset filename under assets/.
 * @returns image width and per-channel samplers.
 */
function decodeRgba(file: string): {
  width: number
  alphaAt: (x: number, y: number) => number
  rgbAt: (x: number, y: number) => [number, number, number]
} {
  const data = readFileSync(join(assets, file))
  const { width, height, colorType } = header(file)
  if (colorType !== RGBA) throw new Error(`${file}: expected RGBA, got colour type ${String(colorType)}`)

  const parts: Buffer[] = []
  for (let at = 8; at < data.byteLength;) {
    const length = data.readUInt32BE(at)
    const type = data.subarray(at + 4, at + 8).toString('latin1')
    if (type === 'IDAT') parts.push(data.subarray(at + 8, at + 8 + length))
    at += 12 + length
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
      const left = x >= 4 ? out[x - 4]! : 0
      const up = prior[x]!
      const value = line[x]!
      if (filter === 0) out[x] = value
      else if (filter === 1) out[x] = (value + left) & 0xFF
      else if (filter === 2) out[x] = (value + up) & 0xFF
      else if (filter === 3) out[x] = (value + ((left + up) >> 1)) & 0xFF
      else throw new Error(`${file}: unhandled PNG filter ${String(filter)}`)
    }
  }
  return {
    width,
    alphaAt: (x, y) => pixels[y * stride + x * 4 + 3]!,
    rgbAt: (x, y) => [pixels[y * stride + x * 4]!, pixels[y * stride + x * 4 + 1]!, pixels[y * stride + x * 4 + 2]!],
  }
}

describe('shipped image assets', () => {
  it('ships an app icon large enough for electron-builder to derive .icns and .ico', () => {
    const icon = header('icon.png')
    expect(icon.width).toBe(icon.height)
    expect(icon.width).toBeGreaterThanOrEqual(512)
    expect(icon.colorType).toBe(RGBA)
  })

  it('ships tray images whose shape lives in the alpha channel', () => {
    // A macOS template image carries no colour information — only alpha.
    for (const file of ['trayTemplate.png', 'trayTemplate@2x.png']) {
      expect(header(file).colorType, file).toBe(RGBA)
      const { width, rgbAt, alphaAt } = decodeRgba(file)
      expect(rgbAt(Math.floor(width / 2), Math.floor(width / 2)), file).toEqual([0, 0, 0])
      expect(alphaAt(Math.floor(width / 2), Math.floor(width / 2)), file).toBeGreaterThan(0)
    }
    // The @2x sibling must be exactly double, or macOS ignores it.
    expect(header('trayTemplate@2x.png').width).toBe(header('trayTemplate.png').width * 2)
  })

  it('ships a window icon carrying the frames Windows asks a window for', () => {
    // A window icon must BE 16x16 and 32x32. Handed one oversized bitmap the
    // shell rejects it and falls back to the window class icon — the running
    // executable's — so the app shows Electron's atom on the taskbar with no
    // error anywhere. Read the icon directory and require both frames.
    const ico = readFileSync(join(assets, 'icon.ico'))
    expect(ico.readUInt16LE(0), 'reserved').toBe(0)
    expect(ico.readUInt16LE(2), 'type must be 1 (icon)').toBe(1)
    const count = ico.readUInt16LE(4)
    expect(count).toBeGreaterThan(0)

    const frames = new Map<number, { bytes: number, offset: number }>()
    for (let index = 0; index < count; index += 1) {
      const at = 6 + index * 16
      // The size fields are one byte each; 0 means 256.
      const width = ico.readUInt8(at) === 0 ? 256 : ico.readUInt8(at)
      expect(ico.readUInt8(at + 1) === 0 ? 256 : ico.readUInt8(at + 1), 'square').toBe(width)
      frames.set(width, { bytes: ico.readUInt32LE(at + 8), offset: ico.readUInt32LE(at + 12) })
    }
    for (const size of [16, 32]) {
      expect([...frames.keys()], `no ${String(size)}px frame`).toContain(size)
    }
    // electron-builder finds this file in buildResources and uses it as the
    // .exe icon too, refusing anything whose largest frame is under 256. That
    // fails packaging rather than runtime, so it is pinned here.
    expect(Math.max(...frames.keys()), 'electron-builder needs a 256px frame').toBeGreaterThanOrEqual(256)
    // Every frame must actually lie inside the file, and be a 32-bit DIB of
    // its declared size — a truncated or mis-sized entry decodes as garbage.
    for (const [size, { bytes, offset }] of frames) {
      expect(offset + bytes, `${String(size)}px frame runs past EOF`).toBeLessThanOrEqual(ico.byteLength)
      expect(ico.readUInt32LE(offset), `${String(size)}px header`).toBe(40)
      expect(ico.readInt32LE(offset + 4), `${String(size)}px width`).toBe(size)
      // Height is doubled: the XOR bits and the AND mask are stacked.
      expect(ico.readInt32LE(offset + 8), `${String(size)}px height`).toBe(size * 2)
      expect(ico.readUInt16LE(offset + 14), `${String(size)}px depth`).toBe(32)
    }
  })

  it('ships a coloured tray image for the platforms that draw it as given', () => {
    // Windows and Linux do not recolour anything: handed the macOS template
    // they would show a black mark, which vanishes on a dark taskbar.
    for (const file of ['tray.png', 'tray@2x.png']) {
      expect(header(file).colorType, file).toBe(RGBA)
      const { width, rgbAt } = decodeRgba(file)
      const [r, g, b] = rgbAt(Math.floor(width / 2), Math.floor(width / 2))
      expect(b, `${file} is not the brand blue`).toBeGreaterThan(Math.max(r, g) + 40)
    }
    // Sized for a 16px tray slot, with the @2x sibling nativeImage looks for.
    expect(header('tray.png').width).toBe(16)
    expect(header('tray@2x.png').width).toBe(32)
  })

  it('has transparent corners on the app icon, so the Dock shows a rounded tile', () => {
    // An RGBA icon can still be fully opaque, which colourType alone cannot
    // catch — decode the top-left pixel and require it to be transparent.
    const { width, alphaAt } = decodeRgba('icon.png')
    expect(alphaAt(0, 0)).toBe(0)
    expect(alphaAt(width - 1, 0)).toBe(0)
    // ...while the middle is opaque artwork, not an empty canvas.
    expect(alphaAt(Math.floor(width / 2), Math.floor(width / 2))).toBe(255)
  })
})
