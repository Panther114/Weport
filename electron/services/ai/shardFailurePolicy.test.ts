import { describe, expect, it } from 'vitest'
import { decideShardAbort } from './shardFailurePolicy'

describe('decideShardAbort —— 硬失败必须中止，而不是覆盖掉好克隆', () => {
  it('额度/计费错误：立刻中止（哪怕只失败了一片）', () => {
    // 这是真实事故的原文：opencode-go 额度耗尽时网关返回它
    const credits =
      "Error from provider (Console Go): Upstream request failed: [insufficient_user_quota] You're out of credits — this request needs $0.06."
    const d = decideShardAbort({ shardCount: 38, failures: 1, hardError: credits })
    expect(d.abort).toBe(true)
    expect(d.reason).toContain('额度')
  })

  it('鉴权类错误同样中止', () => {
    for (const msg of ['401 Unauthorized', 'Invalid API key', 'insufficient balance', '余额不足']) {
      expect(decideShardAbort({ shardCount: 38, failures: 0, hardError: msg }).abort, msg).toBe(true)
    }
  })

  it('失败片过半：中止（残缺的档案比失败更糟）', () => {
    expect(decideShardAbort({ shardCount: 38, failures: 19 }).abort).toBe(true)
    expect(decideShardAbort({ shardCount: 38, failures: 20 }).abort).toBe(true)
    expect(decideShardAbort({ shardCount: 4, failures: 2 }).abort).toBe(true)
  })

  it('少量失败：照旧降级继续（静默丢片是另一条教训）', () => {
    expect(decideShardAbort({ shardCount: 38, failures: 1 }).abort).toBe(false)
    expect(decideShardAbort({ shardCount: 38, failures: 18 }).abort).toBe(false)
    expect(decideShardAbort({ shardCount: 38, failures: 0 }).abort).toBe(false)
  })

  it('普通网络抖动的原文不该被当成硬失败', () => {
    for (const msg of ['fetch failed', 'socket hang up', 'ETIMEDOUT', '空回复（finish_reason=none）']) {
      expect(decideShardAbort({ shardCount: 38, failures: 2, hardError: msg }).abort, msg).toBe(false)
    }
  })

  it('边界：0 片、负数、缺字段都不炸', () => {
    expect(decideShardAbort({ shardCount: 0, failures: 0 }).abort).toBe(false)
    expect(decideShardAbort({ shardCount: -5, failures: -1 }).abort).toBe(false)
    expect(decideShardAbort({ shardCount: 38, failures: 38, hardError: null }).abort).toBe(true)
  })

  it('中止原因必须指向下一步（用户看到的那句话）', () => {
    const d = decideShardAbort({ shardCount: 10, failures: 6 })
    expect(d.abort).toBe(true)
    expect(String(d.reason)).toMatch(/检查 AI 服务|重试/)
  })
})
