/**
 * WeClone 人格克隆 — 渲染进程侧类型（与 src/vite-env.d.ts 的 ElectronApi.weclone
 * 及 electron/services/weCloneService.ts 保持一致）。
 */

/**
 * 生成阶段。
 *
 * `failed` / `aborted` 是**终态**，不来自主进程的进度事件，而是渲染层在
 * `generate()` 失败/取消时自己落下的标记。原来没有终态，失败后 stage 会停在
 * 最后一个中途阶段（例如 `generate`），进度面板于是永远显示「生成人格 MD」在
 * 转圈 —— 一个已经死掉的步骤看起来还在跑。用户报的「导出完成后仍显示准备中」
 * 是同一类缺陷的另一个出口：**结束状态没有显式落地**。
 */
export type WeCloneStage = 'scan' | 'generate' | 'filter' | 'done' | 'failed' | 'aborted'

/** 已结束的阶段：不再有任何步骤处于"进行中" */
export const WECLONE_TERMINAL_STAGES: readonly WeCloneStage[] = ['done', 'failed', 'aborted']

export interface WeCloneProgressInfo {
  stage: WeCloneStage
  /** 总进度 0-100 */
  progress: number
  message: string
}

/** WeCloneMetaInfo 来自 vite-env.d.ts（全局接口） */
export interface WeCloneListItem extends WeCloneMetaInfo {
  /** v1.0 只有本地克隆；保留字段是为了列表分组逻辑不用改 */
  source: 'local'
}

/**
 * 档案预览的五份模型产物，外加两份**算出来的**材料（v1.0.1）：
 * `fingerprint` 是本地统计的说话习惯，`corpus` 是语料处理摘要。
 * 后两项不是模型写的，所以它们可以被用户用来核对"这次生成到底干了什么"。
 */
export type WeCloneMdsPreview = Partial<
  Record<'profile' | 'relationships' | 'knowledge' | 'timeline' | 'language' | 'fingerprint' | 'corpus', string>
>
