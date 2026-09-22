/**
 * 归并阶段的**规划**（v1.0.1）—— 纯函数，可单测。
 *
 * ## 为什么把它单独抽出来
 *
 * 归并是一个"把 N 段摘要压成 1 份"的循环，写起来很像 `while (材料太大) 再压一层`。
 * 第一版就是这么写的，结果是**不收敛**：
 *
 * ```
 * while (总字符 > 预算) {
 *   按预算分组 → 每组调一次模型 → 结果作为下一层
 * }
 * ```
 *
 * 当材料只剩两段、而每段本身就超过预算时，分组会把它们放进**各自的组**，
 * 于是每次调用只是"把一段摘要原样重写一遍"—— 模型不会把 8000 字压成 2000 字，
 * 除非你要求它。材料大小几乎不变，循环永远出不去。实测跑到第 7 层（十几分钟、
 * 十几次调用）还在继续，而且每次都在花钱。
 *
 * 修法的关键不是"再多跑一层"，而是**保证每一次归并都真的在归并**：
 * 每组的成员数必须 ≥ 2；只剩两段时直接进最终归并（哪怕这一次的 prompt 超预算，
 * 那也比无限循环便宜）。再加一层轮数上限作为兜底。
 *
 * 抽成纯函数就是为了能直接断言"它一定收敛"—— 这种东西在 Electron 服务里
 * 根本没法单测。
 */

/** 单次归并调用能吃下的字符总量 */
export const DEFAULT_REDUCE_BUDGET = 80_000

/**
 * 层数上限。
 *
 * 理论上 2 层就够了（N 段 → 若干组 → 1 份）。留 3 层是给"某几段特别长"的情况
 * 一点余量，同时保证再坏的情况也不会无限跑。
 */
export const MAX_REDUCE_ROUNDS = 3

/** 每组至少几段才值得单独调一次模型 —— 1 段就是"原样重写"，纯浪费 */
const MIN_ITEMS_PER_GROUP = 2

export type ReduceStep =
  | { kind: 'reduce'; groups: string[][] }
  | { kind: 'final' }

/**
 * 规划下一步。
 *
 * 返回 `final` 表示"直接把当前这一层交给最终归并"，不再分层。
 *
 * 三条终止条件（缺一不可）：
 * 1. 只剩 ≤ 2 段 —— 再分层就是"每段自己重写自己"；
 * 2. 总量已经装得下一次调用；
 * 3. 轮数用完。
 */
export function planReduceStep(
  level: readonly string[],
  budget = DEFAULT_REDUCE_BUDGET,
  round = 0,
  maxRounds = MAX_REDUCE_ROUNDS
): ReduceStep {
  if (level.length <= 2) return { kind: 'final' }
  if (round >= maxRounds) return { kind: 'final' }
  const total = level.reduce((sum, item) => sum + item.length, 0)
  if (total <= budget) return { kind: 'final' }

  /**
   * 分组：达到预算**且已经有 2 段**才切一组。
   *
   * `current.length >= MIN_ITEMS_PER_GROUP` 这一条是修掉死循环的关键 ——
   * 少了它，一段超长摘要会独占一组，那一组调用等于什么都没压缩。
   */
  const groups: string[][] = []
  let current: string[] = []
  let currentChars = 0
  for (const item of level) {
    if (current.length >= MIN_ITEMS_PER_GROUP && currentChars + item.length > budget) {
      groups.push(current)
      current = []
      currentChars = 0
    }
    current.push(item)
    currentChars += item.length
  }
  if (current.length > 0) groups.push(current)

  // 只分出一组 = 没分层，直接进最终归并
  if (groups.length <= 1) return { kind: 'final' }
  // 兜底：分组没有真的减少段数（理论不可达，但走到这里就是死循环）
  if (groups.length >= level.length) return { kind: 'final' }
  return { kind: 'reduce', groups }
}

/**
 * 把整条归并路径跑一遍（不调用模型），用于断言"一定收敛"。
 *
 * 返回值是每一层的分组；最后一段是 `null` 表示"以最终归并收尾"。
 * 测试里用它检查轮数与终止性 —— 这类循环的 bug 只能在"不花钱地跑一遍"里发现。
 */
export function simulateReducePath(
  items: readonly string[],
  budget = DEFAULT_REDUCE_BUDGET,
  /** 每次归并把一组压成多长 —— 用真实模型的压缩比估计 */
  compressionRatio = 0.5,
  maxRounds = MAX_REDUCE_ROUNDS
): { rounds: string[][][]; converged: boolean } {
  let level = [...items]
  const rounds: string[][][] = []
  for (let round = 0; round < maxRounds + 1; round += 1) {
    const step = planReduceStep(level, budget, round, maxRounds)
    if (step.kind === 'final') return { rounds, converged: true }
    rounds.push(step.groups)
    level = step.groups.map((group) => {
      const chars = group.reduce((sum, item) => sum + item.length, 0)
      // 每段摘要本身有个下限：模型不会把 8000 字压成 100 字
      return 'x'.repeat(Math.max(400, Math.round(chars * compressionRatio)))
    })
  }
  return { rounds, converged: false }
}
