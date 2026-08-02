/**
 * Generate Weport PNG/ICO icons without external deps (pure Node).
 * Creates a compact amber-on-graphite mark suitable for Windows installers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const iconsDir = path.resolve(__dirname, '..', 'src-tauri', 'icons')
fs.mkdirSync(iconsDir, { recursive: true })

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crcBuf = Buffer.alloc(4)
  const crc = crc32(Buffer.concat([typeBuf, data]))
  crcBuf.writeUInt32BE(crc)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function createPng(size) {
  const width = size
  const height = size
  const raw = Buffer.alloc((width * 4 + 1) * height)

  const bg = [18, 21, 28, 255]
  const accent = [232, 162, 58, 255]
  const dark = [26, 18, 6, 255]

  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4
      const nx = (x + 0.5) / width
      const ny = (y + 0.5) / height
      // rounded square background
      const inset = 0.08
      const rx = Math.min(Math.max(nx, inset), 1 - inset)
      const ry = Math.min(Math.max(ny, inset), 1 - inset)
      const inRound =
        nx > inset && nx < 1 - inset && ny > inset && ny < 1 - inset

      let px = bg
      if (inRound) {
        // soft fill
        px = [bg[0] + 8, bg[1] + 10, bg[2] + 14, 255]
        // amber plate
        const plate =
          nx > 0.18 && nx < 0.82 && ny > 0.18 && ny < 0.82
        if (plate) {
          const g = 0.85 + 0.15 * (1 - ny)
          px = [
            Math.round(accent[0] * g),
            Math.round(accent[1] * g),
            Math.round(accent[2] * g),
            255
          ]
          // three horizontal bars (export mark)
          const bars = [
            [0.34, 0.42, 0.28, 0.72],
            [0.48, 0.56, 0.28, 0.58],
            [0.62, 0.70, 0.28, 0.68]
          ]
          for (const [y0, y1, x0, x1] of bars) {
            if (ny >= y0 && ny <= y1 && nx >= x0 && nx <= x1) {
              px = dark
            }
          }
          // signal dot
          const dx = nx - 0.72
          const dy = ny - 0.52
          if (dx * dx + dy * dy < 0.012) {
            px = dark
          }
        }
      } else {
        px = [0, 0, 0, 0]
      }
      raw[i] = px[0]
      raw[i + 1] = px[1]
      raw[i + 2] = px[2]
      raw[i + 3] = px[3]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const compressed = zlib.deflateSync(raw, { level: 9 })
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function createIco(sizes) {
  // ICO with embedded PNGs (Vista+)
  const images = sizes.map((s) => ({ size: s, png: createPng(s) }))
  const headerSize = 6
  const dirEntrySize = 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let offset = headerSize + dirEntrySize * images.length
  const entries = []
  const blobs = []
  for (const img of images) {
    const entry = Buffer.alloc(dirEntrySize)
    entry[0] = img.size >= 256 ? 0 : img.size
    entry[1] = img.size >= 256 ? 0 : img.size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(img.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += img.png.length
    entries.push(entry)
    blobs.push(img.png)
  }
  return Buffer.concat([header, ...entries, ...blobs])
}

// Minimal ICNS (mac optional) — write PNG set only if needed; create placeholder icns via iconutil alternative: store pngs
const png32 = createPng(32)
const png128 = createPng(128)
const png256 = createPng(256)
const ico = createIco([16, 32, 48, 64, 128, 256])

fs.writeFileSync(path.join(iconsDir, '32x32.png'), png32)
fs.writeFileSync(path.join(iconsDir, '128x128.png'), png128)
fs.writeFileSync(path.join(iconsDir, '128x128@2x.png'), png256)
fs.writeFileSync(path.join(iconsDir, 'icon.png'), png256)
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico)

// Tauri also accepts icon.icns — write a minimal multi-png icns
function createIcns() {
  // Use 'ic07' (128), 'ic08' (256), 'ic09' (512->use 256), 'ic12' (32@2x=64) simplified: only ic08 + ic07
  const entries = [
    { type: 'ic07', data: png128 },
    { type: 'ic08', data: png256 },
    { type: 'ic12', data: createPng(64) },
    { type: 'ic13', data: png256 }
  ]
  const chunks = []
  for (const e of entries) {
    const type = Buffer.from(e.type, 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(e.data.length + 8)
    chunks.push(Buffer.concat([type, len, e.data]))
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0)
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

fs.writeFileSync(path.join(iconsDir, 'icon.icns'), createIcns())
console.log('Icons written to', iconsDir)
