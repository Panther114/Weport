import { describe, expect, it } from 'vitest'
import {
  buildRetrievedContext,
  createCorpusBuilder,
  rankDocs,
  tokenize,
} from './localRetrieval'

describe('tokenize', () => {
  it('中文按双字滑窗切分', () => {
    expect(tokenize('静安寺晨读')).toEqual(['静安', '安寺', '寺晨', '晨读'])
  })

  it('两字词就是一个 token', () => {
    expect(tokenize('吃饭')).toEqual(['吃饭'])
  })

  it('高频单字被停用词表滤掉（它们区分度太低，留作检索键只会引入噪声）', () => {
    expect(tokenize('好')).toEqual([])
    expect(tokenize('的')).toEqual([])
  })

  it('拉丁词整串保留，不拆成字母', () => {
    // `released` 必须也在 —— 早期实现用带 g 标志的正则，lastIndex 跨调用残留，
    // 句子后半段的词会整段丢失
    expect(tokenize('GPT-4o released')).toEqual(['gpt-4o', 'released'])
  })

  it('保留下撇号与连字符', () => {
    expect(tokenize("don't e-mail")).toEqual(["don't", 'e-mail'])
  })

  it('版本号按点分段（每段都是一个可检索的 token）', () => {
    expect(tokenize('微信 4.0.6 版本')).toEqual(['微信', '4', '0', '6', '版本'])
  })

  it('过滤停用词', () => {
    const t = tokenize('我的意思是这个很好')
    expect(t).not.toContain('的')
    expect(t).not.toContain('这个')
  })

  it('纯标点与空白返回空数组', () => {
    expect(tokenize('  ，。！？  ')).toEqual([])
    expect(tokenize('')).toEqual([])
  })

  it('大小写归一', () => {
    expect(tokenize('WePort')).toEqual(['weport'])
  })

  it('一段话里中间与结尾的词都能被检索到（不丢尾部）', () => {
    const t = tokenize('我们今天去静安寺')
    expect(t).toContain('静安')
    expect(t).toContain('安寺')
    expect(t).toContain('今天')
  })
})

/** 建一个语料 + 统计量的小工具 */
function buildCorpus(texts: string[]) {
  const builder = createCorpusBuilder()
  const docs: Array<{ index: number; tokens: string[] }> = []
  for (const [i, text] of texts.entries()) {
    const tokens = tokenize(text)
    builder.add(tokens)
    docs.push({ index: i, tokens })
  }
  return { docs, stats: builder.finish() }
}

describe('rankDocs', () => {
  it('把包含查询词的文档排在前面', () => {
    const { docs, stats } = buildCorpus([
      '今天天气不错',
      '明天一起去吃饭吧',
      '吃饭的地方定了吗',
    ])
    const hits = rankDocs(tokenize('吃饭'), docs, stats, 3)
    expect(hits.length).toBe(2)
    expect([hits[0].index, hits[1].index].sort()).toEqual([1, 2])
  })

  it('稀有词权重高于常见词（idf 生效）', () => {
    const { docs, stats } = buildCorpus([
      '好的好的好的',
      '好的没问题',
      '那家静安寺的咖啡',
    ])
    const hits = rankDocs(tokenize('静安寺'), docs, stats, 3)
    expect(hits[0].index).toBe(2)
  })

  it('多词命中比单词重复命中得分高（覆盖度加成）', () => {
    const { docs, stats } = buildCorpus([
      '晨读晨读晨读晨读',
      '静安寺的晨读活动',
      '无关内容',
    ])
    const hits = rankDocs(tokenize('静安寺晨读'), docs, stats, 3)
    expect(hits[0].index).toBe(1)
  })

  it('完全无命中时返回空数组（不是"全部返回"）', () => {
    const { docs, stats } = buildCorpus(['今天天气不错', '明天一起吃饭'])
    expect(rankDocs(tokenize('量子力学'), docs, stats, 5)).toEqual([])
  })

  it('尊重 limit', () => {
    const { docs, stats } = buildCorpus(Array.from({ length: 20 }, (_, i) => `吃饭 ${i}`))
    expect(rankDocs(tokenize('吃饭'), docs, stats, 3)).toHaveLength(3)
  })

  it('空查询或空语料返回空数组', () => {
    const { docs, stats } = buildCorpus(['a b c'])
    expect(rankDocs([], docs, stats, 5)).toEqual([])
    expect(rankDocs(tokenize('a'), [], stats, 5)).toEqual([])
  })

  it('同分时按 index 稳定排序（可复现）', () => {
    const { docs, stats } = buildCorpus(['吃饭', '吃饭', '吃饭'])
    const a = rankDocs(tokenize('吃饭'), docs, stats, 3).map((h) => h.index)
    const b = rankDocs(tokenize('吃饭'), docs, stats, 3).map((h) => h.index)
    expect(a).toEqual(b)
    expect(a).toEqual([0, 1, 2])
  })
})

describe('buildRetrievedContext', () => {
  const hits = [
    { ts: 1700000000, label: '群聊A', text: '后发生的事' },
    { ts: 1600000000, label: '群聊B', text: '先发生的事' },
  ]

  it('按时间正序拼装（分数只决定取哪些，不决定顺序）', () => {
    const out = buildRetrievedContext(hits, 10_000)
    expect(out.indexOf('先发生的事')).toBeLessThan(out.indexOf('后发生的事'))
  })

  it('带会话名与日期', () => {
    const out = buildRetrievedContext(hits, 10_000)
    expect(out).toContain('「群聊B」')
    expect(out).toMatch(/2020-09-13/)
  })

  it('超出字符预算时截断', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ts: i, label: 'x', text: '内容'.repeat(50) }))
    const out = buildRetrievedContext(many, 500)
    expect(out.length).toBeLessThanOrEqual(600)
    expect(out.split('---').length).toBeLessThan(50)
  })

  it('空输入返回空串', () => {
    expect(buildRetrievedContext([], 1000)).toBe('')
  })
})

describe('createCorpusBuilder', () => {
  it('文档频率按"出现过的文档数"计，不按出现次数', () => {
    const b = createCorpusBuilder()
    b.add(tokenize('吃饭吃饭吃饭'))
    b.add(tokenize('吃饭'))
    b.add(tokenize('别的'))
    const stats = b.finish()
    expect(stats.df.get('吃饭')).toBe(2)
    expect(stats.n).toBe(3)
  })

  it('平均长度按 token 数算', () => {
    const b = createCorpusBuilder()
    b.add(tokenize('吃饭')) // 1 token
    b.add(tokenize('静安寺晨读')) // 4 tokens（双字滑窗）
    const stats = b.finish()
    expect(stats.avgdl).toBeCloseTo(2.5, 5)
  })

  it('空语料时 avgdl 为 0（不做除零）', () => {
    const stats = createCorpusBuilder().finish()
    expect(stats.n).toBe(0)
    expect(stats.avgdl).toBe(0)
  })
})
