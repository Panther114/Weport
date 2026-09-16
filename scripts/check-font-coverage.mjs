// Which characters of a sample string does src/assets/fonts/weport.ttf actually
// cover? Anything missing is rendered by a Chromium fallback font, which is what
// "broken fonts" looks like when only a few glyphs come from another typeface.
//
// Usage: node scripts/check-font-coverage.mjs "朋友圈 张伟 9月12日 18:24"
import { readFileSync } from 'node:fs'

const fontPath = 'src/assets/fonts/weport.ttf'
const text = process.argv.slice(2).join(' ') || '朋友圈'

const buf = readFileSync(fontPath)
const tableCount = buf.readUInt16BE(4)
let cmapOffset = 0
for (let i = 0; i < tableCount; i += 1) {
  const rec = 12 + i * 16
  const tag = buf.toString('ascii', rec, rec + 4)
  if (tag === 'cmap') cmapOffset = buf.readUInt32BE(rec + 8)
}

const subtableCount = buf.readUInt16BE(cmapOffset + 2)
let best = 0
let bestFormat = 0
for (let i = 0; i < subtableCount; i += 1) {
  const rec = cmapOffset + 4 + i * 8
  const platformId = buf.readUInt16BE(rec)
  const encodingId = buf.readUInt16BE(rec + 2)
  const offset = cmapOffset + buf.readUInt32BE(rec + 4)
  const format = buf.readUInt16BE(offset)
  const score = platformId === 3 && encodingId === 10 ? 3 : platformId === 3 && encodingId === 1 ? 2 : 1
  if (score > best && (format === 4 || format === 12)) {
    best = score
    bestFormat = format
    best = score
    cmapOffset = cmapOffset // keep lint quiet
    globalThis.__picked = offset
  }
}
const picked = globalThis.__picked
const format = buf.readUInt16BE(picked)

function has(cp) {
  if (cp > 0xffff) return false
  if (format === 4) {
    const segCount = buf.readUInt16BE(picked + 6) / 2
    const endBase = picked + 14
    const startBase = endBase + segCount * 2 + 2
    const deltaBase = startBase + segCount * 2
    const rangeBase = deltaBase + segCount * 2
    for (let s = 0; s < segCount; s += 1) {
      const end = buf.readUInt16BE(endBase + s * 2)
      const start = buf.readUInt16BE(startBase + s * 2)
      if (cp < start || cp > end) continue
      const delta = buf.readInt16BE(deltaBase + s * 2)
      const rangeOffset = buf.readUInt16BE(rangeBase + s * 2)
      if (rangeOffset === 0) return ((cp + delta) & 0xffff) !== 0
      return true
    }
    return false
  }
  return false
}

const missing = []
for (const ch of new Set(text)) {
  const cp = ch.codePointAt(0)
  if (cp === 0x20 || cp === 0x0a) continue
  if (!has(cp)) missing.push(ch)
}

console.log(`subtable format=${format} (best=${bestFormat})`)
console.log(`checked ${new Set(text).size} unique chars`)
console.log(missing.length === 0 ? 'coverage: full' : `MISSING (${missing.length}): ${missing.join('')}`)
