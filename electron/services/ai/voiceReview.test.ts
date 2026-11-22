import { describe, expect, it } from 'vitest'
import { analyzeVoiceReview } from './voiceReview'

const VOICE = [
  '在吗',
  '笑死',
  '刚下课',
  '晚点说',
  '我看看',
  '行',
  '没事 你说',
  '今天好累',
  '不想动',
  '晚点聊',
]

function review(replies: Array<{ content: string; prompt?: string }>, voice = VOICE) {
  return analyzeVoiceReview({ voiceTexts: voice, replies, now: 1 })
}

describe('voice review — corpus only', () => {
  it('reports a missing reply sample instead of inventing conclusions', () => {
    const result = review([])
    expect(result.replySampleSize).toBe(0)
    expect(result.issues.some((issue) => issue.id === 'no-reply-sample')).toBe(true)
    expect(result.summary).toContain('0 条分身回复')
    expect(result.cautions.length).toBeGreaterThan(0)
  })

  it('flags a small corpus', () => {
    const result = review([], ['在吗', '行'])
    expect(result.issues.some((issue) => issue.id === 'voice-sample-small')).toBe(true)
  })
})

describe('voice review — reply problems', () => {
  it('flags replies that are much longer than the person speaks', () => {
    const result = review([
      { content: '我理解你的感受，今天确实很累。建议你先休息一下，明天再处理这些事情，希望对你有帮助。' },
      { content: '听起来你最近压力很大。你可以尝试把任务拆小一点，先做最重要的一件，剩下的明天再说。' },
      { content: '如果你愿意，可以跟我说说具体发生了什么。我会尽量帮你一起梳理。' },
    ])
    expect(result.issues.some((issue) => issue.id === 'reply-too-long')).toBe(true)
    expect(result.metrics.replyToVoiceRatio).toBeGreaterThan(2)
  })

  it('flags assistant-like phrasing and structure', () => {
    const result = review([
      { content: '首先，你需要先确认一下时间。其次，建议你提前准备材料。\n- 第一点\n- 第二点' },
      { content: '作为一个助手，我建议你分三步处理。希望对你有帮助。' },
      { content: '总的来说，先休息，再安排。你可以尝试明天再做。' },
    ])
    expect(result.issues.some((issue) => issue.id === 'assistant-tone')).toBe(true)
    expect(result.issues.some((issue) => issue.id === 'structured-reply')).toBe(true)
    expect(result.metrics.assistantToneRate).toBeGreaterThan(0)
  })

  it('flags language that does not follow the other side', () => {
    const result = review([
      { content: '好的，我知道了，晚点回复你。', prompt: 'hey are you around later?' },
      { content: '没问题，明天见。', prompt: 'see you tomorrow?' },
    ])
    expect(result.issues.some((issue) => issue.id === 'language-mismatch')).toBe(true)
  })

  it('flags repeated openers', () => {
    const result = review(
      Array.from({ length: 8 }, (_, index) => ({ content: `笑死 第${index}次了` })),
    )
    expect(result.issues.some((issue) => issue.id === 'repeated-opener')).toBe(true)
  })

  it('does not flag natural short replies', () => {
    const result = review([
      { content: '行', prompt: '一起吃饭吗' },
      { content: '晚点说', prompt: '在吗' },
      { content: '我看看', prompt: '帮我看看这个' },
      { content: '笑死', prompt: '你看这个' },
    ])
    expect(result.issues.some((issue) => issue.severity === 'warn')).toBe(false)
    expect(result.summary).toContain('分析了')
  })
})
