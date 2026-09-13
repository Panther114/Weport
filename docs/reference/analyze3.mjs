import fs from 'node:fs';
import crypto from 'node:crypto';

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const evs = lines.map((l) => JSON.parse(l));
const surfaceTypes = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);

console.log('=== surfaceOp shapes seen ===');
const ops = {};
for (const e of evs) {
  if (!surfaceTypes.has(e.type)) continue;
  const op = e.surfaceOp == null ? 'missing' : typeof e.surfaceOp === 'string' ? e.surfaceOp : e.surfaceOp.op;
  const k = e.type + ' :: ' + op;
  ops[k] = (ops[k] || 0) + 1;
}
console.log(JSON.stringify(ops, null, 1));

console.log('\n=== sample of each surface type (truncated) ===');
const seen = new Set();
for (const e of evs) {
  if (!surfaceTypes.has(e.type) || seen.has(e.type)) continue;
  seen.add(e.type);
  console.log('[' + e.type + ']', JSON.stringify(e).slice(0, 900), '\n');
}

console.log('\n=== message-kind counts ===');
const kinds = {};
for (const e of evs) {
  if (!surfaceTypes.has(e.type)) continue;
  kinds[e.type] = (kinds[e.type] || 0) + 1;
}
console.log(JSON.stringify(kinds, null, 1));

// Build surface incrementally; snapshot message-array hash right before each assistant/message append.
function project(e) {
  if (e.type === 'system/message') {
    const content = e.data?.message?.content ?? e.data?.content ?? [];
    return { role: 'system', content, data: e.data };
  }
  if (e.type === 'user/message') return { role: 'user', ...e.data };
  if (e.type === 'assistant/message') return { role: 'assistant', ...e.data };
  if (e.type === 'tool/result') return { role: 'tool', ...e.data };
  return null;
}

let surface = [];
const trace = [];
for (const e of evs) {
  if (!surfaceTypes.has(e.type)) continue;
  const op = e.surfaceOp;
  if (op && typeof op === 'object' && op.op === 'replace') {
    const s = op.startSeq, en = op.endSeq;
    const idx = surface.findIndex((n) => n.seq === s);
    if (idx < 0) {
      // replace by seq range: drop nodes with seq within [s,en]
      surface = surface.filter((n) => !(n.seq >= s && n.seq <= en));
    } else {
      let end = idx;
      while (end + 1 < surface.length && surface[end + 1].seq <= en) end++;
      surface.splice(idx, end - idx + 1, { seq: e.seq, type: e.type, msg: project(e) });
    }
  } else {
    surface.push({ seq: e.seq, type: e.type, msg: project(e) });
  }
  if (e.type === 'assistant/message') {
    const u = e.data?.usage;
    const json = JSON.stringify(surface.map((n) => n.msg));
    trace.push({
      seq: e.seq, turn: e.data?.turn, step: e.data?.step,
      nodes: surface.length,
      hash: crypto.createHash('sha256').update(json).digest('hex').slice(0, 16),
      bytes: Buffer.byteLength(json),
      cacheRead: u?.cacheReadTokens, uncached: u?.inputTokens,
      sysNodes: surface.filter((n) => n.type === 'system/message').length,
    });
  }
}

console.log('\n=== surface reconstruction ===');
console.log('traced assistant messages:', trace.length);

// find adjacent pairs where the hash changed at the FIRST node
function firstDiff(aMsgs, bMsgs) {
  const n = Math.min(aMsgs.length, bMsgs.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(aMsgs[i]) !== JSON.stringify(bMsgs[i])) return i;
  }
  if (aMsgs.length !== bMsgs.length) return n;
  return -1;
}

// We need message arrays per step: rebuild and store
surface = [];
const arrs = [];
const metas = [];
for (const e of evs) {
  if (!surfaceTypes.has(e.type)) continue;
  const op = e.surfaceOp;
  if (op && typeof op === 'object' && op.op === 'replace') {
    const s = op.startSeq, en = op.endSeq;
    const idx = surface.findIndex((n) => n.seq === s);
    if (idx < 0) surface = surface.filter((n) => !(n.seq >= s && n.seq <= en));
    else {
      let end = idx;
      while (end + 1 < surface.length && surface[end + 1].seq <= en) end++;
      surface.splice(idx, end - idx + 1, { seq: e.seq, type: e.type, msg: project(e) });
    }
  } else surface.push({ seq: e.seq, type: e.type, msg: project(e) });
  if (e.type === 'assistant/message') {
    arrs.push(surface.map((n) => n.msg));
    metas.push({ seq: e.seq, turn: e.data?.turn, step: e.data?.step, cacheRead: e.data?.usage?.cacheReadTokens, uncached: e.data?.usage?.inputTokens, sysNodes: surface.filter((n) => n.type === 'system/message').length });
  }
}

console.log('\n=== PREFIX-DIVERGENCE BETWEEN CONSECUTIVE REQUESTS ===');
console.log('turn  step  msgs  firstChangedNode  sysNodes  cacheRead  uncached');
let divergences = [];
for (let i = 1; i < arrs.length; i++) {
  const fd = firstDiff(arrs[i - 1], arrs[i]);
  const m = metas[i];
  divergences.push({ ...m, fd, prevLen: arrs[i - 1].length, len: arrs[i].length });
  if (fd <= 2 || (m.uncached ?? 0) > 5000) {
    console.log(String(m.turn).padStart(4), String(m.step).padStart(5), String(arrs[i].length).padStart(5), String(fd).padStart(10), String(m.sysNodes).padStart(8), String(m.cacheRead).padStart(9), String(m.uncached).padStart(9));
  }
}
const hist = {};
for (const d of divergences) { const k = d.fd <= 0 ? '0 (system node 0 changed)' : d.fd === 1 ? '1' : d.fd <= 3 ? '2-3' : d.fd < 1000000 ? '4+' : 'none'; hist[k] = (hist[k] || 0) + 1; }
console.log('\n=== first-changed-node distribution across consecutive request pairs ===');
console.log(JSON.stringify(hist, null, 1));

// count all consecutive pairs where prefix (from node 0) is identical except the tail
let pureAppend = 0;
for (let i = 1; i < arrs.length; i++) {
  const fd = firstDiff(arrs[i - 1], arrs[i]);
  if (fd === arrs[i - 1].length) pureAppend++;
}
console.log('pure append-only growth pairs:', pureAppend, '/', arrs.length - 1);
