/**
 * WeClone 风格指纹（v1.0.1）—— 纯函数、零依赖、可单测。
 *
 * ## 它替代了什么
 *
 * 旧的人格档案完全由模型"读语料写描述"得来，而语料只采样了 250 个分块 ——
 * 一份 50 万条消息的聊天记录里，模型看到的是 0.5‰。于是画像里全是"性格开朗、
 * 喜欢打游戏"这类放在谁身上都成立的话，谈到具体语气就只剩两句口头禅。
 *
 * 这里换个方向：**能算的东西不要问模型**。标点习惯、消息长度分布、表情密度、
 * 高频短语、中英混用比例 —— 这些是语料的确定性统计量，本地算一遍就是事实，
 * 而且**可复现**：同一个语料跑两次结果逐位相同。
 *
 * ## 为什么是"统计量"而不是"样例句"
 *
 * 用户明确要求 system prompt 里不要有预设的示例内容（"不要给出 predetermine
 * 的行为引文"）：示例句会被模型当成必背台词复读，而且换个克隆就完全不一样，
 * 不可复现。统计量则相反 —— "平均 8.4 字、72% 的消息不带句号、最常用的是
 * 「笑死」" 描述的是**模式**，模型据此生成的是新句子，不是抄来的句子。
 *
 * ## 逐字金句去哪了
 *
 * 仍然保留在 `language.md` 与语料里，但改成**按话题检索**（见 weCloneService
 * 的 voice bank）：聊到什么话题就取那个人在那个话题上说过的原话。检索结果
 * 每轮不同，不是写死在 prompt 里的。
 */

/** 消息长度直方图的档位（按字符数） */
export const LENGTH_BUCKETS: ReadonlyArray<{ label: string; max: number }> = [
  { label: '1-3', max: 3 },
  { label: '4-8', max: 8 },
  { label: '9-16', max: 16 },
  { label: '17-30', max: 30 },
  { label: '31-60', max: 60 },
  { label: '60+', max: Number.POSITIVE_INFINITY },
]

export interface WeCloneFingerprint {
  /** 统计口径：本人发出的纯文本消息条数 */
  sampleSize: number
  /** 会话数 */
  sessionCount: number
  /** 平均长度（字符）与中位数 */
  avgLength: number
  medianLength: number
  /** 长度直方图，值与 LENGTH_BUCKETS 对齐 */
  lengthHistogram: Array<{ label: string; count: number; ratio: number }>
  /** 标点/语气标记的出现率（每 100 条消息） */
  markers: Array<{ token: string; per100: number }>
  /** 以句末标点结尾的消息比例（0-1），越低越"微信" */
  endsWithPunctuation: number
  /** 含 emoji / 颜文字 / 表情占位符的消息比例 */
  emojiRatio: number
  /** 拉丁字母占全部字符的比例 */
  latinRatio: number
  /** 不含任何标点的消息比例 */
  noPunctuationRatio: number
  /** 高频短语（中文 n-gram + 英文整词），最多 40 条 */
  phrases: Array<{ text: string; count: number }>
  /**
   * 高频英文词与二元搭配（v1.0.1）。
   *
   * 单独一组而不是混进 `phrases`：中英的"高频"不是一个量纲 —— 中文 3 字片段
   * 出现 6 次就有意义，英文词出现 6 次可能只是 the。分成两组，模型能分别读懂。
   */
  englishPhrases: Array<{ text: string; count: number }>
  /** 单条最长的本人消息长度（用于告诉模型"你也会长篇"） */
  maxLength: number
}

/**
 * 标点与语气标记 —— 都是"看得见"的字面量，不需要模型判断。
 *
 * 中英各一半。这台机器上的真实语料是 **84% 拉丁字母**（用户习惯中英混打），
 * 只列中文标记的话，指纹里"最常用标记"那一行会几乎是空的 —— 实测只数出
 * 一个孤零零的 `6`，那是把数字当标记了。现在两侧都覆盖，并且不再收纯数字。
 */
const MARKERS: readonly string[] = [
  // 中文
  '……', '。。。', '！！', '？？', '～～', '~', '哈哈', 'hhh', '233',
  '！', '？', '，', '。', '、', '：', '；', '“', '”', '…', '艹', '草', '卧槽', '我靠',
  '诶', '唉', '哎', 'awsl', 'xswl', 'yyds',
  // 英文聊天里真正有区分度的
  'lol', 'lmao', 'lmfao', 'haha', 'hahaha', 'yeah', 'yea', 'yep', 'nope', 'nah',
  'ok', 'okay', 'k', 'kk', 'tbh', 'ngl', 'imo', 'imho', 'idk', 'rn', 'fr', 'xd',
  'omg', 'wtf', 'wth', 'bruh', 'dude', 'bro', 'guys', 'pls', 'plz', 'thx', 'ty',
  'u', 'ur', 'cuz', 'coz', 'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'ya',
]

/** 句末标点：消息以此结尾时读起来更"书面" */
const SENTENCE_END = /[。！？!?…~～]$/
/** 任意标点 */
const ANY_PUNCTUATION = /[，。！？、；：“”‘’（）《》…—～,.!?;:'"()<>~-]/
/** emoji 与颜文字 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F2FF}]/u
const KAOMOJI_RE = /[（(][^（）()]{0,12}[）)]|[/\\][（(][^）)]{2,}[）)]|[╯╰ノ゜°▽ω・´`]/u
/** 微信的媒体占位符（"保留 [图片] 这类短标签"） */
const MEDIA_TAG_RE = /\[(图片|视频|语音|表情|动画表情|文件|链接|位置|转账|红包|音乐|聊天记录|名片|引用)\]/

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/

/**
 * 短语提取用的 n-gram 长度区间（只针对**汉字**片段）。
 *
 * 2 字太碎（"这个""什么"满地都是），6 字以上几乎没有重复。3-5 字正好是
 * 口头禅的长度 —— "笑死我了""绝了""我服了""没事没事"。
 */
const NGRAM_MIN = 3
const NGRAM_MAX = 5
/** 出现次数下限：低于它更像是巧合而不是习惯 */
const NGRAM_MIN_COUNT = 6

/**
 * 拉丁词的提取规则。
 *
 * 为什么英文不能沿用 n-gram 滑窗：那是为汉字设计的，套到英文上会切出
 * `the`/`ing `/`tion` 这类**词缀碎片** —— 实测一份 84% 英文的语料，指纹里
 * "高频片段"一栏 40 条全是这种东西，等于什么都没说。英文按**整词**统计，
 * 再来一层二元搭配（`i think` / `you know`），才拿得到真正的说话习惯。
 */
const LATIN_WORD_RE = /[A-Za-z][A-Za-z']{2,19}/g
/** 英文词频的下限与上限（比中文高一点：英文词本来就少而集中） */
const WORD_MIN_COUNT = 8
const WORD_LIMIT = 20
const BIGRAM_MIN_COUNT = 5
const BIGRAM_LIMIT = 12

/**
 * 停用词式的"没有个性"片段（中文）。
 *
 * 判据是"它出现在几乎任何人的聊天里"，而不是语法上的虚词 —— 这一层过滤
 * 是为了让 `phrases` 真的反映**这个人的**习惯，而不是中文本身的高频串。
 */
const BORING_FRAGMENTS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '我们', '你们', '他们', '这个', '那个',
  '什么', '怎么', '为什么', '可以', '不是', '没有', '就是', '还是', '这样', '那样',
  '一个', '一下', '一点', '现在', '今天', '明天', '昨天', '时候', '因为', '所以',
  '但是', '然后', '如果', '真的', '应该', '可能', '知道', '觉得', '感觉', '有点',
])

/**
 * 英文里的"谁都会用"的词。
 *
 * 不做这一层过滤，一份英文语料的词频榜前 20 名会被 `the / and / you / that`
 * 占满 —— 那些是**英文**的特征，不是**这个人**的特征。
 */
const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'you', 'that', 'for', 'are', 'but', 'not', 'have', 'has', 'had',
  'was', 'were', 'with', 'this', 'they', 'them', 'their', 'there', 'here', 'what',
  'when', 'where', 'which', 'who', 'why', 'how', 'can', 'could', 'would', 'should',
  'will', 'just', 'like', 'from', 'about', 'into', 'than', 'then', 'some', 'any',
  'all', 'one', 'two', 'out', 'get', 'got', 'see', 'now', 'its', 'it\'s', 'your',
  'our', 'his', 'her', 'him', 'she', 'too', 'very', 'also', 'been', 'being', 'because',
  'don\'t', 'didn\'t', 'doesn\'t', 'isn\'t', 'aren\'t', 'won\'t', 'can\'t', 'im', 'ive',
  'dont', 'didnt', 'doesnt', 'isnt', 'cant', 'wont', 'thats', 'youre', 'youve',
  'yeah', 'yes', 'okay', 'ok', 'lol', 'haha', 'still', 'more', 'most', 'much',
  'well', 'even', 'only', 'back', 'over', 'after', 'before', 'other', 'same',
])

function isBoring(gram: string): boolean {
  if (BORING_FRAGMENTS.has(gram)) return true
  // 全是标点/空白/数字的片段没有语气信息
  if (!CJK_RE.test(gram) && !/[A-Za-z]/.test(gram)) return true
  return false
}

export interface FingerprintAccumulator {
  add(text: string): void
  finish(): WeCloneFingerprint
}

/**
 * 流式累加器。
 *
 * 语料可能几十万条，这里**只维护计数**（直方图、标记计数、n-gram 计数表），
 * 不保留任何原文。n-gram 计数表是唯一会长大的结构：按 3-5 字滑窗，一条 20 字
 * 的消息贡献约 50 个片段，全语料去重后通常只有几十万项 —— 几十 MB 量级，
 * 且可以在超过阈值时按出现次数剪枝（见 `prune`）。
 */
export function createFingerprintAccumulator(options?: { maxNgrams?: number; sessionCount?: number }): FingerprintAccumulator {
  const maxNgrams = Math.max(10_000, options?.maxNgrams ?? 400_000)
  const histogram = new Array<number>(LENGTH_BUCKETS.length).fill(0)
  const markerCounts = new Map<string, number>()
  const ngramCounts = new Map<string, number>()
  const wordCounts = new Map<string, number>()
  const bigramCounts = new Map<string, number>()
  const lengths: number[] = []
  let sampleSize = 0
  let endsWithPunctuation = 0
  let emoji = 0
  let latin = 0
  let cjk = 0
  let noPunctuation = 0
  let maxLength = 0

  /** n-gram 表超过上限时把出现次数砍半以下的项丢掉，避免无界增长 */
  const prune = (): void => {
    for (const [key, count] of ngramCounts) {
      if (count < 3) ngramCounts.delete(key)
    }
  }

  return {
    add(text: string): void {
      const raw = String(text || '')
      if (!raw.trim()) return
      sampleSize += 1
      const length = raw.length
      lengths.push(length)
      if (length > maxLength) maxLength = length
      const bucket = LENGTH_BUCKETS.findIndex((b) => length <= b.max)
      histogram[bucket >= 0 ? bucket : LENGTH_BUCKETS.length - 1] += 1

      if (SENTENCE_END.test(raw)) endsWithPunctuation += 1
      if (!ANY_PUNCTUATION.test(raw)) noPunctuation += 1
      if (EMOJI_RE.test(raw) || KAOMOJI_RE.test(raw) || MEDIA_TAG_RE.test(raw)) emoji += 1

      for (const ch of raw) {
        if (/[A-Za-z]/.test(ch)) latin += 1
        else if (CJK_RE.test(ch)) cjk += 1
      }
      for (const marker of MARKERS) {
        if (!raw.includes(marker)) continue
        markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + 1)
      }

      // n-gram：只取汉字片段（标点会把片段切开）
      for (let i = 0; i < raw.length; i += 1) {
        if (!CJK_RE.test(raw[i])) continue
        for (let n = NGRAM_MIN; n <= NGRAM_MAX; n += 1) {
          const gram = raw.slice(i, i + n)
          if (gram.length < n) break
          if (!CJK_RE.test(gram)) continue
          ngramCounts.set(gram, (ngramCounts.get(gram) ?? 0) + 1)
        }
      }
      // 英文按整词 + 二元搭配统计（n-gram 滑窗在英文上只出词缀碎片）
      const words = raw.toLowerCase().match(LATIN_WORD_RE) || []
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1)
      }
      for (let i = 0; i + 1 < words.length; i += 1) {
        // 搭配的两端都必须是实词：`and the` 这种搭配没有任何信息
        if (ENGLISH_STOPWORDS.has(words[i]) || ENGLISH_STOPWORDS.has(words[i + 1])) continue
        const bigram = `${words[i]} ${words[i + 1]}`
        bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1)
      }
      if (ngramCounts.size > maxNgrams) prune()
    },

    finish(): WeCloneFingerprint {
      const sortedLengths = [...lengths].sort((a, b) => a - b)
      const total = sortedLengths.length
      const avgLength = total ? sortedLengths.reduce((a, b) => a + b, 0) / total : 0
      const medianLength = total ? sortedLengths[Math.floor(total / 2)] : 0
      const ratio = (n: number) => (sampleSize ? Math.round((n / sampleSize) * 1000) / 1000 : 0)

      const markers = [...markerCounts.entries()]
        .map(([token, count]) => ({ token, per100: sampleSize ? Math.round((count / sampleSize) * 1000) / 10 : 0 }))
        .filter((m) => m.per100 >= 1)
        .sort((a, b) => b.per100 - a.per100)
        .slice(0, 18)

      /**
       * 短语打分：`count × length` 再要求"不是更长的短语的一部分"。
       *
       * 为什么乘长度：3 字片段天然比 5 字片段常见，不乘的话结果全是 3 字碎片。
       * 为什么要排除子串：命中「笑死我了」时必然也命中「笑死我」和「死我了」，
       * 三条一起列出来把真正的那一个淹没了。
       */
      const scored = [...ngramCounts.entries()]
        .filter(([gram, count]) => count >= NGRAM_MIN_COUNT && !isBoring(gram))
        .map(([gram, count]) => ({ text: gram, count, score: count * (gram.length - 1) }))
        .sort((a, b) => b.score - a.score)

      const phrases: Array<{ text: string; count: number }> = []
      for (const item of scored) {
        if (phrases.length >= 40) break
        if (phrases.some((kept) => kept.text.includes(item.text) || item.text.includes(kept.text))) continue
        phrases.push({ text: item.text, count: item.count })
      }

      /**
       * 英文：整词 + 二元搭配。
       *
       * 搭配（`i think` / `you know` / `kind of`）比单词更能反映说话习惯，
       * 所以先排搭配、再补单词，并且去重（搭配里的词不再单独出现，
       * 否则 `i think` 和 `think` 各占一行，看起来像两件事）。
       */
      const englishPhrases: Array<{ text: string; count: number }> = []
      const usedWords = new Set<string>()
      const topBigrams = [...bigramCounts.entries()]
        .filter(([, count]) => count >= BIGRAM_MIN_COUNT)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, BIGRAM_LIMIT)
      for (const [text, count] of topBigrams) {
        englishPhrases.push({ text, count })
        for (const word of text.split(' ')) usedWords.add(word)
      }
      const topWords = [...wordCounts.entries()]
        .filter(([word, count]) => count >= WORD_MIN_COUNT && !ENGLISH_STOPWORDS.has(word) && !usedWords.has(word))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, WORD_LIMIT)
      for (const [text, count] of topWords) englishPhrases.push({ text, count })

      return {
        sampleSize,
        sessionCount: Math.max(0, Math.floor(options?.sessionCount ?? 0)),
        avgLength: Math.round(avgLength * 10) / 10,
        medianLength,
        lengthHistogram: LENGTH_BUCKETS.map((bucket, index) => ({
          label: bucket.label,
          count: histogram[index],
          ratio: ratio(histogram[index]),
        })),
        markers,
        endsWithPunctuation: ratio(endsWithPunctuation),
        emojiRatio: ratio(emoji),
        latinRatio: latin + cjk > 0 ? Math.round((latin / (latin + cjk)) * 1000) / 1000 : 0,
        noPunctuationRatio: ratio(noPunctuation),
        phrases,
        englishPhrases,
        maxLength,
      }
    },
  }
}

export function computeFingerprint(texts: readonly string[], sessionCount = 0): WeCloneFingerprint {
  const acc = createFingerprintAccumulator({ sessionCount })
  for (const text of texts) acc.add(text)
  return acc.finish()
}

/**
 * 指纹 → 给模型看的中文事实块。
 *
 * 写成**陈述句事实**而不是命令（"你平均 8.4 字一条" 而不是 "请保持简短"）：
 * 命令式的 system prompt 会被模型当成任务清单逐条执行，结果是每条回复都刻意
 * 短、刻意带"哈哈"，反而更不像人。事实陈述让它自己决定什么时候用哪一面。
 */
export function renderFingerprint(f: WeCloneFingerprint): string {
  if (f.sampleSize === 0) return ''
  const lines: string[] = []
  lines.push(`- 统计口径：本人发出的 ${f.sampleSize.toLocaleString('en-US')} 条纯文本消息，来自 ${f.sessionCount} 个会话`)
  const pct = (v: number) => `${Math.round(v * 100)}%`
  lines.push(
    `- 单条长度：平均 ${f.avgLength} 字，中位数 ${f.medianLength} 字，最长 ${f.maxLength} 字；` +
      f.lengthHistogram
        .filter((b) => b.count > 0)
        .map((b) => `${b.label} 字占 ${pct(b.ratio)}`)
        .join('、')
  )
  lines.push(
    `- 标点习惯：${pct(f.noPunctuationRatio)} 的消息完全不带标点，${pct(f.endsWithPunctuation)} 以句末标点收尾`
  )
  lines.push(`- 表情/颜文字/表情包文字出现在 ${pct(f.emojiRatio)} 的消息里`)
  lines.push(`- 拉丁字母占全部字符的 ${pct(f.latinRatio)}（中英混用的程度）`)
  if (f.markers.length > 0) {
    lines.push(`- 每 100 条里出现次数最多的标记：${f.markers.map((m) => `${m.token} ${m.per100} 次`).join('、')}`)
  }
  if (f.phrases.length > 0) {
    lines.push(`- 反复出现的中文片段（只是**片段**，不是要照抄的整句）：${f.phrases.map((p) => p.text).join('、')}`)
  }
  if (f.englishPhrases.length > 0) {
    lines.push(
      `- 反复出现的英文词与搭配（同样是习惯痕迹，不是台词）：${f.englishPhrases.map((p) => p.text).join('、')}`
    )
  }
  return lines.join('\n')
}
