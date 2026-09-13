import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decompressAll(path) {
  const buf = fs.readFileSync(path);
  const offsets = [];
  let i = 0;
  while (true) {
    const idx = buf.indexOf(MAGIC, i);
    if (idx < 0) break;
    offsets.push(idx);
    i = idx + 1;
  }
  const parts = [];
  for (let n = 0; n < offsets.length; n++) {
    const start = offsets[n];
    const end = n + 1 < offsets.length ? offsets[n + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))); } catch { /* truncated frame */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

const rows = [];
for (const dir of process.argv.slice(2)) {
  for (const sub of fs.readdirSync(dir)) {
    const p = dir + '\\' + sub;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith('.jsonl.zstd')) continue;
      const full = p + '\\' + f;
      let text;
      try { text = decompressAll(full); } catch { continue; }
      const lines = text.split('\n').filter(Boolean);
      let header = null, preset = null, model = null, provider = null, ctxWin = null, sysLen = null, toolN = null;
      let sumIn = 0, sumCache = 0, n = 0;
      const events = [];
      for (const l of lines) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        events.push(e);
        if (e.type === 'session') preset = e.agentPreset;
        if (e.type === 'request/header' && !header) {
          header = e.data.header;
          model = header?.config?.model; provider = header?.config?.provider;
          toolN = header?.tools?.length ?? null;
          sysLen = typeof header?.system === 'string' ? header.system.length : null;
        }
        if (e.type === 'request/context' && ctxWin == null) ctxWin = e.data.contextWindow;
        if (e.type === 'assistant/message' && e.data?.usage) {
          sumIn += e.data.usage.inputTokens ?? 0;
          sumCache += e.data.usage.cacheReadTokens ?? 0;
          n++;
        }
      }
      const sysText = typeof header?.system === 'string' ? header.system : '';
      const looksMinimal = /You are a helpful software engineer assistant/.test(sysText);
      const hasIdentity = /You are an AI agent powered by DeepSeek Harness/.test(sysText);
      rows.push({
        file: sub, preset, provider, model, ctxWin, sysLen, toolN, steps: n,
        billedInput: sumIn + sumCache, cacheRead: sumCache,
        hitPct: sumIn + sumCache ? (100 * sumCache) / (sumIn + sumCache) : null,
        looksMinimal, hasIdentity,
      });
    }
  }
}

rows.sort((a, b) => (b.billedInput || 0) - (a.billedInput || 0));
console.log('=== SESSIONS IN WEPORT WORKSPACE ===');
console.log('sessions:', rows.length);
const byModel = new Map();
for (const r of rows) {
  const k = `${r.provider}/${r.model}`;
  const b = byModel.get(k) ?? { n: 0, in: 0, cache: 0, steps: 0, toolN: r.toolN, sysLen: r.sysLen };
  b.n++; b.in += r.billedInput; b.cache += r.cacheRead; b.steps += r.steps;
  byModel.set(k, b);
}
console.log('\n--- by model route ---');
for (const [k, b] of [...byModel.entries()].sort((a, c) => c[1].in - a[1].in)) {
  console.log(k.padEnd(38), 'sessions=' + String(b.n).padStart(3), 'steps=' + String(b.steps).padStart(5),
    'billedInput=' + String(b.in).padStart(10),
    'hit=' + (b.in ? ((100 * b.cache) / b.in).toFixed(3) + '%' : 'n/a'),
    'tools=' + b.toolN, 'sysChars=' + b.sysLen);
}

console.log('\n--- top 20 sessions by billed input ---');
for (const r of rows.slice(0, 20)) {
  console.log(
    (r.file || '').slice(0, 46).padEnd(47),
    String(r.steps).padStart(5) + ' steps',
    String(r.billedInput).padStart(9) + ' in',
    (r.hitPct == null ? 'n/a' : r.hitPct.toFixed(2) + '%').padStart(8),
    'tools=' + r.toolN, 'sys=' + r.sysLen, 'preset=' + r.preset,
    r.looksMinimal ? 'MINIMAL-PROMPT' : (r.hasIdentity ? 'standard-prompt' : 'other-prompt'),
  );
}
