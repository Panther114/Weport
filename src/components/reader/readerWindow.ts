/**
 * 阅读器的窗口化数学与注解读取。
 *
 * ## 为什么"每行自带日期分隔"而不是把分隔当成独立的一行
 *
 * 双向无限滚动要往上**插入**更早的消息。若日期分隔是独立行，插入 N 条消息 + k 个
 * 新分隔行之后，`firstItemIndex` 要减去的数量就不再等于消息数（k 取决于边界那天
 * 是否与已加载的合并），虚拟列表的锚点会漂移 —— 表现为"下拉时列表自己跳一下"。
 * 分隔由消息行自己渲染时，行数恒等于消息数，插入多少条就减多少，锚点是精确的。
 * 日期分隔的**标签**仍然集中算在这里（`dayBoundaryFlags`），组件不重复判断。
 *
 * 全部为纯函数：`vitest.config.mts` 的 environment 是 `node`（无 jsdom），能测的
 * 就是这一层。
 */
import type { ReaderMessage, ReaderSearchHit } from './readerTypes'
import { dayKeyOf, messagePreviewText } from './readerMessage'
import { annotationMatchesMessage, type AnnotationMessageIdentity } from '../../utils/annotationIdentity'

/** 按 key 去重、按时间升序合并两段消息（引擎分页给的是升序，这里只兜底）。 */
export function mergeMessages(existing: ReaderMessage[], incoming: ReaderMessage[]): ReaderMessage[] {
  if (incoming.length === 0) return existing
  const seen = new Set(existing.map((message) => message.key))
  const merged = existing.slice()
  for (const message of incoming) {
    if (!message.key || seen.has(message.key)) continue
    seen.add(message.key)
    merged.push(message)
  }
  merged.sort((a, b) => (a.ts - b.ts) || (a.localId - b.localId))
  return merged
}

export interface PrependState {
  messages: ReaderMessage[]
  /** `react-virtuoso` 的 `firstItemIndex`：往上插 N 行就减 N，滚动位置才不会跳。 */
  firstItemIndex: number
}

export const INITIAL_FIRST_ITEM_INDEX = 100000

/**
 * 把"更早的一页"插到前面。返回值里 `added` 是**真正新增**的行数（重复的 key 不算）
 * —— 直接用它去减 `firstItemIndex`，而不是用 `incoming.length`：引擎在把消息数量为
 * 0 的会话跳过、或者相邻页有重叠时会重复投递同一条，按 length 减就会越滚越偏。
 */
export function prependOlderPage(state: PrependState, older: ReaderMessage[]): PrependState & { added: number } {
  const merged = mergeMessages(state.messages, older)
  const added = merged.length - state.messages.length
  return { messages: merged, firstItemIndex: state.firstItemIndex - added, added }
}

export function replaceMessages(messages: ReaderMessage[]): PrependState {
  return { messages, firstItemIndex: INITIAL_FIRST_ITEM_INDEX }
}

/** 第 i 行是否需要渲染日期分隔（i=0 一定需要）。 */
export function dayBoundaryFlags(messages: ReaderMessage[]): boolean[] {
  const flags = new Array<boolean>(messages.length)
  let previous = ''
  for (let index = 0; index < messages.length; index += 1) {
    const key = dayKeyOf(messages[index].ts)
    const changed = key !== previous
    flags[index] = changed || index === 0
    if (changed) previous = key
  }
  return flags
}

/**
 * "未读分界"要画在哪条消息上（在那条之前画一条分隔）。
 *
 * 引擎的 `unreadCount` 是会话级的，只能近似：从最新往回数 `unreadCount` 条。数量
 * 对不上（未读 > 已加载、或会话被读过）时返回 null —— 宁可不画，也不要画在错的地方。
 */
export function unreadAnchorKey(messages: ReaderMessage[], unreadCount: number): string | null {
  const unread = Math.floor(Number(unreadCount) || 0)
  if (unread <= 0 || unread >= messages.length) return null
  const index = messages.length - unread
  const message = messages[index]
  if (!message || message.isSend) return null
  return message.key
}

export function indexOfMessage(messages: ReaderMessage[], key: string): number {
  if (!key) return -1
  return messages.findIndex((message) => message.key === key)
}

/** 在**已加载**的消息里搜索（引擎会话内搜索通道缺失时的降级形态，界面会说明）。 */
export function searchLoadedMessages(messages: ReaderMessage[], keyword: string, limit = 200): ReaderSearchHit[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return []
  const hits: ReaderSearchHit[] = []
  // 从最新往回找：用户搜会话时想看的是最近提到这件事的地方。
  for (let index = messages.length - 1; index >= 0 && hits.length < limit; index -= 1) {
    const message = messages[index]
    const haystack = `${message.text}\n${message.fileName || ''}\n${message.linkTitle || ''}\n${message.quote?.text || ''}`.toLowerCase()
    if (!haystack.includes(needle)) continue
    hits.push({
      key: message.key,
      index,
      ts: message.ts,
      senderName: message.isSend ? '我' : message.senderName || message.senderUsername,
      excerpt: messagePreviewText(message, 80),
    })
  }
  return hits
}

/** 复制一段消息范围：`fromKey`/`toKey` 顺序无关，两端都含。 */
export function selectRange(messages: ReaderMessage[], fromKey: string, toKey: string): ReaderMessage[] {
  const from = indexOfMessage(messages, fromKey)
  const to = indexOfMessage(messages, toKey)
  if (from < 0 || to < 0) return []
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  return messages.slice(start, end + 1)
}

// ---------------------------------------------------------------------------
// 注解（只读侧）
// ---------------------------------------------------------------------------

export interface MessageAnnotationState {
  marked: boolean
  note: string
  favorite: boolean
}

const EMPTY_ANNOTATION: MessageAnnotationState = { marked: false, note: '', favorite: false }

function entriesOf(store: AnnotationsStore | null, key: 'marks' | 'favorites') {
  const list = store?.[key]
  return Array.isArray(list) ? list : []
}

/** 一条消息的标记状态。**只从主进程回的 store 推**，界面不自己记。 */
export function messageAnnotation(store: AnnotationsStore | null, message: AnnotationMessageIdentity): MessageAnnotationState {
  if (!store) return EMPTY_ANNOTATION
  const mark = entriesOf(store, 'marks').find(
    (entry) => entry && annotationMatchesMessage(entry, message),
  )
  const favorite = entriesOf(store, 'favorites').some(
    (entry) => entry && entry.sessionId === message.sessionId && !entry.localId && !entry.messageId,
  )
  if (!mark) return { ...EMPTY_ANNOTATION, favorite }
  return { marked: true, note: String(mark.note || ''), favorite }
}

/** 会话级收藏（`localId` 为空的那种）。 */
export function isSessionFavorite(store: AnnotationsStore | null, sessionId: string): boolean {
  return entriesOf(store, 'favorites').some((entry) => entry && entry.sessionId === sessionId && !entry.localId && !entry.messageId)
}

/** 一个会话挂着的全部标签。 */
export function sessionTags(store: AnnotationsStore | null, sessionId: string): string[] {
  if (!store?.tags) return []
  const direct = store.tags[sessionId]
  if (Array.isArray(direct)) return [...direct].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  // Compatibility for old fixtures/stores that exposed tag -> sessionIds.
  return Object.keys(store.tags)
    .filter((tag) => Array.isArray(store.tags[tag]) && store.tags[tag].includes(sessionId))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

/** 一个会话的标记条数（会话列表上显示）。 */
export function markCountOf(store: AnnotationsStore | null, sessionId: string): number {
  return entriesOf(store, 'marks').filter((entry) => entry && entry.sessionId === sessionId).length
}

/** 全局标记总数 —— 注解不可用（通道缺失）时界面显示的是它，用来区分"没标记"和"读不到"。 */
export function totalMarks(store: AnnotationsStore | null): number {
  return entriesOf(store, 'marks').length
}
