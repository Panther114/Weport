import fs from 'node:fs';

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const evs = lines.map((l) => JSON.parse(l));

const fmt = (n) => (n === undefined ? '  n/a' : String(n).padStart(9));

// Per-step usage: assistant/message data.usage
let rows = [];
let sumIn = 0, sumOut = 0, sumCache = 0, n = 0;
const byTurn = new Map();
for (const e of evs) {
  if (e.type !== 'assistant/message') continue;
  const u = e.data?.usage;
  if (!u) continue;
  const cache = u.cacheReadTokens ?? 0;
  const input = u.inputTokens ?? 0;
  const prompt = input + cache;
  rows.push({ seq: e.seq, turn: e.data.turn, step: e.data.step, input, cache, out: u.outputTokens, prompt, pct: prompt ? (100 * cache) / prompt : null });
  sumIn += input; sumOut += u.outputTokens ?? 0; sumCache += cache; n++;
  const t = e.data.turn;
  if (!byTurn.has(t)) byTurn.set(t, { input: 0, cache: 0, out: 0, steps: 0 });
  const b = byTurn.get(t); b.input += input; b.cache += cache; b.out += u.outputTokens ?? 0; b.steps++;
}

console.log('=== SESSION TOTALS ===');
console.log('assistant messages with usage:', n);
console.log('sum uncached input tokens :', sumIn);
console.log('sum cache-read tokens     :', sumCache);
console.log('sum output tokens         :', sumOut);
console.log('billed input (in+cache)   :', sumIn + sumCache);
console.log('OVERALL cache hit rate    :', (((sumCache / (sumIn + sumCache)) * 100).toFixed(4)) + '%');
console.log('weighted cost ratio vs none:', ((sumCache * 0.02 + sumIn) / (sumIn + sumCache) * 100).toFixed(4) + '% of uncached price (assuming 50x discount)');

console.log('\n=== PER TURN ===');
console.log('turn  steps  uncachedIn  cacheRead   prompt   hit%');
for (const [t, b] of [...byTurn.entries()].sort((a, c) => a[0] - c[0])) {
  const p = b.input + b.cache;
  console.log(String(t).padStart(4), String(b.steps).padStart(6), fmt(b.input), fmt(b.cache), fmt(p), (100 * b.cache / p).toFixed(2) + '%');
}

console.log('\n=== FIRST 20 STEPS ===');
for (const r of rows.slice(0, 20)) console.log(`turn ${r.turn} step ${r.step} seq ${r.seq}: uncached=${r.input} cacheRead=${r.cache} prompt=${r.prompt} hit=${r.pct?.toFixed(2)}%  miss(≈prefix break)=${r.input}`);
console.log('\n=== LAST 15 STEPS ===');
for (const r of rows.slice(-15)) console.log(`turn ${r.turn} step ${r.step} seq ${r.seq}: uncached=${r.input} cacheRead=${r.cache} prompt=${r.prompt} hit=${r.pct?.toFixed(2)}%  miss(≈prefix break)=${r.input}`);

// steps with the largest uncached input (worst cache behavior)
console.log('\n=== WORST 15 STEPS BY UNCACHED INPUT ===');
for (const r of [...rows].sort((a, b) => b.input - a.input).slice(0, 15)) {
  console.log(`turn ${r.turn} step ${r.step} seq ${r.seq}: uncached=${r.input} cacheRead=${r.cache} prompt=${r.prompt} hit=${r.pct?.toFixed(2)}%`);
}

// distribution of uncached input
const buckets = {};
for (const r of rows) { const k = r.input === 0 ? '0' : r.input < 200 ? '1-199' : r.input < 1000 ? '200-999' : r.input < 5000 ? '1k-5k' : r.input < 20000 ? '5k-20k' : '20k+'; buckets[k] = (buckets[k] || 0) + 1; }
console.log('\n=== UNCACHED-INPUT DISTRIBUTION (per step) ===');
console.log(JSON.stringify(buckets, null, 1));
const zero = rows.filter((r) => r.input === 0).length;
console.log('steps with ZERO uncached input:', zero, '/', rows.length);
