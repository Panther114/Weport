/**
 * WeClone 本地语料检索（v1.0 **纯本地**）。
 *
 * ## 为什么需要它
 *
 * 分身聊天原本把"知识库"放在服务器上，靠服务端检索。v1.0 的边界是**只在用户
 * 设备上** —— 没有服务器、不上传、不联网检索。于是要有一种本地检索方式，能在
 * 几万条聊天记录里挑出跟当前问题最相关的几十条，塞进模型上下文。
 *
 * ## 为什么不用向量 / 本地嵌入模型
 *
 * 用户明确要求「不要跑本地嵌入模型」。除了体积和 CPU，还有一个更硬的理由：
 * 嵌入模型在中文口语聊天（大量缩写、方言、表情代称）上的检索质量并不比词面
 * 匹配高多少，而代价是几百 MB 权重 + 每次查询都要过一次前向。BM25 这类词面
 * 打分在这里的性价比高得多，而且是**纯函数**，可以完整单测。
 *
 * ## 内存纪律
 *
 * 语料是逐行 JSONL。这里**只做一遍流式读取**：为每行算好 token 数、维护
 * 全局文档频率与长度统计，但**不把原文留在内存里**；等打分确定 top-K 之后，
 * 再让调用方按行号回读那 K 行。峰值内存与语料大小无关，只与"候选元数据"有关
 * （每个候选约 40 字节）。2M 条消息的极端情况下也只占几十 MB。
 */

/** 分词后的最小单位 */
export interface RetrievalDoc {
  /** 文档序号（与读取顺序一致，用于回取原文） */
  index: number
  /** 该文档的 token 列表 */
  tokens: string[]
}

export interface RetrievalHit {
  index: number
  score: number
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
/** 拉丁字母/数字串，保留内部连字符与撇号（`don't` / `e-mail` 不被切开） */
const LATIN_AT = /^[a-z0-9]+(?:['\-][a-z0-9]+)*/
const isLatinChar = (ch: string) => /[a-z0-9'\-]/i.test(ch)
/** 中文里几乎没有检索价值的虚词与高频单字 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '这', '那', '这个', '那个', '一个', '什么', '怎么', '为什么', '哪', '哪个',
  '和', '与', '就', '都', '也', '还', '又', '把', '被', '给', '让', '从', '到',
  '有', '没有', '不', '没', '很', '太', '会', '能', '可以', '要', '想', '去',
  '啊', '吧', '呢', '吗', '哦', '嗯', '哈', '呀', '啦', '嘛', '着', '过', '好',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
  'at', 'for', 'and', 'or', 'but', 'it', 'this', 'that', 'i', 'you', 'he', 'she',
  'we', 'they', 'my', 'your', 'me', 'do', 'does', 'did', 'so', 'if', 'then',
])

/**
 * 分词。
 *
 * 中文按**双字滑窗**切（不做词典分词：聊天里的新词、缩写、昵称都进不了词典，
 * 而双字滑窗对检索已经够用，且零依赖、零启动成本）。拉丁串整体保留。
 *
 * 实现上刻意**逐字符走，不用带 `g` 标志的正则**：`g` 正则的 `lastIndex` 会在
 * 调用之间残留，`exec` 于是从上次的位置开始找，导致句子后半段的词整段丢失
 * （单测里 `GPT-4o released` 只切出了 `gpt-4o`）。拉丁串改为按字符累积，
 * 没有可残留的状态。
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = String(text || '').toLowerCase()
  let i = 0
  while (i < lower.length) {
    const ch = lower[i]
    if (CJK.test(ch)) {
      // 连续的汉字串切成双字滑窗
      let j = i
      while (j < lower.length && CJK.test(lower[j])) j += 1
      const run = lower.slice(i, j)
      if (run.length === 1) {
        out.push(run)
      } else {
        for (let k = 0; k + 2 <= run.length; k += 1) out.push(run.slice(k, k + 2))
      }
      i = j
      continue
    }
    if (isLatinChar(ch)) {
      const rest = lower.slice(i)
      const m = LATIN_AT.exec(rest)
      if (m) {
        out.push(m[0])
        i += m[0].length
        continue
      }
    }
    i += 1
  }
  return out.filter((t) => t.length > 0 && !STOPWORDS.has(t))
}

export interface CorpusStats {
  /** 文档频率：token → 出现的文档数 */
  df: Map<string, number>
  /** 文档总数 */
  n: number
  /** 平均文档长度（token 数） */
  avgdl: number
  /** 每篇文档的 token 数（用于 BM25 长度归一） */
  lengths: number[]
}

/** BM25 参数：k1 控制词频饱和、b 控制长度归一。取值沿用经典默认。 */
const K1 = 1.2
const B = 0.75

/** 边读边更新统计量（单遍，不保留原文） */
export function createCorpusBuilder() {
  const df = new Map<string, number>()
  const lengths: number[] = []
  return {
    add(tokens: string[]) {
      lengths.push(tokens.length)
      const seen = new Set<string>()
      for (const t of tokens) {
        if (seen.has(t)) continue
        seen.add(t)
        df.set(t, (df.get(t) ?? 0) + 1)
      }
    },
    finish(): CorpusStats {
      const n = lengths.length
      const total = lengths.reduce((a, b) => a + b, 0)
      return { df, n, avgdl: n > 0 ? total / n : 0, lengths }
    },
  }
}

/**
 * 给一批候选文档打分，返回按分数降序的前 `limit` 条。
 *
 * 只需要"每篇文档的 token 集合 / 长度"就能算：BM25 的 tf 项来自候选自身，
 * 因此候选元数据可以在读取阶段就构造成轻量结构（这里直接用 tokens 数组）。
 */
export function rankDocs(
  queryTokens: string[],
  docs: Array<{ index: number; tokens: string[] }>,
  stats: CorpusStats,
  limit: number
): RetrievalHit[] {
  if (!queryTokens.length || !docs.length) return []
  const { df, n, avgdl, lengths } = stats
  const hits: RetrievalHit[] = []
  for (const doc of docs) {
    // tf 只统计 query 里出现的 token，避免为整篇文档建 map
    const want = new Map<string, number>()
    for (const t of queryTokens) want.set(t, (want.get(t) ?? 0) + 1)
    let score = 0
    let matched = 0
    const tf = new Map<string, number>()
    for (const t of doc.tokens) {
      if (!want.has(t)) continue
      tf.set(t, (tf.get(t) ?? 0) + 1)
    }
    const dl = lengths[doc.index] ?? doc.tokens.length
    for (const [term, qtf] of want) {
      const f = tf.get(term) ?? 0
      if (f === 0) continue
      matched += 1
      const dfi = df.get(term) ?? 0
      // BM25 idf，+0.5 平滑避免负值
      const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5))
      const denom = f + K1 * (1 - B + (B * dl) / (avgdl || 1))
      score += idf * ((f * (K1 + 1)) / denom) * qtf
    }
    if (matched === 0) continue
    // 命中不同 query 词的比例作为覆盖度加成：一个词命中 20 次不如 5 个词各命中一次
    const coverage = matched / want.size
    hits.push({ index: doc.index, score: score * (0.6 + 0.4 * coverage) })
  }
  hits.sort((a, b) => b.score - a.score || a.index - b.index)
  return hits.slice(0, limit)
}

/**
 * 从命中结果拼出给模型的上下文块。
 *
 * 按时间原序排列（而不是分数序）：模型读对话时时间线顺序才讲得通；
 * 分数只决定"取哪些"，不决定"怎么排"。
 */
export function buildRetrievedContext(
  hits: Array<{ ts: number; label: string; text: string }>,
  charLimit: number
): string {
  const sorted = [...hits].sort((a, b) => (a.ts || 0) - (b.ts || 0))
  const parts: string[] = []
  let used = 0
  for (const h of sorted) {
    const when = h.ts ? new Date(h.ts * 1000).toISOString().slice(0, 10) : '未知日期'
    const block = `--- 「${h.label}」 ${when} ---\n${h.text}`
    if (used + block.length > charLimit) break
    parts.push(block)
    used += block.length
  }
  return parts.join('\n')
}
