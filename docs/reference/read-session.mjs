import fs from 'node:fs';
import zlib from 'node:zlib';

const src = process.argv[2];
const dst = process.argv[3];
const buf = fs.readFileSync(src);

// zstd frame magic 0x28 0xB5 0x2F 0xFD (little-endian read of 0xFD2FB528)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
let i = 0;
while (true) {
  const idx = buf.indexOf(MAGIC, i);
  if (idx < 0) break;
  offsets.push(idx);
  i = idx + 1;
}
console.log('frames found (magic hits):', offsets.length);
const parts = [];
for (let n = 0; n < offsets.length; n++) {
  const start = offsets[n];
  const end = n + 1 < offsets.length ? offsets[n + 1] : buf.length;
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)));
  } catch (e) {
    // last frame may be truncated (crash mid-write) — try the tail anyway
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start))); } catch { /* skip */ }
  }
}
const out = Buffer.concat(parts);
if (dst) fs.writeFileSync(dst, out);
const lines = out.toString('utf8').split('\n').filter(Boolean);
console.log('lines', lines.length, 'bytes', out.length);
const types = {};
for (const l of lines) {
  let o; try { o = JSON.parse(l); } catch { types.PARSE_FAIL = (types.PARSE_FAIL || 0) + 1; continue; }
  types[o.type] = (types[o.type] || 0) + 1;
}
console.log(JSON.stringify(types, null, 1));
