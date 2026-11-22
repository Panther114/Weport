/**
 * 「说话复盘」的结果类型（v1.3.3）。
 *
 * 单独放在 `src/utils` 而不是 `src/types/weclone.ts`：后者依赖全局的
 * `WeCloneMetaInfo`（由 vite-env 提供），主进程的 tsconfig 看不到它。
 * 这个文件是纯类型 + 纯常量，主进程与渲染层都能安全引用。
 */

export type WeCloneVoiceIssueSeverity = 'info' | 'warn'

export interface WeCloneVoiceIssue {
  id: string
  title: string
  detail: string
  severity: WeCloneVoiceIssueSeverity
  /** 极短证据（命中词 / 截断到几十字的句子），不复制整段聊天 */
  evidence?: string[]
}

export interface WeCloneVoiceMetrics {
  voiceSampleSize: number
  replySampleSize: number
  voiceMedianLength: number
  voiceMeanLength: number
  voiceBurstMean: number
  replyMedianLength: number
  replyMeanLength: number
  replyP90Length: number
  /** 回复中位长度 / 本人单条中位长度 */
  replyToVoiceRatio: number
  assistantToneRate: number
  structureRate: number
  questionRate: number
  voiceEndsWithPunctuation: number
  voiceEmojiRatio: number
}

/**
 * 纯本地统计结果：本人原话 + 分身历史回复。没有模型调用，也不上传任何内容。
 */
export interface WeCloneVoiceReview {
  generatedAt: number
  sampleSize: number
  replySampleSize: number
  summary: string
  issues: WeCloneVoiceIssue[]
  /** 注意什么 —— 可执行的禁区 */
  cautions: string[]
  /** 之后使用什么方式 —— 下一步建议 */
  suggestions: string[]
  metrics: WeCloneVoiceMetrics
}
