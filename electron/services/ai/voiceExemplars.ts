/**
 * 语气示范（voice exemplars）—— 迭代 1 的核心。
 *
 * ## 为什么是"示范"而不是"描述"
 *
 * 我们现在给模型的是**关于这个人怎么说话的文字描述**（25000 字的档案 + 一栏统计量）。
 * 实测过的那篇对照研究把这条路的功效量得很清楚：
 *
 *   - zero-shot + 统计式风格摘要 → 作者一致性 **< 7%**（而模型还"以 >95% 的置信度"
 *     给出错误判断）；作者原话："the statistical style summaries provided in prompts
 *     were not effective anchors for imitation"
 *   - one-shot 给一段真实样本 → 67.6% – 94.7%
 *   - **text completion：给真实前文让它接着写 → ≥99.9%**
 *     （Jemama & Kumar, IEEE UEMCON 2025, arXiv:2509.24930）
 *
 * 生产侧的做法也一样：SillyTavern 的向量化把摘要**只当检索键**，真正塞进上下文的是
 * **原文**（"the summarized message does not replace the original message … the
 * original message is retrieved from chat history and shuffled into context"）。
 *
 * 所以这里做的是：把语料里真实发生过的"**对方说什么 → 本人怎么回**"整对取出来，
 * 以**可以接着写**的形式放在**紧邻生成位置**的地方。
 *
 * ## 为什么不带"对谁说"
 *
 * 用户明确要求：**不要按对话对象自适应** —— "它就应该表现得像我，仅此而已"。
 * 因此检索键是**情境**（对方这句话 + 我们刚才在聊什么），而不是收件人。
 * 语域的差异仍然存在，但那是"同一个人在不同话题上的自然差异"，不是"扮演不同的人"。
 *
 * ## 为什么放在 user 侧而不是 system 侧
 *
 * 人格漂移在 8 轮内就能测到（注意力随轮次衰减）。system prompt 离生成位置有几千
 * token，示范放在那里等于把最强证据放得最远。这里把它压进**本轮 user 消息**里，
 * 顺序是：真实示范 → 空行 → 当前对话 → 本轮锚点。
 */

/** 语用功能：一句话在做什么事（决定"该配什么样的示范"） */
export type PragmaticFunction =
  | 'greeting' // 打招呼/呼叫
  | 'question' // 提问
  | 'sticker' // 纯表情/占位符
  | 'thanks' // 道谢/收尾
  | 'banter' // 玩梗/斗嘴
  | 'logistics' // 约时间/办事
  | 'vent' // 吐槽/骂
  | 'statement' // 陈述

export interface VoiceExchange {
  sid: string
  ts: number
  /** 对方说的话（可能多条，已合并成一段） */
  cue: string
  /** 本人对它的回复（可能多条，已合并） */
  reply: string
}

const STICKER_ONLY_RE = /^(\s*\[[^\]]{1,12}\]\s*|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*)+$/u
/**
 * 打招呼。
 *
 * 注意 **`\b` 对中文无效**：`\b` 是按 ASCII `\w` 定义的，汉字不是 `\w`，
 * 所以 `^(…|早安)\b` 在"早安"这种纯汉字串上**永远不匹配**（实测踩过：
 * 早安/晚安 全部掉进 statement）。中英两条分支因此分开写。
 */
const GREETING_RE =
  /^(hi|hey|hello|yo|sup|morning|gm|gn)\b[\s!！。.~]*$|^(在吗|在不在|早|早安|早上好|晚安|晚上好|睡了没|醒了没|嗨|哈喽|好久不见)[\s!！。.~？?]*$/i
const THANKS_RE = /(谢谢|多谢|感谢|thank|thx|ty\b|3q|thanks)/i
const QUESTION_MARK_RE = /[?？]\s*$/
const QUESTION_WORD_RE = /(吗|呢|是不是|对不对|好不好|怎么|为什么|啥|什么|哪|谁|几点|多少|能不能|可不可以)/
/**
 * 办事/约时间。
 *
 * 单靠"时间词"判定不够，单靠"动作词"也不够，两者都太常见：
 *   - "我今天解密了18.1-18.3" 有时间词（今天）但不是安排；
 *   - "你来吗" 有动作词（来）但更像提问。
 * 所以主判据是 **时间词 ∧ 安排动词**，加上少数本身就足够强的信号。
 */
const LOGISTICS_TIME_RE = /(明天|今天|后天|大后天|下周|这周|周末|晚上|中午|早上|下午|半夜|tmr|tomorrow|tonight)/
const LOGISTICS_ACTION_RE = /(去|来|见|约|一起|吃|开|到|上|课|会|出发|走|集合|带|给|交)/
const LOGISTICS_STRONG_RE = /(几点|几点到|deadline|ddl|发我|帮我|帮我带|\d{1,2}\s*[:：]\s*\d{2})/i
const VENT_RE = /(他妈|卧槽|草|靠|操|傻逼|废物|崩了|完了|烦|累死|服了|fuck|wtf|damn|shit|死|寄了|坠机)/i
const BANTER_RE = /(哈哈|嘿嘿|hhh|233|lol|lmao|笑死|nb|6{2,}|牛逼|gay|草|梗|xswl|awsl|gg)/i

/**
 * 一句话在做什么事 —— 纯规则、可复现、零依赖（不需要模型判定）。
 *
 * 顺序即优先级，有两处是刻意的：
 *  1. **提问优先于吐槽**："是不是坠机了" 是他在**问**，配一段提问的示范才有用；
 *     真骂人（"我他妈物理废了啊"）不含疑问词，仍然是 vent。
 *  2. **办事排在玩梗之前**："明天几点" 里 `几点` 比 `nb` 更能说明这句话在干什么。
 */
export function classifyFunction(text: string): PragmaticFunction {
  const t = String(text || '').trim()
  if (!t) return 'statement'
  if (STICKER_ONLY_RE.test(t)) return 'sticker'
  if (GREETING_RE.test(t)) return 'greeting'
  if (THANKS_RE.test(t) && t.length <= 24) return 'thanks'
  if (QUESTION_MARK_RE.test(t) || QUESTION_WORD_RE.test(t)) return 'question'
  if (LOGISTICS_STRONG_RE.test(t) || (LOGISTICS_TIME_RE.test(t) && LOGISTICS_ACTION_RE.test(t))) return 'logistics'
  if (VENT_RE.test(t)) return 'vent'
  if (BANTER_RE.test(t)) return 'banter'
  return 'statement'
}

/**
 * 从一段分块正文里抽出"对方说 → 本人回"的成对样本。
 *
 * `chunks.jsonl` 的每一行 `text` 是一串 `我: …` / `昵称: …` 行。抽法很直接：
 * 遇到一行本人发言，就把它**前面连续的对方发言**合成 cue，这一行（以及紧随其后的
 * 连续本人发言）合成 reply。没有 cue 的（会话开头自己先说话）跳过 —— 那不是"回应"，
 * 学不到"人家问什么他怎么答"。
 */
export function extractExchanges(chunkText: string, selfLabels: readonly string[] = ['我']): VoiceExchange[] {
  const lines = String(chunkText || '').split('\n')
  const self = new Set(selfLabels)
  const out: VoiceExchange[] = []
  let cueBuffer: string[] = []
  let selfBuffer: string[] = []
  const flush = () => {
    if (cueBuffer.length && selfBuffer.length) {
      const cue = cueBuffer.join(' ').trim()
      const reply = selfBuffer.join(' ').trim()
      if (cue && reply) out.push({ sid: '', ts: 0, cue, reply })
    }
    cueBuffer = []
    selfBuffer = []
  }
  for (const line of lines) {
    const m = /^([^:：]{1,40})[:：]\s?([\s\S]*)$/.exec(line)
    if (!m) continue
    const who = m[1].trim()
    const body = m[2].trim()
    if (!body) continue
    if (self.has(who)) {
      // 连发：已经在攒一条回复，就继续并进去（连发本身是很重要的信号）
      if (selfBuffer.length > 0) {
        selfBuffer.push(body)
        continue
      }
      // 没有对方的话 → 不是"回应"，学不到"人家说什么他怎么答"
      if (cueBuffer.length === 0) continue
      selfBuffer = [body]
    } else {
      if (selfBuffer.length > 0) flush() // 对方开口 = 上一轮结束
      cueBuffer.push(body)
    }
  }
  flush()
  return out
}

/** 分词：中文双字滑窗 + 拉丁整词（与 localRetrieval 同口径，便于比较） */
function tokens(text: string): string[] {
  const out: string[] = []
  const lower = String(text || '').toLowerCase()
  let i = 0
  while (i < lower.length) {
    const ch = lower[i]
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(ch)) {
      let j = i
      while (j < lower.length && /[\u3400-\u4dbf\u4e00-\u9fff]/.test(lower[j])) j += 1
      const run = lower.slice(i, j)
      if (run.length === 1) out.push(run)
      else for (let k = 0; k + 2 <= run.length; k += 1) out.push(run.slice(k, k + 2))
      i = j
      continue
    }
    const m = /^[a-z0-9]+(?:['-][a-z0-9]+)*/.exec(lower.slice(i))
    if (m) {
      out.push(m[0])
      i += m[0].length
      continue
    }
    i += 1
  }
  return out
}

/** 查询与样本的词汇重合度（0–1），用查询侧覆盖率，短查询也能用 */
export function overlapScore(query: string, candidate: string): number {
  const q = new Set(tokens(query))
  if (q.size === 0) return 0
  const c = new Set(tokens(candidate))
  let hit = 0
  for (const t of q) if (c.has(t)) hit += 1
  return hit / q.size
}

/**
 * 示范排序。
 *
 * 打分是三部分之和，每一项都对应一个已知的失败模式：
 *  1. **情境相似**（overlap）：聊的是同一件事，示范才有参考价值；
 *  2. **功能一致**（同 `classifyFunction`）：打招呼就该配打招呼 —— 这是纯话题检索
 *     做不到的（对方只发 "hi" 时，词面上检索不到任何东西）；
 *  3. **长短相近**：中位 14 字的人不该被示范成一段长文（长度是最容易被一眼看穿的维度）。
 *
 * 刻意**扣掉**与查询高度重合的样本：那是"照抄"，会让抄写率门禁变红。
 */
export function rankExemplars(
  query: string,
  pool: readonly VoiceExchange[],
  options?: { limit?: number; functionHint?: PragmaticFunction; avoidTexts?: readonly string[]; maxOverlap?: number }
): VoiceExchange[] {
  const limit = Math.max(1, options?.limit ?? 4)
  const hint = options?.functionHint
  const maxOverlap = options?.maxOverlap ?? 0.75
  const queryLen = String(query || '').trim().length || 1
  const scored = pool.map((ex) => {
    const sim = overlapScore(query, ex.cue)
    const fn = classifyFunction(ex.cue)
    const fnMatches = hint ? fn === hint : true
    const lenPenalty = Math.min(1, Math.abs(ex.reply.length - queryLen) / Math.max(24, queryLen))
    // 与查询本身太像 → 照着抄；扣分而不是直接排除，避免把池子清空
    const copyPenalty = sim > maxOverlap ? 1.5 : 0
    const score = sim * 2 + (fnMatches ? 0.9 : 0) - lenPenalty * 0.6 - copyPenalty
    return { ex, score, sim }
  })
  scored.sort((a, b) => b.score - a.score)
  const picked: VoiceExchange[] = []
  const seen = new Set<string>()
  const avoid = (options?.avoidTexts || []).map((t) => String(t || '').trim())
  for (const item of scored) {
    if (picked.length >= limit) break
    const key = item.ex.reply
    if (!key || seen.has(key)) continue
    // 与已选样本重复（同一个口头禅反复出现）就跳过 —— 多样性比多给一条更重要
    if (picked.some((p) => p.reply.includes(item.ex.reply) || item.ex.reply.includes(p.reply))) continue
    // 不要给模型"你已经说过这句"的印象：与最近的真实对话重合的样本丢掉
    if (avoid.some((a) => a && (a.includes(item.ex.reply) || item.ex.reply.includes(a)))) continue
    seen.add(key)
    picked.push(item.ex)
  }
  return picked
}

/** 把示范渲染成"可以接着写"的一段真实对话 */
export function renderExemplarBlock(
  exchanges: readonly VoiceExchange[],
  options: { maxChars?: number; dateOf?: (ts: number) => string; selfLabel?: string; otherLabel?: string } = {}
): string {
  const maxChars = options.maxChars ?? 2600
  const self = options.selfLabel || 'Me'
  const other = options.otherLabel || 'Them'
  const parts: string[] = []
  let used = 0
  for (const ex of exchanges) {
    const when = ex.ts > 0 && options.dateOf ? ` (${options.dateOf(ex.ts)})` : ''
    // 日期挂在对方那一行上：示范是"可接着写的对话"，日期是背景而非台词
    const block = `${other}${when}: ${ex.cue}\n${self}: ${ex.reply}`
    if (used + block.length > maxChars && parts.length > 0) break
    parts.push(block)
    used += block.length + 2
  }
  return parts.join('\n\n')
}

/**
 * 逐字重合检测（抄写闸门）。
 *
 * 返回第一个长度 ≥ `minLen` 的公共子串，没有则 null。
 * 用滚动哈希把示范侧的 n-gram 收进 Set —— 200 条生成 × 几 KB 示范，开销可以忽略。
 */
export function findVerbatimOverlap(a: string, b: string, minLen = 8): string | null {
  const A = String(a || '')
  const B = String(b || '')
  if (A.length < minLen || B.length < minLen) return null
  const shortSide = A.length <= B.length ? A : B
  const longSide = A.length <= B.length ? B : A
  const seen = new Set<string>()
  for (let i = 0; i + minLen <= shortSide.length; i += 1) seen.add(shortSide.slice(i, i + minLen))
  for (let i = 0; i + minLen <= longSide.length; i += 1) {
    const gram = longSide.slice(i, i + minLen)
    if (!seen.has(gram)) continue
    // 命中就尽量往两边扩展，报最长的重合（便于人看）
    let start = i
    let end = i + minLen
    while (start > 0 && shortSide.includes(longSide.slice(start - 1, end))) start -= 1
    while (end < longSide.length && shortSide.includes(longSide.slice(start, end + 1))) end += 1
    return longSide.slice(start, end)
  }
  return null
}

/** 示范块是否与回复重合到需要重生成（抄写闸门用） */
export function replyCopiesExemplars(reply: string, exemplarBlock: string, minLen = 8): string | null {
  return findVerbatimOverlap(reply, exemplarBlock, minLen)
}
