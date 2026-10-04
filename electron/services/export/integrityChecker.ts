/**
 * 导出正确性自检（v1.2 §10.2 ②）。
 *
 * 静默错数据比崩溃更糟：导出的目录看起来是完整的，只有"行数对不上 / 媒体少了 /
 * 归属错了 / 同一条导了两遍"这些比对才能把它揭出来。本模块就是那组比对，
 * 产物是**导出根目录**下的 `integrity-report.json`（原子写）与 `missing-media.csv`。
 *
 * ## 五项检查
 *
 * 1. **总数交叉核对**：产物里实际写出的行数 vs 数据库侧的独立计数。
 *    `expected` 取 `getMessageTableStats` 给出的每张 `Msg_*` 分片表计数之和；
 *    另外两路旁证（`getSessionMessageCounts` 的会话计数、session 表自带计数器）
 *    同时进报告 —— 三路互相不符本身就是"库/统计口径有问题"的信号。
 * 2. **分片 `real_sender_id` 归属**：抽样重扫本会话的消息行，用**该行自己所在库**
 *    的 `Name2Id` 表解析 `real_sender_id`（跨库解析正是"归属会反"的根因），
 *    报出无法解析的 id 与解析到**别的会话**的 id，并按分片表给出
 *    行数/命中数/跳过数。
 * 3. **媒体覆盖**：媒体类消息 vs 导出目录里真实存在的文件；明确区分
 *    「本次没请求」（没开媒体导出 / 该类型开关是关的）与「请求了但没产出」。
 * 4. **重复**：同一 server id、或同一 `(会话, 时间, 本地 id)` 出现多次。
 * 5. **产物完整性**：账本记录的 `(bytes, sha256)` vs 磁盘上的文件。
 *    文件被截断/被改 → 命中；这是"续跑跳过的产物其实是坏的"的兜底。
 *
 * ## 故意做成"可独立失败"
 *
 * 自检本身出错（数据库读不到、产物读不了）**不允许**让导出失败：它只写一份
 * `ok:false` 的报告并把原因写进 `notes`。反之，任何一项检查没跑成，`ok` 也不会是
 * true —— "没检查" 不等于 "检查通过"。
 *
 * ## 诚实的边界（都写进 notes，不假装做到）
 *
 * - 归属/媒体/重复三项基于**有界抽样**（默认每会话 5000 行，见 `sampleLimit`）。
 *   抽样会置 `sampled: true`；`rowsSkipped`（分片表里没归到本会话的行）只在
 *   全量覆盖时才是硬数字，抽样时给 `null` 而不编一个数。
 * - **群聊**成员的归属无法独立复核（自检侧没有权威成员名单），因此群聊只报
 *   「无法解析的 sender id」，不把"解析到另一个联系人"当错误（那是误报）。
 * - 媒体命中靠**文件名线索**（md5 / dat 名 / `voice_<会话>_<localId>_<时间>` /
 *   附件文件名）与产出的媒体文件做包含匹配；匹配不上即"请求了但没产出"，
 *   原因只能给到 `file-missing`（未下载 / 已过期 / 解密失败在自检侧不可区分），
 *   运行级遥测（缺图片密钥、语音数据缺失）另在 notes 里给出条数作为解释。
 * - 大于 `maxHashBytes`（64MB）的产物只比字节数，不算 sha256（避免为了自检再读一遍 GB 级 JSON）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from './atomicWrite'
import { LEDGER_FILE_NAME, verifyArtifact } from './ledger'
import { decodeMessageContent } from './parsers/contentDecoder'
import { sourceMessageIdentityHash } from './sourceMessageIdentity'
import { wcdbService } from '../wcdbService'
import { chatService } from '../chatService'

export const INTEGRITY_REPORT_VERSION = 1
export const INTEGRITY_REPORT_FILE_NAME = 'integrity-report.json'
export const MISSING_MEDIA_CSV_FILE_NAME = 'missing-media.csv'
/** 报告里重复示例的条数上限。 */
export const DUPLICATE_EXAMPLE_LIMIT = 20
/** `missing-media.csv` 的数据行上限（超过就截断并写一行诚实的说明）。 */
export const MISSING_MEDIA_ROW_LIMIT = 500
/** 无法解析的 sender id 列表上限。 */
export const UNRESOLVED_ID_LIMIT = 20
/** 解析不到的行的样例条数上限（用来判断"系统消息"还是"真丢归属"）。 */
export const UNRESOLVED_SAMPLE_LIMIT = 5
/** 每会话抽样行数上限。 */
export const DEFAULT_SAMPLE_LIMIT = 5000
/** 媒体文件索引上限（防超大导出目录把自检拖死）。 */
export const MEDIA_INDEX_LIMIT = 200000
/** 超过这个字节数就不算 sha256（只比字节数）。 */
export const MAX_HASH_BYTES = 64 * 1024 * 1024
/** 产物超过这个字节数就不解析行数（回退到运行计数器）。 */
export const MAX_PARSE_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

export type MediaKind = 'image' | 'voice' | 'video' | 'emoji' | 'file'

export interface MediaRequestFlags {
  /** 本次是否开启了媒体导出（任意类型）。 */
  enabled: boolean
  images: boolean
  voices: boolean
  videos: boolean
  emojis: boolean
  files: boolean
}

/** 一条消息行的自检视图（只保留检查用得上的字段）。 */
export interface IntegrityMessageRow {
  sessionId: string
  localId: number
  /** Exact local ID token, retained when WCDB returns an int64 string. */
  localIdRaw?: string
  /** Native JSON was already rounded to an unsafe Number; its source identity cannot be trusted. */
  localIdPrecisionLost?: boolean
  createTime: number
  localType: number
  isSend: boolean
  serverId?: string
  serverIdRaw?: string
  realSenderId?: number
  dbPath?: string
  tableName?: string
  /** 行里已经带出来的 sender（群聊常见），有它就不必查 Name2Id。 */
  senderUsername?: string
  /** 解析后的归属（由 runIntegrityCheck 填充）。 */
  resolvedUsername?: string | null
  content?: string
  /** 原始行字段名（同一批行的并集进报告，schema 漂移时一眼能看出来）。 */
  rawFields?: string[]
}

export interface IntegrityTableStat {
  dbName: string
  dbPath: string
  tableName: string
  count: number
}

/** 账本里记录的产物指纹（用于检查 5）。 */
export interface ArtifactFingerprint {
  path: string
  bytes?: number
  sha256?: string
}

export interface IntegritySessionInput {
  sessionId: string
  displayName?: string
  /** 本次运行写出的产物路径。 */
  artifactPath?: string
  /** 产物格式（决定行数怎么数）。 */
  format?: string
  /** 格式器自报的最后一条 `exportedMessages`（产物不可解析时的兜底）。 */
  runExportedMessages?: number
  /** per-session 布局下该会话的目录（限定媒体搜索范围）。 */
  sessionDir?: string
  /** 有时间范围 / 发送人筛选 → 产物只可能是全量计数的子集，只做上界校验。 */
  scoped: boolean
  mediaRequested: MediaRequestFlags
  artifactFingerprints?: ArtifactFingerprint[]
  /** 运行级遥测：缺图片密钥的图片数、语音拿不到数据的条数（解释用）。 */
  imageKeyMissingFiles?: number
  voiceFailedFiles?: number
}

/** 运行级媒体遥测（整次导出一个数，不分会话）。 */
export interface IntegrityMediaTelemetry {
  doneFiles?: number
  imageKeyMissingFiles?: number
  voiceFailedFiles?: number
}

export interface IntegrityCheckInput {
  wxid: string
  outputRoot: string
  sessions: IntegritySessionInput[]
  ledgerEntries: number
  /** 覆盖扫描（默认自己扫导出根目录）。 */
  mediaFileIndex?: string[]
  sampleLimit?: number
  db?: IntegrityDbAccess
  now?: number
  /** 外部补充的说明（如"未请求媒体导出"）。 */
  notes?: string[]
  /** 运行级媒体遥测（导出跑完时由 orchestrator 给出；重跑自检时为 undefined）。 */
  mediaTelemetry?: IntegrityMediaTelemetry
}

export interface MissingMediaRow {
  sessionId: string
  messageLocalId: number
  type: string
  reason: string
}

export interface DuplicateExample {
  sessionId: string
  kind: 'server-id' | 'message-key'
  classification: 'cursor-repeat' | 'source-id-collision' | 'unknown-source-identity'
  payloadClass?: 'identical' | 'conflicting' | 'unknown'
  key: string
  count: number
  localId: number
  createTime: number
}

export interface TotalsVerdict {
  status: 'equal' | 'short' | 'long' | 'scoped-ok' | 'unknown'
  missing: number
  extra: number
  /** 是否算作缺陷（`ok` 会因此为 false）。 */
  gap: boolean
  reason?: string
}

export interface GapEntry {
  kind:
    | 'totals'
    /** 产物行数无法确定（文件读不出来/格式不可解析）—— 不是"数不符"，但同样使 ok=false。 */
    | 'totals-unknown'
    | 'artifact-integrity'
    | 'artifact-rows'
    | 'attribution'
    | 'media'
    | 'duplicates'
    | 'identity'
    | 'db'
  detail: string
  expected?: number
  written?: number
}

export interface AttributionTableReport {
  dbName: string
  tableName: string
  rowsSeen: number
  rowsAttributed: number
  /** 分片表里没有归到本会话的行数；抽样时给 `null`（编一个数就是假精度）。 */
  rowsSkipped: number | null
  /** 抽到的样本里**归属校验没过**的行数（解析不到 / 归到了别的会话）。 */
  rowsUnattributed: number
}

export interface AttributionReport {
  tables: AttributionTableReport[]
  rowsSeen: number
  rowsAttributed: number
  rowsSkipped: number | null
  rowsUnattributed: number
  unresolvedSenderIds: number[]
  /**
   * 只出现在**系统消息**上的 sender id（实测：微信给系统消息的 `real_sender_id` 是
   * 一个 `Name2Id` 里没有名字的固定 id，例如 2）。报告出来，但不算归属缺陷 ——
   * 把它算成缺口会让每个正常库都误报。
   */
  systemSenderIds: number[]
  /** 解析不到的行长什么样（最多 5 条）：判断"这是系统消息还是真丢归属"要靠它。 */
  unresolvedSamples: Array<{ senderId: number; localId: number; localType: number; system: boolean; contentHead: string }>
  foreignSenders: Array<{ senderId: number; username: string; dbPath: string }>
  /** 从"自己发的"行里推出来的本账号 sender id（按库）。 */
  selfSenderIds: Array<{ dbName: string; senderIds: number[] }>
  sampled: boolean
  /** false = 行里没带表名且同库有多张分片表，归属只能到"库"这一级。 */
  perTableResolved: boolean
  ok: boolean
}

export interface MediaCoverage {
  requested: number
  produced: number
  notRequested: number
  missing: MissingMediaRow[]
}

export interface DuplicateReport {
  /** Unique row sets found by either identity. Kept for backwards-compatible details. */
  groups: number
  extraRows: number
  examples: DuplicateExample[]
  /** Rows without a complete exact DB/table/local_id identity cannot be checked safely. */
  unscopedRows: number
  cursorDuplicateGroups: number
  cursorDuplicateExtraRows: number
  sourceIdCollisionGroups: number
  sourceIdCollisionExtraRows: number
  identicalSourceIdPayloadGroups: number
  conflictingSourceIdPayloadGroups: number
  unknownSourceIdPayloadGroups: number
  unknownSourceIdIdentityGroups: number
  unknownSourceIdIdentityRows: number
}

export interface ArtifactIntegrityReport {
  checked: number
  ok: boolean
  failures: Array<{ path: string; reason: string; expectedBytes?: number; actualBytes?: number; hashSkipped?: boolean }>
  hashSkipped: number
}

export interface SourceIdentityAuditReport {
  status: 'not-applicable' | 'legacy-artifact' | 'checked' | 'unavailable'
  expectedRows: number
  artifactRows: number
  matchedRows: number
  missingRows: number
  extraRows: number
  unscopedSourceRows: number
  repeatedIdentityGroups: number
  repeatedIdentityExtraRows: number
  complete: boolean
}

export interface IntegritySessionReport {
  sessionId: string
  displayName?: string
  /** 数据库侧独立计数（分片表计数之和）。 */
  expected: number
  /** 产物里实际写出的行数。 */
  written: number
  gaps: GapEntry[]
  /** Repeated source identities (same DB/table/local_id): this is an export defect. */
  duplicates: number
  /** Reused server IDs across distinct source rows; informational unless identity audit fails. */
  sourceIdCollisions: number
  sourceIdCollisionExtraRows: number
  identicalSourceIdPayloadGroups: number
  conflictingSourceIdPayloadGroups: number
  unknownSourceIdPayloadGroups: number
  unknownSourceIdIdentityGroups: number
  unknownSourceIdIdentityRows: number
  identityAudit: SourceIdentityAuditReport
  mediaRequested: number
  mediaProduced: number
  mediaMissing: number
  // ---- 明细（冗余但可读） ----
  expectedScan?: number
  expectedSessionCounter?: number
  writtenRun?: number
  writtenSource: 'artifact' | 'run-counter' | 'none'
  scoped: boolean
  sampled: boolean
  scannedRows: number
  /** 分片表数（`Msg_*`）。 */
  tableCount: number
  attribution: AttributionReport
  artifact: ArtifactIntegrityReport
  /** 抽样行的原始字段并集（schema 漂移时一眼看得出来，例如少了 `real_sender_id`）。 */
  messageRowFields: string[]
  notes: string[]
}

export interface IntegrityReport {
  v: number
  generatedAt: number
  generatedAtLocal: string
  wxid: string
  outputRoot: string
  ledgerEntries: number
  sessions: IntegritySessionReport[]
  totals: {
    sessions: number
    messages: number
    mismatches: number
    missingMedia: number
    duplicates: number
    sourceIdCollisions: number
    sourceIdCollisionExtraRows: number
    identicalSourceIdPayloadGroups: number
    conflictingSourceIdPayloadGroups: number
    unknownSourceIdPayloadGroups: number
    unknownSourceIdIdentityGroups: number
    unknownSourceIdIdentityRows: number
    identityMissingRows: number
    identityExtraRows: number
  }
  ok: boolean
  notes: string[]
  // ---- 附加信息（UI 用） ----
  durationMs: number
  missingMediaCsv: string | null
  missingMediaTotal: number
  missingMediaTruncatedTo: number | null
  duplicateExamples: DuplicateExample[]
  duplicateExtraRows: number
  sourceIdCollisionExtraRows: number
  dbAccessOk: boolean
  sampled: boolean
  /** 运行级媒体遥测（重跑自检时没有）。 */
  mediaTelemetry?: IntegrityMediaTelemetry
}

// ---------------------------------------------------------------------------
// 数据库访问（注入式：单元测试给假实现，真实运行给 WCDB 适配器）
// ---------------------------------------------------------------------------

export interface IntegrityDbAccess {
  getTableStats(sessionId: string): Promise<{ success: boolean; tables?: IntegrityTableStat[]; error?: string }>
  getSessionMessageCount(sessionId: string): Promise<{ success: boolean; count?: number; error?: string }>
  getSessionCounter(sessionId: string): Promise<{ success: boolean; count?: number; error?: string }>
  scanMessages(sessionId: string, limit: number): Promise<{ success: boolean; rows?: IntegrityMessageRow[]; truncated?: boolean; error?: string }>
  scanMessageIdentityMultiset?(sessionId: string): Promise<{
    success: boolean
    identities?: Record<string, number>
    scannedRows?: number
    unscopedRows?: number
    error?: string
  }>
  resolveSenderUsername(dbPath: string, senderId: number): Promise<string | null>
  listSessionIds(): Promise<string[]>
}

/**
 * 真实运行用的适配器。
 *
 * 全部走**只读**接口（§10.3 的闸门在 wcdbCore 里，任何写语句都会被拒），
 * 关闭游标放在 finally —— 自检不能把游标泄漏给后面的导出。
 */
export function createWcdbIntegrityDbAccess(): IntegrityDbAccess {
  const senderCache = new Map<string, string | null>()
  let knownSessionIds: string[] | null = null

  return {
    async getTableStats(sessionId) {
      const result = await wcdbService.getMessageTableStats(sessionId)
      if (!result.success || !Array.isArray(result.tables)) {
        return { success: false, error: result.error || '读取消息分片表统计失败' }
      }
      const tables: IntegrityTableStat[] = []
      for (const raw of result.tables as Array<Record<string, unknown>>) {
        const dbPath = String(raw?.db_path ?? raw?.dbPath ?? '').trim()
        const count = Number.parseInt(String(raw?.count ?? '0'), 10)
        tables.push({
          dbName: dbPath ? path.basename(dbPath, path.extname(dbPath)) : '',
          dbPath,
          tableName: String(raw?.table_name ?? raw?.tableName ?? '').trim(),
          count: Number.isFinite(count) ? Math.max(0, count) : 0,
        })
      }
      return { success: true, tables }
    },

    async getSessionMessageCount(sessionId) {
      const result = await wcdbService.getSessionMessageCounts([sessionId])
      if (!result.success || !result.counts) {
        return { success: false, error: result.error || '读取会话消息计数失败' }
      }
      const raw = result.counts[sessionId]
      const count = Number(raw)
      return { success: true, count: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0 }
    },

    /** session 表自带的计数器（`messageCountHint`）—— 第三路旁证。 */
    async getSessionCounter(sessionId) {
      const result = await chatService.getSessions()
      if (!result.success || !Array.isArray(result.sessions)) {
        return { success: false, error: result.error || '读取会话列表失败' }
      }
      const hit = result.sessions.find((item) => String(item?.username || '') === sessionId)
      const hint = Number(hit?.messageCountHint)
      if (!Number.isFinite(hint)) return { success: true, count: undefined }
      return { success: true, count: Math.max(0, Math.floor(hint)) }
    },

    async scanMessages(sessionId, limit) {
      const boundedLimit = Math.max(1, Math.floor(limit) || DEFAULT_SAMPLE_LIMIT)
      const batchSize = Math.max(50, Math.min(500, boundedLimit))
      const cursorResult = await wcdbService.openMessageCursor(sessionId, batchSize, false, 0, 0)
      if (!cursorResult.success || !cursorResult.cursor) {
        return { success: false, error: cursorResult.error || '打开消息游标失败' }
      }
      const rows: IntegrityMessageRow[] = []
      let truncated = false
      try {
        while (rows.length < boundedLimit) {
          const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
          if (!batch.success || !Array.isArray(batch.rows)) {
            if (!batch.success) return { success: false, error: batch.error || '读取消息批次失败' }
            break
          }
          for (const raw of batch.rows as Array<Record<string, unknown>>) {
            if (rows.length >= boundedLimit) {
              truncated = true
              break
            }
            const row = coerceMessageRow(String(sessionId), raw)
            if (!row) continue
            // 媒体类消息的正文常常是**压缩过的**（宿主原样给出来，形如 zlib hex）。
            // 不解码就看不出 md5/文件名，媒体覆盖会全判成"缺文件" —— 那是误报。
            // 只对媒体类消息解码：文本消息的正文自检用不上，解码是白花的时间。
            if (MEDIA_CAPABLE_LOCAL_TYPES.has(row.localType)) {
              const decoded = decodeMessageContent(
                raw?.message_content ?? raw?.messageContent,
                raw?.compress_content ?? raw?.compressContent,
              )
              if (decoded) row.content = decoded
            }
            rows.push(row)
          }
          if (!batch.hasMore) break
          if (batch.rows.length === 0) break
        }
      } finally {
        await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => undefined)
      }
      if (rows.length >= boundedLimit) truncated = true
      return { success: true, rows, truncated }
    },

    async scanMessageIdentityMultiset(sessionId) {
      const cursorResult = await wcdbService.openMessageCursor(sessionId, 500, false, 0, 0)
      if (!cursorResult.success || !cursorResult.cursor) {
        return { success: false, error: cursorResult.error || '打开消息游标失败' }
      }
      const identities: Record<string, number> = Object.create(null)
      let scannedRows = 0
      let unscopedRows = 0
      try {
        while (true) {
          const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
          if (!batch.success || !Array.isArray(batch.rows)) {
            return { success: false, error: batch.error || '读取消息批次失败' }
          }
          for (const raw of batch.rows as Array<Record<string, unknown>>) {
            scannedRows += 1
            const localId = raw?.__weport_local_id_text ?? raw?.local_id ?? raw?.localId
            const dbPath = raw?._db_path ?? raw?.db_path ?? raw?.dbPath
            const tableName = raw?._table_name ?? raw?.table_name ?? raw?.tableName
            const identity = sourceMessageIdentityHash({ localId, dbPath, tableName })
            if (!identity) {
              unscopedRows += 1
              continue
            }
            identities[identity] = (identities[identity] || 0) + 1
          }
          if (!batch.hasMore || batch.rows.length === 0) break
        }
        return { success: true, identities, scannedRows, unscopedRows }
      } finally {
        await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => undefined)
      }
    },

    async resolveSenderUsername(dbPath, senderId) {
      const key = `${dbPath}\u001f${senderId}`
      if (senderCache.has(key)) return senderCache.get(key) || null
      const username = await chatService.resolveShardSenderUsername(dbPath, senderId)
      senderCache.set(key, username)
      return username
    },

    async listSessionIds() {
      if (knownSessionIds) return knownSessionIds
      const result = await chatService.getSessions()
      if (!result.success || !Array.isArray(result.sessions)) return []
      knownSessionIds = result.sessions
        .map((item) => String(item?.username || '').trim())
        .filter(Boolean)
      return knownSessionIds
    },
  }
}

// ---------------------------------------------------------------------------
// 纯逻辑：假的数据库实现也能跑，所以这几项必须能独立测试
// ---------------------------------------------------------------------------

/**
 * 归一化数据库行 → 自检视图。缺 local_id/create_time 的行直接丢掉（无法定位）。
 * `isSend` 读 `computed_is_send`（宿主算好的）再退到 `is_send` —— 与 chatService 的
 * 读法一致，否则"自己发的"会被当成收件行，进而把本账号的 sender id 报成"解析不到"。
 */
export function coerceMessageRow(sessionId: string, raw: Record<string, unknown>): IntegrityMessageRow | null {
  const localIdValue = raw?.__weport_local_id_text ?? raw?.local_id ?? raw?.localId
  const localIdRaw = exactUnsignedIdToken(localIdValue)
  const localIdPrecisionLost = isUnsafeIntegerNumber(localIdValue)
  const localId = localIdPrecisionLost ? 0 : toSafeInt(localIdValue, 0)
  const createTime = toSafeInt(raw?.create_time ?? raw?.createTime, 0)
  if (localId <= 0 && createTime <= 0) return null
  const serverIdRaw = String(raw?.server_id_raw ?? raw?.serverIdRaw ?? '').trim()
  const serverId = String(raw?.server_id ?? raw?.serverId ?? '').trim()
  const realSenderId = toSafeInt(raw?.real_sender_id ?? raw?.realSenderId, 0)
  const isSendRaw = raw?.computed_is_send ?? raw?.is_send ?? raw?.isSend
  const content = raw?.message_content ?? raw?.messageContent ?? raw?.content
  return {
    sessionId,
    localId,
    localIdRaw,
    ...(localIdPrecisionLost ? { localIdPrecisionLost: true } : {}),
    createTime,
    localType: toSafeInt(raw?.local_type ?? raw?.localType, 0),
    isSend: Number(isSendRaw) === 1 || isSendRaw === true,
    serverId: serverId || undefined,
    serverIdRaw: serverIdRaw || serverId || undefined,
    realSenderId: realSenderId > 0 ? realSenderId : undefined,
    dbPath: String(raw?._db_path ?? raw?.db_path ?? raw?.dbPath ?? '').trim() || undefined,
    tableName: String(raw?._table_name ?? raw?.table_name ?? raw?.tableName ?? '').trim() || undefined,
    senderUsername: String(raw?.sender_username ?? raw?.senderUsername ?? '').trim() || undefined,
    content: typeof content === 'string' ? content : undefined,
    rawFields: Object.keys(raw || {}).slice(0, 64),
  }
}

export function toSafeInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  const text = String(value ?? '').trim()
  if (!text) return fallback
  const direct = Number.parseInt(text, 10)
  if (Number.isFinite(direct)) return direct
  if (/^\d+$/.test(text)) return fallback
  const parsed = Number(text)
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
}

/** Keep decimal ID tokens exact; JSON number parsing may already have rounded int64 values. */
function exactUnsignedIdToken(value: unknown): string | undefined {
  if (isUnsafeIntegerNumber(value)) return undefined
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return undefined
  return text.replace(/^0+(?=\d)/, '')
}

function isUnsafeIntegerNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
}

/** Normalize signed SQLite int64 and unsigned uint64 spellings to one exact token. */
function canonicalServerIdToken(value: unknown): string | undefined {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return undefined
  const raw = String(value).trim()
  if (!raw || !/^-?\d+$/.test(raw)) return undefined

  let parsed: bigint
  try {
    parsed = BigInt(raw)
  } catch {
    return undefined
  }

  const uint64Limit = 1n << 64n
  if (parsed < 0n) {
    const int64Min = -(1n << 63n)
    if (parsed < int64Min) return undefined
    parsed += uint64Limit
  } else if (parsed >= uint64Limit) {
    return undefined
  }

  // Reuse the exact decimal-token validator so no Number conversion can merge
  // adjacent IDs above JavaScript's safe-integer range.
  return exactUnsignedIdToken(parsed)
}

function normalizeDbPathForIdentity(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const normalized = path.resolve(raw).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 总数判定：`expected` 为数据库独立计数，`written` 为产物实际行数。 */
export function evaluateTotals(expected: number, written: number, scoped = false): TotalsVerdict {
  if (!Number.isFinite(expected) || !Number.isFinite(written) || expected < 0 || written < 0) {
    return { status: 'unknown', missing: 0, extra: 0, gap: true, reason: '计数不可用' }
  }
  const exp = Math.floor(expected)
  const got = Math.floor(written)
  if (exp === got) return { status: 'equal', missing: 0, extra: 0, gap: false }
  if (got > exp) {
    return {
      status: 'long',
      missing: 0,
      extra: got - exp,
      gap: true,
      reason: `产物行数比数据库计数多 ${got - exp} 行（重复导出或计数口径不一致）`,
    }
  }
  const missing = exp - got
  if (scoped) {
    return {
      status: 'scoped-ok',
      missing,
      extra: 0,
      gap: false,
      reason: `分片/带筛选导出：产物 ${got} 行 ≤ 数据库计数 ${exp} 行，属正常`,
    }
  }
  return {
    status: 'short',
    missing,
    extra: 0,
    gap: true,
    reason: `产物比数据库计数少 ${missing} 行`,
  }
}

/** 归属校验：把已解析的行按分片表汇总，并找出解析不到 / 解析到别的会话的 sender。 */
export function evaluateAttribution(params: {
  sessionId: string
  myWxid?: string
  tables: IntegrityTableStat[]
  rows: IntegrityMessageRow[]
  knownSessionIds: Iterable<string>
  sampled: boolean
}): AttributionReport {
  const { sessionId, tables, rows, sampled } = params
  const myWxid = String(params.myWxid || '').trim()
  const known = new Set<string>()
  for (const id of params.knownSessionIds) {
    const normalized = String(id || '').trim()
    if (normalized && normalized !== sessionId) known.add(normalized)
  }
  const isGroup = sessionId.endsWith('@chatroom')

  const byTable = new Map<string, {
    dbName: string
    tableName: string
    rowsSeen: number
    rowsAttributed: number
    rowsUnattributed: number
  }>()
  /** 同一个库里的分片表键（行里没带表名时要靠它落位）。 */
  const keysByDb = new Map<string, string[]>()
  for (const table of tables) {
    const key = attributionTableKey(table.dbPath, table.tableName)
    byTable.set(key, {
      dbName: table.dbName,
      tableName: table.tableName,
      rowsSeen: Math.max(0, Math.floor(table.count || 0)),
      rowsAttributed: 0,
      rowsUnattributed: 0,
    })
    const dbKey = attributionDbKey(table.dbPath)
    const list = keysByDb.get(dbKey)
    if (list) {
      list.push(key)
      continue
    }
    keysByDb.set(dbKey, [key])
  }

  const unresolvedSenderIds = new Set<number>()
  /** 系统消息专用的 sender id（Name2Id 里没名字是正常的）。 */
  const systemSenderIds = new Set<number>()
  const unresolvedSamples: AttributionReport['unresolvedSamples'] = []
  const foreignSenderKeys = new Set<string>()
  const foreignSenders: Array<{ senderId: number; username: string; dbPath: string }> = []
  let attributed = 0
  let unattributed = 0
  // 行里没带表名、而这个库里不止一张分片表 → 只能归到"库"这一级，
  // 按表拆分的 rowsSkipped 就不再是硬数字（诚实降级，不编）。
  let perTableResolved = true

  /**
   * 本账号在每个库里的 sender id。
   *
   * 为什么要它：`Name2Id` 里"自己"那条的 user_name 往往是空的（微信不给本账号存名字），
   * 于是自己发的消息按 id 查名字会返回 null —— 那是**正常的**，不是归属错误。
   * 判据取自数据本身：`isSend` 为真的行，它的 `real_sender_id` 就是本账号在这个库里的 id。
   */
  const selfSenderIds = new Map<string, Set<number>>()
  for (const row of rows) {
    if (!row.isSend) continue
    const senderId = Number(row.realSenderId)
    if (!Number.isFinite(senderId) || senderId <= 0) continue
    const dbKey = attributionDbKey(row.dbPath || '')
    const set = selfSenderIds.get(dbKey)
    if (set) {
      set.add(senderId)
      continue
    }
    selfSenderIds.set(dbKey, new Set([senderId]))
  }

  for (const row of rows) {
    const dbPath = String(row.dbPath || '')
    const statsKeys = keysByDb.get(attributionDbKey(dbPath)) || []
    let key: string
    if (row.tableName) {
      key = attributionTableKey(dbPath, row.tableName)
    } else if (statsKeys.length === 1) {
      key = statsKeys[0]
    } else {
      key = `${attributionDbKey(dbPath)}\u001f`
      if (statsKeys.length > 1) perTableResolved = false
    }
    let bucket = byTable.get(key)
    if (!bucket) {
      // 分片表统计里没有这一张（例如统计接口缺 db_path）：按行里的线索补一张，
      // 否则"命中行数"会凭空少掉，报告看起来像丢数据。
      bucket = {
        dbName: dbPath ? path.basename(dbPath, path.extname(dbPath)) : '',
        tableName: row.tableName || '',
        rowsSeen: 0,
        rowsAttributed: 0,
        rowsUnattributed: 0,
      }
      byTable.set(key, bucket)
    }

    // 归属判定：只把**校验通过**的行计成"归到本会话"。
    // 判定不了的（解析不到 id）与判定为别人的（归到了另一个会话）都记账到
    // rowsUnattributed，并且不进 rowsAttributed —— 校验的意义就在于此。
    let verdict: 'attributed' | 'unresolved' | 'foreign' = 'attributed'
    if (!row.isSend && !String(row.senderUsername || '').trim()) {
      const senderId = Number(row.realSenderId)
      if (Number.isFinite(senderId) && senderId > 0) {
        const resolved = String(row.resolvedUsername || '').trim()
        const isSelfId = selfSenderIds.get(attributionDbKey(row.dbPath || ''))?.has(senderId) === true
        if (!resolved) {
          // 解析不到名字：如果这个 id 在本库里被"我自己发的"行用过，那就是本账号
          // （Name2Id 里自己那条没有名字），归到本会话；否则是真·解析不到 ——
          // 但系统消息（撤回/入群/拍一拍…）本来就挂在一个没有名字的固定 id 上，
          // 那是正常数据，报告出来即可，不算归属缺陷。
          if (!isSelfId) {
            const system = isSystemMessageLocalType(row.localType)
            if (system) {
              systemSenderIds.add(senderId)
            } else {
              verdict = 'unresolved'
              unresolvedSenderIds.add(senderId)
            }
            if (unresolvedSamples.length < UNRESOLVED_SAMPLE_LIMIT) {
              unresolvedSamples.push({
                senderId,
                localId: row.localId,
                localType: row.localType,
                system,
                contentHead: String(row.content || '').slice(0, 80),
              })
            }
          }
        } else if (resolved !== sessionId && !(myWxid && resolved === myWxid) && !isGroup && known.has(resolved)) {
          verdict = 'foreign'
          const foreignKey = `${senderId}\u001f${resolved}`
          if (!foreignSenderKeys.has(foreignKey)) {
            foreignSenderKeys.add(foreignKey)
            foreignSenders.push({ senderId, username: resolved, dbPath: row.dbPath || '' })
          }
        }
      }
    }
    if (verdict === 'attributed') {
      bucket.rowsAttributed += 1
      attributed += 1
    } else {
      bucket.rowsUnattributed += 1
      unattributed += 1
    }
  }

  const tableReports: AttributionTableReport[] = [...byTable.entries()].map(([, value]) => ({
    dbName: value.dbName,
    tableName: value.tableName,
    rowsSeen: value.rowsSeen,
    rowsAttributed: value.rowsAttributed,
    // 只有"没被抽样截断 **且** 能按表落位"时 rowsSeen - rowsAttributed 才是硬数字。
    rowsSkipped: sampled || !perTableResolved
      ? null
      : Math.max(0, value.rowsSeen - value.rowsAttributed - value.rowsUnattributed),
    rowsUnattributed: value.rowsUnattributed,
  }))

  const rowsSeen = tableReports.reduce((sum, table) => sum + table.rowsSeen, 0)
  return {
    tables: tableReports,
    rowsSeen,
    rowsAttributed: attributed,
    rowsSkipped: sampled || !perTableResolved ? null : Math.max(0, rowsSeen - attributed - unattributed),
    rowsUnattributed: unattributed,
    unresolvedSenderIds: [...unresolvedSenderIds].slice(0, UNRESOLVED_ID_LIMIT),
    systemSenderIds: [...systemSenderIds].slice(0, UNRESOLVED_ID_LIMIT),
    unresolvedSamples,
    foreignSenders: foreignSenders.slice(0, UNRESOLVED_ID_LIMIT),
    selfSenderIds: [...selfSenderIds.entries()].map(([dbKey, ids]) => ({
      dbName: dbKey ? path.basename(dbKey, path.extname(dbKey)) : '',
      senderIds: [...ids].sort((a, b) => a - b),
    })),
    sampled,
    perTableResolved,
    ok: unresolvedSenderIds.size === 0 && foreignSenders.length === 0,
  }
}

function attributionDbKey(dbPath: string): string {
  return String(dbPath || '').toLowerCase()
}

/** 抽样行的原始字段并集（报告里留一份，schema 漂移时不用再猜）。 */
function collectRowFields(rows: IntegrityMessageRow[]): string[] {
  const fields = new Set<string>()
  for (const row of rows) {
    for (const field of row.rawFields || []) fields.add(field)
  }
  return [...fields].sort()
}

function attributionTableKey(dbPath: string, tableName: string): string {
  return `${String(dbPath || '').toLowerCase()}\u001f${String(tableName || '').toLowerCase()}`
}

/**
 * 媒体本地类型 → 媒体种类。
 * 与 `ExportContext.isMediaExportEnabled` / `collectMediaMessagesForExport` 的口径一致：
 * 文件消息只认 `49 / 34359738417 / 103079215153 / 25769803825` 且内容像 `<appmsg type=6>`
 * （否则普通链接会被当成"缺文件"而误报）。
 */
export function mediaKindOf(row: IntegrityMessageRow): MediaKind | null {
  const localType = Number(row.localType)
  if (localType === 3) return 'image'
  if (localType === 34) return 'voice'
  if (localType === 43) return 'video'
  if (localType === 47) return 'emoji'
  if (FILE_APP_LOCAL_TYPES.has(localType)) {
    const content = String(row.content || '')
    if (!content.includes('<appmsg') && !content.includes('&lt;appmsg')) return null
    return /<type>\s*6\s*<\/type>/i.test(content) || /<appmsg[^>]*type="6"/i.test(content) ? 'file' : null
  }
  return null
}

const FILE_APP_LOCAL_TYPES = new Set<number>([49, 34359738417, 103079215153, 25769803825])
/** 需要解码正文才能看出媒体线索的本地类型（图片/语音/视频/表情/文件）。 */
const MEDIA_CAPABLE_LOCAL_TYPES = new Set<number>([3, 34, 43, 47, ...FILE_APP_LOCAL_TYPES])

export function isMediaKindRequested(kind: MediaKind, flags: MediaRequestFlags): boolean {
  if (!flags.enabled) return false
  if (kind === 'image') return flags.images
  if (kind === 'voice') return flags.voices
  if (kind === 'video') return flags.videos
  if (kind === 'emoji') return flags.emojis
  return flags.files
}

/** 媒体文件名线索：命中任意一个即认为"产出了"。 */
/** 系统消息本地类型：撤回/入群/拍一拍这类消息的 sender 是"系统"，Name2Id 里没有名字。 */
export const SYSTEM_MESSAGE_LOCAL_TYPES = new Set<number>([10000, 10002, 266287972401])

export function isSystemMessageLocalType(localType: unknown): boolean {
  return SYSTEM_MESSAGE_LOCAL_TYPES.has(Number(localType))
}

/** 媒体目录名（与 `ExportContext.export*` 的落盘目录一致；文件类目录是单数 `file`）。 */
export function mediaDirName(kind: MediaKind): string {
  if (kind === 'image') return 'images'
  if (kind === 'voice') return 'voices'
  if (kind === 'video') return 'videos'
  if (kind === 'emoji') return 'emojis'
  return 'file'
}

export function mediaTokensOf(row: IntegrityMessageRow, kind: MediaKind): string[] {
  const tokens = new Set<string>()
  const push = (value: unknown) => {
    const token = String(value || '').trim().toLowerCase()
    if (token.length >= 8) tokens.add(token)
  }
  const content = String(row.content || '')
  if (kind === 'image') {
    for (const match of content.matchAll(/md5="([0-9a-fA-F]{32})"/g)) push(match[1])
    for (const match of content.matchAll(/datname="([^"]+)"/g)) push(match[1])
  } else if (kind === 'video') {
    for (const match of content.matchAll(/md5="([0-9a-fA-F]{32})"/g)) push(match[1])
    for (const match of content.matchAll(/[0-9a-fA-F]{32}/g)) push(match[0])
  } else if (kind === 'emoji') {
    for (const match of content.matchAll(/md5="([0-9a-fA-F]{32})"/g)) push(match[1])
    for (const match of content.matchAll(/[0-9a-fA-F]{32}/g)) push(match[0])
  } else if (kind === 'voice') {
    // `exportVoice` 的落盘名：`voice_<会话>_<localId>_<createTime>_<serverId>.wav`
    push(`_${row.localId}_${row.createTime}`)
    push(`_${row.localId}_`)
  } else if (kind === 'file') {
    // 注意必须带 `g`：`String.prototype.matchAll` 对非全局正则直接抛 TypeError，
    // 而这一抛会把整次自检打成"未能运行完成"（实测在真实数据上撞到过）。
    for (const match of content.matchAll(/<filename>([^<]+)<\/filename>/gi)) push(basename(match[1]))
    for (const match of content.matchAll(/<title>([^<]+)<\/title>/gi)) push(basename(match[1]))
  }
  return [...tokens]
}

function basename(value: string): string {
  const normalized = String(value || '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/**
 * 媒体覆盖统计。
 *
 * `files` 是**该会话范围内的**产出文件相对路径（已小写），`dirExists` 表示媒体目录存在。
 * 判定顺序：没请求 → `not-requested`；目录不存在 → `dir-missing`；
 * 没有文件名线索或线索都匹配不上 → `file-missing`（对应"未下载/已过期/解密失败"，
 * 自检侧无法进一步区分，运行级遥测在 notes 里补）。
 */
export function evaluateMediaCoverage(params: {
  sessionId: string
  rows: IntegrityMessageRow[]
  files: string[]
  dirExists: boolean
  mediaRequested: MediaRequestFlags
}): MediaCoverage {
  const { sessionId, rows, files, dirExists, mediaRequested } = params
  let requested = 0
  let produced = 0
  let notRequested = 0
  const missing: MissingMediaRow[] = []

  for (const row of rows) {
    const kind = mediaKindOf(row)
    if (!kind) continue
    if (!isMediaKindRequested(kind, mediaRequested)) {
      notRequested += 1
      continue
    }
    requested += 1
    if (!dirExists) {
      missing.push({ sessionId, messageLocalId: row.localId, type: kind, reason: 'dir-missing' })
      continue
    }
    const tokens = mediaTokensOf(row, kind)
    const dirToken = `/${mediaDirName(kind)}/`
    const hit = tokens.length === 0
      // 没有可用的文件名线索时退化为"该类型目录里有东西"（弱信号，但不会漏报整类）
      ? files.some((file) => file.includes(dirToken))
      : tokens.some((token) => files.some((file) => file.includes(token)))
    if (hit) {
      produced += 1
      continue
    }
    missing.push({ sessionId, messageLocalId: row.localId, type: kind, reason: 'file-missing' })
  }

  return { requested, produced, notRequested, missing }
}

/**
 * 重复检测：server id 在会话内全局核对；local id 只在所属 message DB/table 内核对。
 * WeChat 的 local_id 是表内 ID，同一时间相同 local_id 在不同分片可能是两条不同消息。
 */
export function detectDuplicates(rows: IntegrityMessageRow[], exampleLimit = DUPLICATE_EXAMPLE_LIMIT): DuplicateReport {
  const counts = new Map<string, { kind: DuplicateExample['kind']; key: string; rowIndexes: number[] }>()
  let unscopedRows = 0
  const add = (key: string, kind: DuplicateExample['kind'], rowIndex: number) => {
    const bucket = counts.get(`${kind}\u001f${key}`)
    if (bucket) {
      bucket.rowIndexes.push(rowIndex)
      return
    }
    counts.set(`${kind}\u001f${key}`, { kind, key, rowIndexes: [rowIndex] })
  }

  rows.forEach((row, rowIndex) => {
    const localId = exactUnsignedIdToken(row.localIdRaw) || exactUnsignedIdToken(row.localId)
    if (localId && localId !== '0') {
      const sourceIdentity = sourceMessageIdentityHash({ localId, dbPath: normalizeDbPathForIdentity(row.dbPath), tableName: row.tableName })
      if (sourceIdentity) add(`${row.sessionId}\u001f${sourceIdentity}`, 'message-key', rowIndex)
      else unscopedRows += 1
    } else {
      // A rounded Number must stay unknown. Hashing its decimal rendering could
      // merge two different int64 primary keys into one false source duplicate.
      // Missing and zero/sentinel IDs also cannot form a complete source key.
      unscopedRows += 1
    }
    const serverId = canonicalServerIdToken(row.serverIdRaw || row.serverId)
    if (serverId && serverId !== '0') add(`${row.sessionId}\u001f${serverId}`, 'server-id', rowIndex)
  })

  const repeatedBuckets = [...counts.values()].map((bucket) => ({
    ...bucket,
    rowIndexes: [...new Set(bucket.rowIndexes)].sort((a, b) => a - b),
  })).filter((bucket) => bucket.rowIndexes.length > 1)
  const cursorBuckets = repeatedBuckets.filter((bucket) => bucket.kind === 'message-key')
  const serverIdBuckets = repeatedBuckets.filter((bucket) => bucket.kind === 'server-id')
  const cursorSignatures = new Set(cursorBuckets.map((bucket) => bucket.rowIndexes.join(',')))

  let cursorDuplicateExtraRows = 0
  for (const bucket of cursorBuckets) cursorDuplicateExtraRows += bucket.rowIndexes.length - 1
  let sourceIdCollisionGroups = 0
  let sourceIdCollisionExtraRows = 0
  let identicalSourceIdPayloadGroups = 0
  let conflictingSourceIdPayloadGroups = 0
  let unknownSourceIdPayloadGroups = 0
  let unknownSourceIdIdentityGroups = 0
  let unknownSourceIdIdentityRows = 0
  const sourceIdClassification = new Map<string, { collision: boolean; unknownIdentity: boolean; payloadClass: 'identical' | 'conflicting' | 'unknown' }>()
  for (const bucket of serverIdBuckets) {
    const identityHashes = bucket.rowIndexes.map((index) => {
      const row = rows[index]
      const localId = exactUnsignedIdToken(row.localIdRaw) || exactUnsignedIdToken(row.localId)
      return localId ? sourceMessageIdentityHash({ localId, dbPath: row.dbPath, tableName: row.tableName }) : undefined
    })
    const distinctIdentities = new Set(identityHashes.filter((value): value is string => Boolean(value)))
    const unknownIdentity = identityHashes.some((value) => !value)
    const collision = !unknownIdentity && distinctIdentities.size > 1
    if (collision) {
      sourceIdCollisionGroups += 1
      sourceIdCollisionExtraRows += distinctIdentities.size - 1
    }
    if (unknownIdentity) {
      unknownSourceIdIdentityGroups += 1
      unknownSourceIdIdentityRows += bucket.rowIndexes.filter((_, index) => !identityHashes[index]).length
    }
    const payloadHashes = new Set<string>()
    let payloadUnknown = unknownIdentity
    for (const index of bucket.rowIndexes) {
      const row = rows[index]
      if (typeof row.content !== 'string' || (!row.senderUsername && row.realSenderId === undefined)) {
        payloadUnknown = true
        continue
      }
      const contentHash = createHash('sha256').update(row.content).digest('hex')
      const senderIdentity = row.resolvedUsername || row.senderUsername || String(row.realSenderId ?? '')
      const payload = [
        Math.max(0, Number(row.createTime) || 0),
        Math.max(0, Number(row.localType) || 0),
        row.isSend ? '1' : '0',
        senderIdentity,
        contentHash,
      ].join('\u001f')
      payloadHashes.add(createHash('sha256').update(payload).digest('hex'))
    }
    const payloadClass = payloadUnknown || payloadHashes.size === 0
      ? 'unknown'
      : payloadHashes.size === 1 ? 'identical' : 'conflicting'
    if (payloadClass === 'identical') identicalSourceIdPayloadGroups += 1
    else if (payloadClass === 'conflicting') conflictingSourceIdPayloadGroups += 1
    else unknownSourceIdPayloadGroups += 1
    sourceIdClassification.set(bucket.rowIndexes.join(','), { collision, unknownIdentity, payloadClass })
  }

  // A repeated pair often matches both identities. Count the row set once, preferring
  // the server ID example because it also works across distinct shards.
  const duplicateGroups = new Map<string, { kind: DuplicateExample['kind']; key: string; rowIndexes: number[] }>()
  const priority: Record<DuplicateExample['kind'], number> = { 'message-key': 0, 'server-id': 1 }
  for (const bucket of counts.values()) {
    const rowIndexes = [...new Set(bucket.rowIndexes)].sort((a, b) => a - b)
    if (rowIndexes.length < 2) continue
    const signature = rowIndexes.join(',')
    const existing = duplicateGroups.get(signature)
    if (!existing || priority[bucket.kind] > priority[existing.kind]) {
      duplicateGroups.set(signature, { ...bucket, rowIndexes })
    }
  }

  const allExamples: DuplicateExample[] = []
  let extraRows = 0
  for (const bucket of duplicateGroups.values()) {
    const first = rows[bucket.rowIndexes[0]]
    const count = bucket.rowIndexes.length
    extraRows += count - 1
    allExamples.push({
      sessionId: first.sessionId,
      kind: bucket.kind,
      classification: cursorSignatures.has(bucket.rowIndexes.join(','))
        ? 'cursor-repeat'
        : sourceIdClassification.get(bucket.rowIndexes.join(','))?.collision
          ? 'source-id-collision'
          : 'unknown-source-identity',
      ...(sourceIdClassification.has(bucket.rowIndexes.join(','))
        ? { payloadClass: sourceIdClassification.get(bucket.rowIndexes.join(','))!.payloadClass }
        : {}),
      key: bucket.key,
      count,
      localId: first.localId,
      createTime: first.createTime,
    })
  }
  // 先按重复次数排序再截断，保证"最多 20 条示例"给出的是最严重的那几条。
  allExamples.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  return {
    groups: allExamples.length,
    extraRows,
    examples: allExamples.slice(0, Math.max(0, Math.floor(exampleLimit))),
    unscopedRows,
    cursorDuplicateGroups: cursorBuckets.length,
    cursorDuplicateExtraRows,
    sourceIdCollisionGroups,
    sourceIdCollisionExtraRows,
    identicalSourceIdPayloadGroups,
    conflictingSourceIdPayloadGroups,
    unknownSourceIdPayloadGroups,
    unknownSourceIdIdentityGroups,
    unknownSourceIdIdentityRows,
  }
}

/** CSV 单元格转义（RFC4180：含 `,`/`"`/换行才加引号，内部 `"` 翻倍）。 */
export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * 生成 `missing-media.csv` 内容。
 * 超出上限时**在末尾**追加一行注释说明（`# truncated: …`）——
 * 放在末尾而不是开头，读的人用任何 CSV 解析器都还能拿到表头。
 */
export function buildMissingMediaCsv(rows: MissingMediaRow[], cap = MISSING_MEDIA_ROW_LIMIT): {
  content: string
  written: number
  truncated: boolean
  total: number
} {
  const limit = Math.max(0, Math.floor(cap))
  const total = rows.length
  const listed = total > limit ? rows.slice(0, limit) : rows
  const lines = ['sessionId,messageLocalId,type,reason']
  for (const row of listed) {
    lines.push([
      escapeCsvCell(row.sessionId),
      escapeCsvCell(row.messageLocalId),
      escapeCsvCell(row.type),
      escapeCsvCell(row.reason),
    ].join(','))
  }
  const truncated = total > listed.length
  if (truncated) {
    lines.push(`# truncated: ${listed.length} of ${total} rows listed (cap=${limit})`)
  }
  return { content: `${lines.join('\n')}\n`, written: listed.length, truncated, total }
}

export type ArtifactRowCount =
  | {
      ok: true
      rows: number
      how: 'json'
      sourceIdentityCounts: Record<string, number>
      sourceIdentityPresentRows: number
      sourceIdentityInvalidRows: number
    }
  | { ok: true; rows: number; how: 'jsonl' | 'csv' }
  | { ok: false; reason: 'missing' | 'too-large' | 'unparsable' | 'unsupported-format' }

/**
 * 数产物里的行数。只有**确定安全**的格式才解析（其余返回 `ok:false` + 原因，
 * 调用方回退到运行计数器）：
 * - `json` / `chatlab` / `arkme-json`：读 JSON，取 `messages` 数组长度；
 * - `chatlab-jsonl` / `jsonl`：数非空行；
 * - `weclone`：引号感知地数 CSV 记录（减掉表头）。
 *
 * 失败原因是**分开**的：`unparsable` 意味着"这个格式本该能数出来，但文件读不出来"
 * —— 产物被截断/损坏就是这个形状，报告里必须说清楚，而不是笼统地说"格式不支持"。
 */
export async function countRowsInArtifact(
  artifactPath: string,
  format: string,
  options: { maxBytes?: number } = {},
): Promise<ArtifactRowCount> {
  const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? MAX_PARSE_BYTES))
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(artifactPath)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'missing' }
  const normalized = String(format || '').toLowerCase()
  const supported = normalized === 'json' || normalized === 'chatlab' || normalized === 'arkme-json'
    || normalized === 'chatlab-jsonl' || normalized === 'jsonl' || normalized === 'weclone'
  if (!supported) return { ok: false, reason: 'unsupported-format' }
  if (stat.size > maxBytes) return { ok: false, reason: 'too-large' }

  if (normalized === 'json' || normalized === 'chatlab' || normalized === 'arkme-json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.promises.readFile(artifactPath, 'utf-8'))
    } catch {
      return { ok: false, reason: 'unparsable' }
    }
    const messages = (parsed as Record<string, unknown> | null)?.messages
    const messageRows = Array.isArray(messages) ? messages : Array.isArray(parsed) ? parsed : null
    if (messageRows) {
      const sourceIdentityCounts: Record<string, number> = Object.create(null)
      let sourceIdentityPresentRows = 0
      let sourceIdentityInvalidRows = 0
      for (const message of messageRows as Array<Record<string, unknown>>) {
        if (!Object.prototype.hasOwnProperty.call(message || {}, 'sourceIdentityHash')) continue
        sourceIdentityPresentRows += 1
        const identity = String(message?.sourceIdentityHash || '').trim().toLowerCase()
        if (!/^[a-f0-9]{64}$/.test(identity)) {
          sourceIdentityInvalidRows += 1
          continue
        }
        sourceIdentityCounts[identity] = (sourceIdentityCounts[identity] || 0) + 1
      }
      return {
        ok: true,
        rows: messageRows.length,
        how: 'json',
        sourceIdentityCounts,
        sourceIdentityPresentRows,
        sourceIdentityInvalidRows,
      }
    }
    return { ok: false, reason: 'unparsable' }
  }

  if (normalized === 'chatlab-jsonl' || normalized === 'jsonl') {
    const text = await fs.promises.readFile(artifactPath, 'utf-8')
    const rows = text.split('\n').filter((line) => line.trim().length > 0).length
    return { ok: true, rows, how: 'jsonl' }
  }

  const text = await fs.promises.readFile(artifactPath, 'utf-8')
  return { ok: true, rows: Math.max(0, countCsvRecords(text) - 1), how: 'csv' }
}

export function compareSourceIdentityMultisets(
  source: Record<string, number>,
  artifact: Record<string, number>,
): { matchedRows: number; missingRows: number; extraRows: number } {
  const keys = new Set([...Object.keys(source), ...Object.keys(artifact)])
  let matchedRows = 0
  let missingRows = 0
  let extraRows = 0
  for (const key of keys) {
    const sourceCount = Math.max(0, Math.floor(Number(source[key] || 0)))
    const artifactCount = Math.max(0, Math.floor(Number(artifact[key] || 0)))
    matchedRows += Math.min(sourceCount, artifactCount)
    missingRows += Math.max(0, sourceCount - artifactCount)
    extraRows += Math.max(0, artifactCount - sourceCount)
  }
  return { matchedRows, missingRows, extraRows }
}

async function auditJsonSourceIdentities(args: {
  sessionId: string
  format: string
  scoped: boolean
  artifact: ArtifactRowCount | null
  db: IntegrityDbAccess
}): Promise<SourceIdentityAuditReport> {
  const normalizedFormat = String(args.format || '').toLowerCase()
  if (args.scoped || (normalizedFormat !== 'json' && normalizedFormat !== 'arkme-json')) {
    return { status: 'not-applicable', expectedRows: 0, artifactRows: 0, matchedRows: 0, missingRows: 0, extraRows: 0, unscopedSourceRows: 0, repeatedIdentityGroups: 0, repeatedIdentityExtraRows: 0, complete: true }
  }
  if (!args.artifact?.ok || args.artifact.how !== 'json') {
    return { status: 'unavailable', expectedRows: 0, artifactRows: 0, matchedRows: 0, missingRows: 0, extraRows: 0, unscopedSourceRows: 0, repeatedIdentityGroups: 0, repeatedIdentityExtraRows: 0, complete: false }
  }
  const artifactRows = args.artifact.rows
  if (args.artifact.sourceIdentityPresentRows === 0) {
    return { status: 'legacy-artifact', expectedRows: 0, artifactRows, matchedRows: 0, missingRows: 0, extraRows: 0, unscopedSourceRows: 0, repeatedIdentityGroups: 0, repeatedIdentityExtraRows: 0, complete: false }
  }
  if (args.artifact.sourceIdentityPresentRows !== artifactRows || args.artifact.sourceIdentityInvalidRows > 0) {
    return {
      status: 'checked', expectedRows: 0, artifactRows, matchedRows: 0,
      missingRows: 0,
      extraRows: Math.max(0, artifactRows - args.artifact.sourceIdentityPresentRows) + args.artifact.sourceIdentityInvalidRows,
      unscopedSourceRows: 0,
      repeatedIdentityGroups: 0,
      repeatedIdentityExtraRows: 0,
      complete: false,
    }
  }
  if (!args.db.scanMessageIdentityMultiset) {
    return { status: 'unavailable', expectedRows: 0, artifactRows, matchedRows: 0, missingRows: 0, extraRows: artifactRows, unscopedSourceRows: 0, repeatedIdentityGroups: 0, repeatedIdentityExtraRows: 0, complete: false }
  }
  const scanned = await args.db.scanMessageIdentityMultiset(args.sessionId).catch(() => null)
  if (!scanned || scanned.success !== true || !scanned.identities) {
    return { status: 'unavailable', expectedRows: 0, artifactRows, matchedRows: 0, missingRows: 0, extraRows: artifactRows, unscopedSourceRows: 0, repeatedIdentityGroups: 0, repeatedIdentityExtraRows: 0, complete: false }
  }
  const sourceIdentities = scanned.identities
  const sourceIdentityRows = Object.values(sourceIdentities).reduce((sum: number, count: number) => sum + Math.max(0, Number(count) || 0), 0)
  const diff = compareSourceIdentityMultisets(sourceIdentities, args.artifact.sourceIdentityCounts)
  const repeatedSourceIdentities = Object.values(sourceIdentities).reduce((result, rawCount) => {
    const count = Number(rawCount)
    if (!Number.isSafeInteger(count) || count < 0) return result
    if (count > 1) {
      result.groups += 1
      result.extraRows += count - 1
    }
    return result
  }, { groups: 0, extraRows: 0 })
  const unscopedSourceRows = Math.max(0, Number(scanned.unscopedRows || 0))
  return {
    status: 'checked',
    expectedRows: Number.isFinite(scanned.scannedRows) ? Math.max(0, Number(scanned.scannedRows)) : sourceIdentityRows + unscopedSourceRows,
    artifactRows,
    matchedRows: diff.matchedRows,
    missingRows: diff.missingRows,
    extraRows: diff.extraRows + Math.max(0, artifactRows - args.artifact.sourceIdentityPresentRows),
    unscopedSourceRows,
    repeatedIdentityGroups: repeatedSourceIdentities.groups,
    repeatedIdentityExtraRows: repeatedSourceIdentities.extraRows,
    complete: diff.missingRows === 0 && diff.extraRows === 0 && unscopedSourceRows === 0 &&
      repeatedSourceIdentities.groups === 0 &&
      args.artifact.sourceIdentityPresentRows === artifactRows && args.artifact.sourceIdentityInvalidRows === 0,
  }
}

/** 引号感知地数 CSV 记录数（字段内的换行不算新记录）。 */
export function countCsvRecords(text: string): number {
  let records = 0
  let inQuotes = false
  let sawAny = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1
        continue
      }
      inQuotes = !inQuotes
      sawAny = true
      continue
    }
    if (!inQuotes && ch === '\n') {
      records += 1
      sawAny = false
      continue
    }
    if (ch !== '\r') sawAny = true
  }
  if (sawAny) records += 1
  return records
}

// ---------------------------------------------------------------------------
// 报告组装
// ---------------------------------------------------------------------------

export function formatLocalTimestamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 报告根目录的文件索引（相对路径，POSIX 分隔符，已小写）。 */
export async function buildExportFileIndex(rootDir: string, limit = MEDIA_INDEX_LIMIT): Promise<{ files: string[]; truncated: boolean }> {
  const root = path.resolve(rootDir)
  const files: string[] = []
  let truncated = false
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name === LEDGER_FILE_NAME) continue
      files.push(path.relative(root, full).split(path.sep).join('/').toLowerCase())
      if (files.length >= limit) {
        truncated = true
        return { files, truncated }
      }
    }
  }
  return { files, truncated }
}

export function makeEmptyReport(input: { wxid: string; outputRoot: string; ledgerEntries: number; now: number; notes?: string[] }): IntegrityReport {
  return {
    v: INTEGRITY_REPORT_VERSION,
    generatedAt: input.now,
    generatedAtLocal: formatLocalTimestamp(input.now),
    wxid: input.wxid,
    outputRoot: input.outputRoot,
    ledgerEntries: input.ledgerEntries,
    sessions: [],
    totals: {
      sessions: 0,
      messages: 0,
      mismatches: 0,
      missingMedia: 0,
      duplicates: 0,
      sourceIdCollisions: 0,
      sourceIdCollisionExtraRows: 0,
      identicalSourceIdPayloadGroups: 0,
      conflictingSourceIdPayloadGroups: 0,
      unknownSourceIdPayloadGroups: 0,
      unknownSourceIdIdentityGroups: 0,
      unknownSourceIdIdentityRows: 0,
      identityMissingRows: 0,
      identityExtraRows: 0,
    },
    ok: false,
    notes: input.notes ? [...input.notes] : [],
    durationMs: 0,
    missingMediaCsv: null,
    missingMediaTotal: 0,
    missingMediaTruncatedTo: null,
    duplicateExamples: [],
    duplicateExtraRows: 0,
    sourceIdCollisionExtraRows: 0,
    dbAccessOk: true,
    sampled: false,
  }
}

/**
 * 跑一遍自检并落盘（`integrity-report.json` + `missing-media.csv`）。
 *
 * 这个函数**不抛异常**：自检失败也要留下一份可读的报告（`ok:false` + notes）。
 */
export async function runIntegrityCheck(input: IntegrityCheckInput): Promise<IntegrityReport> {
  const startedAt = Date.now()
  const now = Number.isFinite(input.now) ? Math.floor(Number(input.now)) : startedAt
  const outputRoot = path.resolve(input.outputRoot)
  const sampleLimit = Math.max(1, Math.floor(input.sampleLimit ?? DEFAULT_SAMPLE_LIMIT))
  const notes: string[] = [...(input.notes || [])]
  const db = input.db ?? createWcdbIntegrityDbAccess()

  let indexResult: { files: string[]; truncated: boolean }
  if (input.mediaFileIndex) {
    indexResult = { files: input.mediaFileIndex.map((file) => file.toLowerCase()), truncated: false }
  } else {
    indexResult = await buildExportFileIndex(outputRoot)
  }
  if (indexResult.truncated) {
    notes.push(`媒体文件索引已达上限 ${MEDIA_INDEX_LIMIT} 个文件，媒体覆盖检查只在索引范围内匹配`)
  }

  const knownSessionIds = await db.listSessionIds().catch(() => [] as string[])
  const sessions: IntegritySessionReport[] = []
  const allMissing: MissingMediaRow[] = []
  const allDuplicateExamples: DuplicateExample[] = []
  let duplicateExtraRows = 0
  let sourceIdCollisionExtraRows = 0
  let dbAccessOk = true
  let anySampled = false

  for (const session of input.sessions) {
    const sessionNotes: string[] = []
    const gaps: GapEntry[] = []

    // ---- 检查 1：数据库侧独立计数（每张分片表计数之和 + 两路旁证） --------------
    let tableTotal = 0
    let tableCount = 0
    let tables: IntegrityTableStat[] = []
    const statsResult: { success: boolean; tables?: IntegrityTableStat[]; error?: string } = await db
      .getTableStats(session.sessionId)
      .catch((error) => ({ success: false, error: String(error) }))
    if (statsResult.success && Array.isArray(statsResult.tables)) {
      tables = statsResult.tables
      tableCount = tables.length
      tableTotal = tables.reduce((sum, table) => sum + Math.max(0, Math.floor(table.count || 0)), 0)
    } else {
      dbAccessOk = false
      const error = String(statsResult.error || '未知错误')
      gaps.push({ kind: 'db', detail: `分片表统计读取失败：${error}` })
      sessionNotes.push(`未能读取分片表统计（${error}），总数交叉核对缺少数据库侧数字`)
    }

    const scanCountResult: { success: boolean; count?: number; error?: string } = await db
      .getSessionMessageCount(session.sessionId)
      .catch((error) => ({ success: false, error: String(error) }))
    const expectedScan = scanCountResult.success && Number.isFinite(scanCountResult.count)
      ? Math.max(0, Math.floor(Number(scanCountResult.count)))
      : undefined
    if (!scanCountResult.success) {
      sessionNotes.push(`会话计数接口不可用（${String(scanCountResult.error || '未知错误')}）`)
    }
    const counterResult: { success: boolean; count?: number; error?: string } = await db
      .getSessionCounter(session.sessionId)
      .catch((error) => ({ success: false, error: String(error) }))
    const expectedSessionCounter = counterResult.success && Number.isFinite(counterResult.count)
      ? Math.max(0, Math.floor(Number(counterResult.count)))
      : undefined
    if (
      typeof expectedScan === 'number' &&
      typeof expectedSessionCounter === 'number' &&
      expectedScan !== expectedSessionCounter
    ) {
      sessionNotes.push(
        `数据库内部计数不一致：分片表合计 ${tableTotal} / 会话计数 ${expectedScan} / session 表计数器 ${expectedSessionCounter}（属库侧口径差异，不判定为导出缺陷）`,
      )
    }

    // ---- 检查 5：产物完整性（账本指纹 vs 磁盘） --------------------------------
    const artifact = await verifySessionArtifacts(session.artifactFingerprints || [], sessionNotes)

    // ---- 产物行数 --------------------------------------------------------------
    let written: number | null = null
    let writtenSource: IntegritySessionReport['writtenSource'] = 'none'
    let artifactRowIssue: string | null = null
    let countedArtifact: ArtifactRowCount | null = null
    if (session.artifactPath && session.format) {
      const counted = await countRowsInArtifact(session.artifactPath, session.format)
      if (counted.ok) {
        countedArtifact = counted
        written = counted.rows
        writtenSource = 'artifact'
      } else {
        artifactRowIssue = counted.reason
      }
    } else {
      artifactRowIssue = 'missing'
    }
    const writtenRun = Number.isFinite(session.runExportedMessages)
      ? Math.max(0, Math.floor(Number(session.runExportedMessages)))
      : undefined
    /**
     * 拿"格式器自报的行数"顶上，只在这个格式**本来就不解析行数**时成立（html/xlsx/超大文件）。
     *
     * 产物**读不出来**（`unparsable`，文件被截断/损坏的典型形状）或**根本不存在**（`missing`）
     * 时也顶上，等于把"产物坏了"说成"行数对得上"—— 而这正是 §10.2 存在的理由：一份被截断
     * 或被人删掉的导出**必须**报成发现，不能 ok。
     */
    const artifactBroken = artifactRowIssue === 'unparsable' || artifactRowIssue === 'missing'
    if (written === null && typeof writtenRun === 'number' && !artifactBroken) {
      written = writtenRun
      writtenSource = 'run-counter'
    }
    if (written === null) {
      writtenSource = 'none'
      const reasonText = artifactRowIssue === 'unparsable'
        ? '产物存在但读不出来（JSON 解析失败 —— 文件被截断/损坏的典型形状）'
        : artifactRowIssue === 'too-large'
          ? `产物超过 ${Math.floor(MAX_PARSE_BYTES / 1024 / 1024)}MB，不做行数解析`
          : artifactRowIssue === 'missing'
            ? '产物文件不存在'
            : '该格式不参与文件行数解析（如 xlsx/html）'
      gaps.push({ kind: 'totals-unknown', detail: `无法确定产物行数：${reasonText}，运行里也没有计数器` })
      sessionNotes.push('产物行数未知，总数交叉核对无法判定（计入 gaps，ok 必为 false）')
    } else if (writtenSource === 'run-counter') {
      sessionNotes.push('产物行数取自格式器自报的计数器（该格式不参与文件行数解析）')
    } else if (typeof writtenRun === 'number' && written !== writtenRun) {
      gaps.push({
        kind: 'artifact-rows',
        detail: `产物实际行数 ${written} 与格式器自报 ${writtenRun} 不一致（产物可能被截断/篡改）`,
        expected: writtenRun,
        written,
      })
    }
    const writtenValue = written === null ? 0 : written

    // ---- 检查 2/3/4：抽样重扫 ---------------------------------------------------
    const scanResult: { success: boolean; rows?: IntegrityMessageRow[]; truncated?: boolean; error?: string } = await db
      .scanMessages(session.sessionId, sampleLimit)
      .catch((error) => ({ success: false, error: String(error) }))
    let rows: IntegrityMessageRow[] = []
    let sampled = true
    if (scanResult.success && Array.isArray(scanResult.rows)) {
      rows = scanResult.rows
      // 没被抽样上限截断 = 这次把整个会话都扫过了（此时 rowsSkipped 才是硬数字）。
      sampled = scanResult.truncated === true
    } else {
      dbAccessOk = false
      const error = String(scanResult.error || '未知错误')
      gaps.push({ kind: 'db', detail: `消息抽样重扫失败：${error}` })
      sessionNotes.push(`未能重扫消息（${error}），归属/媒体/重复三项检查没有样本`)
    }
    anySampled ||= sampled

    const identityAudit = await auditJsonSourceIdentities({
      sessionId: session.sessionId,
      format: session.format || '',
      scoped: session.scoped,
      artifact: countedArtifact,
      db,
    })
    if (identityAudit.status === 'legacy-artifact') {
      sessionNotes.push('JSON 产物没有 sourceIdentityHash，按旧格式只执行总数校验')
    } else if (identityAudit.status === 'unavailable' && session.format && ['json', 'arkme-json'].includes(session.format.toLowerCase())) {
      gaps.push({ kind: 'identity', detail: 'JSON 源行身份多重集无法校验' })
      dbAccessOk = false
    } else if (identityAudit.status === 'checked' && !identityAudit.complete) {
      gaps.push({
        kind: 'identity',
        detail: `JSON 源行身份不完整：缺少 ${identityAudit.missingRows} 行、额外 ${identityAudit.extraRows} 行、无法定位 ${identityAudit.unscopedSourceRows} 行、重复源身份 ${identityAudit.repeatedIdentityGroups} 组（多出 ${identityAudit.repeatedIdentityExtraRows} 行）`,
        expected: identityAudit.expectedRows,
        written: identityAudit.artifactRows,
      })
    }

    await resolveRowSenders(rows, db)
    const attribution = evaluateAttribution({
      sessionId: session.sessionId,
      myWxid: input.wxid,
      tables,
      rows,
      knownSessionIds,
      sampled,
    })
    if (attribution.unresolvedSenderIds.length > 0) {
      gaps.push({
        kind: 'attribution',
        detail: `${attribution.unresolvedSenderIds.length} 个 real_sender_id 在本库 Name2Id 里解析不到（样例：${attribution.unresolvedSenderIds.join(', ')}）`,
      })
    }
    if (attribution.foreignSenders.length > 0) {
      const sample = attribution.foreignSenders.slice(0, 5).map((item) => `${item.senderId}→${item.username}`).join(', ')
      gaps.push({
        kind: 'attribution',
        detail: `${attribution.foreignSenders.length} 行被归到了别的会话（样例：${sample}）`,
      })
    }
    if (!attribution.perTableResolved) {
      sessionNotes.push('消息行未带表名且同一库里有不止一张分片表，按表的 rowsSkipped 无法拆分（只给到库这一级，不编数）')
    }
    if (attribution.systemSenderIds.length > 0) {
      sessionNotes.push(`系统消息挂着 ${attribution.systemSenderIds.length} 个 Name2Id 里没有名字的 sender id（${attribution.systemSenderIds.join(', ')}）——正常数据，不计为归属缺陷`)
    }

    const sessionFileScope = session.sessionDir
      ? `${path.relative(outputRoot, path.resolve(session.sessionDir)).split(path.sep).join('/').toLowerCase()}/`
      : ''
    const scopedFiles = sessionFileScope
      ? indexResult.files.filter((file) => file.startsWith(sessionFileScope))
      : indexResult.files
    // 会话范围内一个文件都没有 → 媒体目录不存在（请求了媒体也照样报 dir-missing，不许沉默）。
    const dirExists = scopedFiles.length > 0
    const coverage = evaluateMediaCoverage({
      sessionId: session.sessionId,
      rows,
      files: scopedFiles,
      dirExists,
      mediaRequested: session.mediaRequested,
    })
    if (coverage.missing.length > 0) {
      allMissing.push(...coverage.missing)
      gaps.push({
        kind: 'media',
        detail: `请求了媒体导出但缺少 ${coverage.missing.length} 个媒体文件（抽样范围内）`,
      })
    }
    if (!session.mediaRequested.enabled && coverage.notRequested > 0) {
      sessionNotes.push(`抽样里 ${coverage.notRequested} 条消息带媒体，但本次未请求媒体导出（不计为缺失）`)
    }
    if (typeof session.imageKeyMissingFiles === 'number' && session.imageKeyMissingFiles > 0) {
      sessionNotes.push(`本次运行有 ${session.imageKeyMissingFiles} 张图片缺解密密钥（会显示为 [图片] 占位）`)
    }
    if (typeof session.voiceFailedFiles === 'number' && session.voiceFailedFiles > 0) {
      sessionNotes.push(`本次运行有 ${session.voiceFailedFiles} 条语音拿不到数据（微信里没有完整语音文件）`)
    }

    const duplicates = detectDuplicates(rows)
    if (duplicates.unscopedRows > 0) {
      const detail = `${duplicates.unscopedRows} 条抽样消息缺少完整且精确的 DB/表/local_id 身份，无法安全检查重复`
      gaps.push({ kind: 'db', detail })
      sessionNotes.push(detail)
      dbAccessOk = false
    }
    if (duplicates.cursorDuplicateGroups > 0) {
      allDuplicateExamples.push(...duplicates.examples.filter((example) => example.classification === 'cursor-repeat'))
      gaps.push({
        kind: 'duplicates',
        detail: `抽样范围内发现 ${duplicates.cursorDuplicateGroups} 组相同 DB/表/local_id 的重复源行（多出 ${duplicates.cursorDuplicateExtraRows} 行）`,
      })
    }
    if (duplicates.sourceIdCollisionGroups > 0) {
      allDuplicateExamples.push(...duplicates.examples.filter((example) => example.classification === 'source-id-collision'))
      sourceIdCollisionExtraRows += duplicates.sourceIdCollisionExtraRows
      sessionNotes.push(
        `抽样范围内发现 ${duplicates.sourceIdCollisionGroups} 组重复 server_id，包含 ${duplicates.identicalSourceIdPayloadGroups} 组相同 payload、${duplicates.conflictingSourceIdPayloadGroups} 组不同 payload；这些不同 local_id 的源行已保留，不计为重复导出`,
      )
    }
    if (duplicates.unknownSourceIdIdentityGroups > 0) {
      allDuplicateExamples.push(...duplicates.examples.filter((example) => example.classification === 'unknown-source-identity'))
      gaps.push({
        kind: 'identity',
        detail: `${duplicates.unknownSourceIdIdentityGroups} 组重复 server_id 缺少完整 DB/表/local_id 身份，无法确认是源 ID 冲突还是重复读取`,
      })
      dbAccessOk = false
    }

    // The JSON identity audit scans the full source, so its repeated identities
    // cover duplicates that may fall outside the bounded sample above. The two
    // scans overlap; take the larger count instead of adding the same groups twice.
    const sessionDuplicateGroups = Math.max(duplicates.cursorDuplicateGroups, identityAudit.repeatedIdentityGroups)
    const sessionDuplicateExtraRows = Math.max(duplicates.cursorDuplicateExtraRows, identityAudit.repeatedIdentityExtraRows)
    duplicateExtraRows += sessionDuplicateExtraRows

    // ---- 检查 1 判定 -----------------------------------------------------------
    const verdict = evaluateTotals(tableTotal, writtenValue, session.scoped)
    if (verdict.gap) {
      gaps.push({
        kind: 'totals',
        detail: verdict.reason || '总数不符',
        expected: tableTotal,
        written: writtenValue,
      })
    } else if (verdict.status === 'scoped-ok' && verdict.reason) {
      sessionNotes.push(verdict.reason)
    }

    if (!artifact.ok) {
      for (const failure of artifact.failures) {
        gaps.push({
          kind: 'artifact-integrity',
          detail: `账本指纹校验失败：${failure.reason}（${failure.path}）`,
          expected: failure.expectedBytes,
          written: failure.actualBytes,
        })
      }
    }

    sessions.push({
      sessionId: session.sessionId,
      displayName: session.displayName,
      expected: tableTotal,
      written: writtenValue,
      gaps,
      duplicates: sessionDuplicateGroups,
      sourceIdCollisions: duplicates.sourceIdCollisionGroups,
      sourceIdCollisionExtraRows: duplicates.sourceIdCollisionExtraRows,
      identicalSourceIdPayloadGroups: duplicates.identicalSourceIdPayloadGroups,
      conflictingSourceIdPayloadGroups: duplicates.conflictingSourceIdPayloadGroups,
      unknownSourceIdPayloadGroups: duplicates.unknownSourceIdPayloadGroups,
      unknownSourceIdIdentityGroups: duplicates.unknownSourceIdIdentityGroups,
      unknownSourceIdIdentityRows: duplicates.unknownSourceIdIdentityRows,
      identityAudit,
      mediaRequested: coverage.requested,
      mediaProduced: coverage.produced,
      mediaMissing: coverage.missing.length,
      expectedScan,
      expectedSessionCounter,
      writtenRun,
      writtenSource,
      scoped: session.scoped,
      sampled,
      scannedRows: rows.length,
      tableCount,
      attribution,
      artifact,
      messageRowFields: collectRowFields(rows),
      notes: sessionNotes,
    })
  }

  const totals = {
    sessions: sessions.length,
    messages: sessions.reduce((sum, session) => sum + Math.max(0, Math.floor(session.written || 0)), 0),
    mismatches: sessions.reduce((sum, session) => sum + session.gaps.filter((gap) => gap.kind === 'totals').length, 0),
    missingMedia: allMissing.length,
    duplicates: sessions.reduce((sum, session) => sum + session.duplicates, 0),
    sourceIdCollisions: sessions.reduce((sum, session) => sum + session.sourceIdCollisions, 0),
    sourceIdCollisionExtraRows,
    identicalSourceIdPayloadGroups: sessions.reduce((sum, session) => sum + session.identicalSourceIdPayloadGroups, 0),
    conflictingSourceIdPayloadGroups: sessions.reduce((sum, session) => sum + session.conflictingSourceIdPayloadGroups, 0),
    unknownSourceIdPayloadGroups: sessions.reduce((sum, session) => sum + session.unknownSourceIdPayloadGroups, 0),
    unknownSourceIdIdentityGroups: sessions.reduce((sum, session) => sum + session.unknownSourceIdIdentityGroups, 0),
    unknownSourceIdIdentityRows: sessions.reduce((sum, session) => sum + session.unknownSourceIdIdentityRows, 0),
    identityMissingRows: sessions.reduce((sum, session) => sum + session.identityAudit.missingRows, 0),
    identityExtraRows: sessions.reduce((sum, session) => sum + session.identityAudit.extraRows, 0),
  }

  const csv = buildMissingMediaCsv(allMissing)
  let csvPath: string | null = null
  if (allMissing.length > 0) {
    csvPath = path.join(outputRoot, MISSING_MEDIA_CSV_FILE_NAME)
    try {
      await atomicWriteFile(csvPath, csv.content, 'utf-8')
    } catch (error) {
      csvPath = null
      notes.push(`missing-media.csv 写入失败：${String(error)}`)
    }
  }
  if (csv.truncated) {
    notes.push(`missing-media.csv 已截断：仅列出 ${csv.written} 条，共 ${csv.total} 条缺失`)
  }
  if (totals.sourceIdCollisions > 0) {
    notes.push(
      `源库中发现 ${totals.sourceIdCollisions} 组重复 server_id：${totals.identicalSourceIdPayloadGroups} 组 payload 相同、${totals.conflictingSourceIdPayloadGroups} 组 payload 不同；不同 local_id 的消息均保留，需结合源行身份校验判断`,
    )
  }
  if (!dbAccessOk) {
    notes.push('数据库侧的检查没有全部跑成，报告不能视为"通过"（详见各会话的 gaps/notes）')
  }
  const mediaRequestedTotal = sessions.reduce((sum, session) => sum + session.mediaRequested, 0)
  const mediaProducedTotal = sessions.reduce((sum, session) => sum + session.mediaProduced, 0)
  if (mediaRequestedTotal > 0 && mediaProducedTotal === 0) {
    notes.push(`本次请求了 ${mediaRequestedTotal} 个媒体但一个文件都没产出：检查图片密钥（缺密钥时图片只能是 [图片] 占位）、语音数据是否完整、表情包是否需要联网下载`)
  }
  // 运行级媒体计数只在真的请求了媒体时才写进 notes（纯文本导出写它只是噪音）。
  if (mediaRequestedTotal > 0 && input.mediaTelemetry && Number.isFinite(input.mediaTelemetry.doneFiles)) {
    notes.push(`本次运行写入媒体文件 ${Math.max(0, Math.floor(Number(input.mediaTelemetry.doneFiles)))} 个（运行级计数，含所有会话）`)
  }

  // ---- ok 语义：任何一处对不上、任何一项没跑成，都不是 true --------------------
  const gapSessions = sessions.filter((session) => session.gaps.length > 0)
  const ok = dbAccessOk && gapSessions.length === 0
  if (!ok) {
    for (const session of gapSessions) {
      for (const gap of session.gaps) {
        notes.push(`会话 ${session.sessionId}：${gap.detail}`)
      }
    }
  } else {
    const auditedJsonSessions = sessions.filter((session) => session.identityAudit.status === 'checked').length
    const legacyJsonSessions = sessions.filter((session) => session.identityAudit.status === 'legacy-artifact').length
    const identityNote = auditedJsonSessions > 0 || legacyJsonSessions > 0
      ? `；JSON 源身份完整核对 ${auditedJsonSessions} 个会话，旧格式 ${legacyJsonSessions} 个会话`
      : ''
    notes.push(`总数、归属、媒体与产物校验通过：${sessions.length} 个会话、${totals.messages} 条消息、无重复源身份行、无缺失媒体${identityNote}`)
  }

  const report: IntegrityReport = {
    v: INTEGRITY_REPORT_VERSION,
    generatedAt: now,
    generatedAtLocal: formatLocalTimestamp(now),
    wxid: input.wxid,
    outputRoot,
    ledgerEntries: Math.max(0, Math.floor(input.ledgerEntries || 0)),
    sessions,
    totals,
    ok,
    notes,
    durationMs: Date.now() - startedAt,
    missingMediaCsv: csvPath ? path.relative(outputRoot, csvPath).split(path.sep).join('/') : null,
    missingMediaTotal: csv.total,
    missingMediaTruncatedTo: csv.truncated ? csv.written : null,
    duplicateExamples: allDuplicateExamples.slice(0, DUPLICATE_EXAMPLE_LIMIT),
    duplicateExtraRows,
    sourceIdCollisionExtraRows,
    dbAccessOk,
    sampled: anySampled,
    mediaTelemetry: input.mediaTelemetry,
  }

  // 报告本身也走原子写：中断/崩溃时要么是上一份完整报告、要么没有，
  // 不会留下半个 JSON 让"打开报告"打不开。
  try {
    await atomicWriteFile(path.join(outputRoot, INTEGRITY_REPORT_FILE_NAME), `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  } catch (error) {
    notes.push(`integrity-report.json 写入失败：${String(error)}`)
  }
  return report
}

/** 写一份"自检没能跑起来"的报告（导出结束时自检抛异常时调用），保证 UI 总能看到一个结论。 */
export async function writeIntegrityFailureReport(input: {
  wxid: string
  outputRoot: string
  ledgerEntries: number
  error: string
  now?: number
}): Promise<IntegrityReport> {
  const now = Number.isFinite(input.now) ? Math.floor(Number(input.now)) : Date.now()
  const report = makeEmptyReport({
    wxid: input.wxid,
    outputRoot: path.resolve(input.outputRoot),
    ledgerEntries: input.ledgerEntries,
    now,
    notes: [`自检未能运行完成：${input.error}`],
  })
  report.dbAccessOk = false
  try {
    await atomicWriteFile(
      path.join(report.outputRoot, INTEGRITY_REPORT_FILE_NAME),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf-8',
    )
  } catch {
    /* 连报告都写不了就只能靠调用方日志了 */
  }
  return report
}

async function resolveRowSenders(rows: IntegrityMessageRow[], db: IntegrityDbAccess): Promise<void> {
  const cache = new Map<string, string | null>()
  const pending = new Map<string, IntegrityMessageRow[]>()
  for (const row of rows) {
    if (row.isSend) continue
    if (row.senderUsername) continue
    // 已经解析过的行不重复解析，更不允许被后一次的 null 覆盖掉（那会把
    // "解析到了"变成"解析不到"，凭空造出一个归属缺口）。
    if (row.resolvedUsername !== undefined && row.resolvedUsername !== null && String(row.resolvedUsername).trim()) continue
    if (!row.realSenderId || !row.dbPath) continue
    const key = `${row.dbPath}\u001f${row.realSenderId}`
    const list = pending.get(key)
    if (list) {
      list.push(row)
      continue
    }
    pending.set(key, [row])
  }
  for (const [key, list] of pending) {
    const separator = key.lastIndexOf('\u001f')
    const dbPath = key.slice(0, separator)
    const senderId = Number(key.slice(separator + 1))
    let resolved: string | null = null
    try {
      resolved = await db.resolveSenderUsername(dbPath, senderId)
    } catch {
      resolved = null
    }
    cache.set(key, resolved)
    for (const row of list) {
      if (row.resolvedUsername === undefined) row.resolvedUsername = resolved
    }
  }
}

async function verifySessionArtifacts(
  fingerprints: ArtifactFingerprint[],
  sessionNotes: string[],
): Promise<ArtifactIntegrityReport> {
  const failures: ArtifactIntegrityReport['failures'] = []
  let hashSkipped = 0
  for (const fingerprint of fingerprints) {
    if (!fingerprint.path) continue
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(fingerprint.path)
    } catch {
      failures.push({
        path: fingerprint.path,
        reason: 'missing',
        expectedBytes: fingerprint.bytes,
      })
      continue
    }
    if (Number.isFinite(fingerprint.bytes) && stat.size !== Math.floor(Number(fingerprint.bytes))) {
      failures.push({
        path: fingerprint.path,
        reason: 'size-mismatch',
        expectedBytes: fingerprint.bytes,
        actualBytes: stat.size,
      })
      continue
    }
    if (fingerprint.sha256 && stat.size <= MAX_HASH_BYTES) {
      const verification = await verifyArtifact(fingerprint.path, {
        bytes: fingerprint.bytes,
        sha256: fingerprint.sha256,
      })
      if (!verification.ok) {
        failures.push({
          path: fingerprint.path,
          reason: verification.reason || 'sha-mismatch',
          expectedBytes: fingerprint.bytes,
          actualBytes: verification.bytes,
        })
      }
      continue
    }
    if (fingerprint.sha256) {
      hashSkipped += 1
      sessionNotes.push(`产物 ${path.basename(fingerprint.path)} 超过 ${Math.floor(MAX_HASH_BYTES / 1024 / 1024)}MB，只比字节数不算 sha256`)
    }
  }
  return {
    checked: fingerprints.length,
    ok: failures.length === 0,
    failures,
    hashSkipped,
  }
}

/**
 * 对**已经存在**的导出目录重跑一次自检（不重新导出）。
 *
 * 会话清单来自 `export-manifest.json`，产物指纹来自 `$.weport-export-ledger.jsonl` ——
 * 两者都是导出自己留下的记录，所以重跑自检不需要用户再选一次会话。
 * 已知限制（写进 notes，不假装知道）：manifest 里没有原始的时间范围/发送人筛选，
 * 因此重跑时一律按"分片导出"处理（`scoped: true`，只做上界校验）；这种情况下
 * 产物被截断靠的是**账本指纹（字节数 + sha256）**命中，而不是行数比对。
 */
export async function runIntegrityCheckForExportRoot(
  outputRoot: string,
  options: { db?: IntegrityDbAccess; now?: number } = {},
): Promise<{ success: boolean; report?: IntegrityReport; error?: string }> {
  const root = path.resolve(String(outputRoot || '').trim())
  if (!root) return { success: false, error: '未指定导出目录' }
  // 清单跟着产物写在格式子目录里，调用方给的常常只是导出根目录 —— 两处都找（见 findExportArtifact）。
  const found = await findExportArtifact(root, 'export-manifest.json')
  const manifestPath = found ?? path.join(root, 'export-manifest.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8')) as Record<string, unknown>
  } catch (error) {
    return { success: false, error: `读取导出清单失败（${manifestPath}）：${String(error)}` }
  }
  const units = Array.isArray(manifest.units) ? manifest.units as Array<Record<string, unknown>> : []
  const format = String(manifest.format || '')
  const bySession = new Map<string, Array<{ path: string; bytes?: number; sha256?: string }>>()
  for (const unit of units) {
    const sessionId = String(unit?.sessionId || '').trim()
    const artifact = String(unit?.artifact || '').trim()
    if (!sessionId || !artifact) continue
    const list = bySession.get(sessionId)
    /**
     * 清单里的 `artifact` 按**当时的绝对路径**写；用户把导出目录整个拷走/换盘之后这些路径
     * 全都不存在了，于是重跑自检会把每一行都报成 `missing` —— 报告说的不是"产物有问题"，
     * 而是"你搬过家"。这里以**清单所在目录**为基准重算，并拒绝跳出导出目录的路径
     * （`../..` 这种不该出现在清单里，出现时按可疑处理而不是去读导出目录之外的文件）。
     */
    const manifestDir = path.dirname(manifestPath)
    const absolute = path.resolve(manifestDir, artifact)
    const insideRoot = absolute === manifestDir || absolute.startsWith(manifestDir.endsWith(path.sep) ? manifestDir : manifestDir + path.sep)
    if (!insideRoot) return { success: false, error: '导出清单引用了目录之外的文件，请重新导出生成相对路径清单' }
    const entry = {
      path: absolute,
      bytes: Number.isFinite(Number(unit?.bytes)) ? Math.floor(Number(unit.bytes)) : undefined,
      sha256: typeof unit?.sha256 === 'string' ? unit.sha256 : undefined,
    }
    if (list) {
      list.push(entry)
      continue
    }
    bySession.set(sessionId, [entry])
  }
  if (bySession.size === 0) {
    return { success: false, error: `导出清单里没有任何单元（${manifestPath}）` }
  }

  const sessions: IntegritySessionInput[] = [...bySession.entries()].map(([sessionId, artifacts]) => ({
    sessionId,
    artifactPath: artifacts[0]?.path,
    format,
    sessionDir: artifacts[0]?.path ? path.dirname(artifacts[0].path) : undefined,
    // 未知原始筛选条件 → 只做上界校验；截断由账本指纹（bytes/sha256）命中。
    scoped: true,
    // 重跑自检不知道当时的媒体开关：全按"没请求"处理，避免把"当时没导媒体"
    // 报成"媒体缺失"（那是误报，不是发现）。
    mediaRequested: { enabled: false, images: false, voices: false, videos: false, emojis: false, files: false },
    artifactFingerprints: artifacts,
  }))

  const report = await runIntegrityCheck({
    wxid: '',
    // 报告写回**产物所在的那个目录**（格式子目录），不是导出根目录：否则第一份报告在
    // `TXT/`、重跑那份落在根上，同一个导出目录里散着两份报告。
    outputRoot: path.dirname(manifestPath),
    ledgerEntries: units.length,
    sessions,
    db: options.db,
    now: options.now,
    notes: ['重跑自检（未重新导出）：清单来自 export-manifest.json，产物指纹来自账本；'
      + '原始时间范围/发送人筛选不在清单里，因此总数只做上界校验，媒体覆盖不判定'],
  })
  return { success: true, report }
}

// ---------------------------------------------------------------------------
// 读取（IPC 用）
// ---------------------------------------------------------------------------

/**
 * 找一份导出产物：根目录**和**一层子目录都收，取**最新**的一份。
 *
 * 为什么要找：导出把 `export-manifest.json` / `.weport-export-ledger.jsonl` /
 * `integrity-report.json` 都写在**格式子目录**里（跟着产物在一起，整个目录拷走就是一份完整导出），
 * 而调用方（渲染层、IPC）手上通常只有"导出根目录"。`readIntegrityReport` 一直这么找，
 * `runIntegrityCheckForExportRoot` 原来只查根目录 —— 实测在真实导出上必然报
 * `读取导出清单失败：… ENOENT …export-manifest.json`，也就是"重跑自检"这个功能是坏的。
 * 两处现在共用这一份查找，行为一致。
 */
export async function findExportArtifact(root: string, fileName: string): Promise<string | null> {
  const candidates: Array<{ file: string; mtimeMs: number }> = []
  const collect = async (dir: string) => {
    const file = path.join(dir, fileName)
    try {
      const stat = await fs.promises.stat(file)
      if (stat.isFile()) candidates.push({ file, mtimeMs: stat.mtimeMs })
    } catch {
      /* 这里没有就算了，继续找下一处 */
    }
  }
  // 根目录**和**一层子目录都收，最后按修改时间取最新：只看"根目录没有才找子目录"的话，
  // 一份旧的根级报告（改格式之前那次导出留下的）会一直盖住格式子目录里的新报告。
  await collect(root)
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) await collect(path.join(root, entry.name))
    }
  } catch {
    /* 根目录读不了：只有已经收到的候选（多半没有） */
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0].file
}

/**
 * 读一份已落盘的自检报告。
 * 传入的可以是**导出根目录**（返回其中有报告的那个格式子目录里最新的一份），
 * 也可以直接是 `<…>/TXT` 这样的格式子目录。
 */
export async function readIntegrityReport(target: string): Promise<{
  success: boolean
  report?: IntegrityReport
  path?: string
  /** `missing-media.csv` 的绝对路径（存在才有），渲染层直接拿去 `shell.openPath`。 */
  csvPath?: string
  error?: string
}> {
  const resolved = path.resolve(String(target || '').trim())
  if (!resolved) return { success: false, error: '未指定导出目录' }
  const picked = await findExportArtifact(resolved, INTEGRITY_REPORT_FILE_NAME)
  if (!picked) {
    // 目录可能压根不存在（和下面 stat/readFile 的错误区分开：这里说的是"目录里没有报告"）
    try {
      await fs.promises.stat(resolved)
    } catch (error) {
      return { success: false, error: `导出目录不存在或不可读：${String(error)}` }
    }
    return { success: false, error: '该导出目录下还没有自检报告（integrity-report.json）' }
  }
  try {
    const parsed = JSON.parse(await fs.promises.readFile(picked, 'utf-8')) as IntegrityReport
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
      return { success: false, error: `报告形状不可识别：${picked}` }
    }
    // 报告里的 `missingMediaCsv` 是相对**报告所在目录**的，这里顺手解析成绝对路径，
    // 免得渲染层自己拼路径（拼错就点不开）。
    let csvPath: string | undefined
    if (typeof parsed.missingMediaCsv === 'string' && parsed.missingMediaCsv) {
      const candidate = path.resolve(path.dirname(picked), parsed.missingMediaCsv)
      try {
        const stat = await fs.promises.stat(candidate)
        if (stat.isFile()) csvPath = candidate
      } catch {
        /* CSV 不在就不给链接 */
      }
    }
    return { success: true, report: parsed, path: picked, csvPath }
  } catch (error) {
    return { success: false, error: `报告解析失败：${String(error)}` }
  }
}
