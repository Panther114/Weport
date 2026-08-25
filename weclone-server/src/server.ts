/**
 * weclone-server 入口（v0.9.10）。
 *
 * 极简内存 Fastify 服务：仅暴露 WeClone 聊天 API（PORT 单端口），
 * 不含任何本地 WCDB / httpService / mcpService 能力。
 *
 * 内存策略：
 * - 启动零加载（无 clone 语料驻留）；BM25 索引懒构建 + LRU(5)
 * - 元数据为 JSON 文件存储（无 native 依赖）；NODE_OPTIONS=--max-old-space-size=256
 *   由 Dockerfile 注入
 * - 优雅停机：SIGINT/SIGTERM/SIGBREAK → close（5s 强制兜底）
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'

import { MetaStore } from './store/metaStore'
import { BlobStore } from './store/blobStore'
import { RetrievalManager } from './retrieval/bm25'
import { describeLlm } from './llm/proxy'
import { readLimitsFromEnv, type WecloneContext } from './context'
import { registerUploadRoute } from './routes/upload'
import { registerCloneRoutes } from './routes/clones'
import { registerChatRoute } from './routes/chat'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const VERSION = readVersion()
const PORT = positiveIntEnv('PORT', 8080)
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = resolve(process.env.WECLONE_DATA_DIR || join(process.cwd(), 'data'))
const PUBLIC_DIR = join(__dirname, '..', 'public')

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

function readVersion(): string {
  try {
    // dist/server.ts → ../package.json；ts-node src/server.ts → ../package.json
    const pkg = require(join(__dirname, '..', 'package.json')) as { version?: string }
    return pkg.version || 'dev'
  } catch {
    return 'dev'
  }
}

function corsOrigins(): boolean | string[] {
  const raw = process.env.CORS_ALLOW_ORIGINS?.trim()
  if (!raw || raw === '*') return true // 反射任意 origin（网站公开浏览）
  const fixed = 'https://weport.up.railway.app'
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.includes(fixed)) list.push(fixed)
  return list
}

// ---------------------------------------------------------------------------
// 应用装配
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'warn' },
    bodyLimit: 2 * 1024 * 1024, // 全局默认 2MB；upload 路由单独放宽
    disableRequestLogging: true,
    trustProxy: true,
  })

  await app.register(cors, { origin: corsOrigins() })
  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ success: false, error: 'too many requests' }),
  })

  // ---- 服务上下文 ----
  const metaStore = new MetaStore(DATA_DIR)
  const blobStore = new BlobStore(DATA_DIR)
  const context: WecloneContext = {
    metaStore,
    blobStore,
    retrieval: new RetrievalManager(blobStore),
    limits: readLimitsFromEnv(),
  }
  app.decorate('weclone', context)

  // ---- 健康检查 ----
  app.get('/health', async () => ({
    ok: true,
    mem: process.memoryUsage(),
    version: VERSION,
    uptime: Math.round(process.uptime()),
    store: metaStore.kind,
    llm: describeLlm().configured ? 'configured' : 'mock',
    llmModels: describeLlm().candidates,
  }))

  registerUploadRoute(app)
  registerCloneRoutes(app)
  registerChatRoute(app)

  // ---- 静态站（可选：public/ 存在才挂载；SPA fallback 到 index.html）----
  if (existsSync(PUBLIC_DIR)) {
    await app.register(fastifyStatic, { root: PUBLIC_DIR, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      const path = request.raw.url || '/'
      if ((request.method === 'GET' || request.method === 'HEAD') && !path.startsWith('/api')) {
        return reply.sendFile('index.html')
      }
      return reply.status(404).send({ success: false, error: 'not found' })
    })
  }

  // ---- 错误归一化 ----
  app.setErrorHandler((err, request, reply) => {
    const statusCode = err.statusCode ?? 500
    if (statusCode >= 500) request.log.error(err)
    void reply.status(statusCode).send({
      success: false,
      error: statusCode >= 500 ? 'internal error' : err.message,
    })
  })

  // ---- 优雅停机 ----
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] ${signal} received — shutting down`)
    // 兜底：SSE 长连接可能拖住 close，5s 后强制退出
    setTimeout(() => process.exit(0), 5_000).unref()
    app.close()
      .catch(() => undefined)
      .finally(() => {
        metaStore.close()
        process.exit(0)
      })
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => shutdown(signal))
  }
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection:', reason)
  })

  // ---- 启动 ----
  await app.listen({ port: PORT, host: HOST })
  console.log(`[server] weclone-server v${VERSION} listening on http://${HOST}:${PORT}`)
  console.log(`[server] data dir: ${DATA_DIR} (store=${metaStore.kind})`)
  console.log(
    `[server] llm proxy: ${process.env.WECLONE_LLM_API_KEY ? 'configured' : 'MOCK MODE — set WECLONE_LLM_API_KEY'} ` +
    `→ ${process.env.WECLONE_LLM_BASE_URL || 'https://opencode.ai/zen/go/v1'} (${process.env.WECLONE_LLM_MODEL || 'muse-spark-1.2-contributor'})`,
  )
}

main().catch((err) => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
