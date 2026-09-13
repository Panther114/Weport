/**
 * POST /api/weclone/:id/chat —— 克隆对话（v0.9.10）。
 *
 * 鉴权：public 匿名可聊；link 需 ?secret=（或 x-weclone-secret 头 / body.secret）；
 *       private 仅 owner Bearer。
 * 流程：
 *   a) BM25 检索 top-K（默认 8）chunks（懒建索引 + LRU 5）
 *   b) system = WECLONE_CHAT_SYSTEM_PROMPT + mds + 检索片段
 *      （服务端前置注入，不可被客户端覆盖）
 *   c) 敏感提问预过滤 → 追加防线指令（不覆盖 roleplay 人设）
 *   d) LLM 代理流式转发（SSE：event delta / event done）；?stream=false 走 JSON
 * 客户端传入的 system 角色一律剥离（防注入覆盖拒答红线）。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getBearerToken, safeEqual, sha256Hex } from '../utils/auth'
import {
  buildWeCloneChatSystemPrompt, detectSensitiveAsk, type WeCloneMdKey,
} from '../prompts'
import { collectStream, streamChatWithLLM, type LlmMessage } from '../llm/proxy'

const MAX_HISTORY_MESSAGES = 20
const MAX_MESSAGE_CHARS = 4_000
const MAX_TOTAL_INPUT_CHARS = 16_000
const TOP_K_CHUNKS = 8

interface ChatBody {
  message?: unknown
  history?: unknown
  messages?: unknown
  stream?: unknown
  secret?: unknown
}

interface ClientMessage {
  role: 'user' | 'assistant'
  content: string
}

function extractSecret(request: FastifyRequest, body: ChatBody): string {
  const query = (request.query ?? {}) as Record<string, unknown>
  if (typeof query.secret === 'string' && query.secret) return query.secret
  const header = request.headers['x-weclone-secret']
  if (typeof header === 'string' && header) return header
  return typeof body.secret === 'string' ? body.secret : ''
}

/** 归一化 history/messages/message → 受控的 user/assistant 序列 */
function normalizeMessages(body: ChatBody): ClientMessage[] {
  const rawList: unknown[] = Array.isArray(body.messages)
    ? (body.messages as unknown[])
    : Array.isArray(body.history)
      ? [...(body.history as unknown[]), ...(typeof body.message === 'string' && body.message ? [{ role: 'user', content: body.message }] : [])]
      : typeof body.message === 'string' && body.message
        ? [{ role: 'user', content: body.message }]
        : []

  const out: ClientMessage[] = []
  let totalChars = 0
  for (const item of rawList.slice(-MAX_HISTORY_MESSAGES)) {
    const rec = item as Record<string, unknown> | null
    // system 角色一律视为普通内容丢弃角色 —— 防注入覆盖服务端拒答红线
    const role = rec?.role === 'assistant' ? 'assistant' : 'user'
    const content = typeof rec?.content === 'string' ? rec.content : ''
    if (!content) continue
    const clipped = content.slice(0, MAX_MESSAGE_CHARS)
    totalChars += clipped.length
    if (totalChars > MAX_TOTAL_INPUT_CHARS) break
    out.push({ role, content: clipped })
  }
  return out
}

function formatChunkLine(ts: number, sid: string, text: string): string {
  const when = ts > 0 ? new Date(ts < 1e12 ? ts * 1000 : ts).toISOString().slice(0, 10) : '未知时间'
  const where = sid || '会话'
  return `- （${when} · ${where}）${text.replace(/\s+/g, ' ').slice(0, 400)}`
}

export function registerChatRoute(app: FastifyInstance): void {
  const { metaStore, blobStore, retrieval, limits } = app.weclone

  app.post<{ Params: { id: string }; Querystring: Record<string, unknown>; Body: ChatBody }>(
    '/api/weclone/:id/chat',
    {
      config: { rateLimit: { max: limits.rateLimitChat, timeWindow: '1 minute' } },
      bodyLimit: 256 * 1024,
    },
    async (request, reply) => {
      const row = metaStore.get(request.params.id)
      if (!row) return reply.status(404).send({ success: false, error: 'clone not found' })

      // ---- 鉴权 ----
      // public：匿名可直接聊（无 Bearer / secret 时两个分支都不命中，放行）；
      // link：需 ?secret= / x-weclone-secret 头 / body.secret；private：仅 owner Bearer。
      const body = request.body ?? {}
      const token = getBearerToken(request.headers.authorization)
      const isOwner = Boolean(token && safeEqual(sha256Hex(token), row.ownerTokenHash))
      if (!isOwner) {
        if (row.visibility === 'private') {
          return reply.status(401).send({ success: false, error: 'this clone is private' })
        }
        if (row.visibility === 'link') {
          const secret = extractSecret(request, body)
          if (!secret || !row.secret || !safeEqual(secret, row.secret)) {
            return reply.status(401).send({ success: false, error: 'invalid share secret' })
          }
        }
      }

      // ---- 输入 ----
      const messages = normalizeMessages(body)
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      if (!lastUser || !lastUser.content.trim()) {
        return reply.status(400).send({ success: false, error: 'message required' })
      }

      // ---- 检索 + prompt 组装 ----
      const retrieved = await retrieval.search(row.id, lastUser.content, TOP_K_CHUNKS)
      // meta 行内 mds 为准；blob 缺失/为空时回退读 mds/*.md 文件
      const mdsSource = Object.keys(row.mds ?? {}).length > 0 ? row.mds : blobStore.getMds(row.id)
      const mds: Partial<Record<WeCloneMdKey, string>> = {}
      for (const key of ['profile', 'relationships', 'knowledge', 'timeline', 'language'] as const) {
        const value = mdsSource[`${key}.md`] ?? mdsSource[key]
        if (typeof value === 'string') mds[key] = value
      }
      const systemPrompt = buildWeCloneChatSystemPrompt({
        displayName: row.displayName,
        knowledgeCutoff: row.knowledgeCutoff,
        mds,
        retrievedChunks: retrieved.map((c) => formatChunkLine(c.ts, c.sid, c.text)),
        sensitiveCategories: detectSensitiveAsk(lastUser.content),
      })

      const llmMessages: LlmMessage[] = [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ]

      // ---- 流式 / 非流式 ----
      const query = request.query ?? {}
      const wantStream = body.stream !== false && query.stream !== 'false'

      if (!wantStream) {
        try {
          const text = await collectStream(streamChatWithLLM({ messages: llmMessages }))
          return { success: true, reply: text }
        } catch (err) {
          request.log.warn(`chat upstream failed: ${(err as Error).message}`)
          return reply.status(502).send({ success: false, error: 'LLM upstream unavailable' })
        }
      }

      // SSE：接管原始响应
      reply.hijack()
      const res = reply.raw
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(': sse ok\n\n') // 立即冲刷响应头

      const abort = new AbortController()
      const onClose = () => abort.abort()
      res.on('close', onClose)

      try {
        for await (const delta of streamChatWithLLM({ messages: llmMessages, signal: abort.signal })) {
          if (res.writableEnded || res.destroyed) break
          res.write(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`)
        }
        res.write('event: done\ndata: [DONE]\n\n')
      } catch (err) {
        request.log.warn(`chat stream failed: ${(err as Error).message}`)
        if (!res.writableEnded && !res.destroyed) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: 'LLM upstream unavailable' })}\n\n`)
        }
      } finally {
        res.off('close', onClose)
        if (!res.writableEnded) res.end()
      }
      return reply
    },
  )
}
