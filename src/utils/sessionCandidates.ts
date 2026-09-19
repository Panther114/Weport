/**
 * `@` 引用候选的唯一来源。
 *
 * 抽出来是因为这里踩过一次真实的 bug：`chat:getSessions` 的返回是
 * `{ success, sessions }`（见 `electron/services/chatService.ts` 的 `getSessions`），
 * 而两个调用点都按 `{ data: [...] }` 去解包 —— 于是 `list` 永远是空数组，
 * `@` 面板在**已经连上微信**的机器上照样显示「还没有可引用的会话（先连接微信）」。
 * 两处各写一份解包逻辑，就注定会有第二处不同步；现在只有这一份。
 *
 * 三类信息在这里被区分开，因为它们对用户意味着完全不同的事情：
 * - **未连接**：去连接微信；
 * - **连接了但一个会话都没有**：账号是空的，不是 bug；
 * - **读取失败**：IPC / WCDB 报错，要把原因说出来。
 * 以前的 UI 把三者都渲染成同一句「先连接微信」。
 */
import type { ReferenceCandidate } from '../components/reference/ReferencePicker'
import type { ReferenceKind } from './mentionTrigger'

/** WCDB 会话行里我们真正会读的字段（其余一律不管）。 */
export interface RawSessionLike {
  username?: unknown
  displayName?: unknown
  nickName?: unknown
  remark?: unknown
  avatarUrl?: unknown
}

export interface ReferenceCandidateResult {
  candidates: ReferenceCandidate[]
  /** 底层调用是否成功 —— 失败时要展示 `error`，而不是「没有会话」。 */
  ok: boolean
  /** 失败原因（`ok === false` 时有值）。 */
  error?: string
}

export function referenceKindOf(id: string): ReferenceKind {
  if (id.endsWith('@chatroom')) return 'group'
  if (id.startsWith('gh_')) return 'official'
  return 'private'
}

/**
 * 从 `chat:getSessions` 的返回值里取出会话数组。
 *
 * 同时认 `sessions`（真实字段）与 `data`（历史/兼容字段），以及裸数组 ——
 * 这个函数存在的意义就是"返回形状变了也不会静默变成空列表"。
 */
export function sessionListFromPayload(payload: unknown): RawSessionLike[] {
  if (Array.isArray(payload)) return payload as RawSessionLike[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as { sessions?: unknown; data?: unknown }
  if (Array.isArray(record.sessions)) return record.sessions as RawSessionLike[]
  if (Array.isArray(record.data)) return record.data as RawSessionLike[]
  return []
}

export function toReferenceCandidates(sessions: RawSessionLike[]): ReferenceCandidate[] {
  const mapped: ReferenceCandidate[] = []
  for (const session of sessions) {
    const id = String(session?.username || '').trim()
    if (!id) continue
    const kind = referenceKindOf(id)
    const label = String(session.displayName || session.remark || session.nickName || id)
    // 备注与显示名相同时不再重复一遍（否则每条都会写「备注：<同名>」）。
    const remark = String(session.remark || '')
    const subtitle = remark && remark !== label ? `备注：${remark}` : undefined
    mapped.push({ id, label, kind, subtitle, avatarUrl: session.avatarUrl as string | undefined })
  }
  // 群聊排前面：这两个入口的典型用法都是「引用某个群」，私聊相对少见。
  return mapped.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'group' ? -1 : b.kind === 'group' ? 1 : 0
    return a.label.localeCompare(b.label)
  })
}

/**
 * 解包 + 映射一步到位。`ok` 只有在**底层明确报错**时才是 false：
 * 一个成功的空列表说明账号确实没有会话。
 */
export function parseSessionPayload(payload: unknown): ReferenceCandidateResult {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as { success?: unknown; error?: unknown }
    if (record.success === false) {
      return { candidates: [], ok: false, error: String(record.error || '读取会话列表失败') }
    }
  }
  return { candidates: toReferenceCandidates(sessionListFromPayload(payload)), ok: true }
}

// ---------------------------------------------------------------------------
// 共享缓存
// ---------------------------------------------------------------------------

/**
 * 读一次会话列表要过一遍 WCDB，两个页面各自在挂载时读一次是浪费；但更要紧的是
 * **空结果绝不能被缓存** —— 用户先打开 AI 页面、再去连微信，是再正常不过的顺序，
 * 缓存了那次空结果就等于把 `@` 永久锁死。所以：
 * - 只有非空、成功的结果才进缓存；
 * - 缓存有效期 60s，过后重新读（新会话、改名都能反映出来）。
 */
const CACHE_TTL_MS = 60_000

/**
 * 失败后的重试间隔。
 *
 * 为什么需要它：`ensureReferenceCandidates` 是在**每一次按键**上被调用的
 * （`syncMention` 里 `if (active) void ensure(...)`）。读失败时缓存是空的，
 * 于是每个字符都会再打一次 IPC —— 用户在输入框里打十个字，主进程被问了十次，
 * 每次都失败。留 3 秒的冷却，失败时的代价从"每键一次"降到"每 3 秒一次"。
 */
const FAILURE_RETRY_MS = 3_000

let cache: { candidates: ReferenceCandidate[]; at: number } | null = null
let inflight: Promise<ReferenceCandidateResult> | null = null
let lastFailureAt = 0

export function peekCachedReferenceCandidates(): ReferenceCandidate[] | null {
  if (!cache) return null
  if (Date.now() - cache.at > CACHE_TTL_MS) return null
  return cache.candidates
}

export function invalidateReferenceCandidates(): void {
  cache = null
  lastFailureAt = 0
}

type GetSessions = () => Promise<unknown>

/**
 * 取会话候选。并发调用合并成一次 IPC；只有拿到非空结果才写缓存。
 *
 * 失败会被记下来并冷却 3 秒 —— 调用方不需要知道这件事，它只管每次按键都问。
 */
export async function loadReferenceCandidates(getSessions: GetSessions): Promise<ReferenceCandidateResult> {
  const cached = peekCachedReferenceCandidates()
  if (cached) return { candidates: cached, ok: true }
  if (inflight) return inflight
  if (lastFailureAt > 0 && Date.now() - lastFailureAt < FAILURE_RETRY_MS) {
    // 冷却期内不重试：直接把上次的结论再说一遍，调用方看到的是同样的空态
    return { candidates: [], ok: false, error: '读取会话失败（稍后会自动重试）' }
  }

  inflight = (async () => {
    try {
      const raw = await getSessions()
      const result = parseSessionPayload(raw)
      if (result.ok && result.candidates.length > 0) {
        cache = { candidates: result.candidates, at: Date.now() }
      }
      lastFailureAt = result.ok ? 0 : Date.now()
      return result
    } catch (error) {
      lastFailureAt = Date.now()
      return { candidates: [], ok: false, error: String((error as Error)?.message || error) }
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * `@` 面板的空态文案。
 *
 * 未知（还在读）与"读失败"必须分开：把 WCDB 的报错渲染成「先连接微信」正是
 * 用户报的那个 bug 的可见形态 —— 明明连着，却被告知去连接。
 */
export function emptyReferenceHint(input: {
  loading?: boolean
  ok: boolean
  error?: string
  hasCandidates: boolean
}): string {
  if (input.loading) return '正在读取会话…'
  if (!input.ok) return `读取会话失败：${input.error || '未知原因'}`
  if (input.hasCandidates) return '没有匹配的会话'
  return '这个账号还没有可引用的会话（先连接微信）'
}
