import fs from 'node:fs';

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const evs = lines.map((l) => JSON.parse(l));

console.log('=== request/header structure ===');
for (const e of evs) {
  if (e.type !== 'request/header') continue;
  const h = e.data.header;
  console.log('top-level keys:', Object.keys(h));
  if (h.tools) {
    console.log('tool count:', h.tools.length);
    console.log('tool names in order:', h.tools.map((t) => t.name ?? t.function?.name).join(', '));
    console.log('first tool full JSON (2000 chars):');
    console.log(JSON.stringify(h.tools[0]).slice(0, 2000));
    console.log('last tool full JSON (1200 chars):');
    console.log(JSON.stringify(h.tools[h.tools.length - 1]).slice(0, 1200));
  }
  if (h.config) console.log('config:', JSON.stringify(h.config));
  if (h.adapterDefaults) console.log('adapterDefaults:', JSON.stringify(h.adapterDefaults));
  for (const k of Object.keys(h)) {
    if (['tools', 'config', 'adapterDefaults', 'system'].includes(k)) continue;
    console.log('other header key', k, '=', JSON.stringify(h[k]).slice(0, 300));
  }
  break;
}

console.log('\n=== every request/header + request/context (reason if present) ===');
for (const e of evs) {
  if (e.type === 'request/header') {
    const h = e.data;
    console.log(e.seq, 'header keys=', Object.keys(h), JSON.stringify(h).length, 'chars, reason=', h.reason ?? h.data?.reason ?? '(none)', 'tools=', h.header?.tools?.length ?? h.tools?.length);
  }
  if (e.type === 'request/context') console.log(e.seq, 'context', JSON.stringify(e.data).slice(0, 300));
}

console.log('\n=== user/message sources (first 40) ===');
let n = 0;
for (const e of evs) {
  if (e.type !== 'user/message') continue;
  const d = e.data;
  const text = (d.content ?? []).map((c) => c.text ?? '').join('|');
  console.log(e.seq, JSON.stringify(d.source), 'op=' + JSON.stringify(e.surfaceOp), 'text=' + JSON.stringify(text.slice(0, 220)));
  if (++n > 40) break;
}
