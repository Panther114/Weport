import { describe, expect, it } from 'vitest'
import { LENGTH_BUCKETS, computeFingerprint, createFingerprintAccumulator, renderFingerprint } from './weCloneFingerprint'

/**
 * 风格指纹（v1.0.1）。
 *
 * 这个模块存在的意义是：**能算的东西不要问模型**。标点习惯、消息长度分布、
 * 高频片段都是语料的确定性统计量，本地算一遍就是事实，而且可复现 ——
 * 同一个语料跑两次逐位相同。模型只负责"读"，不负责"数"。
 *
 * 所以这里的断言全部是"数出来的值对不对"，没有一条依赖模型行为。
 */

describe('长度直方图与均值', () => {
  it('分档正确：每个档位的边界都落在该档里', () => {
    const f = computeFingerprint(['a', 'abcd', 'abcdefghij', 'a'.repeat(20), 'a'.repeat(40), 'a'.repeat(80)])
    const byLabel = Object.fromEntries(f.lengthHistogram.map((b) => [b.label, b.count]))
    expect(byLabel['1-3']).toBe(1) // 'a'
    expect(byLabel['4-8']).toBe(1) // 'abcd'
    expect(byLabel['9-16']).toBe(1) // 10 字
    expect(byLabel['17-30']).toBe(1) // 20 字
    expect(byLabel['31-60']).toBe(1) // 40 字
    expect(byLabel['60+']).toBe(1) // 80 字
    expect(f.sampleSize).toBe(6)
    expect(f.maxLength).toBe(80)
  })

  it('档位总数与 LENGTH_BUCKETS 对齐（UI 直接拿它渲染，不能错位）', () => {
    const f = computeFingerprint(['hi'])
    expect(f.lengthHistogram).toHaveLength(LENGTH_BUCKETS.length)
  })

  it('均值与中位数', () => {
    // 长度 2,4,6 → 均值 4，中位数 4
    const f = computeFingerprint(['ab', 'abcd', 'abcdef'])
    expect(f.avgLength).toBe(4)
    expect(f.medianLength).toBe(4)
  })

  it('空语料不抛错，返回全零而不是 NaN', () => {
    const f = computeFingerprint([])
    expect(f.sampleSize).toBe(0)
    expect(f.avgLength).toBe(0)
    expect(Number.isNaN(f.avgLength)).toBe(false)
    expect(f.lengthHistogram.every((b) => b.count === 0 && b.ratio === 0)).toBe(true)
    expect(f.phrases).toEqual([])
    expect(renderFingerprint(f)).toBe('')
  })

  it('空白消息不算样本（否则会把平均长度拉向 0）', () => {
    const f = computeFingerprint(['', '   ', '\n', '真正的消息'])
    expect(f.sampleSize).toBe(1)
  })
})

describe('标点与语气标记', () => {
  it('"完全不带标点"的比例反映微信式打字习惯', () => {
    const f = computeFingerprint(['在吗', '好的', '收到。', '嗯嗯'])
    expect(f.noPunctuationRatio).toBe(0.75)
  })

  it('句末标点收尾的比例', () => {
    const f = computeFingerprint(['走吧。', '好', '真的！', '嗯'])
    expect(f.endsWithPunctuation).toBe(0.5)
  })

  it('表情/颜文字/表情包文字都算进 emojiRatio', () => {
    const f = computeFingerprint(['[图片]', '(╯‵□′)╯', '笑死 😂', '普通一句'])
    expect(f.emojiRatio).toBe(0.75)
  })

  it('高频标记按每 100 条计次排序，低频（<1）不列出以省 token', () => {
    const texts = Array.from({ length: 20 }, () => '哈哈')
    texts.push('……')
    const f = computeFingerprint(texts)
    const tokenMap = Object.fromEntries(f.markers.map((m) => [m.token, m.per100]))
    // 20/21 ≈ 95.2 次每百条
    expect(tokenMap['哈哈']).toBeGreaterThan(90)
    // 「……」只出现 1 次 ≈ 4.8 次每百条
    expect(tokenMap['……']).toBeGreaterThan(4)
    expect(f.markers.every((m) => m.per100 >= 1)).toBe(true)
  })

  it('中英混用比例：全中文 0，全英文 1', () => {
    expect(computeFingerprint(['全部都是中文内容']).latinRatio).toBe(0)
    expect(computeFingerprint(['all english here']).latinRatio).toBe(1)
  })
})

describe('高频片段（口头禅）提取', () => {
  it('重复出现的 3-5 字片段会被提取出来', () => {
    const texts = Array.from({ length: 12 }, (_, i) => `笑死我了这波${i}`)
    const f = computeFingerprint(texts)
    expect(f.phrases.some((p) => p.text.includes('笑死我了'))).toBe(true)
  })

  it('只出现一两次的片段不算口头禅（避免把巧合当习惯）', () => {
    const f = computeFingerprint(['独一无二的表达方式出现了', '另外一句话'])
    expect(f.phrases).toEqual([])
  })

  it('互相包含的片段只留最长的那个：命中「笑死我了」时不再列出「笑死我」和「死我了」', () => {
    const texts = Array.from({ length: 12 }, () => '笑死我了')
    const f = computeFingerprint(texts)
    const hasLong = f.phrases.some((p) => p.text === '笑死我了')
    const hasShort = f.phrases.some((p) => p.text === '笑死我' || p.text === '死我了')
    expect(hasLong).toBe(true)
    expect(hasShort).toBe(false)
  })

  it('停用式高频词被过滤掉（否则结果全是「这个」「什么」）', () => {
    const texts = Array.from({ length: 30 }, () => '这个东西什么都可以')
    const f = computeFingerprint(texts)
    expect(f.phrases.some((p) => p.text === '这个' || p.text === '什么')).toBe(false)
  })

  it('短语数量有上限（40 条），不会把整个 n-gram 表倒进 prompt', () => {
    const texts = Array.from({ length: 200 }, (_, i) => `第${i}句独一无二的啰嗦表达方式${'啊'.repeat(i % 7)}`)
    const f = computeFingerprint(texts)
    expect(f.phrases.length).toBeLessThanOrEqual(40)
  })
})

describe('n-gram 表的内存护栏', () => {
  it('超过上限时按出现次数剪枝，不会无界增长', () => {
    const acc = createFingerprintAccumulator({ maxNgrams: 10_000 })
    // 每一条都是全新的随机串 → n-gram 表必然膨胀
    for (let i = 0; i < 3000; i += 1) {
      acc.add(`句${i}${Math.random().toString(36).slice(2)}独特的文字内容`)
    }
    const f = acc.finish()
    expect(f.sampleSize).toBe(3000)
    // 剪枝发生过：低频片段被丢掉，所以不会出现"每条都成了口头禅"
    expect(f.phrases.length).toBeLessThanOrEqual(40)
  })
})

describe('英文语料（本机真实语料是 84% 拉丁字母）', () => {
  /**
   * 这一组是拿真实语料换来的。
   *
   * 旧实现用汉字那套 n-gram 滑窗去切英文，指纹里"高频片段"一栏 40 条全是
   * `the` / `ing ` / `tion` / `ed ` 这种**词缀碎片** —— 整栏等于什么都没说。
   * 英文必须按整词统计，再加一层二元搭配。
   */
  const englishCorpus = [
    ...Array.from({ length: 20 }, () => 'i think we should just ship it honestly'),
    ...Array.from({ length: 14 }, () => 'yo that build is kinda broken ngl'),
    ...Array.from({ length: 12 }, () => 'let me check the logs real quick'),
    ...Array.from({ length: 10 }, () => 'yeah the the the'),
  ]
  const f = computeFingerprint(englishCorpus)

  it('产出英文词与搭配，而不是词缀碎片', () => {
    expect(f.englishPhrases.length).toBeGreaterThan(0)
    const texts = f.englishPhrases.map((p) => p.text)
    // 不该出现纯词缀（长度 <3 或明显是切片残留）
    expect(texts.every((t) => t.trim().length >= 4)).toBe(true)
    expect(texts.some((t) => t.includes(' '))).toBe(true) // 至少有个搭配
  })

  it('英文停用词被过滤掉（否则榜首全是 the / and / you）', () => {
    const texts = f.englishPhrases.map((p) => p.text)
    expect(texts).not.toContain('the')
    expect(texts).not.toContain('and')
    expect(texts).not.toContain('you')
  })

  it('搭配里的词不再单独占一行（`i think` 与 `think` 不该看成两件事）', () => {
    const texts = f.englishPhrases.map((p) => p.text)
    const bigrams = texts.filter((t) => t.includes(' '))
    const wordsInBigrams = new Set(bigrams.flatMap((t) => t.split(' ')))
    const standaloneOverlap = texts.filter((t) => !t.includes(' ') && wordsInBigrams.has(t))
    expect(standaloneOverlap).toEqual([])
  })

  it('中文片段那一组对英文语料为空（两组各管一侧，不互相污染）', () => {
    expect(f.phrases).toEqual([])
  })

  it('仍然正确报告"几乎不打标点"与中英比例', () => {
    expect(f.noPunctuationRatio).toBe(1)
    expect(f.latinRatio).toBeGreaterThan(0.9)
  })

  it('渲染块里中英两组分别成行', () => {
    const text = renderFingerprint(f)
    expect(text).toContain('英文词与搭配')
    expect(text).not.toContain('反复出现的中文片段')
  })
})

describe('渲染成给模型看的事实块', () => {  const f = computeFingerprint([
    '在吗',
    '笑死我了',
    '笑死我了这波',
    '好的好的',
    '[图片]',
    '嗯',
    '真的假的啊',
    '走吧',
  ])

  it('写成陈述句事实，不写成命令（命令会被逐条执行，反而更假）', () => {
    const text = renderFingerprint(f)
    expect(text).toContain('统计口径')
    expect(text).toContain('单条长度')
    expect(text).toContain('标点习惯')
    // 不该出现祈使句式
    expect(text).not.toMatch(/请|必须|你应该|务必/)
  })

  it('明确写出"是片段不是整句"，防止模型把片段当台词复读', () => {
    const withPhrases = computeFingerprint(Array.from({ length: 12 }, () => '笑死我了这波真的'))
    expect(renderFingerprint(withPhrases)).toContain('不是要照抄的整句')
  })

  it('可复现：同样的输入渲染出逐字节相同的结果', () => {
    const texts = ['在吗', '笑死我了', '好的好的']
    expect(renderFingerprint(computeFingerprint(texts))).toBe(renderFingerprint(computeFingerprint(texts)))
  })
})
