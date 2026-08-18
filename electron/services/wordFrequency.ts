/**
 * Shared word-frequency/tokenization module.
 *
 * The tokenizer is deliberately conservative: chat exports contain markup,
 * identifiers, media payloads, URLs, and short conversational glue alongside
 * meaningful words. Keep this module renderer-free so global and group
 * analytics use exactly the same vocabulary rules.
 */

export interface WordFrequencyItem {
  word: string
  count: number
}

export interface TokenizeOptions {
  /** Maximum accepted tokens from one message. Defaults to 200. */
  maxTokensPerMessage?: number
  /** Exact token exclusions, matched after normalization. */
  excludedTokens?: Iterable<string>
  /** Phrases removed before segmentation, useful for account-specific noise. */
  excludedPhrases?: Iterable<string>
  /** Additional stopwords, merged with the built-in language lists. */
  stopwords?: {
    chinese?: Iterable<string>
    english?: Iterable<string>
  }
  /** Minimum token length. Defaults to two code points. */
  minTokenLength?: number
}

/** Prefer parsed/plain chat fields and only use a cleaned raw protocol field as fallback. */
export function extractAnalyticsText(row: Record<string, unknown>): string {
  const preferredKeys = ['parsedContent', 'parsed_content', 'textContent', 'text', 'plainText', 'plain_text']
  for (const key of preferredKeys) {
    const value = String(row?.[key] || '').trim()
    if (value) return value
  }
  const raw = String(row?.StrContent || row?.message_content || row?.content || row?.msg_content || '').trim()
  if (!raw) return ''
  const decoded = raw
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '\"')
  const tagged = /<(?:title|des|content|text|label|summary)[^>]*>([\s\S]*?)<\/(?:title|des|content|text|label|summary)>/iu.exec(decoded)?.[1]
  return (tagged || decoded)
    .replace(/<[^>]{1,400}>/gu, ' ')
    .replace(/^\s*[a-zA-Z0-9_@-]{4,}:(?!\/\/)(?:\r?\n|<br\s*\/?>)/i, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

interface SegmentPart {
  segment: string
  isWordLike?: boolean
}

interface SegmenterLike {
  segment(input: string): Iterable<SegmentPart>
}

const URL_RE = /(?:https?|ftp|file|mailto|data|blob|weixin):\/\/[^\s<]+/giu
const PROTOCOL_RE = /\b(?:https?|ftp|file|mailto|data|blob|weixin):[^\s<]+/giu
const XML_TAG_RE = /<[^>]{1,400}>/gu
const XML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp);/giu
const WXID_RE = /\bwxid_[a-z0-9_-]+\b/giu
const MENTION_RE = /[@＠][\p{L}\p{N}._-]+/gu
const PHONE_RE = /(?:\+?86[\s-]?)?1[3-9]\d{9}\b|\b\d{7,}\b/gu
const INVISIBLE_RE = /[\u200B-\u200D\uFEFF]/gu
const FALLBACK_TOKEN_RE = /[\p{Script=Han}]+|[A-Za-z]+(?:['’-][A-Za-z]+)*/gu
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u
const HEX_RE = /^(?:0x)?[a-f\d]{8,}$/iu
const BASE64_RE = /^(?=.{12,}$)(?=.*[\d+/=])[A-Za-z\d+/]+={0,2}$/u
const PURE_NUMBER_RE = /^[\d.,%+\-/:]+$/u
const REPEATED_CHAR_RE = /^(.)\1{2,}$/u
const REPEATED_PATTERN_RE = /^(.{1,4})\1{2,}$/u
const EDGE_PUNCTUATION_RE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

const CJK_STOPWORDS = new Set<string>([
  '的', '了', '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
  '是', '在', '有', '就', '都', '而', '及', '与', '着', '或', '一个', '没有', '不是',
  '这个', '那个', '什么', '怎么', '可以', '因为', '所以', '如果', '但是', '然后',
  '还是', '已经', '正在', '一下', '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '嘛',
  '啦', '喂', '哦哦', '嗯嗯', '哈哈', '哈哈哈', '哈哈哈哈', '好的', '好吧', '好呀', '行',
  '谢谢', '感谢', '客气', '没事', '没关系', '抱歉', '不好意思', '今天', '明天', '昨天',
  '现在', '时候', '时间', '问题', '东西', '事情', '知道', '觉得', '感觉', '真的', '这么',
  '那么', '为什么', '请问', '回复', '发送', '消息', '内容', '图片', '视频', '语音', '表情',
  '文件', '链接', '大家', '咱们', '这样', '那样', '一样', '一些', '一直', '一定', '有点',
  '起来', '出来', '回来', '过来', '开始', '之后', '之前', '的话', '是不是', '有没有',
  '会不会', '要不要', '能不能', '然后', '以及', '还有', '自己',
])

const LATIN_STOPWORDS = new Set<string>([
  'a', 'an', 'the', 'and', 'or', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on',
  'to', 'with', 'about', 'are', 'am', 'be', 'been', 'being', 'but', 'can', 'could', 'did',
  'do', 'does', 'had', 'has', 'have', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i',
  'if', 'it', 'its', 'just', 'me', 'my', 'no', 'not', 'now', 'our', 'ours', 'out', 'she',
  'so', 'some', 'than', 'that', 'their', 'theirs', 'them', 'they', 'this', 'those', 'too',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'would',
  'you', 'your', 'yours', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'same',
  'such', 'only', 'over', 'under', 'again', 'also', 'back', 'day', 'get', 'good', 'hello',
  'hey', 'hi', 'like', 'look', 'many', 'much', 'need', 'new', 'one', 'please', 'really', 'right',
  'say', 'see', 'sure', 'take', 'thank', 'thanks', 'thing', 'things', 'think', 'time', 'use',
  'want', 'well', 'yeah', 'yes', 'okay', 'ok', 'dont', 'doesnt', 'isnt', 'wasnt', 'wont',
])

const PROTOCOL_WORDS = new Set(['http', 'https', 'ftp', 'file', 'mailto', 'data', 'blob', 'weixin', 'xml', 'html', 'sysmsg', 'appmsg'])

function normalizeToken(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[’‘]/gu, "'")
    .replace(/[‐‑‒–—]/gu, '-')
    .replace(EDGE_PUNCTUATION_RE, '')
    .trim()
}

function normalizeExclusion(value: string): string {
  const token = normalizeToken(String(value))
  return /[\p{Script=Han}]/u.test(token) ? token : token.toLocaleLowerCase('en-US')
}

function addWords(target: Set<string>, values?: Iterable<string>): void {
  if (!values) return
  for (const value of values) {
    const normalized = normalizeExclusion(String(value))
    if (normalized) target.add(normalized)
  }
}

function getSegmenter(locale: string): SegmenterLike | null {
  const IntlWithSegmenter = Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity: 'word' }) => SegmenterLike
  }
  if (!IntlWithSegmenter.Segmenter) return null
  try {
    return new IntlWithSegmenter.Segmenter(locale, { granularity: 'word' })
  } catch {
    return null
  }
}

function fallbackSegments(text: string): string[] {
  const segments: string[] = []
  const matches = text.match(FALLBACK_TOKEN_RE) || []
  for (const match of matches) {
    if (!/[\p{Script=Han}]/u.test(match)) {
      segments.push(match)
      continue
    }
    const chars = Array.from(match)
    if (chars.length === 1) {
      segments.push(match)
      continue
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      segments.push(chars.slice(index, index + 2).join(''))
    }
  }
  return segments
}

function segmentText(text: string): string[] {
  const segmenter = getSegmenter('zh')
  if (!segmenter) return fallbackSegments(text)

  const segments: string[] = []
  for (const part of segmenter.segment(text)) {
    if (part.isWordLike === false) continue
    const raw = part.segment
    if (!/[\p{Script=Han}]/u.test(raw)) {
      segments.push(raw)
      continue
    }
    // ICU normally returns useful Chinese word boundaries. Long unbroken
    // runs are split into bigrams to avoid turning a pasted paragraph into
    // one opaque cloud item on older ICU builds.
    const chars = Array.from(raw)
    if (chars.length <= 8) {
      segments.push(raw)
    } else {
      for (let index = 0; index < chars.length - 1; index += 1) {
        segments.push(chars.slice(index, index + 2).join(''))
      }
    }
  }
  return segments
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function sanitizeText(text: string, excludedPhrases: Set<string>): string {
  let cleaned = String(text || '')
    .normalize('NFKC')
    .replace(URL_RE, ' ')
    .replace(PROTOCOL_RE, ' ')
    .replace(XML_TAG_RE, ' ')
    .replace(XML_ENTITY_RE, ' ')
    .replace(WXID_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(PHONE_RE, ' ')
    .replace(INVISIBLE_RE, ' ')

  for (const phrase of excludedPhrases) {
    if (phrase) cleaned = cleaned.replace(new RegExp(escapeRegExp(phrase), 'giu'), ' ')
  }
  return cleaned
}

function isRepeatedNoise(token: string): boolean {
  return REPEATED_CHAR_RE.test(token) || REPEATED_PATTERN_RE.test(token)
}

function isTechnicalNoise(token: string): boolean {
  return PURE_NUMBER_RE.test(token)
    || HEX_RE.test(token)
    || BASE64_RE.test(token)
    || EMOJI_RE.test(token)
    || isRepeatedNoise(token)
    || PROTOCOL_WORDS.has(token)
}

function buildOptions(input: number | TokenizeOptions | undefined): Required<Pick<TokenizeOptions, 'maxTokensPerMessage' | 'minTokenLength'>> & {
  excludedTokens: Set<string>
  excludedPhrases: Set<string>
  chineseStopwords: Set<string>
  englishStopwords: Set<string>
} {
  const options = typeof input === 'number' ? { maxTokensPerMessage: input } : (input || {})
  const maxTokensPerMessage = Number.isFinite(options.maxTokensPerMessage)
    ? Math.max(0, Math.floor(options.maxTokensPerMessage as number))
    : 200
  const minTokenLength = Number.isFinite(options.minTokenLength)
    ? Math.max(1, Math.floor(options.minTokenLength as number))
    : 2
  const chineseStopwords = new Set(CJK_STOPWORDS)
  const englishStopwords = new Set(LATIN_STOPWORDS)
  addWords(chineseStopwords, options.stopwords?.chinese)
  addWords(englishStopwords, options.stopwords?.english)

  const excludedTokens = new Set<string>()
  addWords(excludedTokens, options.excludedTokens)
  const excludedPhrases = new Set<string>()
  addWords(excludedPhrases, options.excludedPhrases)

  return { maxTokensPerMessage, minTokenLength, excludedTokens, excludedPhrases, chineseStopwords, englishStopwords }
}

function candidateTokens(raw: string): string[] {
  const normalized = normalizeToken(raw)
  if (!normalized) return []
  if (/[\p{Script=Han}]/u.test(normalized) && /[^\p{Script=Han}]/u.test(normalized)) {
    return normalized.match(FALLBACK_TOKEN_RE) || []
  }
  return [normalized]
}

function shouldKeepToken(token: string, options: ReturnType<typeof buildOptions>): boolean {
  if (!token || Array.from(token).length < options.minTokenLength) return false
  const normalized = normalizeExclusion(token)
  if (!normalized || options.excludedTokens.has(normalized)) return false
  if (isTechnicalNoise(normalized)) return false
  if (/[\p{Script=Han}]/u.test(normalized)) return !options.chineseStopwords.has(normalized)
  return !options.englishStopwords.has(normalized)
}

/**
 * Tokenize one message. The numeric second argument remains supported for the
 * existing analytics callers; structured options add configurable exclusions.
 */
export function tokenizeText(text: string, maxTokensPerMessage?: number): string[]
export function tokenizeText(text: string, options?: TokenizeOptions): string[]
export function tokenizeText(text: string, input?: number | TokenizeOptions): string[] {
  if (!text) return []
  const options = buildOptions(input)
  if (options.maxTokensPerMessage === 0) return []

  const tokens: string[] = []
  const push = (raw: string): boolean => {
    for (const candidate of candidateTokens(raw)) {
      const token = normalizeExclusion(candidate)
      if (!shouldKeepToken(token, options)) continue
      tokens.push(token)
      if (tokens.length >= options.maxTokensPerMessage) return false
    }
    return true
  }

  for (const segment of segmentText(sanitizeText(text, options.excludedPhrases))) {
    if (!push(segment)) break
  }
  return tokens
}

/** Batch text → word-frequency map using the same per-message rules. */
export function countWordFrequency(texts: Iterable<string>, options?: TokenizeOptions): Map<string, number> {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const token of tokenizeText(text, options)) {
      counts.set(token, (counts.get(token) || 0) + 1)
    }
  }
  return counts
}

/** Map → stable descending top-N list. */
export function topWordFrequency(counts: Map<string, number>, limit = 60): WordFrequencyItem[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([word, count]) => ({ word, count }))
}
