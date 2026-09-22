import { describe, expect, it } from 'vitest'
import { runToolBatch, type ToolBatchOutcome } from './toolSchedule'

/**
 * DSH 式工具调度的回归护栏（对应 `dsh-agent-loop` `src/tool-calls.ts`）：
 *
 * 1. 并行安全的调用在有界并发池里重叠执行；
 * 2. exclusive（改状态）调用单独成顺序屏障；
 * 3. 结果**永远按提交顺序**回填 —— wire 消息数组逐字节确定（前缀缓存前提）；
 * 4. 中止后未启动的调用标记 started:false，而不是静默消失；
 * 5. 单个调用抛异常不拖垮整批。
 */

const names = (list: string[]) => list.map((name) => ({ name }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('runToolBatch', () => {
  it('并行调用真的重叠执行：三个都挂在同一个 gate 上', async () => {
    const gate = deferred()
    let concurrent = 0
    let peak = 0
    const batch = runToolBatch<string>(
      names(['a', 'b', 'c']),
      { maxParallel: 3, isExclusive: () => false },
      async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await gate.promise
        concurrent -= 1
        return 'ok'
      },
    )
    // 批还挂着（gate 没放行）时，三个 execute 必须都已经进入 —— 串行实现到不了这一步。
    await new Promise((r) => setTimeout(r, 10))
    expect(peak).toBe(3)
    gate.resolve()
    const outcomes = await batch
    expect(outcomes.every((o) => o.started && o.result === 'ok')).toBe(true)
  })

  it('并发数受 maxParallel 上限约束', async () => {
    let concurrent = 0
    let peak = 0
    const outcomes = await runToolBatch<number>(
      names(['a', 'b', 'c', 'd', 'e', 'f']),
      { maxParallel: 2, isExclusive: () => false },
      async (index) => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await new Promise((r) => setTimeout(r, 5))
        concurrent -= 1
        return index
      },
    )
    expect(peak).toBeLessThanOrEqual(2)
    expect(outcomes).toHaveLength(6)
    expect(outcomes.map((o) => o.result)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('exclusive 调用是顺序屏障：不与任何并行调用重叠', async () => {
    const events: string[] = []
    let concurrent = 0
    const isExclusive = (name: string) => name === 'write'
    const list = names(['r1', 'r2', 'write', 'r3'])
    const outcomes = await runToolBatch<number>(
      list,
      { maxParallel: 4, isExclusive },
      async (index) => {
        const exclusive = isExclusive(list[index].name)
        if (!exclusive) {
          concurrent += 1
          expect(concurrent).toBeLessThanOrEqual(4)
        }
        events.push(`${exclusive ? 'X' : 'P'}:${index}:start`)
        await new Promise((r) => setTimeout(r, 3))
        events.push(`${exclusive ? 'X' : 'P'}:${index}:end`)
        if (!exclusive) concurrent -= 1
        return index
      },
    )
    // write(index 2) 的 start 必须在 r1/r2 都 end 之后，且 r3 的 start 在 write end 之后。
    const writeStart = events.indexOf('X:2:start')
    expect(writeStart).toBeGreaterThan(events.indexOf('P:0:end'))
    expect(writeStart).toBeGreaterThan(events.indexOf('P:1:end'))
    expect(events.indexOf('P:3:start')).toBeGreaterThan(events.indexOf('X:2:end'))
    expect(outcomes.map((o) => o.result)).toEqual([0, 1, 2, 3])
  })

  it('结果按提交顺序回填，与完成顺序无关', async () => {
    const delays = [30, 5, 15, 1]
    const outcomes = await runToolBatch<number>(
      names(['a', 'b', 'c', 'd']),
      { maxParallel: 4, isExclusive: () => false },
      async (index) => {
        await new Promise((r) => setTimeout(r, delays[index]))
        return index
      },
    )
    expect(outcomes.map((o) => o.result)).toEqual([0, 1, 2, 3])
  })

  it('单个调用抛异常只影响自己，不 reject 整批', async () => {
    const outcomes = await runToolBatch<string>(
      names(['bad', 'good']),
      { maxParallel: 2, isExclusive: () => false },
      async (index) => {
        if (index === 0) throw new Error('boom')
        return 'ok'
      },
    )
    expect(outcomes[0].error).toBeInstanceOf(Error)
    expect((outcomes[0].error as Error).message).toBe('boom')
    expect(outcomes[1].result).toBe('ok')
  })

  it('中止后不再启动新调用，未启动的标记 started:false', async () => {
    let aborted = false
    const started: number[] = []
    const outcomes = await runToolBatch<number>(
      names(['a', 'b', 'c', 'd']),
      { maxParallel: 1, isExclusive: () => false },
      async (index) => {
        started.push(index)
        aborted = true // 第一个调用一启动就把批掐掉
        await new Promise((r) => setTimeout(r, 1))
        return index
      },
      { shouldAbort: () => aborted },
    )
    expect(started).toEqual([0])
    expect(outcomes[0].started).toBe(true)
    expect(outcomes.slice(1).every((o: ToolBatchOutcome<number>) => o.started === false)).toBe(true)
  })

  it('onStart / onSettled 每个调用各触发一次', async () => {
    const starts: number[] = []
    const settles: number[] = []
    await runToolBatch<number>(
      names(['a', 'b', 'c']),
      { maxParallel: 2, isExclusive: (name) => name === 'b' },
      async (index) => index,
      {
        onStart: (index) => starts.push(index),
        onSettled: (index) => settles.push(index),
      },
    )
    expect([...starts].sort((x, y) => x - y)).toEqual([0, 1, 2])
    expect([...settles].sort((x, y) => x - y)).toEqual([0, 1, 2])
  })

  it('空批次立即返回', async () => {
    expect(await runToolBatch([], { maxParallel: 4, isExclusive: () => false }, async () => 'x')).toEqual([])
  })
})
