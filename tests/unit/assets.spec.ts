/**
 * The shipped image assets.
 *
 * Alpha is not cosmetic here. macOS derives a template image ENTIRELY from the
 * alpha channel, so an opaque tray PNG renders as a filled block instead of a
 * glyph; and an opaque app icon is a hard-edged square where every other app
 * shows a rounded one. Both are silent — nothing fails, it just looks wrong —
 * so they are asserted.
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
 * @returns image width and an alpha sampler.
 */
function decodeRgba(file: string): { width: number, alphaAt: (x: number, y: number) => number } {
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
  return { width, alphaAt: (x, y) => pixels[y * stride + x * 4 + 3]! }
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
    }
    // The @2x sibling must be exactly double, or macOS ignores it.
    expect(header('trayTemplate@2x.png').width).toBe(header('trayTemplate.png').width * 2)
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
