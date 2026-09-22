import { describe, expect, it } from 'vitest'
import {
  COMPACT_RETAIN_RATIO,
  COMPACT_TRIGGER_RATIO,
  DIGEST_MAX_CHARS,
  buildPrefixFrame,
  comparePrefixFrames,
  compressOverflow,
  mergeDigest,
  messageChars,
  summariseCacheUsage,
  tailLinesWithin,
  type CompressibleMessage,
  type PrefixFrame,
} from './prefixCache'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

interface TestMessage extends CompressibleMessage {
  role: 'user' | 'assistant' | 'tool'
  toolName?: string
  toolCalls?: unknown[]
}

const user = (content: string): TestMessage => ({ role: 'user', content })
const assistant = (content: string, toolCalls?: unknown[]): TestMessage => ({ role: 'assistant', content, toolCalls })
const toolResult = (content: string, toolName = 'read_session_messages'): TestMessage => ({ role: 'tool', content, toolName })

/**
 * 构造一段「真实形态」的历史：user → assistant(tool_calls) → tool → …。
 * 每个 agent step 追加一个 assistant + N 个 tool 结果，正好是 harness 的形状。
 */
function buildHistory(steps: number, toolChars = 400): TestMessage[] {
  const messages: TestMessage[] = []
  for (let i = 0; i < steps; i += 1) {
    if (i % 5 === 0) messages.push(user(`第 ${i} 轮的用户提问 — `.repeat(6)))
    messages.push(assistant(`step ${i} 的分析`, [{ id: `call_${i}`, name: 'read_session_messages', args: {} }]))
    messages.push(toolResult(`step ${i} 工具结果 ${'x'.repeat(toolChars)}`))
  }
  return messages
}

const budgets = { maxChars: 4000, retainChars: 800 }

// ---------------------------------------------------------------------------
// tailLinesWithin / mergeDigest —— 摘要必须有界且只有一份
// ---------------------------------------------------------------------------

describe('tailLinesWithin', () => {
  it('保留末尾的行，并在超出预算时标注省略条数', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
    const result = tailLinesWithin(lines, 40)
    expect(result.text).toContain('line-49')
    expect(result.text).not.toContain('line-0')
    expect(result.text).toMatch(/已省略/)
  })

  it('预算足够时原样返回，不加省略标记', () => {
    const result = tailLinesWithin(['a', 'b'], 1000)
    expect(result.text).toBe('a\nb')
    expect(result.kept).toBe(2)
  })

  it('单行就超预算时硬截断而不是返回空', () => {
    const result = tailLinesWithin(['x'.repeat(500)], 50)
    expect(result.text.length).toBeLessThan(100)
    expect(result.text).toContain('x')
  })
})

describe('mergeDigest', () => {
  it('合并后不超过上限——摘要永远只有一份', () => {
    let digest = ''
    // 模拟 40 次压缩：旧实现会无限追加，这里必须始终有界。
    for (let i = 0; i < 40; i += 1) {
      digest = mergeDigest(digest, `[用户] 第 ${i} 段被压缩的内容 ${'y'.repeat(500)}`)
      expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS + 64)
    }
  })

  it('保留最新的内容，丢弃最旧的', () => {
    let digest = mergeDigest('', `[用户] oldest ${'a'.repeat(DIGEST_MAX_CHARS)}`)
    digest = mergeDigest(digest, '[用户] newest-marker')
    expect(digest).toContain('newest-marker')
    expect(digest).not.toContain('oldest')
  })

  it('空输入返回空串', () => {
    expect(mergeDigest('', '')).toBe('')
    expect(mergeDigest('   ', '')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// compressOverflow —— 触发条件、边界、安全性
// ---------------------------------------------------------------------------

describe('compressOverflow', () => {
  it('未达阈值时完全不压缩（保持逐字节 append-only）', () => {
    const messages = buildHistory(2, 20)
    const result = compressOverflow(messages, { maxChars: 1_000_000, retainChars: 1000 })
    expect(result.digest).toBe('')
    expect(result.kept).toBe(messages) // 同一个引用：调用方不会误以为发生了改写
    expect(result.dropped).toEqual([])
  })

  it('超过阈值时压缩，且 kept + dropped 恰好覆盖原历史', () => {
    const messages = buildHistory(40, 400)
    const result = compressOverflow(messages, budgets)
    expect(result.digest).not.toBe('')
    expect(result.dropped.length + result.kept.length).toBe(messages.length)
    expect(result.dropped.length).toBeGreaterThan(0)
    expect(result.kept.length).toBeGreaterThan(0)
  })

  it('保留窗口的**第一条**永远是 user 消息——绝不能从孤立 tool 结果开始', () => {
    // 这是严格 provider 会以 400 拒绝的形状（role=tool 找不到对应的 tool_calls），
    // 也是压缩最容易悄悄引入的线上故障。
    for (const steps of [12, 25, 40, 60]) {
      const result = compressOverflow(buildHistory(steps, 300), budgets)
      if (result.digest === '') continue
      expect(result.kept[0].role).toBe('user')
    }
  })

  it('不会把最近一轮也压掉（至少保留 4 条）', () => {
    const messages = buildHistory(30, 400)
    const result = compressOverflow(messages, budgets)
    expect(result.kept.length).toBeGreaterThanOrEqual(4)
  })

  it('极端预算下宁可放弃压缩，也不产出半截历史', () => {
    // retainChars 小到立即触底时，dropCount 会撞到长度上限 —— 必须原样返回。
    const messages = buildHistory(3, 10)
    const result = compressOverflow(messages, { maxChars: 1, retainChars: 1 })
    if (result.digest !== '') {
      expect(result.kept[0].role).toBe('user')
      expect(result.dropped.length + result.kept.length).toBe(messages.length)
    } else {
      expect(result.kept).toBe(messages)
    }
  })

  it('摘要体积有界，且包含被压缩内容的痕迹', () => {
    const messages = buildHistory(200, 500)
    const result = compressOverflow(messages, budgets)
    expect(result.digest.length).toBeLessThan(DIGEST_MAX_CHARS + 200)
    expect(result.digest).toMatch(/摘要|压缩/)
  })

  it('触发线比例说明：0.8 触发 / 0.16 保留（防止被误改回每轮压缩）', () => {
    expect(COMPACT_TRIGGER_RATIO).toBeGreaterThanOrEqual(0.7)
    expect(COMPACT_RETAIN_RATIO).toBeLessThan(COMPACT_TRIGGER_RATIO)
    // 旧实现按「消息条数 > 40」触发，几乎每轮都压缩；窗口比例必须远大于 1。
    const windowTokens = 128_000
    const maxChars = windowTokens * COMPACT_TRIGGER_RATIO * 2.5
    expect(maxChars).toBeGreaterThan(200_000)
  })
})

// ---------------------------------------------------------------------------
// 前缀稳定性 —— 本次重构的核心断言
// ---------------------------------------------------------------------------

describe('comparePrefixFrames', () => {
  const system = 'SYSTEM PROMPT'
  const tools = [{ type: 'function', function: { name: 'a' } }]
  const wire = (...contents: string[]) => contents.map((content) => ({ role: 'user', content }))

  const frameOf = (contents: string[]): PrefixFrame => buildPrefixFrame(system, tools, wire(...contents))

  it('第一条请求标记为 first', () => {
    expect(comparePrefixFrames(undefined, frameOf(['a'])).change).toBe('first')
  })

  it('纯追加是唯一健康形态', () => {
    const result = comparePrefixFrames(frameOf(['a', 'b']), frameOf(['a', 'b', 'c']))
    expect(result.change).toBe('append')
    expect(result.divergedAt).toBe(2)
    expect(result.previousLength).toBe(2)
  })

  it('内容相同也算 append（幂等重放）', () => {
    expect(comparePrefixFrames(frameOf(['a', 'b']), frameOf(['a', 'b'])).change).toBe('append')
  })

  it('中段被改写 → head-rewrite，并给出分歧下标', () => {
    const result = comparePrefixFrames(frameOf(['a', 'b', 'c']), frameOf(['a', 'CHANGED', 'c']))
    expect(result.change).toBe('head-rewrite')
    expect(result.divergedAt).toBe(1)
  })

  it('历史被丢弃（头部收缩）→ head-rewrite', () => {
    expect(comparePrefixFrames(frameOf(['a', 'b', 'c']), frameOf(['b', 'c'])).change).toBe('head-rewrite')
  })

  it('系统提示变化 → system（整段前缀失效）', () => {
    const previous = buildPrefixFrame(system, tools, wire('a'))
    const current = buildPrefixFrame('DIFFERENT SYSTEM', tools, wire('a'))
    expect(comparePrefixFrames(previous, current).change).toBe('system')
  })

  it('工具定义变化 → tools（整段前缀失效）', () => {
    const previous = buildPrefixFrame(system, tools, wire('a'))
    const current = buildPrefixFrame(system, [{ type: 'function', function: { name: 'b' } }], wire('a'))
    expect(comparePrefixFrames(previous, current).change).toBe('tools')
  })

  it('模型路由变化 → route（换缓存域，即使字节全同也命中不了）', () => {
    const previous = buildPrefixFrame(system, tools, wire('a'), 'opencode-go|deepseek-v4.1-flash|openai-compatible')
    const current = buildPrefixFrame(system, tools, wire('a'), 'opencode-go|gpt-6-astra|openai')
    const result = comparePrefixFrames(previous, current)
    expect(result.change).toBe('route')
    expect(result.divergedAt).toBe(0)
    expect(result.previousLength).toBe(1)
  })

  it('路由一致时不影响 append 判定（缺省路由 = 缺省路由）', () => {
    expect(comparePrefixFrames(buildPrefixFrame(system, tools, wire('a')), buildPrefixFrame(system, tools, wire('a', 'b'))).change).toBe('append')
  })

  it('帧经 JSON 落盘往返后仍能逐字节比较（跨重启探针的前提）', () => {
    // PrefixFrame 就是 prefix-probe.json 的磁盘格式：只有哈希，没有正文。
    const previous = JSON.parse(JSON.stringify(buildPrefixFrame(system, tools, wire('a', 'b'), 'prov|model|proto'))) as PrefixFrame
    const current = buildPrefixFrame(system, tools, wire('a', 'b', 'c'), 'prov|model|proto')
    expect(comparePrefixFrames(previous, current).change).toBe('append')
    const rewritten = buildPrefixFrame('OTHER', tools, wire('a', 'b', 'c'), 'prov|model|proto')
    expect(comparePrefixFrames(previous, rewritten).change).toBe('system')
  })

  it('空请求数组之间也是 append', () => {
    expect(comparePrefixFrames(buildPrefixFrame(system, tools, []), buildPrefixFrame(system, tools, [])).change).toBe('append')
  })
})

describe('长任务模拟：一轮里只允许出现一次 head-rewrite', () => {
  /**
   * 模拟 harness 的真实循环：每步把 assistant + tool 结果**追加**到请求数组。
   * 这正是 DSH 用 443 次真实调用证明过的性质（442/442 全 append）。
   */
  it('50 步追加期间 100% 是 append', () => {
    const system = 'SYSTEM'
    const tools = [{ type: 'function', function: { name: 'read_session_messages' } }]
    const request: Array<Record<string, unknown>> = [{ role: 'system', content: system }]
    let previous: PrefixFrame | undefined

    const kinds: string[] = []
    for (let step = 0; step < 50; step += 1) {
      request.push({ role: 'assistant', content: `analysis ${step}` })
      request.push({ role: 'tool', tool_call_id: `call_${step}`, content: `result ${step}` })
      const frame = buildPrefixFrame(system, tools, request)
      kinds.push(comparePrefixFrames(previous, frame).change)
      previous = frame
    }

    expect(kinds[0]).toBe('first')
    expect(kinds.slice(1).every((kind) => kind === 'append')).toBe(true)
    expect(kinds.filter((kind) => kind === 'head-rewrite')).toHaveLength(0)
  })

  it('压缩在同一步只造成一次 head-rewrite，之后立即恢复 append', () => {
    const system = 'SYSTEM'
    const tools: unknown[] = []
    let request: Array<Record<string, unknown>> = [{ role: 'system', content: system }]
    let previous: PrefixFrame | undefined
    const kinds: string[] = []

    const step = () => {
      request.push({ role: 'assistant', content: 'a' })
      request.push({ role: 'tool', tool_call_id: 'x', content: 'r' })
      const frame = buildPrefixFrame(system, tools, request)
      kinds.push(comparePrefixFrames(previous, frame).change)
      previous = frame
    }

    for (let i = 0; i < 10; i += 1) step()
    // 压缩：丢弃前 6 条，插入一条摘要 system 消息（就是新的前缀头）
    request = [{ role: 'system', content: system }, { role: 'system', content: 'SUMMARY' }, ...request.slice(6)]
    step()
    for (let i = 0; i < 10; i += 1) step()

    const rewrites = kinds.filter((kind) => kind === 'head-rewrite')
    expect(rewrites).toHaveLength(1)
    expect(kinds[kinds.length - 1]).toBe('append')
  })
})

// ---------------------------------------------------------------------------
// 计量
// ---------------------------------------------------------------------------

describe('summariseCacheUsage', () => {
  it('聚合命中率随步数自然升高，稳态值反映尾部', () => {
    const steps = [{ promptTokens: 1000, cacheHitTokens: 0 }]
    for (let i = 0; i < 40; i += 1) steps.push({ promptTokens: 1000 + i * 50, cacheHitTokens: 980 + i * 50 })
    const summary = summariseCacheUsage(steps)
    expect(summary.aggregate).toBeGreaterThan(90)
    expect(summary.steadyState).toBeGreaterThan(97)
  })

  it('provider 不上报缓存时不会假装 100%', () => {
    const summary = summariseCacheUsage([{ promptTokens: 500, cacheHitTokens: 0 }])
    expect(summary.aggregate).toBe(0)
    expect(summary.steadyState).toBe(0)
  })

  it('空输入不产生 NaN', () => {
    const summary = summariseCacheUsage([])
    expect(summary.aggregate).toBe(0)
    expect(summary.steadyState).toBe(0)
    expect(summary.promptTokens).toBe(0)
  })
})

describe('messageChars', () => {
  it('把 reasoning 计入体积（推理模型的主要增量）', () => {
    expect(messageChars({ role: 'assistant', content: 'x'.repeat(100), reasoning: 'y'.repeat(900) })).toBeGreaterThan(1000)
  })
})
