/**
 * Prompt-cache-aware context maintenance.
 *
 * This module is deliberately **pure and dependency-free** (no `electron`, no
 * config, no I/O) so the invariants that keep the provider's prefix cache warm
 * can be unit-tested directly. The architecture is derived from the DeepSeek
 * harness study in `docs/reference/dsh-cache-architecture.md`; the invariants
 * it encodes are:
 *
 * 1. The model-visible history is append-only *within a run*. Dropping or
 *    rewriting its head changes token 0 and destroys the provider's prefix-cache
 *    match, so compaction happens only at a user-turn boundary and is rare,
 *    large, and bounded in cost.
 * 2. There is exactly **one** rolling summary, never a chain of summaries.
 * 3. Every question about "did we keep the prefix?" is answered by comparing the
 *    serialized request arrays byte-for-byte, not by inspecting config.
 */

import { createHash } from 'crypto'

/** 摘要体积上限（字符）。超出后从最旧的部分开始丢弃，因此摘要不会无界增长。 */
export const DIGEST_MAX_CHARS = 8000

/**
 * 压缩触发线：上下文占用达到模型窗口的 80% 才压缩（DSH `thresholdRatio`）。
 * 更早触发会把一次完整的 prefix miss 变成每轮一次。
 */
export const COMPACT_TRIGGER_RATIO = 0.8

/** 压缩后保留的原文比例（DSH `retainRatio`）。 */
export const COMPACT_RETAIN_RATIO = 0.16

/**
 * 字符 → token 的保守估算系数：中文约 1 字 1 token，英文约 4 字符 1 token，
 * 混合内容取 2.5（宁可早一点压缩，也不要超窗口被 provider 拒绝）。
 */
export const CHARS_PER_TOKEN = 2.5

/**
 * 压缩只需要读到这几个字段，因此这里用结构化类型而不是 import
 * `AiMessage`，避免与 weportAiService 形成循环依赖。
 */
export interface CompressibleMessage {
  role: string
  content: string
  reasoning?: string
  toolName?: string
  toolCalls?: unknown[]
}

export interface CompactBudgets {
  /** 超过这个字符数就压缩（≈ 窗口 × COMPACT_TRIGGER_RATIO）。 */
  maxChars: number
  /** 压缩后保留的原文上限（≈ 窗口 × COMPACT_RETAIN_RATIO）。 */
  retainChars: number
}

export interface CompactionResult<T extends CompressibleMessage> {
  kept: T[]
  digest: string
  dropped: T[]
}

/**
 * 在 maxChars 预算内保留**末尾**若干行（越近的信息越有用），超出时在头部标注
 * 被省略的行数。单行本身超预算时硬截断该行，保证一定产出内容。
 */
export function tailLinesWithin(lines: string[], maxChars: number): { text: string; kept: number } {
  if (lines.length === 0) return { text: '', kept: 0 }
  let used = 0
  let start = lines.length
  while (start > 0 && used + lines[start - 1].length + 1 <= maxChars) {
    used += lines[start - 1].length + 1
    start -= 1
  }
  if (start === lines.length) {
    const only = lines[lines.length - 1].slice(-maxChars)
    return { text: `（更早的 ${lines.length - 1} 条已省略）\n${only}`, kept: 1 }
  }
  const body = lines.slice(start).join('\n')
  return { text: start > 0 ? `（更早的 ${start} 条已省略）\n${body}` : body, kept: lines.length - start }
}

/**
 * 把「上一份摘要」与「本轮新摘要」合并成**唯一一份**有界摘要。
 *
 * 绝不链式追加：旧摘要在超限时从最旧的部分开始丢弃。这既让摘要体积有界，
 * 也让每次压缩产出的文本是确定的（同样的输入必然得到同样的字节）。
 */
export function mergeDigest(previous: string, incoming: string, maxChars = DIGEST_MAX_CHARS): string {
  const parts = [String(previous || '').trim(), String(incoming || '').trim()].filter(Boolean)
  if (parts.length === 0) return ''
  const merged = parts.join('\n')
  return merged.length <= maxChars ? merged : tailLinesWithin(merged.split('\n'), maxChars).text
}

/** 消息体积估算（工具结果单独成一条 role=tool 消息，不重复计数）。 */
export function messageChars(message: CompressibleMessage): number {
  return message.content.length + (message.reasoning?.length || 0) + 40
}

/**
 * 上下文压缩。调用方必须在用户回合边界调用，并把返回的 digest 交给
 * {@link mergeDigest} 合并（而不是追加）。
 *
 * 返回 `digest: ''` 表示**没有压缩**，调用方必须保持原样 —— 宁可超出窗口，
 * 也不要产出一次半截的历史改写。
 */
export function compressOverflow<T extends CompressibleMessage>(
  messages: T[],
  budgets: CompactBudgets
): CompactionResult<T> {
  let total = 0
  for (const message of messages) total += messageChars(message)
  if (total <= budgets.maxChars) return { kept: messages, digest: '', dropped: [] }

  // 从最新往回收，保留 retainChars 的原文（并至少保留 4 条，避免把最近一轮
  // 也压掉）。
  let retained = 0
  let dropCount = messages.length
  while (dropCount > 4) {
    const size = messageChars(messages[dropCount - 1])
    if (retained + size > budgets.retainChars) break
    retained += size
    dropCount -= 1
  }

  // 压缩边界必须落在 user 消息上：从孤立的 tool 结果开始会让严格 provider
  // 直接 400（role 'tool' 必须是某个 tool_calls 的响应）。
  //
  // 注意方向：这里往**回**退（多保留几条），而不是往前吃掉保留窗口。往前吃
  // 会在「保留窗口正好落在 assistant/tool 上」时一路吃到底，于是压缩静默失败、
  // 上下文继续无界增长，最后被 provider 以超窗口拒绝 —— 这个失败模式很难从
  // 日志上看出来。
  while (dropCount > 0 && messages[dropCount]?.role !== 'user') {
    dropCount -= 1
  }
  // 连一条可压缩的历史都没有 —— 放弃压缩（保持 append-only，宁可超窗口也
  // 不要一次半截的改写）。
  if (dropCount <= 0 || dropCount >= messages.length) {
    return { kept: messages, digest: '', dropped: [] }
  }

  const dropped = messages.slice(0, dropCount)
  const lines = dropped.map((message) => {
    if (message.role === 'assistant') {
      const toolCount = Array.isArray(message.toolCalls) ? message.toolCalls.length : 0
      return `[AI ${toolCount ? `(工具${toolCount}个)` : '回答'}] ${String(message.content || '').slice(0, 280)}`
    }
    if (message.role === 'user') return `[用户] ${String(message.content || '').slice(0, 140)}`
    return `[工具 ${message.toolName || ''}] ${String(message.content || '').slice(0, 140)}`
  })

  const digest = [
    '以下是更早轮次的关键内容摘要（为节省上下文，原始消息已压缩）：',
    tailLinesWithin(lines, DIGEST_MAX_CHARS).text,
    '（摘要结束 —— 新对话从这里继续）',
  ].join('\n')

  return { kept: messages.slice(dropCount), digest, dropped }
}

// ---------------------------------------------------------------------------
// 前缀稳定性探针
// ---------------------------------------------------------------------------

export type PrefixChangeKind = 'first' | 'append' | 'system' | 'tools' | 'route' | 'head-rewrite'

export interface PrefixFrame {
  systemHash: string
  toolsHash: string
  /**
   * 模型路由（`providerId|model|protocol`）。DSH 把 route change 当作与
   * compaction 同级的「缓存重置点」——换模型 = 换缓存域，哪怕 system/tools/
   * messages 逐字节不变也命中不了。这一项让探针**报得出**那种全量失效。
   */
  route: string
  /**
   * 每一条请求消息单独序列化后的哈希，用于逐条比较。
   *
   * 存哈希而不是原文：这一帧要**落盘**（跨重启也要能发现 system/tools/route
   * 变化），哈希足以做逐字节等价判断，又不会把对话正文写进诊断文件。
   * `JSON.stringify(frame)` 就是磁盘格式。
   */
  wireHashes: string[]
}

export interface PrefixChange {
  change: PrefixChangeKind
  /** 与上一次请求第一处分歧的消息下标；`append` 时等于上一次的长度。 */
  divergedAt: number
  previousLength: number
  /** 上一帧来自磁盘（进程重启过）而非内存 —— 重启后的 `append` 才解释得通。 */
  restored?: boolean
}

/**
 * 生成一帧前缀指纹。消息必须用 `JSON.stringify(message)` 逐条序列化后再取
 * 哈希：请求数组里的消息都是逐字段显式构造的（不是 spread 出来的内部对象），
 * 所以键顺序稳定，序列化结果可以当作字节级的身份。
 *
 * `route` 形如 `opencode-go|deepseek-v4.1-flash|openai-compatible`，由调用方
 * 传入（这里保持纯函数，不 import 任何 provider 类型）。
 */
export function buildPrefixFrame(
  systemContent: string,
  tools: unknown,
  apiMessages: Array<Record<string, unknown>>,
  route = '',
): PrefixFrame {
  return {
    systemHash: sha256(systemContent),
    toolsHash: sha256(JSON.stringify(tools)),
    route,
    wireHashes: apiMessages.map((message) => sha256(JSON.stringify(message))),
  }
}

/**
 * 比较两帧，回答「这次请求的前缀是否逐字节等于上一次请求」。
 *
 * - `first`        会话的第一条请求；
 * - `append`       上一次请求是本次请求的逐字节前缀 —— 唯一健康的形态；
 * - `system`       系统提示变了 —— 整段前缀失效；
 * - `tools`        工具定义变了 —— 整段前缀失效；
 * - `route`        模型路由（provider/model/protocol）换了 —— 换了缓存域，
 *                  即便字节全同也只能全量重算（DSH 的 cache reset point）；
 * - `head-rewrite` 历史中段被改写（压缩，或丢弃了历史头部）—— 从分歧点起失效。
 */
export function comparePrefixFrames(previous: PrefixFrame | undefined, current: PrefixFrame): PrefixChange {
  if (!previous) return { change: 'first', divergedAt: 0, previousLength: 0 }
  if (previous.systemHash !== current.systemHash) {
    return { change: 'system', divergedAt: 0, previousLength: previous.wireHashes.length }
  }
  if (previous.toolsHash !== current.toolsHash) {
    return { change: 'tools', divergedAt: 0, previousLength: previous.wireHashes.length }
  }
  if ((previous.route || '') !== (current.route || '')) {
    return { change: 'route', divergedAt: 0, previousLength: previous.wireHashes.length }
  }

  const limit = Math.min(previous.wireHashes.length, current.wireHashes.length)
  for (let i = 0; i < limit; i += 1) {
    if (previous.wireHashes[i] !== current.wireHashes[i]) {
      return { change: 'head-rewrite', divergedAt: i, previousLength: previous.wireHashes.length }
    }
  }
  if (current.wireHashes.length < previous.wireHashes.length) {
    return { change: 'head-rewrite', divergedAt: current.wireHashes.length, previousLength: previous.wireHashes.length }
  }
  return { change: 'append', divergedAt: limit, previousLength: previous.wireHashes.length }
}

/**
 * 一轮请求的缓存命中统计。
 *
 * 注意区分两个数：
 * - `aggregate` 是整轮 `Σ命中 / Σ请求`，会随步数增大自然升高；
 * - `steadyState` 是去掉前面几步冷启动后的平均每步命中率，才是「稳态」读数。
 * 只报其中一个都可能误导，因此两个都算。
 */
export function summariseCacheUsage(steps: Array<{ promptTokens: number; cacheHitTokens: number }>): {
  promptTokens: number
  cacheHitTokens: number
  aggregate: number
  steadyState: number
} {
  let promptTokens = 0
  let cacheHitTokens = 0
  for (const step of steps) {
    promptTokens += step.promptTokens || 0
    cacheHitTokens += step.cacheHitTokens || 0
  }
  const tail = steps.slice(Math.min(2, Math.max(0, steps.length - 1)))
  let tailPrompt = 0
  let tailHit = 0
  for (const step of tail) {
    tailPrompt += step.promptTokens || 0
    tailHit += step.cacheHitTokens || 0
  }
  return {
    promptTokens,
    cacheHitTokens,
    aggregate: promptTokens > 0 ? (cacheHitTokens / promptTokens) * 100 : 0,
    steadyState: tailPrompt > 0 ? (tailHit / tailPrompt) * 100 : 0,
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}
