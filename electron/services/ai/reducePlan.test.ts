import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REDUCE_BUDGET,
  MAX_REDUCE_ROUNDS,
  planReduceStep,
  simulateReducePath,
} from './reducePlan'

/**
 * 归并规划（v1.0.1）。
 *
 * 这个文件守的是一次**真实事故**：第一版 `reduceDigests` 是
 * `while (总字符 > 预算) 再压一层`，而分组允许"一段超长摘要独占一组" ——
 * 那一组的模型调用只是把同一段摘要原样重写一遍，材料大小不变，
 * 循环永远出不去。实测跑到第 7 层还在继续（十几分钟、十几次调用、都在花钱），
 * 最后只能人工掐掉。
 *
 * 所以这里的断言只有一件核心事：**一定收敛**。
 */

const big = (chars: number) => 'x'.repeat(chars)

describe('终止条件', () => {
  it('只剩两段时直接进最终归并（再分层就是每段自己重写自己）', () => {
    expect(planReduceStep([big(90_000), big(90_000)]).kind).toBe('final')
  })

  it('只剩一段时进最终归并', () => {
    expect(planReduceStep([big(200_000)]).kind).toBe('final')
  })

  it('总量已经装得下一次调用时进最终归并', () => {
    expect(planReduceStep([big(1000), big(1000), big(1000)]).kind).toBe('final')
  })

  it('轮数用完时进最终归并（兜底，防止任何未预料的循环）', () => {
    const level = Array.from({ length: 20 }, () => big(50_000))
    expect(planReduceStep(level, DEFAULT_REDUCE_BUDGET, MAX_REDUCE_ROUNDS).kind).toBe('final')
  })
})

describe('分组永远不是"一组一段"', () => {
  it('每段都超过预算时，仍然两两成组（这就是修掉死循环的那一条）', () => {
    const level = Array.from({ length: 6 }, () => big(120_000))
    const step = planReduceStep(level, DEFAULT_REDUCE_BUDGET, 0)
    expect(step.kind).toBe('reduce')
    if (step.kind !== 'reduce') return
    expect(step.groups).toHaveLength(3)
    for (const group of step.groups) {
      expect(group.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('正常长度下按预算分组', () => {
    const level = Array.from({ length: 12 }, () => big(20_000))
    const step = planReduceStep(level, DEFAULT_REDUCE_BUDGET, 0)
    expect(step.kind).toBe('reduce')
    if (step.kind !== 'reduce') return
    // 20k × 4 = 80k ≈ 预算，所以大约每 4 段一组
    expect(step.groups.length).toBeGreaterThan(1)
    expect(step.groups.length).toBeLessThan(12)
    for (const group of step.groups) expect(group.length).toBeGreaterThanOrEqual(2)
  })

  it('分组后段数必须真的变少，否则直接进最终归并', () => {
    // 3 段、每段都超大 → 两两成组会得到 2 组（[a,b] 与 [c]）—— 组数 2 < 段数 3，允许
    const step = planReduceStep([big(120_000), big(120_000), big(120_000)], DEFAULT_REDUCE_BUDGET, 0)
    expect(step.kind).toBe('reduce')
    if (step.kind !== 'reduce') return
    expect(step.groups.length).toBeLessThan(3)
  })
})

describe('一定收敛（用模拟路径断言，不花模型调用）', () => {
  const cases: Array<{ name: string; items: string[] }> = [
    { name: '真实规模：37 段 × 4000 字', items: Array.from({ length: 37 }, () => big(4000)) },
    { name: '极端：37 段 × 8000 字（摘要上限）', items: Array.from({ length: 37 }, () => big(8000)) },
    { name: '病态：6 段 × 120k 字（单段超预算）', items: Array.from({ length: 6 }, () => big(120_000)) },
    { name: '两段超长', items: [big(90_000), big(90_000)] },
    { name: '单段超长', items: [big(300_000)] },
    { name: '小语料：4 段 × 1000 字', items: Array.from({ length: 4 }, () => big(1000)) },
    { name: '空', items: [] },
  ]

  for (const { name, items } of cases) {
    it(`${name} → 在 ${MAX_REDUCE_ROUNDS} 层内收敛`, () => {
      const result = simulateReducePath(items)
      expect(result.converged, `${name} 没有收敛`).toBe(true)
      expect(result.rounds.length).toBeLessThanOrEqual(MAX_REDUCE_ROUNDS)
    })
  }

  it('压缩比很差时也收敛（模型只肯压掉 10%）', () => {
    const items = Array.from({ length: 37 }, () => big(8000))
    expect(simulateReducePath(items, DEFAULT_REDUCE_BUDGET, 0.9).converged).toBe(true)
  })

  it('真实规模下只需要 1-2 层（层数多了纯属浪费钱）', () => {
    const items = Array.from({ length: 37 }, () => big(4000))
    expect(simulateReducePath(items).rounds.length).toBeLessThanOrEqual(2)
  })
})
