/**
 * 分片提炼失败的取舍策略（纯函数，可单测）。
 *
 * ## 它挡的是哪一个真实事故
 *
 * opencode-go 额度耗尽时，网关返回 `[insufficient_user_quota] You're out of credits`。
 * `isProviderUnavailable()` 正确地**不重试**这类错误（重试没有意义），但 map 阶段是
 * **按片 catch** 的：每片失败都会用"本地统计兜底摘要"顶上，而兜底摘要**非空** ——
 * 于是 `mapResult.digests.length > 0` 成立，管线继续往下走，用一堆空壳写成五份档案，
 * 最后**原子换名把原本好好的克隆覆盖掉**。界面上显示的是"生成完成"。
 *
 * 也就是说：额度用完时，产品不会报错，而是**静默毁掉用户已有的克隆**。
 *
 * ## 判据
 *
 * 1. **硬失败**（额度/计费/鉴权/配额）→ 立刻中止。这类错误重试与降级都没有意义，
 *    继续跑只会烧钱并产出一份看着像样、其实是空壳的档案。
 * 2. **失败片过半** → 中止。剩下的内容已经不足以代表这个人，硬写出来比失败更糟：
 *    用户拿到的会是一份"部分失忆"的克隆，而他无从察觉。
 * 3. 其余情况：少量失败照旧降级继续（历史教训：静默丢一片等于删掉那段历史，
 *    所以少量失败必须保留兜底摘要，并且计数写进 metadata）。
 */

/** 硬失败的错误特征（额度/计费/鉴权） */
const HARD_FAILURE_RE =
  /insufficient|out of credits|quota|billing|payment|credit|unauthor|invalid api key|authentication|401|403|余额|欠费/i

export interface ShardFailureInput {
  /** 计划的分片总数 */
  shardCount: number
  /** 实际失败的片数 */
  failures: number
  /** 第一个"硬失败"的原文（没有则为 null/undefined） */
  hardError?: string | null
}

export interface ShardFailureDecision {
  abort: boolean
  /** 中止时给用户看的一句话（必须能指向下一步） */
  reason?: string
}

export function decideShardAbort(input: ShardFailureInput): ShardFailureDecision {
  const shardCount = Math.max(0, Math.floor(input.shardCount || 0))
  const failures = Math.max(0, Math.floor(input.failures || 0))
  const hard = String(input.hardError || '').trim()

  if (hard && HARD_FAILURE_RE.test(hard)) {
    return {
      abort: true,
      reason:
        'AI 服务拒绝服务（额度/计费/鉴权），已中止生成以免用空壳档案覆盖现有克隆。' +
        `服务方原文：${hard.slice(0, 160)}`,
    }
  }
  if (shardCount > 0 && failures >= Math.ceil(shardCount / 2)) {
    return {
      abort: true,
      reason:
        `分片提炼有 ${failures}/${shardCount} 片失败（超过一半），继续生成只会得到一份` +
        '内容残缺却看不出残缺的克隆，已中止；请检查 AI 服务后重试。',
    }
  }
  return { abort: false }
}
