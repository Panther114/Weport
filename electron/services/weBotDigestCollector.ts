import { createHash } from 'node:crypto'
import type { WeBotTask } from './weBotService'
import type { DigestBatch, DigestCursor } from './weBotDigest'
import { exactLocalIdToken } from './export/sourceMessageIdentity'

interface Row { createTime: number; parsedContent?: string; rawContent?: string; localIdRaw?: string; localId?: number; _db_path?: string; _table_name?: string }
interface Dependencies {
  currentAccountId(): string
  getMessages(sessionId: string, offset: number, limit: number, start: number, end: number, ascending: boolean): Promise<{ success: boolean; messages?: Row[]; hasMore?: boolean; nextOffset?: number; error?: string }>
  now?: () => number
  registerEvidence(accountId: string, sessionId: string, row: Row): string
}

/** Collect only the task's frozen account/session/time scope. No model chooses reads. */
export async function collectDigestBatch(task: WeBotTask, signal: AbortSignal, deps: Dependencies): Promise<DigestBatch> {
  const config = task.digest
  if (!config) throw new Error('任务未配置增量摘要。')
  const assertCurrent = () => {
    if (signal.aborted) throw new Error('已中止')
    if (deps.currentAccountId() !== config.scope.accountId) throw new Error('摘要绑定的账号与当前账号不一致。')
  }
  const cursors: Record<string, DigestCursor> = JSON.parse(JSON.stringify(task.digestState?.cursors || {}))
  const evidence: DigestBatch['evidence'] = []
  let chars = 0, inspected = 0, hasMore = false
  const end = Math.floor((deps.now?.() ?? Date.now()) / 1000)
  for (const sessionId of config.scope.sessionIds) {
    let cursor = cursors[sessionId] || { timestamp: config.scope.startTime, identities: [] }
    const original = { timestamp: cursor.timestamp, identities: [...cursor.identities] }
    let offset = 0
    for (let page = 0; page < 100; page++) {
      assertCurrent()
      if (inspected >= config.limits.maxMessages || chars >= config.limits.maxInputChars) { hasMore = true; break }
      const result = await deps.getMessages(sessionId, offset, Math.min(100, config.limits.maxMessages + original.identities.length + 1), original.timestamp * 1000, end * 1000, true)
      assertCurrent()
      if (!result.success) throw new Error(result.error || '摘要证据读取失败。')
      for (const row of result.messages || []) {
        if (!Number.isFinite(row.createTime) || row.createTime > end) throw new Error('摘要证据超出已请求的时间范围。')
        const db = String(row._db_path || '').replaceAll('\\', '/'), table = String(row._table_name || ''), localId = exactLocalIdToken(row.localIdRaw ?? row.localId)
        if (!db || !table || !localId || localId === '0') throw new Error('摘要证据缺少精确来源身份。')
        const id = createHash('sha256').update(JSON.stringify([config.scope.accountId, sessionId, db, table, localId])).digest('hex')
        if (row.createTime < original.timestamp || (row.createTime === original.timestamp && original.identities.includes(id))) continue
        if (inspected >= config.limits.maxMessages || chars >= config.limits.maxInputChars) { hasMore = true; break }
        inspected++
        const full = String(row.parsedContent || row.rawContent || '')
        if (full.length > config.limits.maxInputChars - chars) {
          if (evidence.length === 0) throw new Error('单条消息超过摘要文本上限，请提高上限后重试；水位未前进。')
          hasMore = true; inspected--; break
        }
        cursor = row.createTime === cursor.timestamp ? { timestamp: row.createTime, identities: [...new Set([...cursor.identities, id])] } : { timestamp: row.createTime, identities: [id] }
        cursors[sessionId] = cursor
        const text = full
        chars += text.length
        const sourceUrl = deps.registerEvidence(config.scope.accountId, sessionId, row)
        if (!/^weport-evidence:[a-f0-9]{64}$/.test(sourceUrl)) throw new Error('摘要来源引用未注册。')
        evidence.push({ id, sessionId, timestamp: row.createTime, text, sourceUrl })
      }
      if (hasMore || !result.hasMore) break
      const next = result.nextOffset ?? offset + (result.messages || []).length
      if (next <= offset) throw new Error('摘要证据游标没有前进。')
      offset = next
      if (page === 99) throw new Error('摘要证据分页超出限制。')
    }
  }
  assertCurrent()
  return { evidence, cursors, hasMore }
}
