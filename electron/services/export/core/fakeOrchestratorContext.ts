/**
 * 集成测试用的假 ExportContext（v1.2 §10.1 验收）。
 *
 * 为什么需要它：真实数据通路要 `WeFlow.exe` + `wcdb_api.dll` + 一份真实 SQLCipher
 * `session.db` + 有效密钥，在 `npx vitest run` 里既拿不到（宿主名检查 -1006、
 * koffi FFI、真实密钥），也不该拿用户的库做试验。所以这里只替换**数据来源**：
 *
 * - `ensureConnected` / `getContactInfo` / `getSessionFilePrefix` 返回固定数据；
 * - `exportSessionToTxt`（本测试唯一用到的格式化器）用**真实的** `atomicWriteText`
 *   写出真实产物文件；
 * - `ledgerRecord` 的 bytes/sha256 用真实的 `fingerprintFile` 计算。
 *
 * 被验证的部分全是**真实代码**：ExportOrchestrator 的账本命中/校验/重导逻辑、
 * ledger.ts 的追加/读取/校验、atomicWrite.ts 的 tmp → fsync → os.replace、
 * 以及"中断后重跑 == 一次性导出"的字节级比较。
 *
 * 数据内容用一个可注入的"故障点"控制：`failAfterUnits` 之后的会话直接抛错，
 * 模拟中途被杀；已经在磁盘上的产物保持完整（这正是原子写要守的性质）。
 */
import * as fs from 'fs'
import * as path from 'path'
import crypto from 'crypto'
import type { ExportOptions, ExportProgress, ExportTaskControl, ExportDisplayProfile } from '../types'
import { atomicWriteText } from '../atomicWrite'
import type { ExportContext } from '../core/ExportContext'

export interface FakeSessionSeed {
  sessionId: string
  displayName: string
  messages: Array<{ id: number; ts: number; sender: string; text: string }>
}

export interface FakeOrchestratorContextOptions {
  /** 会话与消息（确定性，两次运行必须完全一致）。 */
  sessions: FakeSessionSeed[]
  /**
   * 从 1 开始计数：第 N 个会话的产物写完**之后**，后续会话直接抛错，
   * 模拟"导出到 60% 时进程被杀/盘满"。
   * 与真实的"格式化器返回 {success:false}"不同：抛错会让编排器把这一轮标记为
   * 中断（pendingSessionIds 非空），未处理的会话留给下一次续跑 —— 正是要验的场景。
   */
  failAfterUnits?: number
  /** 记录每个已导出会话，供断言"续跑只补缺口"。 */
  onSessionExported?: (sessionId: string) => void
}

export interface FakeOrchestratorContext {
  context: ExportContext
  /** 本次运行真正执行了导出的会话（不含账本跳过）。 */
  exportedSessions: string[]
  telemetry: {
    skips: number
    mismatches: Record<string, number>
  }
  /**
   * 产物写入实现。测试用 `vi.spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt')`
   * 把它接到编排器的原型方法上 —— 真实格式化器（TxtFormatter）会走 wcdbService 拉数据，
   * 纯 Node 测试里跑不了；这里替换的是"数据来源"，账本与原子写仍然是产品代码。
   */
  exportSessionImplementation: (
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void,
    control?: ExportTaskControl,
  ) => Promise<{ success: boolean; error?: string }>
}

/**
 * 造一个"够 ExportOrchestrator 用"的 context。
 * 只实现 orchestrator 真正会调用的那些方法；其余方法一律不存在（调用即 TypeError，
 * 这样 orchestrator 一旦多调了别的东西，测试会立刻炸，而不是悄悄走默认值）。
 */
export function createFakeOrchestratorContext(config: FakeOrchestratorContextOptions): FakeOrchestratorContext {
  const exportedSessions: string[] = []
  const telemetry = { skips: 0, mismatches: {} as Record<string, number> }
  let unitCounter = 0

  const profileOf = (sessionId: string): ExportDisplayProfile => {
    const seed = config.sessions.find((item) => item.sessionId === sessionId)
    const displayName = seed?.displayName || sessionId
    return {
      wxid: sessionId,
      nickname: displayName,
      remark: '',
      alias: '',
      groupNickname: '',
      displayName,
    }
  }

  /** 产物写入实现（见 FakeOrchestratorContext.exportSessionImplementation 的说明）。 */
  const exportSessionImplementation: FakeOrchestratorContext['exportSessionImplementation'] = async (
    sessionId,
    outputPath,
    _options,
    onProgress,
    control,
  ) => {
    unitCounter += 1
    if (typeof config.failAfterUnits === 'number' && unitCounter > config.failAfterUnits) {
      // 已经导完 failAfterUnits 个单元，之后一律"中断"：抛错而不是返回失败，
      // 因为要验的是"进程被杀"（未处理的会话留给续跑），而不是"某个会话导出失败"
      throw new Error(`simulated-kill-after-${config.failAfterUnits}`)
    }
    if (control?.shouldStop?.()) throw new Error('WEFLOW_EXPORT_STOP_REQUESTED')
    const seed = config.sessions.find((item) => item.sessionId === sessionId)
    if (!seed) return { success: false, error: `未找到会话 ${sessionId}` }
    onProgress?.({
      current: 0,
      total: 100,
      currentSession: seed.displayName,
      currentSessionId: sessionId,
      phase: 'exporting',
    })
    const lines = seed.messages.map((message) => `${message.ts}\t${message.sender}\t${message.text}`)
    // 真实产物 + 真实原子写：中断时要么是完整上一份、要么什么都没有
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
    await atomicWriteText(outputPath, `${lines.join('\n')}\n`)
    exportedSessions.push(sessionId)
    config.onSessionExported?.(sessionId)
    onProgress?.({
      current: 100,
      total: 100,
      currentSession: seed.displayName,
      currentSessionId: sessionId,
      phase: 'complete',
      exportedMessages: seed.messages.length,
    })
    return { success: true }
  }

  const fake = {
    async getSourceFingerprint() { return crypto.createHash('sha256').update(JSON.stringify(config.sessions)).digest('hex') },
    getMediaDoneFilesCount: () => 0,
    integrityDbAccess: {
      async getTableStats(sessionId: string) {
        return { success: true, tables: [{ dbName: 'fixture.db', dbPath: 'fixture.db', tableName: 'Msg_fixture', count: config.sessions.find(s => s.sessionId === sessionId)?.messages.length || 0 }] }
      },
      async getSessionMessageCount(sessionId: string) { return { success: true, count: config.sessions.find(s => s.sessionId === sessionId)?.messages.length || 0 } },
      async getSessionCounter(sessionId: string) { return { success: true, count: config.sessions.find(s => s.sessionId === sessionId)?.messages.length || 0 } },
      async scanMessages(sessionId: string) {
        const seed = config.sessions.find(s => s.sessionId === sessionId)
        return { success: true, truncated: false, rows: (seed?.messages || []).map(message => ({ sessionId, localId: message.id, createTime: message.ts, localType: 1, isSend: message.sender === 'wxid_me', senderUsername: message.sender, content: message.text, dbPath: 'fixture.db', tableName: 'Msg_fixture' })) }
      },
      async resolveSenderUsername(_db: string, senderId: number) { return String(senderId) },
      async listSessionIds() { return config.sessions.map(s => s.sessionId) },
    },
    // --- 连接与元数据 ---
    async ensureConnected() {
      return { success: true, cleanedWxid: 'wxid_me' }
    },
    async getContactInfo(sessionId: string) {
      return { displayName: profileOf(sessionId).displayName, username: sessionId }
    },
    async getSessionFilePrefix() {
      return ''
    },

    // --- 选项归一化 ---
    normalizeExportOptionsForRun(input: ExportOptions): ExportOptions {
      return { ...input }
    },
    isMediaContentBatchExport() {
      return false
    },
    isMediaExportEnabled() {
      return false
    },
    resolveExportWriteLayout() {
      return 'B' as const
    },
    isUnboundedDateRange(dateRange?: { start: number; end: number } | null) {
      return !dateRange || (!dateRange.start && !dateRange.end)
    },
    buildExportStatsCacheKey() {
      return 'fake'
    },
    getExportStatsCacheEntry() {
      return null
    },
    configureSharedMediaConcurrency() {
      /* noop */
    },
    triggerMediaFileCacheCleanup() {
      /* noop */
    },

    // --- 遥测（或chestrator 只读这两个字段） ---
    getMediaTelemetrySnapshot() {
      return { mediaImageKeyMissingFiles: 0, mediaVoiceFailedFiles: 0 }
    },
    resetMediaRuntimeState() {
      /* noop */
    },
    clearMediaRuntimeState() {
      /* noop */
    },

    // --- 账本遥测 ---
    resetLedgerRuntimeState() {
      telemetry.skips = 0
      telemetry.mismatches = {}
    },
    loadLedgerMediaIndex() {
      /* 本用例不涉及媒体导出 */
    },
    noteLedgerSkip() {
      telemetry.skips += 1
    },
    noteLedgerMismatch(reason: string) {
      telemetry.mismatches[reason] = (telemetry.mismatches[reason] || 0) + 1
    },

    // --- 进度与错误判定 ---
    createProgressEmitter(onProgress?: (progress: ExportProgress) => void) {
      return {
        emit: (progress: ExportProgress) => { onProgress?.(progress) },
        flush: () => { /* noop */ },
      }
    },
    throwIfStopRequested(control?: ExportTaskControl) {
      if (control?.shouldStop?.()) throw new Error('WEFLOW_EXPORT_STOP_REQUESTED')
      if (control?.shouldPause?.()) throw new Error('WEFLOW_EXPORT_PAUSE_REQUESTED')
    },
    isStopError(error: unknown) {
      return String(error).includes('WEFLOW_EXPORT_STOP_REQUESTED')
    },
    isPauseError(error: unknown) {
      return String(error).includes('WEFLOW_EXPORT_PAUSE_REQUESTED')
    },

    // --- 真实原子写（这份是产品代码，不是替身） ---
    async writeArtifactFile(outputPath: string, data: string | Buffer) {
      return atomicWriteText(outputPath, String(data))
    },
  }

  // 其余格式化器（json/html/excel/...）本用例不导出；给出显式失败，避免"看起来成功"
  const unsupportedFormatter = async () => ({ success: false, error: '集成测试只实现 txt 格式化器' })

  const context = {
    ...fake,
    exportSessionToDetailedJson: unsupportedFormatter,
    exportSessionToChatLab: unsupportedFormatter,
    exportSessionToExcel: unsupportedFormatter,
    exportSessionToMarkdown: unsupportedFormatter,
    exportSessionToWeCloneCsv: unsupportedFormatter,
    exportSessionToHtml: unsupportedFormatter,
    exportSessionToSql: unsupportedFormatter,
  }

  return {
    context: context as unknown as ExportContext,
    exportedSessions,
    telemetry,
    exportSessionImplementation,
  }
}

/** 确定性种子数据（两次运行逐字节一致）。 */
export function buildDeterministicSessions(count: number, messagesPerSession = 12): FakeSessionSeed[] {
  const sessions: FakeSessionSeed[] = []
  for (let i = 0; i < count; i += 1) {
    const sessionId = `wxid_user_${String(i).padStart(3, '0')}`
    const messages = []
    for (let j = 0; j < messagesPerSession; j += 1) {
      messages.push({
        id: i * 1000 + j,
        ts: 1700000000 + i * 86400 + j * 60,
        sender: j % 2 === 0 ? sessionId : 'wxid_me',
        text: `session ${i} message ${j} — 中文内容与 emoji 🙂 混排`,
      })
    }
    sessions.push({ sessionId, displayName: `会话${i}`, messages })
  }
  return sessions
}

/** 目录快照：相对路径 → {bytes, sha256}，用于字节级比较。 */
export async function snapshotDirectory(rootDir: string): Promise<Map<string, { bytes: number; sha256: string }>> {
  const out = new Map<string, { bytes: number; sha256: string }>()
  const stack = [path.resolve(rootDir)]
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
      const buffer = await fs.promises.readFile(full)
      out.set(path.relative(rootDir, full).split(path.sep).join('/'), {
        bytes: buffer.byteLength,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      })
    }
  }
  return out
}
