/**
 * `@` 引用的触发判定。
 *
 * 抽成纯函数是为了能直接单测 —— 这类「光标位置 + 正则」的逻辑最容易在
 * 边界上出错（邮箱里的 @、换行后的 @、刚打出一个 @ 就按 Esc），而在 UI 里
 * 手工复现这些边界非常费时。
 */

export interface ActiveMention {
  /** `@` 在文本中的下标。 */
  start: number
  /** `@` 之后、光标之前的查询串（可能为空串）。 */
  query: string
}

/**
 * 判断光标处是否处于一个活跃的 `@` 查询中。
 *
 * 规则：
 * - `@` 必须位于文本开头，或紧跟在空白之后 —— 否则 `a@b.com` 这类内容
 *   会不断弹出选择器。
 * - `@` 与光标之间不能出现空白或换行（出现即视为已结束这次引用）。
 * - 不限制查询长度：用户可能想搜一个很长的群名。
 */
export function findActiveMention(value: string, caret: number): ActiveMention | null {
  const text = String(value ?? '')
  const position = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, position)

  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0) {
    const previous = before[at - 1]
    if (!/\s/.test(previous)) return null
  }

  const query = before.slice(at + 1)
  if (/[\s\n\r]/.test(query)) return null

  return { start: at, query }
}

/**
 * 把选中的引用写回文本：用 `@显示名` 替换掉 `@查询串`，并返回新的光标位置。
 *
 * 输出里保留人类可读的 `@名称`（而不是内部 id）——用户需要看得见自己引用了
 * 谁；机器可读的引用列表由调用方单独维护，两者不混在同一个字符串里。
 */
export function applyMention(
  value: string,
  mention: ActiveMention,
  caret: number,
  label: string
): { value: string; caret: number } {
  const text = String(value ?? '')
  const position = Math.max(0, Math.min(caret, text.length))
  const insertion = `@${label} `
  const next = text.slice(0, mention.start) + insertion + text.slice(position)
  return { value: next, caret: mention.start + insertion.length }
}

export type ReferenceKind = 'group' | 'private' | 'official'

export interface ChatReference {
  id: string
  label: string
  kind: ReferenceKind
}

/** 会话类型的中文标签（选择器与引用 chip 共用同一套措辞）。 */
export function referenceKindLabel(kind: ReferenceKind): string {
  if (kind === 'group') return '群聊'
  if (kind === 'official') return '公众号'
  return '私聊'
}

/**
 * 按查询串筛选候选：先匹配显示名，再匹配备注/副标题，最后匹配 id。
 *
 * 排序刻意保持「前缀命中优先」——搜「化学」时把「化学 3 班」排在
 * 「高一化学兴趣小组」前面，比按会话时间排更符合输入即筛选的直觉。
 */
export function filterReferenceCandidates<T extends { id: string; label: string; subtitle?: string }>(
  candidates: T[],
  query: string,
  limit = 200
): T[] {
  const trimmed = String(query || '').trim().toLowerCase()
  if (!trimmed) return candidates.slice(0, limit)

  const scored: Array<{ item: T; score: number }> = []
  for (const item of candidates) {
    const label = String(item.label || '').toLowerCase()
    const subtitle = String(item.subtitle || '').toLowerCase()
    const id = String(item.id || '').toLowerCase()

    let score = -1
    if (label.startsWith(trimmed)) score = 0
    else if (label.includes(trimmed)) score = 1
    else if (subtitle.includes(trimmed)) score = 2
    else if (id.includes(trimmed)) score = 3
    if (score >= 0) scored.push({ item, score })
  }

  return scored
    .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.item.label.localeCompare(b.item.label)))
    .slice(0, limit)
    .map((entry) => entry.item)
}
