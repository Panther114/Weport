/**
 * 克隆管理路由（v0.9.10）：
 *   GET    /api/weclone/list                Bearer → 自己的克隆
 *   GET    /api/weclone/public              匿名   → 公开克隆（≤50）
 *   GET    /api/weclone/:id                 Bearer owner / ?secret=（link）/ 匿名（public）→ 元数据 + mds
 *   DELETE /api/weclone/:id                 Bearer owner → 删除即焚毁
 *   PATCH  /api/weclone/:id/visibility      Bearer owner → private|public|link
 *
 * 隐私检查：private 仅 owner；link 需 secret（owner 亦可通过）；public 匿名可读。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { generateSecret, getBearerToken, safeEqual, sha256Hex } from '../utils/auth'
import type { CloneRecord } from '../store/metaStore'

/** 公开列表返回的字段（不含 ownerTokenHash / secret / mds 正文） */
function publicView(row: CloneRecord) {
  return {
    id: row.id,
    displayName: row.displayName,
    knowledgeCutoff: row.knowledgeCutoff,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
  }
}

/** owner 视图字段 */
function ownerView(row: CloneRecord) {
  return {
    ...publicView(row),
    wxid: row.wxid,
    generatedAt: row.generatedAt,
    visibility: row.visibility,
    secret: row.secret ?? undefined,
  }
}

/**
 * 匿名/link 访客视图：剥离 wxid / secret / ownerTokenHash（隐私边界）。
 * 仅暴露展示所需元数据；mds 正文单独返回且经 stripPrivateMds 过滤。
 */
function anonView(row: CloneRecord) {
  return {
    id: row.id,
    displayName: row.displayName,
    visibility: row.visibility,
    knowledgeCutoff: row.knowledgeCutoff,
    generatedAt: row.generatedAt,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
  }
}

/** 鉴权：返回 'owner' | 'link' | 'anon'（public 匿名可读）| null */
function authorize(row: CloneRecord, request: FastifyRequest): 'owner' | 'link' | 'anon' | null {
  const token = getBearerToken(request.headers.authorization)
  if (token && safeEqual(sha256Hex(token), row.ownerTokenHash)) return 'owner'
  if (row.visibility === 'link' && row.secret) {
    const query = (request.query ?? {}) as Record<string, unknown>
    const secret = typeof query.secret === 'string' ? query.secret : ''
    if (secret && safeEqual(secret, row.secret)) return 'link'
  }
  // public 克隆允许匿名读取（Browse → /c/:id 无需任何凭证）
  if (row.visibility === 'public') return 'anon'
  return null
}

export function registerCloneRoutes(app: FastifyInstance): void {
  const { metaStore, blobStore, retrieval } = app.weclone

  // ---- 自己的克隆列表 ----
  app.get('/api/weclone/list', async (request, reply) => {
    const token = getBearerToken(request.headers.authorization)
    if (!token) return reply.status(401).send({ success: false, error: 'missing bearer token' })
    const rows = metaStore.listByOwner(sha256Hex(token))
    return { success: true, clones: rows.map(ownerView) }
  })

  // ---- 公开浏览（匿名；find-my-way 静态段优先于 :id，注册顺序无关）----
  app.get<{ Querystring: Record<string, unknown> }>('/api/weclone/public', async (request) => {
    const query = request.query ?? {}
    const limitRaw = Number(query.limit)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 50) : 20
    const offsetRaw = Number(query.offset)
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0
    const q = typeof query.q === 'string' ? query.q : undefined
    const rows = metaStore.listPublic(limit, offset, q)
    return { success: true, clones: rows.map(publicView), limit, offset }
  })

  // ---- 元数据 + mds（Bearer 或 ?secret=；隐私检查）----
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>('/api/weclone/:id', async (request, reply) => {
    const row = metaStore.get(request.params.id)
    if (!row) return reply.status(404).send({ success: false, error: 'clone not found' })
    const who = authorize(row, request)
    if (!who || (row.visibility === 'private' && who !== 'owner')) {
      return reply.status(who ? 403 : 401).send({ success: false, error: 'not authorized for this clone' })
    }
    // meta 行内 mds 为准（冗余存储）；blob 缺失/为空时回退读 mds/*.md 文件
    const mdsSource = Object.keys(row.mds ?? {}).length > 0 ? row.mds : blobStore.getMds(row.id)
    const mds = who === 'owner' ? mdsSource : stripPrivateMds(mdsSource)
    return {
      success: true,
      // 非 owner（link / 匿名）只拿脱敏视图：无 wxid / secret / ownerTokenHash
      meta: who === 'owner' ? ownerView(row) : anonView(row),
      mds,
      visibility: row.visibility,
    }
  })

  // ---- 删除即焚毁 ----
  app.delete<{ Params: { id: string } }>('/api/weclone/:id', async (request, reply) => {
    const token = getBearerToken(request.headers.authorization)
    if (!token) return reply.status(401).send({ success: false, error: 'missing bearer token' })
    const row = metaStore.get(request.params.id)
    if (!row) return reply.status(404).send({ success: false, error: 'clone not found' })
    if (!safeEqual(sha256Hex(token), row.ownerTokenHash)) {
      return reply.status(403).send({ success: false, error: 'only the owner can delete this clone' })
    }
    await blobStore.deleteBlob(row.id)
    metaStore.delete(row.id)
    retrieval.invalidate(row.id)
    return { success: true, id: row.id }
  })

  // ---- 可见性 ----
  app.patch<{ Params: { id: string }; Body: { visibility?: unknown } }>(
    '/api/weclone/:id/visibility',
    async (request, reply) => {
      const token = getBearerToken(request.headers.authorization)
      if (!token) return reply.status(401).send({ success: false, error: 'missing bearer token' })
      const row = metaStore.get(request.params.id)
      if (!row) return reply.status(404).send({ success: false, error: 'clone not found' })
      if (!safeEqual(sha256Hex(token), row.ownerTokenHash)) {
        return reply.status(403).send({ success: false, error: 'only the owner can change visibility' })
      }
      const next = request.body?.visibility
      if (next !== 'private' && next !== 'public' && next !== 'link') {
        return reply.status(400).send({ success: false, error: "visibility must be 'private'|'public'|'link'" })
      }
      // link：沿用已有 secret，没有则生成 16-hex；其余可见性清空 secret
      let secret: string | null = null
      if (next === 'link') secret = row.secret ?? generateSecret()
      metaStore.updateVisibility(row.id, next, secret)
      retrieval.invalidate(row.id)

      const host = request.headers.host ? String(request.headers.host) : 'localhost'
      const proto = request.protocol || 'https'
      return {
        success: true,
        visibility: next,
        ...(secret ? { secret, shareUrl: `${proto}://${host}/share/${row.id}?secret=${secret}` } : {}),
      }
    },
  )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const PRIVATE_MD_KEYS = new Set(['profile', 'relationships', 'knowledge', 'timeline', 'language'])

/** link/匿名访问时只暴露已知知识文件，过滤未知键 */
function stripPrivateMds(mds: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(mds ?? {})) {
    if (typeof v === 'string' && PRIVATE_MD_KEYS.has(k.replace(/\.md$/, ''))) out[k] = v
  }
  return out
}
