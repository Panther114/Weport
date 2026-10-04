import { describe, expect, it } from 'vitest'
import {
  INITIAL_FIRST_ITEM_INDEX,
  dayBoundaryFlags,
  indexOfMessage,
  isSessionFavorite,
  markCountOf,
  messageAnnotation,
  prependOlderPage,
  replaceMessages,
  searchLoadedMessages,
  selectRange,
  sessionTags,
  totalMarks,
  unreadAnchorKey,
} from './readerWindow'
import { normalizeMessage } from './readerMessage'
import type { ReaderMessage } from './readerTypes'

/**
 * 窗口化数学 + 注解（v1.2 §3）。
 *
 * 双向无限滚动的第一条断言是"往上插 N 条，`firstItemIndex` 恰好减 N"：引擎分页在
 * 相邻页重叠、或跳过没有消息表的会话时会给回重复行，按 `length` 减就必然越滚越偏
 * （表现是"下拉一次跳一次"）。这里把它钉住。
 *
 * 注解那几条测的是"界面读的是主进程回的 store，而不是自己推演的状态"。
 */

function message(localId: number, createTime: number, extra: Record<string, unknown> = {}): ReaderMessage {
  return normalizeMessage({ localId, createTime, localType: 1, parsedContent: `#${localId}`, ...extra }, 's1')
}

/**
 * 日期分隔标记。
 *
 * 界面把这份 flag 数组按**数据下标**喂给 `MessageRow`（`showDay`），所以这里钉住两件事：
 * 第一行永远要分隔；同一天内连续的行不要分隔。上一轮有人（包括我）按"react-virtuoso 给的是
 * 绝对下标"去减 `firstItemIndex`，结果分隔线一条都不出 —— 实测下来它给的就是数据下标。
 * 这条断言把"下标含义"钉在测试里，省得下一个人再猜一次。
 */
describe('dayBoundaryFlags', () => {
  const at = (day: string, hour: number) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).getTime()

  it('第一天和每天的第一行都要分隔', () => {
    const flags = dayBoundaryFlags([
      message(1, at('2026-09-24', 9)),
      message(2, at('2026-09-24', 10)),
      message(3, at('2026-09-25', 8)),
      message(4, at('2026-09-25', 9)),
      message(5, at('2026-09-27', 23)),
    ])
    expect(flags).toEqual([true, false, true, false, true])
  })

  it('空列表就是空数组', () => {
    expect(dayBoundaryFlags([])).toEqual([])
  })
})

describe('mergeMessages / prependOlderPage', () => {
  it('首屏替换会重置锚点', () => {    const state = replaceMessages([message(1, 100), message(2, 200)])
    expect(state.firstItemIndex).toBe(INITIAL_FIRST_ITEM_INDEX)
    expect(state.messages.map((item) => item.localId)).toEqual([1, 2])
  })

  it('往上插 2 条更早的：锚点减 2，顺序仍是升序', () => {
    const state = replaceMessages([message(3, 300), message(4, 400)])
    const merged = prependOlderPage(state, [message(1, 100), message(2, 200)])
    expect(merged.added).toBe(2)
    expect(merged.firstItemIndex).toBe(INITIAL_FIRST_ITEM_INDEX - 2)
    expect(merged.messages.map((item) => item.localId)).toEqual([1, 2, 3, 4])
  })

  it('重复行不算新增（锚点不会被多减）', () => {
    const state = replaceMessages([message(3, 300), message(4, 400)])
    const merged = prependOlderPage(state, [message(4, 400), message(5, 500)])
    expect(merged.added).toBe(1)
    expect(merged.firstItemIndex).toBe(INITIAL_FIRST_ITEM_INDEX - 1)
    expect(merged.messages).toHaveLength(3)
  })

  it('引擎给了乱序的一页也按时间排好（不靠引擎的排序）', () => {
    const state = replaceMessages([message(3, 300)])
    const merged = prependOlderPage(state, [message(3, 300), message(1, 100), message(2, 200)])
    expect(merged.messages.map((item) => item.localId)).toEqual([1, 2, 3])
  })

  it('空页不动锚点（到底了不会再减）', () => {
    const state = replaceMessages([message(1, 100)])
    const merged = prependOlderPage(state, [])
    expect(merged.added).toBe(0)
    expect(merged.firstItemIndex).toBe(INITIAL_FIRST_ITEM_INDEX)
  })

  it('连续三次上翻的锚点等于 初始值 - 累计条数', () => {
    let state = replaceMessages([message(9, 900)])
    state = prependOlderPage(state, [message(8, 800)])
    state = prependOlderPage(state, [message(6, 600), message(7, 700)])
    state = prependOlderPage(state, [message(5, 500)])
    expect(state.firstItemIndex).toBe(INITIAL_FIRST_ITEM_INDEX - 4)
    expect(state.messages).toHaveLength(5)
  })
})

describe('dayBoundaryFlags', () => {
  const day = (localId: number, y: number, m: number, d: number, h = 12) =>
    message(localId, Math.floor(new Date(y, m - 1, d, h).getTime() / 1000))

  it('第一行一定带分隔，跨天的那一行也带', () => {
    const flags = dayBoundaryFlags([day(1, 2026, 9, 26), day(2, 2026, 9, 26), day(3, 2026, 9, 27)])
    expect(flags).toEqual([true, false, true])
  })

  it('同一天连续消息只有一个分隔（不是每条都画）', () => {
    const flags = dayBoundaryFlags([day(1, 2026, 9, 27, 1), day(2, 2026, 9, 27, 2), day(3, 2026, 9, 27, 23)])
    expect(flags.filter(Boolean)).toHaveLength(1)
  })

  it('行数恒等于消息数（虚拟列表的锚点靠这个不变式）', () => {
    const messages = [day(1, 2026, 9, 26), day(2, 2026, 9, 27), day(3, 2026, 9, 28)]
    expect(dayBoundaryFlags(messages)).toHaveLength(messages.length)
  })

  it('空列表不报错', () => {
    expect(dayBoundaryFlags([])).toEqual([])
  })
})

describe('unreadAnchorKey', () => {
  const messages = [message(1, 100), message(2, 200), message(3, 300), message(4, 400)]

  it('未读 2 条 → 分界画在倒数第二条上', () => {
    expect(unreadAnchorKey(messages, 2)).toBe(messages[2].key)
  })

  it('没有未读 / 未读全都未读 → 不画（宁可不画也不画错）', () => {
    expect(unreadAnchorKey(messages, 0)).toBeNull()
    expect(unreadAnchorKey(messages, 4)).toBeNull()
    expect(unreadAnchorKey(messages, 99)).toBeNull()
  })

  it('分界落在自己发的消息上时不画（"未读"不能从自己那条开始）', () => {
    const own = [message(1, 100), message(2, 200, { isSend: 1 })]
    expect(unreadAnchorKey(own, 1)).toBeNull()
  })
})

describe('indexOfMessage / selectRange', () => {
  const messages = [message(1, 100), message(2, 200), message(3, 300), message(4, 400)]

  it('找到下标，找不到给 -1', () => {
    expect(indexOfMessage(messages, messages[2].key)).toBe(2)
    expect(indexOfMessage(messages, '不存在')).toBe(-1)
    expect(indexOfMessage(messages, '')).toBe(-1)
  })

  it('范围两端都含，且与点击顺序无关', () => {
    expect(selectRange(messages, messages[0].key, messages[2].key).map((item) => item.localId)).toEqual([1, 2, 3])
    expect(selectRange(messages, messages[2].key, messages[0].key).map((item) => item.localId)).toEqual([1, 2, 3])
  })

  it('端点不在已加载窗口里时返回空（不猜一段出来）', () => {
    expect(selectRange(messages, 'x', messages[1].key)).toEqual([])
  })
})

describe('searchLoadedMessages', () => {
  const messages = [
    message(1, 100, { parsedContent: '项目进度' }),
    message(2, 200, { parsedContent: '无关' }),
    message(3, 300, { parsedContent: '项目又延了' }),
  ]

  it('从最新往回给结果（用户想先看最近提到的）', () => {
    const hits = searchLoadedMessages(messages, '项目')
    expect(hits.map((hit) => hit.index)).toEqual([2, 0])
  })

  it('大小写不敏感', () => {
    const english = [message(1, 1, { parsedContent: 'Bug 修复' })]
    expect(searchLoadedMessages(english, 'bug')).toHaveLength(1)
  })

  it('文件名与引用内容也参与命中', () => {
    const withFile = [message(1, 1, { localType: 49, fileName: '季度报表.xlsx' })]
    expect(searchLoadedMessages(withFile, '季度')).toHaveLength(1)
    const withQuote = [message(2, 2, { localType: 244813135921, quotedContent: '预算表在哪' })]
    expect(searchLoadedMessages(withQuote, '预算')).toHaveLength(1)
  })

  it('空关键词不返回全部（否则一打开就"命中 N 条"）', () => {
    expect(searchLoadedMessages(messages, '   ')).toEqual([])
  })

  it('命中带上发送者与摘要', () => {
    const hits = searchLoadedMessages([message(1, 100, { parsedContent: '项目', senderDisplayName: '张三' })], '项目')
    expect(hits[0].senderName).toBe('张三')
    expect(hits[0].excerpt).toContain('项目')
  })
})

describe('注解读取', () => {
  const store: AnnotationsStore = {
    tags: { 工作: ['s1'], 家人: ['s2'], 同时: ['s1', 's2'] },
    favorites: [
      { sessionId: 's1', localId: '', ts: 1 },
      { sessionId: 's1', localId: '42', ts: 2 },
    ],
    marks: [
      { sessionId: 's1', localId: '42', ts: 100, note: '重要' },
      { sessionId: 's1', localId: '43', ts: 200 },
      { sessionId: 's2', localId: '7', ts: 300 },
    ],
    savedSearches: [],
  }

  it('标记与备注从 store 读，界面不自己推演', () => {
    expect(messageAnnotation(store, { sessionId: 's1', localId: 42, ts: 100 })).toEqual({ marked: true, note: '重要', favorite: true })
    expect(messageAnnotation(store, { sessionId: 's1', localId: 43, ts: 200 })).toEqual({ marked: true, note: '', favorite: true })
    expect(messageAnnotation(store, { sessionId: 's1', localId: 1, ts: 100 })).toEqual({ marked: false, note: '', favorite: true })
  })

  it('localId 是字符串也能对上（引擎契约里它是 string）', () => {
    expect(messageAnnotation(store, { sessionId: 's1', localId: '42', ts: 100 }).marked).toBe(true)
  })

  it('exact shard identity selects only its exact mark; a legacy mark cannot decorate another shard', () => {
    const exactStore: AnnotationsStore = {
      ...store,
      marks: [
        { sessionId: 's1', localId: '42', messageId: '42', idKind: 'local', ts: 100, db: 'message_2.db', table: 'Msg_A', note: 'A' },
        { sessionId: 's1', localId: '42', messageId: '42', idKind: 'local', ts: 100, db: 'message_3.db', table: 'Msg_B', note: 'B' },
      ],
    }
    expect(messageAnnotation(exactStore, { sessionId: 's1', localId: 42, ts: 100, db: 'C:/wx/message_2.db', table: 'Msg_A' }).note).toBe('A')
    expect(messageAnnotation(store, { sessionId: 's1', localId: 42, ts: 100, db: 'message_3.db', table: 'Msg_B' }).marked).toBe(false)
  })

  it('store 为 null（通道缺失）时一律报告"没标记"，绝不假装已标记', () => {
    expect(messageAnnotation(null, { sessionId: 's1', localId: 42, ts: 100 })).toEqual({ marked: false, note: '', favorite: false })
    expect(isSessionFavorite(null, 's1')).toBe(false)
    expect(sessionTags(null, 's1')).toEqual([])
    expect(totalMarks(null)).toBe(0)
  })

  it('会话级收藏只看 localId 为空的那条（消息级收藏不算会话收藏）', () => {
    expect(isSessionFavorite(store, 's1')).toBe(true)
    expect(isSessionFavorite(store, 's2')).toBe(false)
  })

  it('标签按会话归集并排序（按中文拼音，不是按写入顺序）', () => {
    expect(sessionTags(store, 's1')).toEqual(['工作', '同时'])
    expect(sessionTags(store, 's2')).toEqual(['家人', '同时'])
  })

  it('标记条数按会话统计', () => {
    expect(markCountOf(store, 's1')).toBe(2)
    expect(markCountOf(store, 's2')).toBe(1)
    expect(markCountOf(store, 'nope')).toBe(0)
  })

  it('store 字段缺失（引擎刚接线只回 { tags }）不会炸', () => {
    const partial = { tags: {} } as unknown as AnnotationsStore
    expect(messageAnnotation(partial, { sessionId: 's1', localId: 1, ts: 100 }).marked).toBe(false)
    expect(totalMarks(partial)).toBe(0)
  })
})
