/**
 * POST /api/weclone/upload —— 上传一个克隆（v0.9.10）。
 *
 * 鉴权：Bearer ownerToken（客户端生成；服务端只存 SHA-256 哈希）。
 * 校验链：
 *   1. 体积校验：请求体 ≤ WECLONE_MAX_UPLOAD_MB（默认 25MB，Fastify bodyLimit，
 *      超限 413）；chunks 序列化 ≤ WECLONE_MAX_BLOB_MB（默认 20MB）
 *   2. 结构校验（mds ≤5 份、单份 ≤20k chars；chunks 数量与单条长度）
 *   3. 服务端 PII 二次复核：严重类别命中计数 > WECLONE_PII_MAX_HITS
 *      （默认 5）→ 400 拒绝；未超阈值 → 全文就地脱敏后入库
 *   4. 每 token clone 配额（默认 5）
 * 落盘：blobStore（chunks.jsonl + mds/*.md，原子写）→ metaStore.create
 * （失败回滚 blob，不留孤儿目录）。
 */

import type { FastifyInstance } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { generateSecret, getBearerToken, sha256Hex } from '../utils/auth'
import { auditSeverePii, redactSensitiveText } from '../utils/pii'
import type { CloneVisibility, CloneRecord } from '../store/metaStore'
import type { WeCloneChunk } from '../store/blobStore'

const MAX_MD_FILES = 5
const MAX_MD_CHARS = 20_000
const MAX_TOTAL_MD_CHARS = 60_000
const MAX_CHUNK_COUNT = 50_000
const MAX_CHUNK_TEXT_CHARS = 1_200 // 设计值 800，留 50% 容差
/** PII 抽审字符预算：超过后剩余 chunks 信任客户端阶段 A 结果（防阻塞事件循环） */
const PII_SCAN_CHAR_BUDGET = 2_000_000

interface UploadBody {
  meta?: {
    wxid?: unknown
    displayName?: unknown
    knowledgeCutoff?: unknown
    generatedAt?: unknown
    messageCount?: unknown
    visibility?: unknown
  }
  mds?: unknown
  chunks?: unknown
  visibility?: unknown
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function normalizeVisibility(value: unknown): CloneVisibility {
  return value === 'public' || value === 'link' ? value : 'private'
}

export function registerUploadRoute(app: FastifyInstance): void {
  const { metaStore, blobStore, retrieval, limits } = app.weclone
  const piiMaxHits = Math.max(0, Math.floor(Number(process.env.WECLONE_PII_MAX_HITS) || 5))

  app.post<{ Body: UploadBody }>('/api/weclone/upload', {
    bodyLimit: (limits.maxUploadMb + 2) * 1024 * 1024,
    config: { rateLimit: { max: limits.rateLimitUpload, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const token = getBearerToken(request.headers.authorization)
    if (!token) {
      return reply.status(401).send({ success: false, error: 'missing bearer token' })
    }
    const ownerTokenHash = sha256Hex(token)

    // ---- 配额 ----
    const owned = metaStore.countByOwner(ownerTokenHash)
    if (owned >= limits.maxClonesPerToken) {
      return reply.status(403).send({
        success: false,
        error: `clone quota exceeded (max ${limits.maxClonesPerToken} per token)`,
      })
    }

    // ---- 结构校验 ----
    const body = request.body ?? {}
    const meta = body.meta ?? {}
    const displayName = str(meta.displayName).trim()
    if (!displayName || displayName.length > 64) {
      return reply.status(400).send({ success: false, error: 'meta.displayName required (1..64 chars)' })
    }

    const mdsIn = (body.mds && typeof body.mds === 'object' ? body.mds : {}) as Record<string, unknown>
    const mdEntries = Object.entries(mdsIn)
      .filter(([k, v]) => k.endsWith('.md') && typeof v === 'string')
      .map(([k, v]) => [k, v as string] as const)
    if (mdEntries.length === 0) {
      return reply.status(400).send({ success: false, error: 'mds must contain at least one *.md entry' })
    }
    if (mdEntries.length > MAX_MD_FILES) {
      return reply.status(400).send({ success: false, error: `mds exceeds ${MAX_MD_FILES} files` })
    }
    let totalMdChars = 0
    for (const [name, content] of mdEntries) {
      if (content.length > MAX_MD_CHARS) {
        return reply.status(400).send({ success: false, error: `mds.${name} exceeds ${MAX_MD_CHARS} chars` })
      }
      totalMdChars += content.length
    }
    if (totalMdChars > MAX_TOTAL_MD_CHARS) {
      return reply.status(400).send({ success: false, error: `total mds exceeds ${MAX_TOTAL_MD_CHARS} chars` })
    }

    const chunksIn = Array.isArray(body.chunks) ? (body.chunks as unknown[]) : []
    if (chunksIn.length === 0) {
      return reply.status(400).send({ success: false, error: 'chunks must be a non-empty array' })
    }
    if (chunksIn.length > MAX_CHUNK_COUNT) {
      return reply.status(400).send({ success: false, error: `chunks exceeds ${MAX_CHUNK_COUNT} items` })
    }
    const chunks: WeCloneChunk[] = []
    let approxChars = 0
    for (let i = 0; i < chunksIn.length; i += 1) {
      const item = chunksIn[i] as Record<string, unknown> | null
      const text = typeof item?.text === 'string' ? item.text : ''
      if (!text) {
        return reply.status(400).send({ success: false, error: `chunks[${i}].text missing` })
      }
      if (text.length > MAX_CHUNK_TEXT_CHARS) {
        return reply.status(400).send({ success: false, error: `chunks[${i}].text exceeds ${MAX_CHUNK_TEXT_CHARS} chars` })
      }
      approxChars += text.length
      chunks.push({
        id: str(item?.id),
        sid: str(item?.sid),
        ts: typeof item?.ts === 'number' ? item.ts : 0,
        text,
      })
    }
    if (approxChars > limits.maxBlobMb * 1024 * 1024) {
      return reply.status(413).send({ success: false, error: `chunks exceed ${limits.maxBlobMb}MB` })
    }

    // ---- 服务端 PII 二次复核（防客户端绕过；严重计数 > 阈值 → 400）----
    let severeCount = 0
    const severeCategories = new Set<string>()
    const sanitizedMds: Record<string, string> = {}
    for (const [name, content] of mdEntries) {
      const audit = auditSeverePii(content)
      severeCount += audit.count
      audit.labels.forEach((l) => severeCategories.add(l))
      sanitizedMds[name] = redactSensitiveText(content) // 就地脱敏（幂等）
    }
    let scannedChars = 0
    for (const chunk of chunks) {
      if (scannedChars >= PII_SCAN_CHAR_BUDGET) break // 超预算部分信任客户端阶段 A
      scannedChars += chunk.text.length
      const audit = auditSeverePii(chunk.text)
      severeCount += audit.count
      audit.labels.forEach((l) => severeCategories.add(l))
      chunk.text = redactSensitiveText(chunk.text)
    }
    if (severeCount > piiMaxHits) {
      return reply.status(400).send({
        success: false,
        error:
          `severe PII detected: ${severeCount} hits (> ${piiMaxHits}) — ` +
          `categories: ${[...severeCategories].join('/')}. Run client-side sanitization before upload.`,
        hits: severeCount,
        categories: [...severeCategories],
      })
    }

    // ---- 落盘 ----
    const id = uuidv4()
    const visibility = normalizeVisibility(body.visibility ?? meta.visibility)
    const secret = visibility === 'link' ? generateSecret() : null
    const now = new Date().toISOString()
    const knowledgeCutoff = str(meta.knowledgeCutoff).slice(0, 32)
    const generatedAtRaw = meta.generatedAt
    const generatedAt = typeof generatedAtRaw === 'number'
      ? new Date(generatedAtRaw).toISOString()
      : str(generatedAtRaw, now).slice(0, 64)
    const messageCount = Number.isFinite(Number(meta.messageCount))
      ? Math.max(chunks.length, Math.floor(Number(meta.messageCount)))
      : chunks.length

    try {
      await blobStore.saveChunks(id, chunks, limits.maxBlobMb * 1024 * 1024)
      await blobStore.saveMds(id, sanitizedMds)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      await blobStore.deleteBlob(id).catch(() => undefined) // 清理半成品
      if (code === 'BLOB_TOO_LARGE') {
        return reply.status(413).send({ success: false, error: `serialized chunks exceed ${limits.maxBlobMb}MB` })
      }
      throw err
    }

    const record: CloneRecord = {
      id,
      displayName,
      wxid: str(meta.wxid).slice(0, 128),
      knowledgeCutoff,
      generatedAt,
      visibility,
      secret,
      ownerTokenHash,
      messageCount,
      mds: sanitizedMds,
      createdAt: now,
    }
    try {
      metaStore.create(record)
    } catch (err) {
      await blobStore.deleteBlob(id) // 回滚，不留孤儿 blob
      throw err
    }
    retrieval.invalidate(id)

    return reply.status(201).send({
      success: true,
      id,
      visibility,
      ...(secret ? { secret } : {}),
      cutoff: knowledgeCutoff,
    })
  })
}
