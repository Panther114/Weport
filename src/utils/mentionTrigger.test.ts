import { describe, expect, it } from 'vitest'
import {
  filterReferenceCandidates,
  findActiveMention,
  referenceKindLabel,
  resolveReferenceIndex,
  rewriteMentionQuery,
  stripMention,
} from './mentionTrigger'

describe('findActiveMention', () => {
  it('识别行首的 @', () => {
    expect(findActiveMention('@化学', 3)).toEqual({ start: 0, query: '化学' })
  })

  it('识别空白之后的 @', () => {
    expect(findActiveMention('看看 @化学', 6)).toEqual({ start: 3, query: '化学' })
  })

  it('刚打出一个 @ 时查询串为空', () => {
    expect(findActiveMention('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('不把邮箱里的 @ 当成引用（否则输入邮箱会一直弹选择器）', () => {
    expect(findActiveMention('a@b.com', 7)).toBeNull()
  })

  it('查询串里出现空格即视为这次引用已结束', () => {
    expect(findActiveMention('@化学 3 班', 8)).toBeNull()
  })

  it('换行同样结束引用', () => {
    expect(findActiveMention('@化学\n', 4)).toBeNull()
  })

  it('没有 @ 时返回 null', () => {
    expect(findActiveMention('普通文本', 4)).toBeNull()
  })

  it('只看光标之前的内容', () => {
    // 光标在 @ 之前，后面还有 @ 也不算
    expect(findActiveMention('abc@def', 2)).toBeNull()
  })

  it('越界光标被夹到合法范围而不是抛错', () => {
    expect(findActiveMention('@x', 99)).toEqual({ start: 0, query: 'x' })
    expect(findActiveMention('@x', -5)).toBeNull()
  })

  it('空输入安全', () => {
    expect(findActiveMention('', 0)).toBeNull()
  })
})

/**
 * 引用**不再**写回输入框（用户报的"名字同时出现在输入框和下面"）。
 * 这些用例把"输入框里一行 `@名称` 都不留"钉死。
 */
describe('stripMention', () => {
  it('把 @查询串摘掉，输入框里不留任何痕迹', () => {
    const value = '分析 @化学'
    const caret = value.length
    const mention = findActiveMention(value, caret)!
    const result = stripMention(value, mention, caret)
    expect(result.value).toBe('分析 ')
    expect(result.value).not.toContain('@')
    expect(result.caret).toBe(3)
  })

  it('保留光标之后的文本', () => {
    const value = '@化学 的记录'
    const mention = findActiveMention(value, 3)!
    const result = stripMention(value, mention, 3)
    expect(result.value).toBe(' 的记录')
    expect(result.caret).toBe(0)
  })

  it('摘掉一个空查询时不会吃掉已有文本', () => {
    const value = '看看 @'
    const mention = findActiveMention(value, value.length)!
    const result = stripMention(value, mention, value.length)
    expect(result.value).toBe('看看 ')
  })

  it('光标越界时被夹到文本长度，不会切掉文本', () => {
    const value = '@化学 的记录'
    const result = stripMention(value, { start: 0, query: '化学' }, 999)
    expect(result.value).toBe('')
    expect(result.caret).toBe(0)
  })

  it('空输入安全', () => {
    expect(stripMention('', { start: 0, query: '' }, 0)).toEqual({ value: '', caret: 0 })
  })
})

describe('rewriteMentionQuery', () => {
  it('弹层搜索框改查询串时同步改写输入框里的那段 @查询', () => {
    const value = '分析 @化'
    const caret = value.length
    const mention = findActiveMention(value, caret)!
    const result = rewriteMentionQuery(value, mention, caret, '化学')
    expect(result.value).toBe('分析 @化学')
    expect(result.caret).toBe(result.value.length)
  })

  it('清空搜索框后输入框里只剩一个 @（选择器仍然活着）', () => {
    const value = '@化学'
    const mention = findActiveMention(value, value.length)!
    const result = rewriteMentionQuery(value, mention, value.length, '')
    expect(result.value).toBe('@')
    expect(findActiveMention(result.value, result.caret)).toEqual({ start: 0, query: '' })
  })

  it('查询串里的空白被去掉：否则 findActiveMention 会认为这次引用已结束', () => {
    const value = '@a'
    const mention = findActiveMention(value, value.length)!
    const result = rewriteMentionQuery(value, mention, value.length, '化学 3 班')
    expect(result.value).toBe('@化学3班')
    const next = findActiveMention(result.value, result.caret)
    expect(next).toEqual({ start: 0, query: '化学3班' })
  })

  it('保留光标之后的文本', () => {
    const value = '@ab 的记录'
    const mention = findActiveMention(value, 3)!
    const result = rewriteMentionQuery(value, mention, 3, '化学')
    expect(result.value).toBe('@化学 的记录')
    expect(result.caret).toBe(3)
  })
})

describe('filterReferenceCandidates', () => {
  const candidates = [
    { id: 'wxid_a@chatroom', label: '高一化学兴趣小组' },
    { id: 'wxid_b@chatroom', label: '化学 3 班' },
    { id: 'wxid_c', label: '家人', subtitle: '家庭群备注：化学老师' },
    { id: 'chemistry_wxid', label: '张三' },
  ]

  it('空查询返回原始顺序（即调用方给的时间序）', () => {
    expect(filterReferenceCandidates(candidates, '').map((c) => c.label)).toEqual([
      '高一化学兴趣小组',
      '化学 3 班',
      '家人',
      '张三',
    ])
  })

  it('前缀命中排在包含命中之前', () => {
    const result = filterReferenceCandidates(candidates, '化学')
    expect(result[0].label).toBe('化学 3 班')
    expect(result.map((c) => c.label)).toContain('高一化学兴趣小组')
  })

  it('可以按备注匹配', () => {
    expect(filterReferenceCandidates(candidates, '老师').map((c) => c.label)).toEqual(['家人'])
  })

  it('可以按 id 匹配（方便粘贴 wxid）', () => {
    expect(filterReferenceCandidates(candidates, 'chemistry').map((c) => c.label)).toEqual(['张三'])
  })

  it('大小写不敏感', () => {
    expect(filterReferenceCandidates(candidates, 'CHEMISTRY').length).toBe(1)
  })

  it('无命中返回空数组而不是全部', () => {
    expect(filterReferenceCandidates(candidates, 'zzzz')).toEqual([])
  })

  it('遵守上限（5000 个会话的账号也不会卡住）', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `id${i}`, label: `群 ${i}` }))
    expect(filterReferenceCandidates(many, '', 60).length).toBe(60)
  })
})

describe('referenceKindLabel', () => {
  it('三种类型都有中文标签', () => {
    expect(referenceKindLabel('group')).toBe('群聊')
    expect(referenceKindLabel('private')).toBe('私聊')
    expect(referenceKindLabel('official')).toBe('公众号')
  })
})

/**
 * 已引用过的候选灰掉之后仍然占着列表里的位置，键盘导航必须跳过它们。
 * 没有这层跳过，用户会在灰掉的那条上按回车 —— 什么也不会发生。
 */
describe('resolveReferenceIndex：跳过不可选（已引用）的候选', () => {
  const none = () => false
  const pickedSecond = (index: number) => index === 1

  it('下键跳过被灰掉的那条', () => {
    expect(resolveReferenceIndex(4, 0, pickedSecond, 1)).toBe(2)
  })

  it('上键跳过被灰掉的那条（并环绕）', () => {
    expect(resolveReferenceIndex(4, 0, pickedSecond, -1)).toBe(3)
    expect(resolveReferenceIndex(4, 2, pickedSecond, -1)).toBe(0)
  })

  it('当前下标落在灰条目上时（delta=0）夹到下一个可选项', () => {
    expect(resolveReferenceIndex(4, 1, pickedSecond, 0)).toBe(2)
  })

  it('全部可选时就是普通的上下移动', () => {
    expect(resolveReferenceIndex(3, 1, none, 1)).toBe(2)
    expect(resolveReferenceIndex(3, 0, none, -1)).toBe(2)
  })

  it('全都被引用时保持原位，不会卡成死循环', () => {
    expect(resolveReferenceIndex(3, 1, () => true, 1)).toBe(1)
  })

  it('空列表返回 0', () => {
    expect(resolveReferenceIndex(0, 5, none, 1)).toBe(0)
  })

  it('越界的当前下标先被夹回范围', () => {
    expect(resolveReferenceIndex(3, 99, none, 0)).toBe(2)
  })
})
