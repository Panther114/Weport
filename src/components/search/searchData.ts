/**
 * 搜索页的数据读取与本地筛选（v1.2 §6）。
 *
 * 两个原则：
 *   1. **不造假数据**。通道缺失 / 调用失败时返回明确的失败原因，由页面渲染
 *      "此处不可用"，而不是编几条结果让界面看起来是活的。
 *   2. 会话候选列表来自 `chat:getSessions`（引擎已有的通道），但只保留界面上
 *      真正用到的三个字段 —— 渲染层不需要、也不该缓存整包会话对象。
 */
import { displayNameOrFallback } from '../../utils/displayName'
import type { ScopeParams } from './searchQuery'

export interface SessionCandidate {
  username: string
  displayName: string
}

/** 最近用过的会话（本机偏好，不是数据）。key 带版本前缀，避免将来改形状时读到旧格式。 */
const RECENT_KEY = 'weport.search.recentSessions'
const RECENT_MAX = 8

function readJsonArray(key: string): string[] {
  try {
    const raw = window.localStorage?.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    // 隐私模式 / 配额满 / 半截 JSON：偏好读不到不是错误，静默降级
    return []
  }
}

function writeJsonArray(key: string, value: string[]): void {
  try {
    window.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    /* 同上：写不进去只影响"最近使用"这个便利功能 */
  }
}

export function loadRecentSessions(): string[] {
  return readJsonArray(RECENT_KEY).slice(0, RECENT_MAX)
}

export function rememberRecentSession(username: string): string[] {
  const next = [username, ...loadRecentSessions().filter((item) => item !== username)].slice(0, RECENT_MAX)
  writeJsonArray(RECENT_KEY, next)
  return next
}

export interface CandidatesResult {
  list: SessionCandidate[]
  /** 通道不存在或调用失败时的原因（界面据此显示"会话列表不可用"，但关键词搜索仍可用） */
  error?: string
}

/**
 * 读会话候选。
 *
 * `undefined` 的 `chat` 组是真实情况（引擎还没接线 / 精简构建）：这不是异常，
 * 是"这个功能在本机不可用"，所以走返回值而不是 throw —— 页面要能把它显示出来。
 */
export async function loadSessionCandidates(): Promise<CandidatesResult> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  const chat = api?.chat
  if (!chat?.getSessions) return { list: [], error: '会话通道不可用' }
  try {
    const res = await chat.getSessions()
    if (!res || res.success === false) return { list: [], error: res?.error || '读取会话失败' }
    const rows = Array.isArray(res.sessions) ? res.sessions : []
    const list: SessionCandidate[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const username = typeof (row as { username?: unknown }).username === 'string' ? (row as { username: string }).username : ''
      if (!username || seen.has(username)) continue
      seen.add(username)
      list.push({ username, displayName: displayNameOrFallback(username, (row as { displayName?: unknown }).displayName) })
    }
    list.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'))
    return { list }
  } catch (error) {
    return { list: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export interface CandidateFilterInput {
  /** 关键词（会话名或 id 的子串，大小写不敏感） */
  keyword: string
  /** 已经选中的会话 id（永远置顶，且不会被关键词筛掉） */
  selected: string[]
  /** 已打标签的会话 id 集合；为空表示"不按标签筛" */
  tagged?: Set<string>
  /** 最近使用过的会话 id */
  recent?: string[]
  limit?: number
}

/**
 * 会话选择器的本地筛选与排序（纯函数，有单测）。
 *
 * 排序：已选中 > 最近使用 > 名称命中 > 其余。选中置顶是必须的 —— 否则用户勾了
 * 五个会话之后，改一下关键词就看不见自己勾了什么。
 */
export function filterCandidates(list: SessionCandidate[], input: CandidateFilterInput): SessionCandidate[] {
  const kw = input.keyword.trim().toLowerCase()
  const selected = new Set(input.selected)
  const recentRank = new Map((input.recent || []).map((id, index) => [id, index]))
  const matched: Array<{ item: SessionCandidate; rank: number; recent: number }> = []

  for (const item of list) {
    if (input.tagged && !input.tagged.has(item.username) && !selected.has(item.username)) continue
    const hit = !kw || item.displayName.toLowerCase().includes(kw) || item.username.toLowerCase().includes(kw)
    if (!hit && !selected.has(item.username)) continue
    const isSelected = selected.has(item.username) ? 0 : 1
    const recentOrder = recentRank.get(item.username)
    const recentValue = recentOrder === undefined ? Number.MAX_SAFE_INTEGER : recentOrder
    const nameHit = !kw || item.displayName.toLowerCase().includes(kw) ? 0 : 1
    matched.push({ item, rank: isSelected * 2 + nameHit, recent: recentValue })
  }

  matched.sort((a, b) => a.rank - b.rank || a.recent - b.recent || a.item.displayName.localeCompare(b.item.displayName, 'zh-CN'))
  return (input.limit ? matched.slice(0, input.limit) : matched).map((row) => row.item)
}

/** 把作用域里的会话 id 换成显示名（结果页的"筛选摘要"用）。 */
export function describeScope(scope: ScopeParams, names: Map<string, string>): string[] {
  const parts: string[] = []
  if (scope.tags.length) parts.push(`标签 ${scope.tags.join('、')}`)
  if (scope.sessionIds.length) parts.push(`会话 ${scope.sessionIds.map((id) => names.get(id) || id).join('、')}`)
  if (scope.senders.length) parts.push(`发送者 ${scope.senders.join('、')}`)
  if (scope.from || scope.to) parts.push(`${scope.from || '不限'} 至 ${scope.to || '不限'}`)
  if (scope.kinds.length) parts.push(`类型 ${scope.kinds.join('、')}`)
  return parts
}
