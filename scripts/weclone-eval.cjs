/* weclone-eval.cjs — run eval stimuli through chatLocal via CDP and score. */
const http = require('http')
const fs = require('fs')

function listTargets(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(JSON.parse(d)))
    }).on('error', reject)
  })
}

async function main() {
  const port = Number(process.argv[2]) || 9223
  const evalPath = process.argv[3]
  const outPath = process.argv[4]
  const cloneId = process.argv[5] || 'wc_wxid_gsnpwh6vh2z012_mt5rq81j'
  const limit = Number(process.argv[6]) || 12
  if (!evalPath) { console.error('usage: node weclone-eval.cjs <port> <evalPairs.json> <out.json> [cloneId] [limit]'); process.exit(1) }
  let pairs = JSON.parse(fs.readFileSync(evalPath, 'utf8'))
  pairs = pairs.slice(0, limit)
  const targets = await listTargets(port)
  const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')) })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
  }
  const send = (method, params) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true, silent: true })
    try { return r.result.value } catch { return undefined }
  }
  const results = []
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]
    const escStim = JSON.stringify(p.stimulus)
    const t0 = Date.now()
    const raw = await evaluate(`const r = await window.electronAPI.weclone.chatLocal({ id: ${JSON.stringify(cloneId)}, message: ${escStim}, history: [] }); return JSON.stringify(r)`)
    let reply = '', ok = false
    try { const parsed = JSON.parse(raw); reply = parsed.reply || ''; ok = Boolean(parsed.success) } catch { reply = String(raw).slice(0, 120) }
    results.push({ stimulus: p.stimulus, expected: p.reply, got: reply, ok, ms: Date.now() - t0 })
    console.log(`[${i + 1}/${pairs.length}] Q: ${p.stimulus}\n   real: ${p.reply}\n   clone: ${reply}${ok ? '' : '  (FAILED: ' + reply + ')'}\n`)
  }
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
  ws.close()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
