/**
 * Generate Weport PNG/ICO icons — monochrome white mark on transparent.
 *
 * Single source of truth for every icon the app ships:
 *   src-tauri/icons/*   → bundle icons, NSIS installer icon, exe resource icon
 *   assets/icons/icon.png → window icon embedded by gui.rs
 *
 * The design is the white "signal plate": a rounded-square outline ring,
 * three signal bars and one square — all white, background fully transparent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const iconsDir = path.resolve(__dirname, '..', 'src-tauri', 'icons')
const assetsDir = path.resolve(__dirname, '..', 'assets', 'icons')
fs.mkdirSync(iconsDir, { recursive: true })
fs.mkdirSync(assetsDir, { recursive: true })

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

  const white = [255, 255, 255, 255]
  const smoothstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }

  const pad = 0.075
  const ring = 0.085

  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4
      const nx = (x + 0.5) / width
      const ny = (y + 0.5) / height

      // Distance to the rounded-square plate edge (positive = inside plate)
      const dx = Math.max(nx - pad, pad + 1 - nx, 0)
      const dy = Math.max(ny - pad, pad + 1 - ny, 0)
      const edgeDist = Math.max(dx, dy)

      let alpha = 0

      // White ring: plate border band
      if (edgeDist >= -ring && edgeDist <= 0.012) {
        const t = 1 - Math.abs(edgeDist) / ring
        alpha = Math.max(alpha, smoothstep(0, 0.5, t))
      }

      // Three signal bars + signal square (white)
      const bars = [
        [0.34, 0.42, 0.26, 0.76],
        [0.48, 0.56, 0.26, 0.62],
        [0.62, 0.7, 0.26, 0.72]
      ]
      for (const [y0, y1, x0, x1] of bars) {
        if (ny >= y0 && ny <= y1 && nx >= x0 && nx <= x1) {
          alpha = 1
        }
      }
      if (nx >= 0.72 && nx <= 0.82 && ny >= 0.48 && ny <= 0.58) {
        alpha = 1
      }

      // Soft AA on the ring
      if (alpha > 0 && alpha < 1) {
        // keep fractional ring alpha as-is
      }

      raw[i] = white[0]
      raw[i + 1] = white[1]
      raw[i + 2] = white[2]
      raw[i + 3] = Math.round(255 * Math.min(1, alpha))
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

const png32 = createPng(32)
const png128 = createPng(128)
const png256 = createPng(256)
const png512 = createPng(512)
const ico = createIco([16, 32, 48, 64, 128, 256])

// Tauri bundle icons
fs.writeFileSync(path.join(iconsDir, '32x32.png'), png32)
fs.writeFileSync(path.join(iconsDir, '128x128.png'), png128)
fs.writeFileSync(path.join(iconsDir, '128x128@2x.png'), png256)
fs.writeFileSync(path.join(iconsDir, 'icon.png'), png256)
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico)

// Universal window-icon copy (embedded by gui.rs)
fs.writeFileSync(path.join(assetsDir, 'icon.png'), png512)

function createIcns() {
  const entries = [
    { type: 'ic07', data: png128 },
    { type: 'ic08', data: png256 },
    { type: 'ic09', data: png512 },
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
console.log('White icons written to', iconsDir)
console.log('Universal window icon written to', assetsDir)
