import { describe, expect, it } from 'vitest'
import {
  classifyFunction,
  extractExchanges,
  findVerbatimOverlap,
  overlapScore,
  rankExemplars,
  renderExemplarBlock,
  replyCopiesExemplars,
  type VoiceExchange,
} from './voiceExemplars'

describe('classifyFunction —— 语用功能判定（规则，可复现）', () => {
  it('认得出打招呼（含只有两三个字母的）', () => {
    for (const t of ['hi', 'yo', 'hello', '在吗', '早安', 'gm', 'hey']) {
      expect(classifyFunction(t), t).toBe('greeting')
    }
  })

  it('认得出纯表情/占位符', () => {
    expect(classifyFunction('[Sob][Sob]')).toBe('sticker')
    expect(classifyFunction('[动画表情]')).toBe('sticker')
    expect(classifyFunction('🤣')).toBe('sticker')
  })

  it('认得出提问（带问号和中文疑问词两种）', () => {
    expect(classifyFunction('几点睡?')).toBe('question')
    expect(classifyFunction('你几点睡')).toBe('question')
    expect(classifyFunction('是不是坠机了')).toBe('question')
  })

  it('认得出吐槽/办事/玩梗，且优先级稳定', () => {
    expect(classifyFunction('我他妈物理废了啊')).toBe('vent')
    expect(classifyFunction('明天去吃老盛昌吧')).toBe('logistics')
    expect(classifyFunction('ok this is gay')).toBe('banter')
  })

  it('其余算陈述', () => {
    expect(classifyFunction('我今天解密了18.1-18.3')).toBe('statement')
  })
})

describe('extractExchanges —— 从分块正文里抽"对方说 → 本人回"', () => {
  it('把对方的话和本人回复配成一对', () => {
    const text = ['Ivan: 你复习咋样了', '我: 跳了', 'Ivan: 那我完了'].join('\n')
    const out = extractExchanges(text)
    expect(out).toHaveLength(1)
    expect(out[0].cue).toBe('你复习咋样了')
    expect(out[0].reply).toBe('跳了')
  })

  it('连发的本人消息并进同一条回复（连发本身是重要信号）', () => {
    const text = ['Hank: 交了吗', '我: 但是', '我: 我他妈没有源码啊'].join('\n')
    const out = extractExchanges(text)
    expect(out).toHaveLength(1)
    expect(out[0].reply).toBe('但是 我他妈没有源码啊')
  })

  it('多人群聊里对方连发几句会合并成 cue', () => {
    const text = ['A: 那个啥', 'A: 到底行不行', '我: 行'].join('\n')
    const out = extractExchanges(text)
    expect(out[0].cue).toBe('那个啥 到底行不行')
  })

  it('没有对方发言时不成对（会话开头的自言自语学不到"怎么回"）', () => {
    const text = ['我: 有人在吗', '我: 算了'].join('\n')
    expect(extractExchanges(text)).toHaveLength(0)
  })

  it('两个来回抽出两对', () => {
    const text = ['A: 一', '我: 二', 'A: 三', '我: 四'].join('\n')
    const out = extractExchanges(text)
    expect(out.map((e) => [e.cue, e.reply])).toEqual([
      ['一', '二'],
      ['三', '四'],
    ])
  })
})

const pool: VoiceExchange[] = [
  { sid: 's1', ts: 1, cue: 'hi', reply: 'yo' },
  { sid: 's1', ts: 2, cue: '在吗', reply: 'in' },
  { sid: 's2', ts: 3, cue: '你复习咋样了', reply: '跳了' },
  { sid: 's2', ts: 4, cue: '物理怎么办啊', reply: '卧槽物理废了啊' },
  { sid: 's3', ts: 5, cue: '明天几点', reply: '我1:30到' },
]

describe('rankExemplars —— 情境 + 功能 + 长度，而不是单纯词面', () => {
  it('打招呼的查询优先取打招呼的示范（词面重合度几乎为 0 也能命中）', () => {
    const picked = rankExemplars('hi', pool, { limit: 1, functionHint: 'greeting' })
    expect(['yo', 'in']).toContain(picked[0].reply)
  })

  it('话题相同优先于话题不同', () => {
    const picked = rankExemplars('物理怎么办啊', pool, { limit: 1 })
    expect(picked[0].reply).toBe('卧槽物理废了啊')
  })

  it('避免重复/包含关系的样本（同一个口头禅不要占满名额）', () => {
    const dup: VoiceExchange[] = [
      { sid: 'a', ts: 1, cue: 'x 怎么办', reply: 'ok' },
      { sid: 'a', ts: 2, cue: 'x 怎么办', reply: 'ok' },
      { sid: 'a', ts: 3, cue: 'x 怎么办', reply: 'okay' },
    ]
    const picked = rankExemplars('x 怎么办', dup, { limit: 3 })
    expect(picked.length).toBeLessThanOrEqual(2)
  })

  it('与最近真实对话重合的样本会被剔除（避免"你已经说过这句"）', () => {
    const picked = rankExemplars('物理怎么办啊', pool, { limit: 2, avoidTexts: ['卧槽物理废了啊'] })
    expect(picked.some((p) => p.reply === '卧槽物理废了啊')).toBe(false)
  })

  it('limit 生效', () => {
    expect(rankExemplars('怎么办', pool, { limit: 2 }).length).toBeLessThanOrEqual(2)
  })
})

describe('overlapScore', () => {
  it('完全无关为 0，完全包含为 1', () => {
    expect(overlapScore('物理怎么办', '明天吃什么')).toBe(0)
    expect(overlapScore('物理', '物理怎么办')).toBe(1)
  })
})

describe('renderExemplarBlock', () => {
  it('渲染成带说话人标签、可接着写的对话', () => {
    const block = renderExemplarBlock(
      [{ sid: 's', ts: 1780000000, cue: '你几点睡', reply: '1:30' }],
      { selfLabel: 'Me', otherLabel: 'Them', dateOf: () => '2026-05-30' }
    )
    expect(block).toContain('你几点睡')
    expect(block).toContain('Me: 1:30')
    expect(block).toContain('2026-05-30')
  })

  it('超过字符上限就停（示范不该挤占上下文）', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      sid: 's',
      ts: i,
      cue: `对方的第 ${i} 句话，写得比较长一些`,
      reply: `我的回复第 ${i} 句`,
    }))
    const block = renderExemplarBlock(many, { maxChars: 200 })
    expect(block.length).toBeLessThanOrEqual(260)
  })

  it('空输入返回空串', () => {
    expect(renderExemplarBlock([], {})).toBe('')
  })
})

describe('抄写闸门', () => {
  it('检出 ≥8 字的逐字重合', () => {
    const exemplar = '我: 这个破玩意儿真的搞不定'
    const reply = '这个破玩意儿真的搞不定'
    expect(findVerbatimOverlap(reply, exemplar, 8)).toBeTruthy()
    expect(replyCopiesExemplars(reply, exemplar, 8)).toBeTruthy()
  })

  it('短于阈值不算抄（避免误判正常口头禅）', () => {
    expect(findVerbatimOverlap('绷不住了', '我: 绷不住了', 8)).toBeNull()
  })

  it('自己的话不算抄', () => {
    expect(replyCopiesExemplars('那我明天一点半到', 'Them: 明天几点\nMe: 我1:30到', 8)).toBeNull()
  })
})
