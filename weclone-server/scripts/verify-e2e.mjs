/**
 * verify-e2e.mjs —— weclone-server 端到端回归（零依赖，node >=18）。
 *
 * 覆盖 v0.9.10 的两个关键行为：
 *   1) 模型降级链：首选模型（muse-spark-1.2-contributor）在上游返回 500
 *      "Internal server error" 时，chat 必须自动降级到备选模型并成功回复；
 *   2) 上传 → 列表 → 可见性 → 公开聊天 → 删除 的最小闭环。
 *
 * 用法：node scripts/verify-e2e.mjs   （需先 npm run build）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18777
const STUB_PORT = 18778
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'wc_verify_e2e_token'
let failures = 0

function ok(name, cond, extra = '') {
  if (cond) console.log(`  ✔ ${name}`)
  else {
    failures += 1
    console.error(`  ✘ ${name} ${extra}`)
  }
}

/** 模拟 opencode-go 网关：muse-spark-1.2-contributor 一律 500，其他模型回 SSE 流 */
function startStubLlm() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let model = ''
      try { model = String(JSON.parse(body)?.model || '') } catch { /* noop */ }
      if (model === 'muse-spark-1.2-contributor') {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal server error')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const reply = `[${model}] 你好，我是你的克隆`
      for (let i = 0; i < reply.length; i += 6) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(i, i + 6) } }] })}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)))
}

function api(method, path, body, headers = {}) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${TOKEN}`, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'weclone-e2e-'))
  const stub = await startStubLlm()
  const child = spawn(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      WECLONE_DATA_DIR: dataDir,
      WECLONE_LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
      // 自定义网关下必须显式给出降级候选（与生产默认网关行为一致地被启用）
      WECLONE_LLM_FALLBACK_MODELS: 'glm-5,minimax-m2.5',
      WECLONE_LLM_API_KEY: 'sk-e2e',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  child.stdout.on('data', (c) => (serverLog += c))
  child.stderr.on('data', (c) => (serverLog += c))
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server start timeout\n${serverLog}`)), 10_000)
    child.stdout.on('data', (c) => {
      if (String(c).includes('listening')) { clearTimeout(t); resolve() }
    })
    child.on('exit', (code) => reject(new Error(`server exited early code=${code}\n${serverLog}`)))
  })

  try {
    console.log('[1] health')
    const health = await (await fetch(`${BASE}/health`)).json()
    ok('health ok', health.ok === true)
    ok('llm configured', health.llm === 'configured')

    console.log('[2] upload clone')
    const up = await api('POST', '/api/weclone/upload', {
      meta: { wxid: 'wxid_e2e', displayName: 'E2E 克隆', knowledgeCutoff: '2026-08-25' },
      mds: { 'profile.md': '# profile 直来直去爱打篮球' },
      chunks: [
        { id: 'c1', sid: 's1', ts: 1720000000, text: '今晚打球吗' },
        { id: 'c2', sid: 's1', ts: 1720000100, text: '明天加班改需求' },
      ],
      visibility: 'public',
    })
    const upBody = await up.json()
    ok('upload 201', up.status === 201 && upBody.success === true, JSON.stringify(upBody))
    const cloneId = upBody.id

    console.log('[3] list')
    const list = await (await api('GET', '/api/weclone/list')).json()
    ok('list contains clone', Array.isArray(list.clones) && list.clones.some((c) => c.id === cloneId))

    console.log('[4] chat — 首选模型 500 后必须自动降级成功')
    const chat = await api('POST', `/api/weclone/${cloneId}/chat`, { message: '你好', stream: false })
    const chatBody = await chat.json()
    ok('chat success', chat.status === 200 && chatBody.success === true, JSON.stringify(chatBody))
    ok('reply came from fallback model', typeof chatBody.reply === 'string' && /\[(glm-5|minimax-m2\.5)\]/.test(chatBody.reply), chatBody.reply)

    console.log('[5] SSE stream chat')
    const sse = await api('POST', `/api/weclone/${cloneId}/chat`, { message: '你好' })
    const sseText = await sse.text()
    ok('sse has delta events', sseText.includes('event: delta') && sseText.includes('event: done'))
    // 逐帧重拼 delta（分片会拆散模型标记，必须重组后再断言）
    const joined = sseText
      .split('\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => { try { return JSON.parse(l.slice(6))?.delta || '' } catch { return '' } })
      .join('')
    ok('sse reply from fallback too', /\[(glm-5|minimax-m2\.5)\]/.test(joined), joined)

    console.log('[6] public browse + visibility + delete')
    const pub = await (await fetch(`${BASE}/api/weclone/public`)).json()
    ok('public list contains clone', Array.isArray(pub.clones) && pub.clones.some((c) => c.id === cloneId))
    const vis = await api('PATCH', `/api/weclone/${cloneId}/visibility`, { visibility: 'private' })
    ok('visibility patch ok', vis.status === 200)
    const pubAfter = await (await fetch(`${BASE}/api/weclone/public`)).json()
    ok('private clone hidden from public', !(pubAfter.clones || []).some((c) => c.id === cloneId))
    const del = await api('DELETE', `/api/weclone/${cloneId}`)
    ok('delete ok', del.status === 200)
    const gone = await api('GET', `/api/weclone/${cloneId}`)
    ok('clone gone', gone.status !== 200)
  } finally {
    child.kill('SIGTERM')
    stub.close()
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* noop */ }
  }

  if (failures > 0) {
    console.error(`\nverify-e2e: ${failures} check(s) FAILED\nserver log:\n${serverLog}`)
    process.exit(1)
  }
  console.log('\nverify-e2e: all checks passed')
}

main().catch((e) => {
  console.error('verify-e2e crashed:', e)
  process.exit(1)
})
