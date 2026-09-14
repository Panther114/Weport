// 对话标题的纯逻辑。抽出来是为了能脱离 electron 直接单测（与 prefixCache.ts
// 同一套做法）—— 标题规则全是字符串边界情况，只有在测试里才跑得全。
//
// 背景：用户报的「标题就是消息开头的几个字」。三条原因，三条都在这里修：
//   1. 系统提示词只要「简短标题」，模型经常直接把用户原话抄回来；
//   2. 生成结果没有校验，抄回来的原话被当成有效标题落库；
//   3. 兜底路径是 `slice(0, 8)`，本身就是"截断前 8 个字"。
//
// 中文按**字符**算词（4 个词 ≈ 12 字以内），西文按**空格分词**算，因为
// "8 个汉字"和"8 个字符的英文单词"完全不是一个信息量。

/** 中文标题的字符上限（≈ 4 个词） */
export const TITLE_MAX_CJK_CHARS = 12
/** 西文标题的词数上限 */
export const TITLE_MAX_WORDS = 4
/** 兜底标题的字符上限：比 AI 标题紧，因为它没有归纳能力，长了就是半句话 */
const FALLBACK_MAX_CJK_CHARS = 8

/** 去掉模型爱加的前后缀：代码块、`标题：`、引号、结尾标点 */
export function stripTitleNoise(raw: string): string {
  const firstLine = String(raw || '')
    .replace(/```[\s\S]*?\n|```/g, '')
    .split(/\r?\n/)[0]
    .trim()
  return firstLine
    .replace(/^(标题|title|话题|主題)\s*[:：]\s*/i, '')
    .replace(/^["'“”「」『』\s]+|["'“”「」『』\s]+$/g, '')
    .replace(/[。．.!！?？,，;；:：]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 是否含 CJK（决定按字算还是按词算） */
export function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)
}

/**
 * 把模型输出规整成 2–4 个词的短标题。
 * 空/纯噪声返回 `null`（调用方应退回兜底标题，而不是落一个空标题）。
 */
export function normaliseTitle(raw: string): string | null {
  let title = stripTitleNoise(raw)
  if (!title) return null
  // 推理型模型偶尔输出整段解释，只在第一行里取首句
  title = title.split(/[。！？!?]\s*/)[0].trim()
  if (!title) return null

  if (hasCjk(title)) {
    const chars = Array.from(title)
    if (chars.length <= TITLE_MAX_CJK_CHARS + 2) return title
    return chars.slice(0, TITLE_MAX_CJK_CHARS + 2).join('').trim()
  }
  const words = title.split(/\s+/).filter(Boolean)
  if (words.length <= TITLE_MAX_WORDS + 2) return title
  return words.slice(0, TITLE_MAX_WORDS + 2).join(' ')
}

/**
 * 标题是否只是用户原话的截断。
 *
 * 抄回来的标题等于没有标题：列表里显示的就是消息开头几个字。判定时忽略
 * 空白与标点，并允许「原话以标题开头」——那正是截断的特征。
 */
export function titleEchoesSource(title: string, source: string): boolean {
  const norm = (s: string) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  const a = norm(title)
  const b = norm(source)
  if (!a || !b) return false
  if (a === b) return true
  return b.startsWith(a) && a.length >= 3
}

/**
 * 客套前缀。中英文两套：只剥离中文会让英文用户看到 "please analyze the full
 * message" 这种既没归纳又没省字的标题。
 *
 * 这里**只放客套话，不放动词**（`analyze` / `分析一下` 这类）：动词往往是话里
 * 唯一的实义动作，剥掉之后标题就只剩宾语，反而更难认。
 */
const COURTESY_PREFIXES: RegExp[] = [
  /^(请(你|帮我)?|帮我|我想|我想要|请你|麻烦你|可以|能不能|给我)\s*/,
  /^(please|could you|can you|would you|help me|i want to|i'd like to|i would like to)\s+/i,
  /^(kindly|just|maybe|hey|hi)\s+/i,
]

/**
 * 兜底标题：模型不可用（没配 key、超时、被限流）时用。
 *
 * 去掉客套前缀、截到第一个句读，再按词/字边界收敛。它永远不如 AI 标题，
 * 但至少是"一句话的开头"而不是"一句话的前 8 个字符"。
 */
export function buildFallbackTitle(text: string): string {
  let working = String(text || '').trim()
  // 客套话会叠（「请帮我看看…」），循环剥到不再变化为止。
  for (let i = 0; i < 4; i += 1) {
    let stripped = false
    for (const prefix of COURTESY_PREFIXES) {
      const next = working.replace(prefix, '')
      if (next !== working) {
        working = next.trim()
        stripped = true
      }
    }
    if (!stripped) break
  }
  const stripped = working.split(/[。！？!?\n]/)[0].replace(/\s+/g, ' ').trim()
  if (!stripped) return '新对话'
  if (hasCjk(stripped)) {
    // 去掉句尾的语气与客套（「…怎么样」「…好吗」）再截断：这些字占着标题
    // 的位置却不携带信息，去掉之后同样的字数能放下更多主题。
    const trimmed = stripped.replace(/(怎么样|好不好|如何|好吗|好吗？|吧|吗|呢|啊|呀)+$/g, '').trim()
    const base = Array.from(trimmed || stripped)
    return base.slice(0, FALLBACK_MAX_CJK_CHARS).join('')
  }
  return stripped.split(/\s+/).filter(Boolean).slice(0, TITLE_MAX_WORDS).join(' ')
}
