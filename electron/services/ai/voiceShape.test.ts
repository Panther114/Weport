import { describe, expect, it } from 'vitest'
import { profileFromVoice, shapeReply, splitSegments } from './voiceShape'

const profile = {
  medianLength: 14,
  p90Length: 30,
  meanLength: 23.7,
  burstMean: 4.31,
  burstMedian: 2,
  burstMax: 4,
  endsWithPunctuation: 0.03,
  sampleSize: 100,
}

describe('profileFromVoice —— 从本人原话里算形态', () => {
  it('长度中位数/p90 与样本一致', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      ts: 1000 + i * 3600,
      sid: 's1',
      // 长度 1..100
      text: 'x'.repeat(i + 1),
    }))
    const p = profileFromVoice(rows)
    expect(p.sampleSize).toBe(100)
    expect(p.medianLength).toBeGreaterThanOrEqual(49)
    expect(p.medianLength).toBeLessThanOrEqual(51)
    expect(p.p90Length).toBeGreaterThan(p.medianLength)
  })

  it('连发按"同会话内 ≤180 秒"近似成串', () => {
    // 同一会话里 5 条挨着发（间隔 10 秒）→ 一串 5 条；另有一条隔了一小时 → 新串
    const rows = [
      ...[0, 10, 20, 30, 40].map((d) => ({ ts: 1000 + d, sid: 's1', text: 'ok' })),
      { ts: 1000 + 3600, sid: 's1', text: 'bye' },
    ]
    const p = profileFromVoice(rows)
    expect(p.burstMean).toBeGreaterThan(1)
    expect(p.burstMax).toBeGreaterThanOrEqual(2)
  })

  it('句末标点率是算出来的（他几乎不用句号）', () => {
    const p = profileFromVoice([
      { ts: 1, sid: 's', text: '跳了' },
      { ts: 2, sid: 's', text: 'ok' },
      { ts: 3, sid: 's', text: '好的。' },
      { ts: 4, sid: 's', text: '行。' },
    ])
    expect(p.endsWithPunctuation).toBeCloseTo(0.5, 5)
  })

  it('空输入不炸', () => {
    const p = profileFromVoice([])
    expect(p.sampleSize).toBe(0)
    expect(Number.isFinite(p.p90Length)).toBe(true)
  })
})

describe('splitSegments', () => {
  it('按空行与单换行切段', () => {
    expect(splitSegments('a\n\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('按句末标点切，且标点跟着前一句走', () => {
    expect(splitSegments('我先走了。你回不回?')).toEqual(['我先走了。', '你回不回?'])
  })

  it('不打标点的长句仍是一段（本人 82% 不带标点）', () => {
    const t = '我今天中午试试能不能破速通记录目前记录是四分40秒'
    expect(splitSegments(t)).toEqual([t])
  })

  it('空输入返回空数组', () => {
    expect(splitSegments('')).toEqual([])
    expect(splitSegments('   \n\n  ')).toEqual([])
  })
})

describe('shapeReply —— 切成"像本人那样的一串短消息"', () => {
  it('短回复保持一条（不要为了切而切）', () => {
    expect(shapeReply('ok', profile)).toEqual(['ok'])
    expect(shapeReply('跳了', profile)).toEqual(['跳了'])
  })

  it('长段落被切成多条，且每条不超过 p90 量级', () => {
    const long =
      '这个前端工作还真的不在我的能力范围内，我先看一下 cursor 那个方案，' +
      '如果实在不行就让 Max 来做这一块，总之今天先把这个页面跑起来再说。'
    const out = shapeReply(long, profile)
    expect(out.length).toBeGreaterThan(1)
    for (const b of out) expect(b.length).toBeLessThanOrEqual(profile.p90Length + 6)
  })

  it('不丢内容：切分后拼回来与原文只差标点与空白', () => {
    const raw = '第一句话。第二句话比较长一些，需要单独成条。第三句话收尾。'
    const out = shapeReply(raw, profile)
    const strip = (s: string) => s.replace(/[\s。.,，]/g, '')
    expect(strip(out.join(''))).toBe(strip(raw))
  })

  it('超过连发上限时把多余的并进最后一条，而不是删掉', () => {
    const many = Array.from({ length: 12 }, (_, i) => `第${i}句。`).join('')
    const out = shapeReply(many, profile)
    expect(out.length).toBeLessThanOrEqual(profile.burstMax)
    const strip = (s: string) => s.replace(/[\s。.,，]/g, '')
    expect(strip(out.join(''))).toBe(strip(many))
  })

  it('去掉句末句号（他只有 3%），但保留问号/感叹号', () => {
    const out = shapeReply('行。', profile)
    expect(out).toEqual(['行'])
    const q = shapeReply('你几点到?', profile)
    expect(q.join('')).toContain('?')
    const ex = shapeReply('牛逼！', profile)
    expect(ex.join('')).toContain('！')
  })

  it('确定性：同一输入两次结果逐字相同', () => {
    const raw = '我今天去了一趟学校。然后遇到老师了，聊了几句关于考试的事。感觉还行。'
    expect(shapeReply(raw, profile)).toEqual(shapeReply(raw, profile))
  })

  it('空回复返回空数组（调用方保留原回复）', () => {
    expect(shapeReply('', profile)).toEqual([])
  })
})
