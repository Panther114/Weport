/**
 * 词频统计共享模块（v0.9.5）
 *
 * 全局词云 / 群成员词云共用同一套分词与停用词规则，保证口径一致：
 * - 中文按 CJK 连续片段滑窗取二元组（bigram）
 * - 英文按单词切分（小写、过滤停用词）
 * - 过滤 URL / wxid / 手机号 / 纯标点等噪声
 */

export interface WordFrequencyItem {
  word: string
  count: number
}

const URL_RE = /https?:\/\/\S+/g
const WXID_RE = /wxid_[a-zA-Z0-9_]+/g
const MENTION_RE = /@[\w-]+/g
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]+/g
const LATIN_RE = /[a-zA-Z][a-zA-Z'-]{1,}/g
const NUMBER_RE = /^[\d.%-]+$/

const CJK_STOPWORDS = new Set<string>([
  '的', '了', '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
  '是', '在', '有', '就', '都', '而', '及', '与', '着', '或', '一个', '没有', '不是',
  '这个', '那个', '什么', '怎么', '可以', '因为', '所以', '如果', '但是', '然后',
  '还是', '已经', '正在', '一下', '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '嘛',
  '啦', '喂', '哦哦', '嗯嗯', '哈哈', '哈哈哈哈哈', '好的', '好吧', '好呀', '行',
  '谢谢', '感谢', '客气', '没事', '没关系', '抱歉', '不好意思', '今天', '明天',
  '昨天', '现在', '时候', '时间', '问题', '东西', '事情', '知道', '觉得', '感觉',
  '真的', '这么', '那么', '为什么', '请问', '回复', '发送', '消息', '内容', '图片',
  '视频', '语音', '表情', '文件', '链接', '大家', '咱们', '这样', '那样', '一样',
  '一下', '一些', '一直', '一定', '有点', '起来', '出来', '回来', '过来', '开始',
  '之后', '之前', '的话', '是不是', '有没有', '会不会', '要不要', '能不能',
])

const LATIN_STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now',
  'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she',
  'too', 'use', 'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they', 'know',
  'want', 'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here',
  'just', 'like', 'long', 'make', 'many', 'more', 'only', 'other', 'over', 'such',
  'take', 'than', 'them', 'well', 'were', 'what', 'dont', 'does', 'look', 'made',
  'also', 'back', 'even', 'every', 'first', 'found', 'give', 'great', 'help', 'love',
  'mean', 'most', 'need', 'really', 'right', 'think', 'thing', 'things', 'going',
  'hello', 'thank', 'please', 'sure', 'yeah', 'okay', 'ok',
])

/** 单条文本 → 词元（去噪、停用词过滤、中文二元组 + 英文单词） */
export function tokenizeText(text: string, maxTokensPerMessage = 200): string[] {
  if (!text) return []
  let cleaned = String(text)
    .replace(URL_RE, ' ')
    .replace(WXID_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(/[\uD800-\uDFFF]/g, ' ')

  const tokens: string[] = []
  const push = (token: string) => {
    if (!token || token.length < 2) return
    if (NUMBER_RE.test(token)) return
    if (CJK_STOPWORDS.has(token) || LATIN_STOPWORDS.has(token)) return
    tokens.push(token)
  }

  const cjkMatches = cleaned.match(CJK_RE) || []
  for (const run of cjkMatches) {
    if (run.length === 1) {
      push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      push(run.slice(i, i + 2))
      if (tokens.length >= maxTokensPerMessage) return tokens
    }
  }

  const latinMatches = cleaned.match(LATIN_RE) || []
  for (const raw of latinMatches) {
    push(raw.toLowerCase())
    if (tokens.length >= maxTokensPerMessage) return tokens
  }

  return tokens
}

/** 批量文本 → 词频 Map（按出现次数统计，与既有 commonPhrases 口径一致） */
export function countWordFrequency(texts: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const token of tokenizeText(text)) {
      counts.set(token, (counts.get(token) || 0) + 1)
    }
  }
  return counts
}

/** Map → 降序 topN 列表 */
export function topWordFrequency(counts: Map<string, number>, limit = 60): WordFrequencyItem[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }))
}
