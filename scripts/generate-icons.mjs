/**
 * Generate Weport PNG/ICO icons — white WeChat-style mark on transparent.
 *
 * Single source of truth for every icon the app ships:
 *   src-tauri/icons/*   → bundle icons, NSIS installer icon, exe resource icon
 *   assets/icons/icon.png → window icon embedded by gui.rs
 *
 * Design: classic dual speech-bubble silhouette (WeChat-like), solid white
 * on fully transparent background. Readable at 16–256px.
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

function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

/** True if (px,py) is inside a rounded rectangle centered at (cx,cy). */
function inRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx)
  const dy = Math.abs(py - cy)
  if (dx > hw || dy > hh) return false
  if (dx <= hw - r || dy <= hh - r) return true
  const ex = dx - (hw - r)
  const ey = dy - (hh - r)
  return ex * ex + ey * ey <= r * r
}

/** Barycentric point-in-triangle. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax
  const v0y = cy - ay
  const v1x = bx - ax
  const v1y = by - ay
  const v2x = px - ax
  const v2y = py - ay
  const dot00 = v0x * v0x + v0y * v0y
  const dot01 = v0x * v1x + v0y * v1y
  const dot02 = v0x * v2x + v0y * v2y
  const dot11 = v1x * v1x + v1y * v1y
  const dot12 = v1x * v2x + v1y * v2y
  const inv = 1 / (dot00 * dot11 - dot01 * dot01)
  const u = (dot11 * dot02 - dot01 * dot12) * inv
  const v = (dot00 * dot12 - dot01 * dot02) * inv
  return u >= 0 && v >= 0 && u + v < 1
}

function inCircle(px, py, cx, cy, r) {
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * Soft edge: sample 4 subpixels for AA.
 * Primary bubble bottom-left, secondary top-right — WeChat dual-chat mark.
 */
function sampleMark(nx, ny) {
  // Primary (larger) bubble
  const pBody = { cx: 0.4, cy: 0.56, hw: 0.28, hh: 0.22, r: 0.11 }
  const pTail = { ax: 0.2, ay: 0.72, bx: 0.34, by: 0.78, tx: 0.12, ty: 0.9 }

  // Secondary (smaller) bubble
  const sBody = { cx: 0.68, cy: 0.34, hw: 0.18, hh: 0.14, r: 0.08 }
  const sTail = { ax: 0.74, ay: 0.46, bx: 0.82, by: 0.48, tx: 0.9, ty: 0.58 }

  const eyes = [
    [0.3, 0.54, 0.032],
    [0.46, 0.54, 0.032],
    [0.62, 0.33, 0.026],
    [0.74, 0.33, 0.026]
  ]

  let inside =
    inRoundRect(nx, ny, pBody.cx, pBody.cy, pBody.hw, pBody.hh, pBody.r) ||
    inTriangle(nx, ny, pTail.ax, pTail.ay, pTail.bx, pTail.by, pTail.tx, pTail.ty) ||
    inRoundRect(nx, ny, sBody.cx, sBody.cy, sBody.hw, sBody.hh, sBody.r) ||
    inTriangle(nx, ny, sTail.ax, sTail.ay, sTail.bx, sTail.by, sTail.tx, sTail.ty)

  if (!inside) return 0

  // Eye cutouts
  for (const [ex, ey, er] of eyes) {
    if (inCircle(nx, ny, ex, ey, er)) return 0
  }
  return 1
}

function createPng(size) {
  const width = size
  const height = size
  const raw = Buffer.alloc((width * 4 + 1) * height)
  // 2x2 supersampling for smoother edges at small sizes
  const ss = size <= 48 ? 2 : 1

  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / width
          const ny = (y + (sy + 0.5) / ss) / height
          acc += sampleMark(nx, ny)
        }
      }
      const a = clamp01(acc / (ss * ss))
      const i = row + 1 + x * 4
      raw[i] = 255
      raw[i + 1] = 255
      raw[i + 2] = 255
      raw[i + 3] = Math.round(255 * a)
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

/** Black rounded plate + white WeChat mark — always visible in the system tray. */
function createTrayPng(size) {
  const width = size
  const height = size
  const raw = Buffer.alloc((width * 4 + 1) * height)
  const ss = 2
  const pad = 0.04
  const radius = 0.18

  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      let plate = 0
      let mark = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / width
          const ny = (y + (sy + 0.5) / ss) / height
          if (inRoundRect(nx, ny, 0.5, 0.5, 0.5 - pad, 0.5 - pad, radius)) {
            plate += 1
            mark += sampleMark(nx, ny)
          }
        }
      }
      const p = clamp01(plate / (ss * ss))
      const m = clamp01(mark / (ss * ss))
      // White mark on black plate; transparent outside plate.
      const i = row + 1 + x * 4
      if (p <= 0) {
        raw[i] = 0
        raw[i + 1] = 0
        raw[i + 2] = 0
        raw[i + 3] = 0
      } else {
        const w = Math.round(255 * m)
        raw[i] = w
        raw[i + 1] = w
        raw[i + 2] = w
        raw[i + 3] = Math.round(255 * p)
      }
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

const png16 = createPng(16)
const png32 = createPng(32)
const png48 = createPng(48)
const png64 = createPng(64)
const png128 = createPng(128)
const png256 = createPng(256)
const png512 = createPng(512)
const tray16 = createTrayPng(16)
const tray32 = createTrayPng(32)
const ico = createIco([16, 32, 48, 64, 128, 256])

fs.writeFileSync(path.join(iconsDir, '32x32.png'), png32)
fs.writeFileSync(path.join(iconsDir, '128x128.png'), png128)
fs.writeFileSync(path.join(iconsDir, '128x128@2x.png'), png256)
fs.writeFileSync(path.join(iconsDir, 'icon.png'), png256)
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico)
fs.writeFileSync(path.join(assetsDir, 'icon.png'), png512)
fs.writeFileSync(path.join(iconsDir, 'tray-16.png'), tray16)
fs.writeFileSync(path.join(iconsDir, 'tray-32.png'), tray32)

function createIcns() {
  const entries = [
    { type: 'ic07', data: png128 },
    { type: 'ic08', data: png256 },
    { type: 'ic09', data: png512 },
    { type: 'ic12', data: png64 },
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
fs.writeFileSync(path.join(iconsDir, '16x16.png'), png16)
fs.writeFileSync(path.join(iconsDir, '48x48.png'), png48)

console.log('White WeChat-style icons written to', iconsDir)
console.log('Tray plate icons written (tray-16/32.png)')
console.log('Universal window icon written to', assetsDir)
