import { describe, expect, it } from 'vitest'
import {
  applyMention,
  filterReferenceCandidates,
  findActiveMention,
  referenceKindLabel,
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

describe('applyMention', () => {
  it('用 @显示名 替换查询串，并把光标移到插入内容之后', () => {
    const value = '分析 @化学'
    const caret = value.length
    const mention = findActiveMention(value, caret)!
    const result = applyMention(value, mention, caret, '化学 3 班')
    expect(result.value).toBe('分析 @化学 3 班 ')
    expect(result.caret).toBe(result.value.length)
  })

  it('保留光标之后的文本', () => {
    const value = '@化学 的记录'
    const mention = findActiveMention(value, 3)!
    const result = applyMention(value, mention, 3, '化学 3 班')
    expect(result.value).toBe('@化学 3 班  的记录')
  })

  it('替换一个空查询不会吃掉已有文本', () => {
    const value = '看看 @'
    const mention = findActiveMention(value, value.length)!
    const result = applyMention(value, mention, value.length, '家人')
    expect(result.value).toBe('看看 @家人 ')
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
