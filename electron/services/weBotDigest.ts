import { createHash } from 'node:crypto'

export type DigestTemplate = 'decisions-deadlines' | 'unanswered-questions' | 'weekly-highlights'
export interface DigestLimits { maxMessages: number; maxInputChars: number; maxTotalTokens: number; timeoutMs: number }
export interface DigestCursor { timestamp: number; identities: string[] }
export interface DigestScope { accountId: string; sessionIds: string[]; startTime: number }
export interface DigestConfig { template: DigestTemplate; scope: DigestScope; limits: DigestLimits }
export interface DigestEvidence { id: string; sessionId: string; timestamp: number; text: string; sourceUrl: string }
export interface DigestBatch { evidence: DigestEvidence[]; cursors: Record<string, DigestCursor>; hasMore: boolean }
export interface DigestState { cursors: Record<string, DigestCursor>; lastSuccessAt?: number; commits: string[] }

export const DIGEST_TEMPLATES: Record<DigestTemplate, string> = {
  'decisions-deadlines': '整理新增的决定、截止日期和待确认承诺。承诺是待用户复核的解释，不代表已经确认的事实。',
  'unanswered-questions': '找出新增消息中尚未得到明确答复的问题。不能从缺少上下文推断对方一定没有回答。',
  'weekly-highlights': '整理新增消息中的重要进展、变化和后续事项，不重复已有摘要。',
}
export function digestRelevantEvidence(template: DigestTemplate, text: string): boolean {
  if (!text.trim()) return false
  if (template === 'weekly-highlights') return true
  if (template === 'unanswered-questions') return /[?？]|请问|能否|是否|怎么|如何|为什么|\b(?:question|anyone|could|would|when|where|why|how)\b/i.test(text)
  return /截止|决定|确认|安排|承诺|约定|完成|提交|计划|周[一二三四五六日天]|\d{1,2}[月日号:/-]|今天|明天|下周|\b(?:decision|decided|deadline|due|agree|commit|submit|tomorrow|today|schedule)\b/i.test(text)
}
export function normalizeDigestLimits(input?: Partial<DigestLimits>): DigestLimits {
  const clamp = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback
  return { maxMessages: clamp(input?.maxMessages, 200, 1, 1000), maxInputChars: clamp(input?.maxInputChars, 24000, 1000, 100000),
    maxTotalTokens: clamp(input?.maxTotalTokens, 8000, 256, 32000), timeoutMs: clamp(input?.timeoutMs, 120000, 1000, 300000) }
}
export function digestCommitId(taskId: string, config: DigestConfig, batch: DigestBatch): string {
  return createHash('sha256').update(JSON.stringify({ taskId, scope: config.scope, template: config.template,
    evidence: batch.evidence.map(row => [row.id, row.timestamp, row.text]), cursors: batch.cursors })).digest('hex')
}
export function normalizeDigest(input: DigestConfig, accountId: string, sessionIds: string[]): DigestConfig {
  if (!accountId) throw new Error('请先连接账号，再创建增量摘要任务。')
  const sessions = [...new Set(sessionIds.map(String).filter(Boolean))].sort()
  if (!sessions.length) throw new Error('增量摘要至少需要一个明确选择的会话。')
  if (!Object.hasOwn(DIGEST_TEMPLATES, input.template)) throw new Error('未知的摘要模板。')
  return { template: input.template, scope: { accountId, sessionIds: sessions, startTime: Math.max(0, Number(input.scope?.startTime) || 0) }, limits: normalizeDigestLimits(input.limits) }
}
