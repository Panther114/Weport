/**
 * weclone-web API 客户端 —— 同源 fetch 封装（开发模式经 vite proxy 转发）。
 *
 * 服务端协议见 weclone-server/src/routes/{clones,chat}.ts：
 * - GET  /api/weclone/public            → { success, clones: PublicClone[] }
 * - GET  /api/weclone/:id?secret=       → { success, meta, mds, visibility }
 * - POST /api/weclone/:id/chat          → SSE（event: delta / done / error）
 */

export interface PublicClone {
  id: string
  displayName: string
  knowledgeCutoff: string
  messageCount: number
  createdAt: string
}

export type CloneVisibility = 'private' | 'public' | 'link'

export interface CloneMeta extends PublicClone {
  wxid?: string
  generatedAt?: string
  visibility?: CloneVisibility
  secret?: string
}

export interface CloneDetail {
  meta: CloneMeta
  mds: Record<string, string>
  visibility: CloneVisibility
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 带 HTTP 状态码的错误（401/403 → 前端弹出密钥输入） */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function readError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText || 'request failed'}`
  try {
    const data = (await res.json()) as { error?: unknown }
    if (data && typeof data.error === 'string' && data.error) message = data.error
  } catch {
    // 非 JSON 错误体，保留默认消息
  }
  return new ApiError(res.status, message)
}

/** YYYY-MM-DD 截取展示；其余原样返回 */
export function formatDate(value: string | undefined | null): string {
  if (!value) return '—'
  const head = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : value
}

// ---------------------------------------------------------------------------
// 公开列表
// ---------------------------------------------------------------------------

export async function fetchPublicClones(q?: string): Promise<PublicClone[]> {
  const params = new URLSearchParams({ limit: '50' })
  if (q) params.set('q', q)
  const res = await fetch(`/api/weclone/public?${params.toString()}`)
  if (!res.ok) throw await readError(res)
  const data = (await res.json()) as { clones?: PublicClone[] }
  return Array.isArray(data.clones) ? data.clones : []
}

// ---------------------------------------------------------------------------
// 克隆元数据 + mds（Bearer 由 Weport 客户端使用；网页走 ?secret= 或匿名）
// ---------------------------------------------------------------------------

export async function getClone(id: string, secret?: string): Promise<CloneDetail> {
  const qs = secret ? `?secret=${encodeURIComponent(secret)}` : ''
  const res = await fetch(`/api/weclone/${encodeURIComponent(id)}${qs}`)
  if (!res.ok) throw await readError(res)
  const data = (await res.json()) as {
    meta?: CloneMeta
    mds?: Record<string, string>
    visibility?: CloneVisibility
  }
  return {
    meta: data.meta ?? { id, displayName: id, knowledgeCutoff: '', messageCount: 0, createdAt: '' },
    mds: data.mds ?? {},
    visibility: data.visibility ?? data.meta?.visibility ?? 'public',
  }
}

// ---------------------------------------------------------------------------
// 聊天流（SSE 解析）
// ---------------------------------------------------------------------------

export async function chatStream(
  id: string,
  opts: {
    messages: ChatMessage[]
    secret?: string
    signal?: AbortSignal
    onDelta: (delta: string) => void
  },
): Promise<void> {
  const res = await fetch(`/api/weclone/${encodeURIComponent(id)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: opts.messages,
      stream: true,
      ...(opts.secret ? { secret: opts.secret } : {}),
    }),
    signal: opts.signal,
  })
  if (!res.ok) throw await readError(res)
  if (!res.body) throw new ApiError(res.status || 502, '响应无内容流')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  /** 处理单个 SSE 帧（event + data 行）；error 帧抛出异常中断 */
  const handleBlock = (block: string): void => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      // 注释行（`: ping`）与其余字段忽略
    }
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')

    if (event === 'delta') {
      try {
        const parsed = JSON.parse(data) as { delta?: unknown }
        if (typeof parsed.delta === 'string' && parsed.delta) opts.onDelta(parsed.delta)
      } catch {
        // 忽略无法解析的 delta 帧
      }
    } else if (event === 'error') {
      let message = '生成回复失败，请稍后重试'
      try {
        const parsed = JSON.parse(data) as { error?: unknown }
        if (typeof parsed.error === 'string' && parsed.error) message = parsed.error
      } catch {
        // keep default
      }
      throw new ApiError(502, message)
    }
    // event: done → 自然结束，无需处理
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf('\n\n')
      while (sep >= 0) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        handleBlock(block)
        sep = buffer.indexOf('\n\n')
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}
