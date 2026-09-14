import { describe, expect, it } from 'vitest'
import { buildFallbackTitle, hasCjk, normaliseTitle, stripTitleNoise, titleEchoesSource } from './chatTitle'

// 这套用例锁的是用户报的那个 bug：「标题就是消息开头的几个字」。
// 每个 case 都对应一条真实翻车路径。

describe('stripTitleNoise', () => {
  it('去掉模型爱加的前缀、引号与结尾标点', () => {
    expect(stripTitleNoise('标题：分析群聊活跃度。')).toBe('分析群聊活跃度')
    expect(stripTitleNoise('Title: chat activity analysis')).toBe('chat activity analysis')
    expect(stripTitleNoise('「8月8日时间线」')).toBe('8月8日时间线')
    expect(stripTitleNoise('```\n整理朋友圈\n```')).toBe('整理朋友圈')
  })

  it('多行输出只取第一行', () => {
    expect(stripTitleNoise('群聊活跃度\n这是解释')).toBe('群聊活跃度')
  })

  it('纯噪声返回空串', () => {
    expect(stripTitleNoise('   ')).toBe('')
    expect(stripTitleNoise('""')).toBe('')
  })
})

describe('normaliseTitle', () => {
  it('中文标题收敛到 2-4 个词的量级（不超过 14 字）', () => {
    const long = normaliseTitle('整理了2026年9月14日当天全部聊天的完整时间线并输出了摘要')
    expect(long).not.toBeNull()
    expect(Array.from(long as string).length).toBeLessThanOrEqual(14)
  })

  it('英文标题收敛到 6 个词以内', () => {
    const long = normaliseTitle('analyze the full message volume for this particular group chat today')
    expect(long).not.toBeNull()
    expect((long as string).split(/\s+/).length).toBeLessThanOrEqual(6)
  })

  it('短标题原样保留', () => {
    expect(normaliseTitle('群聊活跃度')).toBe('群聊活跃度')
    expect(normaliseTitle('Chat activity')).toBe('Chat activity')
  })

  it('只取首句，丢掉后面的解释', () => {
    expect(normaliseTitle('朋友圈整理。因为用户要求……')).toBe('朋友圈整理')
  })

  it('空/噪声返回 null（调用方应退回兜底，而不是落一个空标题）', () => {
    expect(normaliseTitle('')).toBeNull()
    expect(normaliseTitle('   ')).toBeNull()
    expect(normaliseTitle('。')).toBeNull()
  })
})

describe('titleEchoesSource', () => {
  it('完全相同的文本算截断（原话被原样当成标题）', () => {
    expect(titleEchoesSource('帮我分析一下我和小明的关系', '帮我分析一下我和小明的关系')).toBe(true)
  })

  it('原话以标题开头 → 是截断（这正是用户看到的现象）', () => {
    expect(titleEchoesSource('帮我分析一下', '帮我分析一下我和小明的关系怎么样')).toBe(true)
    expect(titleEchoesSource('8月8日发生了什么', '8月8日发生了什么重要的事情吗')).toBe(true)
  })

  it('忽略空白与标点后仍然判定', () => {
    expect(titleEchoesSource('帮我分析一下，', '帮我分析一下 我和小明')).toBe(true)
  })

  it('真正的标题不是截断', () => {
    expect(titleEchoesSource('群聊活跃度', '帮我分析一下我和小明的关系怎么样')).toBe(false)
    expect(titleEchoesSource('关系分析', '8月8日发生了什么重要的事情吗')).toBe(false)
  })

  it('标题太短（<3 字）时不做前缀判定，避免误伤', () => {
    expect(titleEchoesSource('分析', '分析一下我和小明')).toBe(false)
  })

  it('空输入不误判', () => {
    expect(titleEchoesSource('', '任意原话')).toBe(false)
    expect(titleEchoesSource('标题', '')).toBe(false)
  })
})

describe('buildFallbackTitle', () => {
  it('剥掉客套前缀（会叠加，要循环剥）', () => {
    expect(buildFallbackTitle('帮我分析一下群聊的活跃度')).toBe('分析一下群聊的活')
    expect(buildFallbackTitle('请帮我看看这个群')).toBe('看看这个群')
  })

  it('英文客套前缀同样剥掉，且动词保留（动词是唯一的实义动作）', () => {
    expect(buildFallbackTitle('please analyze the group chat')).toBe('analyze the group chat')
    expect(buildFallbackTitle('could you summarize this conversation for me')).toBe('summarize this conversation for')
  })

  it('截到第一个句读', () => {
    expect(buildFallbackTitle('整理朋友圈。顺便看看照片')).toBe('整理朋友圈')
  })

  it('中文收敛到 8 字，并去掉句尾语气词', () => {
    const t = buildFallbackTitle('帮我看看2026年9月14日当天所有群聊的完整消息时间线和活跃度分布')
    expect(Array.from(t).length).toBeLessThanOrEqual(8)
    expect(buildFallbackTitle('我和小明的关系怎么样')).toBe('我和小明的关系')
  })

  it('英文收敛到 4 个词', () => {
    const t = buildFallbackTitle('please analyze the full message volume for this group chat today')
    expect(t.split(/\s+/).length).toBeLessThanOrEqual(4)
    expect(t).not.toMatch(/^please/)
  })

  it('空输入给「新对话」而不是空串', () => {
    expect(buildFallbackTitle('')).toBe('新对话')
    expect(buildFallbackTitle('   ')).toBe('新对话')
  })

  it('兜底结果不会长于上限，也确实是原话的一部分（不是凭空造的）', () => {
    const source = '帮我分析一下我和小明的关系怎么样'
    const fallback = buildFallbackTitle(source)
    expect(Array.from(fallback).length).toBeLessThanOrEqual(8)
    expect(source.includes(fallback)).toBe(true)
  })
})

describe('hasCjk', () => {
  it('识别中日韩文字', () => {
    expect(hasCjk('群聊')).toBe(true)
    expect(hasCjk('カタカナ')).toBe(true)
    expect(hasCjk('한국어')).toBe(true)
    expect(hasCjk('group chat')).toBe(false)
  })
})
