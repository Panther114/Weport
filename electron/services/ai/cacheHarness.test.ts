import { describe, expect, it } from 'vitest'
import { buildPrefixFrame, comparePrefixFrames, compressOverflow, mergeDigest, type PrefixFrame } from './prefixCache'

/**
 * 长任务缓存投影（long-task cache harness）。
 *
 * ## 这个测试证明了什么、没证明什么 —— 请勿误读
 *
 * **证明**：在 harness 真实产生的请求序列下，相邻两次请求的前缀是**逐字节
 * 相同**的（只差末尾追加），并且压缩是罕见事件。这是 prefix cache 命中的
 * **必要条件**：提供商只能在完全一致的前缀上命中，前缀一旦被改写，从改写点
 * 之后全部计费。
 *
 * **没有证明**：真实的命中率。那取决于提供商的缓存实现与保留策略，本地模拟
 * 不出来。因此下面的百分比是「在前缀稳定的前提下，按照 token 记账推导出的
 * **投影值**」，不是实测值。
 *
 * **真实测量**由两处给出：
 *   1. 应用内右下角的缓存命中读数（来自 provider 返回的 usage）；
 *   2. `node scripts/verify-cache-prefix.mjs` —— 直接读 weport-ai/debug.log 里
 *      的 `kind:"prefix"` 记录，逐条核对前缀变化原因。
 */

/** 与真实运行量级一致的参数：稳定前缀约 30k token，每步新增约 2k token。 */
const PREFIX_TOKENS = 30_000
const STEP_TOKENS = 2_000

interface SimulatedStep {
  promptTokens: number
  cacheHitTokens: number
}

/**
 * 模拟一个 N 步的 agent 循环。
 *
 * 关键前提（由下面的字节级断言保证，而不是假设）：第 i 步的请求，恰好等于
 * 第 i-1 步的请求再加上本步新增的 assistant + tool 结果。于是第 i 步可以命中
 * 第 i-1 步的全部内容。
 */
function simulateRun(steps: number, options: { breakPrefixEvery?: number } = {}): SimulatedStep[] {
  const result: SimulatedStep[] = []
  let prompt = PREFIX_TOKENS
  let cacheable = PREFIX_TOKENS
  for (let i = 1; i <= steps; i += 1) {
    // 前缀被改写时，之前累积的所有内容都不可再命中 —— 这正是旧实现每轮
    // 压缩都会发生的事。
    if (options.breakPrefixEvery && i % options.breakPrefixEvery === 0) cacheable = 0
    result.push({ promptTokens: prompt, cacheHitTokens: Math.min(cacheable, prompt) })
    prompt += STEP_TOKENS
    cacheable = prompt - STEP_TOKENS
  }
  return result
}

const aggregateHitRate = (steps: SimulatedStep[]): number => {
  const prompt = steps.reduce((sum, step) => sum + step.promptTokens, 0)
  const hit = steps.reduce((sum, step) => sum + step.cacheHitTokens, 0)
  return prompt > 0 ? (hit / prompt) * 100 : 0
}

/** 稳态命中率：只看尾部若干步（去掉冷启动那几步）。 */
const steadyStateHitRate = (steps: SimulatedStep[], tail = 5): number => {
  const slice = steps.slice(-tail)
  const prompt = slice.reduce((sum, step) => sum + step.promptTokens, 0)
  const hit = slice.reduce((sum, step) => sum + step.cacheHitTokens, 0)
  return prompt > 0 ? (hit / prompt) * 100 : 0
}

describe('长任务：前缀必须逐字节只增不改', () => {
  const system = 'SYSTEM PROMPT (stable)'
  const tools = [{ type: 'function', function: { name: 'read_session_messages' } }]

  /** 跑一次模拟循环，返回每一步的前缀变化类型。 */
  function runSteps(steps: number): string[] {
    const request: Array<Record<string, unknown>> = [{ role: 'system', content: system }]
    let previous: PrefixFrame | undefined
    const kinds: string[] = []
    for (let i = 0; i < steps; i += 1) {
      request.push({ role: 'assistant', content: `analysis ${i}`, tool_calls: [{ id: `c${i}` }] })
      request.push({ role: 'tool', tool_call_id: `c${i}`, content: `result ${i}` })
      const frame = buildPrefixFrame(system, tools, request)
      kinds.push(comparePrefixFrames(previous, frame).change)
      previous = frame
    }
    return kinds
  }

  it('200 步里除第一步外全部是 append', () => {
    const kinds = runSteps(200)
    expect(kinds[0]).toBe('first')
    expect(kinds.slice(1).every((kind) => kind === 'append')).toBe(true)
  })

  it('同一 session 的 system/tools 在整个循环里从未变化', () => {
    const kinds = runSteps(200)
    expect(kinds.filter((kind) => kind === 'system')).toHaveLength(0)
    expect(kinds.filter((kind) => kind === 'tools')).toHaveLength(0)
    expect(kinds.filter((kind) => kind === 'head-rewrite')).toHaveLength(0)
  })

  it('一次压缩只产生一次 head-rewrite，之后立刻回到 append', () => {
    const request: Array<Record<string, unknown>> = [{ role: 'system', content: system }]
    let previous: PrefixFrame | undefined
    const kinds: string[] = []
    const step = () => {
      request.push({ role: 'assistant', content: 'a' })
      request.push({ role: 'tool', tool_call_id: 'x', content: 'r' })
      const frame = buildPrefixFrame(system, tools, request)
      kinds.push(comparePrefixFrames(previous, frame).change)
      previous = frame
    }
    for (let i = 0; i < 30; i += 1) step()
    // 压缩：丢弃前 20 条，摘要插在 system 之后（就是新的前缀头）
    const compacted = [
      { role: 'system', content: system },
      { role: 'system', content: 'SUMMARY' },
      ...request.slice(20),
    ] satisfies Array<Record<string, unknown>>
    request.length = 0
    request.push(...compacted)
    step()
    for (let i = 0; i < 30; i += 1) step()

    expect(kinds.filter((kind) => kind === 'head-rewrite')).toHaveLength(1)
    expect(kinds[kinds.length - 1]).toBe('append')
  })
})

describe('长任务：命中率投影', () => {
  it('200 步的聚合命中率投影 > 99%', () => {
    const rate = aggregateHitRate(simulateRun(200))
    expect(rate).toBeGreaterThan(99)
  })

  it('稳态（尾部 5 步）命中率投影 > 99%', () => {
    expect(steadyStateHitRate(simulateRun(200))).toBeGreaterThan(99)
  })

  it('任务越长命中率越高 —— 这是"每步只追加"的直接结果', () => {
    const short = aggregateHitRate(simulateRun(20))
    const long = aggregateHitRate(simulateRun(400))
    expect(long).toBeGreaterThan(short)
  })

  it('回归护栏：如果每轮都改写前缀（旧实现的行为），命中率会显著塌陷', () => {
    // 旧实现按「消息条数 > 40」触发压缩，且每次把摘要**追加**到已有摘要上，
    // 于是前缀头部每轮都在变。这里用"每 20 步改写一次"近似它。
    const broken = aggregateHitRate(simulateRun(200, { breakPrefixEvery: 20 }))
    const healthy = aggregateHitRate(simulateRun(200))
    expect(broken).toBeLessThan(95)
    expect(healthy).toBeGreaterThan(99)
    expect(healthy - broken).toBeGreaterThan(4)
  })

  it('old behaviour would have shown up as the ~95% the UI reported', () => {
    // 这一条不是断言"当时就是这个数"，而是把当时的量级关系固定下来：
    // 每轮改写前缀必然落在 95% 附近，这正是 issue 里看到的现象。
    const broken = aggregateHitRate(simulateRun(200, { breakPrefixEvery: 25 }))
    expect(broken).toBeGreaterThan(85)
    expect(broken).toBeLessThan(99)
  })
})

describe('长任务：压缩触发频率', () => {
  it('按窗口比例触发时，一次长任务只压缩很少次', () => {
    // 128k 窗口、0.8 触发、0.16 保留：一次压缩可回收约 64% 的窗口，
    // 因此 200 步内压缩次数应当是个位数。
    const windowTokens = 128_000
    const maxChars = Math.floor(windowTokens * 0.8 * 2.5)
    const retainChars = Math.floor(windowTokens * 0.16 * 2.5)

    const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = []
    let compactions = 0
    for (let step = 0; step < 200; step += 1) {
      if (step % 5 === 0) messages.push({ role: 'user', content: 'q'.repeat(400) })
      messages.push({ role: 'assistant', content: 'a'.repeat(1500) })
      messages.push({ role: 'tool', content: 't'.repeat(2000) })
      const result = compressOverflow(messages, { maxChars, retainChars })
      if (result.digest) {
        compactions += 1
        messages.length = 0
        messages.push(...result.kept)
      }
    }
    expect(compactions).toBeGreaterThan(0)
    expect(compactions).toBeLessThan(20)
  })

  it('摘要只有一份且体积有界，不会随压缩次数线性增长', () => {
    let digest = ''
    for (let i = 0; i < 50; i += 1) {
      digest = mergeDigest(digest, `[工具 read_session_messages] 第 ${i} 批结果 ${'x'.repeat(600)}`)
    }
    expect(digest.length).toBeLessThanOrEqual(8_064)
  })
})
