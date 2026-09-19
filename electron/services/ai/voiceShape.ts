/**
 * 消息形态（迭代 2）—— 把一条回复切成"像本人那样的一串消息"。
 *
 * ## 为什么这是缺口最大的一步
 *
 * 实测（60 例 held-out，当前线上行为）：
 *
 * | 指标 | 本人（真实下一条） | 克隆 |
 * |---|---|---|
 * | 单条长度 | 17.2 字 | **27.3 字**（+59%） |
 * | 每条回复的气泡数 | 连发平均 **4.31** | **2.53** |
 * | 整条回复长度偏差 | 0 | **+54.6 字** |
 *
 * 换成人的直觉：他是**一次连发四五条、每条十几个字**，克隆是**两段一百多字的英文**。
 * 这是最容易被一眼看穿的维度，而且**完全不需要动模型**就能修 —— 只要按他自己的
 * 长度分布与连发分布去切。
 *
 * ## 为什么是"确定性"的
 *
 * 同一份输入必须给出同一份输出：可单测、可复现、可对账。所以这里没有随机数 ——
 * 标点策略用"他的句末标点率只有 3%"这一条事实做**统一决定**，而不是按概率抛硬币。
 *
 * ## 边界（刻意不做的事）
 *
 * - **不丢内容**：切分只换气泡边界，字符一个不少（超出气泡上限只会并进上一条）。
 * - **不截断**：连发条数超过上限时把多余的并进最后一条，而不是删掉。
 * - **不改语义**：不替换词、不缩写、不"润色"。
 */

export interface VoiceShapeProfile {
  /** 单条长度中位数（他 = 14） */
  medianLength: number
  /** 单条长度 p90（超过它就该考虑换一条发） */
  p90Length: number
  meanLength: number
  /** 连发：平均条数（他 = 4.31）、中位数、上限 */
  burstMean: number
  burstMedian: number
  burstMax: number
  /** 以句末标点收尾的比例（他 = 3%，所以默认去掉句末句号） */
  endsWithPunctuation: number
  /** 构成这份 profile 的样本量（供 meta 显示） */
  sampleSize: number
}

export interface VoiceRow {
  ts: number
  sid: string
  text: string
}

/**
 * 从**本人的原话**里算出形态 profile。
 *
 * 连发用"同一会话内时间间隔 ≤180 秒"近似 —— 语料里没有"对方是否已回复"这个方向，
 * 这是能在纯统计下做到的最好近似（评测夹具用的是同一套近似，口径一致才好对比）。
 */
export function profileFromVoice(rows: readonly VoiceRow[], gapSeconds = 180): VoiceShapeProfile {
  const texts = rows.map((r) => String(r.text || '')).filter((t) => t.trim().length > 0)
  const lengths = texts.map((t) => [...t].length).sort((a, b) => a - b)
  const n = lengths.length
  const pick = (q: number) => (n === 0 ? 0 : lengths[Math.min(n - 1, Math.max(0, Math.floor(q * n)))])
  const mean = n === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / n

  // 连发：按会话分组、按时间排序，间隔超过阈值就断开
  const bySid = new Map<string, number[]>()
  for (const r of rows) {
    const ts = Number(r.ts) || 0
    if (!ts) continue
    const sid = String(r.sid || '?')
    if (!bySid.has(sid)) bySid.set(sid, [])
    bySid.get(sid)!.push(ts)
  }
  const bursts: number[] = []
  for (const list of bySid.values()) {
    list.sort((a, b) => a - b)
    let size = 0
    let prev = 0
    for (const ts of list) {
      if (size === 0 || ts - prev <= gapSeconds) size += 1
      else {
        bursts.push(size)
        size = 1
      }
      prev = ts
    }
    if (size > 0) bursts.push(size)
  }
  bursts.sort((a, b) => a - b)
  const burstMean = bursts.length ? bursts.reduce((a, b) => a + b, 0) / bursts.length : 1
  const burstMedian = bursts.length ? bursts[Math.floor(bursts.length / 2)] : 1
  const burstMax = bursts.length ? bursts[bursts.length - 1] : 1

  const endPunct = texts.filter((t) => /[。！？!?…~～]\s*$/.test(t)).length

  return {
    medianLength: pick(0.5),
    // p90 作为"单条该有多长"的上界：比中位数宽，但不至于让 3 倍长的句子留在一条里
    p90Length: Math.max(pick(0.9), pick(0.5) + 8),
    meanLength: Math.round(mean * 10) / 10,
    burstMean: Math.round(burstMean * 100) / 100,
    burstMedian: burstMedian || 1,
    // 上限取 p90 与均值+1 的较大者，且至少 2 —— 不要把"他偶尔连发 8 条"当成常态
    burstMax: Math.max(2, Math.min(8, Math.max(bursts.length ? bursts[Math.floor(bursts.length * 0.9)] : 3, 3))),
    endsWithPunctuation: texts.length ? endPunct / texts.length : 0,
    sampleSize: n,
  }
}

/** 句末标点（保留 `?`/`！` 这类有信息量的；句号在微信里他几乎不用） */
const TRAILING_PERIOD_RE = /[。.]\s*$/
const QUESTIONY_RE = /[?？]/

/**
 * 把句子切成段。
 *
 * 两级：先按空行/换行（模型常常自己就分了段），再按句末标点切。
 * 标点**跟着**它前面的句子走 —— 丢了标点，`？` 这种语义就没了。
 */
export function splitSegments(raw: string): string[] {
  const out: string[] = []
  for (const block of String(raw || '').split(/\n\s*\n|\n/)) {
    const trimmed = block.trim()
    if (!trimmed) continue
    // 在句末标点后切开，但保留标点
    const parts = trimmed.split(/(?<=[。！？!?；;])\s*/).map((s) => s.trim()).filter(Boolean)
    out.push(...(parts.length ? parts : [trimmed]))
  }
  return out
}

/**
 * 按本人的长度分布与连发分布，把一条回复切成若干条消息。
 *
 * 规则（全部确定性）：
 *  1. 段按顺序打包成气泡，单条不超过 `p90Length`；
 *  2. 段数超过 `burstMax` 时，**多余的并进最后一条**（宁可最后一条长一点，也不删内容）；
 *  3. 单段本身超过 `2 × p90Length` 时才硬切（按逗号/空格找最近的位置）；
 *  4. 结尾是句号的去掉句号（他的句末标点率只有 3%），`?`/`！` 保留 —— 那是语义。
 */
export function shapeReply(raw: string, profile: VoiceShapeProfile): string[] {
  const segments = splitSegments(raw)
  if (segments.length === 0) return []

  const perBubble = Math.max(8, Math.round(profile.p90Length || 30))
  const hardLimit = Math.max(perBubble * 2, 40)
  const maxBubbles = Math.max(1, Math.min(8, Math.round(profile.burstMax || 4)))

  // 3) 先把过长的段硬切开（很少发生；只是为了防止一条 300 字的墙）
  const pieces: string[] = []
  for (const seg of segments) {
    if ([...seg].length <= hardLimit) {
      pieces.push(seg)
      continue
    }
    let rest = seg
    while ([...rest].length > perBubble) {
      // 在 perBubble 附近找最近的逗号/空格/顿号，找不到就按长度切
      const chars = [...rest]
      const window = chars.slice(Math.floor(perBubble * 0.6), perBubble)
      let cut = -1
      for (let i = window.length - 1; i >= 0; i -= 1) {
        if (/[，,、\s]/.test(window[i])) {
          cut = Math.floor(perBubble * 0.6) + i + 1
          break
        }
      }
      if (cut <= 0) cut = perBubble
      pieces.push(chars.slice(0, cut).join('').trim())
      rest = chars.slice(cut).join('').trim()
    }
    if (rest) pieces.push(rest)
  }

  // 1) 打包成气泡
  const bubbles: string[] = []
  for (const piece of pieces) {
    const current = bubbles[bubbles.length - 1]
    if (current === undefined) {
      bubbles.push(piece)
      continue
    }
    // 还能塞下就并进去；否则新开一条
    if ([...current].length + [...piece].length <= perBubble) bubbles[bubbles.length - 1] = `${current}${piece}`
    else bubbles.push(piece)
  }

  // 2) 超过连发上限：把多余的并进最后一条（不丢内容）
  if (bubbles.length > maxBubbles) {
    const head = bubbles.slice(0, maxBubbles - 1)
    const tail = bubbles.slice(maxBubbles - 1).join('')
    head.push(tail)
    return head.map(finalize)
  }
  return bubbles.map(finalize)
}

/** 4) 标点收尾策略：句号去掉（他几乎不用），问号/感叹号保留 */
function finalize(bubble: string): string {
  const t = bubble.trim()
  if (!t) return t
  if (QUESTIONY_RE.test(t) || /[！!…~～]\s*$/.test(t)) return t
  return t.replace(TRAILING_PERIOD_RE, '').trim()
}
