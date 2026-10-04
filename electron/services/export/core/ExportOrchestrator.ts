import { ExportOptions, ExportProgress, ExportTaskControl } from '../types';
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
// 这里原本 import 了 exceljs 却从未使用 —— 它把 18MB 的库拉进主进程启动图。
// XLSX 的实际写入在 ExcelFormatter / ExportContext，那里按需动态加载。
import { getEmojiPath } from 'wechat-emojis'
import { ConfigService } from '../../config'
import { wcdbService } from '../../wcdbService'
import { imageDecryptService } from '../../imageDecryptService'
import { chatService } from '../../chatService'
import { exportRecordService } from '../../exportRecordService'
import { EXPORT_HTML_STYLES } from '../../exportHtmlStyles'
import { LRUCache } from '../../../utils/LRUCache.js'
import { normalizeTimestampSeconds, formatTimestamp, formatIsoTimestamp, parseCompactDateTimeDigitsToSeconds, parseDateTimeTextToSeconds, normalizeExportDateRange, normalizeRowTimestampSeconds, getTimestampSecondsFromRow } from '../../export/utils/timestamp';
import { escapeHtml, escapeAttribute, renderMultilineText, decodeHtmlEntities } from '../../export/utils/htmlEscape';
import { sanitizeExportFileNamePart, resolveFileAttachmentExtensionDir, normalizeExportConflictStrategy, formatDateTokenBySeconds, buildDateRangeFileNamePart, buildSessionExportBaseName, reserveUniqueOutputPath } from '../../export/utils/fileNaming';
import { extractXmlValue, extractXmlAttribute, extractAppMessageType, normalizeAppMessageContent } from '../../export/parsers/xmlExtractor';
import { decodeMessageContent, decodeMaybeCompressed, decodeBinaryContent, looksLikeHex, looksLikeBase64 } from '../../export/parsers/contentDecoder';
import { parseVoipMessage } from '../../export/parsers/voipParser';
import { resolveTransferDesc, getTransferPrefix, isTransferExportContent, appendTransferDesc, extractAmountFromText, isSameWxid } from '../../export/parsers/transferParser';
import { looksLikeWxid, sanitizeQuotedContent, parseQuoteMessage } from '../../export/parsers/quoteParser';
import { parseChatHistory, formatForwardChatRecordContent } from '../../export/parsers/forwardRecordParser';
import { formatEmojiSemanticText, extractLooseHexMd5, normalizeEmojiCaption } from '../../export/parsers/fileAppParser';
import { stripSenderPrefix, cleanSystemMessage, extractReadableSystemMessageText, parseDurationSeconds } from '../../export/parsers/messageParser';
import { getPreferredDisplayName, resolveExportDisplayProfile } from '../../export/contacts/contactResolver';
import { resolveGroupNicknameByCandidates, buildGroupNicknameIdCandidates, normalizeGroupNicknameIdentity, normalizeGroupNickname } from '../../export/contacts/groupNickname';
import { getAvatarFallback } from '../../export/contacts/avatarHelper';
import { pathExists, ensureExportDir, copyFileOptimized, hardlinkOrCopyFile } from '../../export/media/fileCopy';
import { getMediaFileStat } from '../../export/media/attachmentResolver';
import { runBoundedPool } from '../../export/utils/parallelLimit';
import {
  ExportLedger,
  LEDGER_FILE_NAME,
  fingerprintFile,
  toLedgerRelativePath,
  unitKeyOf,
  verifyArtifact,
} from '../ledger';
import { cleanupStaleAtomicTemps } from '../atomicWrite';
import { hashFileContent } from '../mediaDedupeCache';
import { runIntegrityCheck, writeIntegrityFailureReport } from '../integrityChecker';
import { ExportContext } from "../core/ExportContext";
import { CONFIRMED_EMPTY_SESSION_SKIP } from './emptySession'
import { optionsFingerprint } from '../sourceFingerprint';
import { ChatLabFormatter } from '../formatters/ChatLabFormatter';
import { ExcelFormatter } from '../formatters/ExcelFormatter';
import { HtmlFormatter } from '../formatters/HtmlFormatter';
import { JsonFormatter } from '../formatters/JsonFormatter';
import { MarkdownFormatter } from '../formatters/MarkdownFormatter';
import { SqlFormatter } from '../formatters/SqlFormatter';
import { TxtFormatter } from '../formatters/TxtFormatter';
import { WeCloneFormatter } from '../formatters/WeCloneFormatter';

/**
 * v1.2 §10.1 ①：收集某个会话目录下的媒体文件内容哈希（账本 `mediaHashes`）。
 * 只读导出目录、只写账本；路径统一成**相对导出根目录**的 POSIX 形式，
 * 这样换导出目录/换布局后哈希仍然可比。顺序按路径排序，保证两次运行产出同一份清单。
 */
async function collectMediaHashes(
  exportRootDir: string,
  sessionDir: string,
): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const root = path.resolve(sessionDir)
  const files: string[] = []
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
      // 账本自己的文件不算媒体
      if (entry.name === LEDGER_FILE_NAME) continue
      files.push(full)
    }
  }
  files.sort((a, b) => a.localeCompare(b))
  const out: Array<{ path: string; sha256: string; bytes: number }> = []
  for (const file of files) {
    const hash = await hashFileContent(file)
    if (!hash) continue
    out.push({
      path: toLedgerRelativePath(exportRootDir, file),
      sha256: hash.sha256,
      bytes: hash.bytes,
    })
  }
  return out
}

/**
 * 账本超过这么多条就压缩一次。
 *
 * 账本是"一次追加一行"的 JSONL，每次运行都要整份读回再逐行 JSON.parse：条目越多，续跑的固定
 * 开销越大，而且文件本身也会一直长。2000 条大约对应"几百个会话跑过几轮"，压一次的写放大
 * 可以忽略，而它换来的是稳定的续跑时间。
 */
const LEDGER_COMPACT_MIN_ENTRIES = 2000

export class ExportOrchestrator {
    constructor(public context: ExportContext) {
    }

    /**
     * v1.2 §10.1 ①：导出根目录的清单。走原子写（tmp → fsync → os.replace），
     * 中断时要么是上一份完整清单、要么没有，不会留下半截 JSON。
     * 内容刻意**不含**时间戳/耗时：它描述"产出物集合"，续跑与一次性导出应当得到同一份清单
     * （`taskId` 会变，所以比较时忽略它）。
     */
    private async writeExportRootManifest(params: {
        outputDir: string
        format: string
        taskId: string
        ledgerIndex: Map<string, { sessionId: string; bytes: number; sha256: string; outputPath?: string; at?: number }>
    }): Promise<void> {
        const { outputDir, format, taskId, ledgerIndex } = params
        const latestByPath = new Map<string, { sessionId: string; bytes: number; sha256: string; outputPath?: string; at?: number }>()
        for (const unit of ledgerIndex.values()) {
          if (!unit.outputPath) continue
          const key = path.resolve(unit.outputPath)
          const previous = latestByPath.get(key)
          if (!previous || (unit.at || 0) >= (previous.at || 0)) latestByPath.set(key, unit)
        }
        const units = [...latestByPath.values()]
            .filter((unit) => unit.outputPath)
            .map((unit) => ({
                sessionId: unit.sessionId,
                artifact: path.relative(outputDir, unit.outputPath as string).split(path.sep).join('/'),
                bytes: unit.bytes,
                sha256: unit.sha256,
            }))
            .sort((a, b) => a.artifact.localeCompare(b.artifact) || a.sessionId.localeCompare(b.sessionId))
        const manifest = {
            v: 1,
            generator: 'weport-export',
            format,
            taskId,
            unitCount: units.length,
            units,
        }
        await this.context.writeArtifactFile(path.join(outputDir, 'export-manifest.json'), JSON.stringify(manifest, null, 2))
    }

    /**
     * 账本单元键的"产物"维度（§10.1：会话 × 时间分片 × 产物）。
     * 形状是 `<格式>#<同名序号>`：
     * - 格式进键 → 换格式导出不会把上一次的产物当成"已完成"；
     * - 同名序号进键 → 两个同名会话（如多个「一家人」群）各自一条，互不覆盖。
     * 序号按会话在本次列表里的**出现顺序**给定（`runOne` 一进来就取号，见调用处），
     * 不按完成顺序 —— 会话是并发导出的，按完成顺序编号会让中断前后的键不一致，
     * 续跑直接失效。
     */
    private nextLedgerDiscriminator(sessionId: string, sequence: Map<string, number>): string {
        const next = (sequence.get(sessionId) || 0) + 1
        sequence.set(sessionId, next)
        return String(next)
    }

    /**
     * issue #15/#5b：读取本次运行的缺图片密钥计数。
     * 必须在 clearMediaRuntimeState() 之前调用（finally 会清掉遥测）。
     */
    private getRunImageKeyMissingCount(): number {
        const raw = Number(this.context.getMediaTelemetrySnapshot().mediaImageKeyMissingFiles || 0)
        return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
    }

    /** issue #22：语音拿不到数据而跳过的条数。 */
    private getRunVoiceFailedCount(): number {
        const raw = Number(this.context.getMediaTelemetrySnapshot().mediaVoiceFailedFiles || 0)
        return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
    }

    /**
     * 导出单个会话为 ChatLab 格式（并行优化版本）
     */
    async exportSessionToChatLab(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new ChatLabFormatter(this.context);
        return formatter.export(sessionId, outputPath, options, onProgress, control);
    }

    /**
     * 导出单个会话为详细 JSON 格式（原项目格式）- 并行优化版本
     */
    async exportSessionToDetailedJson(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new JsonFormatter(this.context);
        return formatter.export(sessionId, outputPath, options, onProgress, control);
    }

    /**
     * 导出单个会话为 Excel 格式（参考 echotrace 格式）
     */
    async exportSessionToExcel(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new ExcelFormatter(this.context);
        return formatter.export(sessionId, outputPath, options, onProgress, control);
    }

    /**
     * 导出单个会话为 TXT 格式（默认与 Excel 精简列一致）
     */
    async exportSessionToTxt(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new TxtFormatter(this.context);
        return formatter.export(sessionId, outputPath, options, onProgress, control);
    }

    /**
     * 导出单个会话为 WeClone CSV 格式
     */
    async exportSessionToWeCloneCsv(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new WeCloneFormatter(this.context);
        return formatter.export(sessionId, outputPath, options, onProgress, control);
    }

    /**
     * 导出单个会话为 HTML 格式
     */
    async exportSessionToHtml(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new HtmlFormatter(this.context);
        return formatter.export(sessionId, outputPath, options, onProgress, control);
    }

    /**
     * 导出单个会话为 Markdown 格式
     */
    async exportSessionToMarkdown(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new MarkdownFormatter(this.context);
        return formatter.export(sessionId, outputPath, options, onProgress, control);
    }

    /**
     * 导出单个会话为 PostgreSQL SQL 脚本
     */
    async exportSessionToSql(sessionId: string, outputPath: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{ success: boolean; error?: string }> {
        const formatter = new SqlFormatter(this.context);
        return formatter.export(sessionId, outputPath, options, onProgress, control);
    }

    /**
     * 批量导出多个会话
     */
    async exportSessions(sessionIds: string[], outputDir: string, options: ExportOptions, onProgress?: (progress: ExportProgress) => void, control?: ExportTaskControl): Promise<{
        success: boolean
        successCount: number
        failCount: number
        paused?: boolean
        stopped?: boolean
        pendingSessionIds?: string[]
        successSessionIds?: string[]
        failedSessionIds?: string[]
        failedSessionErrors?: Record<string, string>
        sessionOutputPaths?: Record<string, string>
        emptySkippedSessionIds?: string[]
        // issue #15/#5b：因缺图片解密密钥而显示为 [图片] 占位符的消息数。
        imageKeyMissingFiles?: number
        // issue #22：语音数据拿不到而没能导出成文件的条数。
        voiceFailedFiles?: number
        error?: string
        }> {
        let successCount = 0;
        let failCount = 0;
        const successSessionIds: string[] = [];
        const failedSessionIds: string[] = [];
        const failedSessionErrors: Record<string, string> = {};
        const sessionOutputPaths: Record<string, string> = {};
        const emptySkippedSessionIds: string[] = []
        // 同一次导出运行内已占用的输出路径（跨会话去重）。
        // 两个同名会话（如多个「一家人」群）在 overwrite/incremental 模式下
        // 会算出完全相同的输出路径，后一个会把前一个的导出结果整个覆盖掉。
        const claimedOutputPaths = new Set<string>();
        const progressEmitter = this.context.createProgressEmitter(onProgress);
        let attachMediaTelemetry = false;
        const emitProgress = (progress: ExportProgress, options?: { force?: boolean }) => {
                  const payload = attachMediaTelemetry
                    ? { ...progress, ...this.context.getMediaTelemetrySnapshot() }
                    : progress
                  progressEmitter.emit(payload, options)
                };
        try {
          const conn = await this.context.ensureConnected()
          if (!conn.success) {
            return { success: false, successCount: 0, failCount: sessionIds.length, imageKeyMissingFiles: 0, voiceFailedFiles: 0, error: conn.error }
          }

          this.context.resetMediaRuntimeState()
          const normalizedOptions = this.context.normalizeExportOptionsForRun(options)
          const effectiveOptions: ExportOptions = this.context.isMediaContentBatchExport(normalizedOptions)
            ? { ...normalizedOptions, exportVoiceAsText: false }
            : normalizedOptions
          const sourceWatermark = await this.context.getSourceFingerprint(effectiveOptions.exportMedia === true || effectiveOptions.exportAvatars === true)
          const conflictStrategy = normalizeExportConflictStrategy(effectiveOptions.exportConflictStrategy)

          // ---- §10.1 ①：导出账本（可续跑）--------------------------------------
          // 账本落在导出根目录。读不出来只意味着"这次全量重导"，不能让导出失败。
          //
          // 单元键（会话 × 时间分片 × 产物）里**不含** taskId —— taskId 是会变的运行标识，
          // 进键的话每次重跑都是新键，续跑永远命中不了。taskId 只写进每一行当来源留痕。
          const ledger = new ExportLedger(outputDir)
          const taskId = `export-${Date.now()}-${process.pid}`
          const ledgerIndex = await ledger.buildIndex()          // 账本里所有会话的媒体清单合起来作为本次去重基础：续跑时后一个会话也能命中前面会话写过的媒体
          const runMediaHashes: Array<{ path: string; sha256: string; bytes: number }> = []
          for (const unit of ledgerIndex.values()) {
            if (!Array.isArray(unit.mediaHashes)) continue
            for (const mediaEntry of unit.mediaHashes) {
              if (!runMediaHashes.some((existing) => existing.path === mediaEntry.path)) {
                runMediaHashes.push({ path: mediaEntry.path, sha256: mediaEntry.sha256, bytes: mediaEntry.bytes })
              }
            }
          }
          // 账本里的媒体路径是**相对 `exportBaseDir`** 的（`collectMediaHashes(exportBaseDir, …)`），
          // 所以内容寻址表的根也必须是 `exportBaseDir`。以前这里传的是 `outputDir`：布局 B
          // 两者相同、看不出问题；布局 A（exportBaseDir = `<outputDir>/texts`）就整体高了一级，
          // `resolveAbsolute` 还原出来的路径全错 —— 续跑时媒体去重**静默失效**，同一张图被重复
          // 解密/复制，而界面与日志都看不出来。
          const writeLayout = this.context.resolveExportWriteLayout(effectiveOptions)
          const exportBaseDir = writeLayout === 'A' ? path.join(outputDir, 'texts') : outputDir
          this.context.resetLedgerRuntimeState()
          this.context.loadLedgerMediaIndex(runMediaHashes, exportBaseDir)
          const ledgerSequence = new Map<string, number>()

          const exportMediaEnabled = this.context.isMediaExportEnabled(effectiveOptions)
          attachMediaTelemetry = exportMediaEnabled
          if (exportMediaEnabled) {
            this.context.triggerMediaFileCacheCleanup()
          }
          // 上次崩溃留下的 `.tmp-<pid>` 在开始写之前清掉：它们既不是产物，
          // 也不该被续跑的"文件已存在"判定当成产物（必须在 exportBaseDir 之后）。
          const staleTemps = await cleanupStaleAtomicTemps(exportBaseDir).catch(() => [] as string[])
          if (staleTemps.length > 0) {
            console.info(`[Export] cleaned ${staleTemps.length} stale atomic temp file(s)`)
          }
          const createdTaskDirs = new Set<string>()
          const reservedOutputPaths = new Set<string>()
          const ensureTaskDir = async (dirPath: string) => {
            if (createdTaskDirs.has(dirPath)) return
            await ensureExportDir(dirPath, control)
            createdTaskDirs.add(dirPath)
          }
          await ensureTaskDir(exportBaseDir)
          // 显式指定了 sessionLayout 时一律尊重（目录结构 C = 按会话分目录，
          // 纯文本导出也需要 per-session 才能真正区分 B/C）；否则按媒体开关兜底
          const sessionLayout = effectiveOptions.sessionLayout
            ?? (exportMediaEnabled ? 'per-session' : 'shared')
          let completedCount = 0
          const activeSessionRatios = new Map<string, number>()
          // §10.2 ②：自检要用到的两样东西 —— 每个会话的产物目录（限定媒体搜索范围）
          // 与格式器自报的写出行数（产物不可解析时的兜底计数）。
          const sessionDirs = new Map<string, string>()
          const exportedMessageHints = new Map<string, number>()
          const computeAggregateCurrent = () => {
            let activeRatioSum = 0
            for (const ratio of activeSessionRatios.values()) {
              activeRatioSum += Math.max(0, Math.min(1, ratio))
            }
            return Math.min(sessionIds.length, completedCount + activeRatioSum)
          }
          const isTextContentBatchExport = effectiveOptions.contentType === 'text' && !exportMediaEnabled
          const defaultConcurrency = exportMediaEnabled ? 2 : 4
          const rawConcurrency = typeof effectiveOptions.exportConcurrency === 'number'
            ? Math.floor(effectiveOptions.exportConcurrency)
            : defaultConcurrency
          // Text exports are safe to overlap at the session boundary. Media
          // exports keep a smaller outer pool because each formatter already
          // has its own bounded media/voice pools.
          const maxSessionConcurrency = exportMediaEnabled ? 2 : 10
          const clampedConcurrency = Math.max(1, Math.min(rawConcurrency, maxSessionConcurrency))
          const sessionConcurrency = clampedConcurrency
          this.context.configureSharedMediaConcurrency(exportMediaEnabled ? Math.min(6, Math.max(1, rawConcurrency)) : 1)
          let activeSessionWorkers = 0
          let peakSessionWorkers = 0
          let queue = [...sessionIds]
          let pauseRequested = false
          let stopRequested = false
          const sessionMessageCountHints = new Map<string, number>()
          const sessionLatestTimestampHints = new Map<string, number>()
          const exportStatsCacheKey = this.context.buildExportStatsCacheKey(sessionIds, effectiveOptions, conn.cleanedWxid)
          const cachedStatsEntry = this.context.getExportStatsCacheEntry(exportStatsCacheKey)
          if (cachedStatsEntry?.sessions) {
            for (const sessionId of sessionIds) {
              const snapshot = cachedStatsEntry.sessions[sessionId]
              if (!snapshot) continue
              sessionMessageCountHints.set(sessionId, Math.max(0, Math.floor(snapshot.totalCount || 0)))
              if (Number.isFinite(snapshot.lastTimestamp) && Number(snapshot.lastTimestamp) > 0) {
                sessionLatestTimestampHints.set(sessionId, Math.floor(Number(snapshot.lastTimestamp)))
              }
            }
          }
          const canUseSessionSnapshotHints = isTextContentBatchExport &&
            this.context.isUnboundedDateRange(effectiveOptions.dateRange) &&
            !String(effectiveOptions.senderUsername || '').trim()
          const canFastSkipEmptySessions = false
          const precheckSessionIds = canFastSkipEmptySessions
            ? sessionIds.filter((sessionId) => !sessionMessageCountHints.has(sessionId))
            : []
          if (canFastSkipEmptySessions && precheckSessionIds.length > 0) {
            const EMPTY_SESSION_PRECHECK_LIMIT = 1200
            if (precheckSessionIds.length <= EMPTY_SESSION_PRECHECK_LIMIT) {
              let checkedCount = 0
              emitProgress({
                current: computeAggregateCurrent(),
                total: sessionIds.length,
                currentSession: '',
                currentSessionId: '',
                phase: 'preparing',
                phaseProgress: 0,
                phaseTotal: precheckSessionIds.length,
                phaseLabel: `预检查空会话 0/${precheckSessionIds.length}`
              })

              const PRECHECK_BATCH_SIZE = 160
              for (let i = 0; i < precheckSessionIds.length; i += PRECHECK_BATCH_SIZE) {
                if (control?.shouldStop?.()) {
                  stopRequested = true
                  break
                }
                if (control?.shouldPause?.()) {
                  pauseRequested = true
                  break
                }

                const batchSessionIds = precheckSessionIds.slice(i, i + PRECHECK_BATCH_SIZE)
                const countsResult = await wcdbService.getMessageCounts(batchSessionIds)
                if (countsResult.success && countsResult.counts) {
                  for (const batchSessionId of batchSessionIds) {
                    const count = countsResult.counts[batchSessionId]
                    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
                      sessionMessageCountHints.set(batchSessionId, Math.max(0, Math.floor(count)))
                    }
                  }
                }

                checkedCount = Math.min(precheckSessionIds.length, checkedCount + batchSessionIds.length)
                emitProgress({
                  current: computeAggregateCurrent(),
                  total: sessionIds.length,
                  currentSession: '',
                  currentSessionId: '',
                  phase: 'preparing',
                  phaseProgress: checkedCount,
                  phaseTotal: precheckSessionIds.length,
                  phaseLabel: `预检查空会话 ${checkedCount}/${precheckSessionIds.length}`
                })
              }
            } else {
              emitProgress({
                current: computeAggregateCurrent(),
                total: sessionIds.length,
                currentSession: '',
                currentSessionId: '',
                phase: 'preparing',
                phaseLabel: `会话较多，已跳过空会话预检查（${precheckSessionIds.length} 个）`
              })
            }
          }

          if (canUseSessionSnapshotHints && sessionIds.length > 0) {
            const missingHintSessionIds = sessionIds.filter((sessionId) => (
              !sessionMessageCountHints.has(sessionId) || !sessionLatestTimestampHints.has(sessionId)
            ))
            if (missingHintSessionIds.length > 0) {
              const sessionSet = new Set(missingHintSessionIds)
              const sessionsResult = await chatService.getSessions()
              if (sessionsResult.success && Array.isArray(sessionsResult.sessions)) {
                for (const item of sessionsResult.sessions) {
                  const username = String(item?.username || '').trim()
                  if (!username) continue
                  if (!sessionSet.has(username)) continue
                  const messageCountHint = Number(item?.messageCountHint)
                  if (
                    !sessionMessageCountHints.has(username) &&
                    Number.isFinite(messageCountHint) &&
                    messageCountHint >= 0
                  ) {
                    sessionMessageCountHints.set(username, Math.floor(messageCountHint))
                  }
                  const lastTimestamp = Number(item?.lastTimestamp)
                  if (
                    !sessionLatestTimestampHints.has(username) &&
                    Number.isFinite(lastTimestamp) &&
                    lastTimestamp > 0
                  ) {
                    sessionLatestTimestampHints.set(username, Math.floor(lastTimestamp))
                  }
                }
              }
            }
          }

          if (stopRequested) {
            return {
              success: true,
              successCount,
              failCount,
              stopped: true,
              pendingSessionIds: [...queue],
              successSessionIds,
              failedSessionIds,
              failedSessionErrors,
              sessionOutputPaths
            }
          }
          if (pauseRequested) {
            return {
              success: true,
              successCount,
              failCount,
              paused: true,
              pendingSessionIds: [...queue],
              successSessionIds,
              failedSessionIds,
              failedSessionErrors,
              sessionOutputPaths
            }
          }

          const runOne = async (sessionId: string): Promise<'done' | 'stopped' | 'paused'> => {
            try {
              this.context.throwIfStopRequested(control)
              const sessionInfo = await this.context.getContactInfo(sessionId)
              const messageCountHint = sessionMessageCountHints.get(sessionId)
              const latestTimestampHint = sessionLatestTimestampHints.get(sessionId)

              const sessionProgress = (progress: ExportProgress) => {
                if (Number.isFinite(progress.exportedMessages)) {
                  exportedMessageHints.set(sessionId, Math.max(0, Math.floor(Number(progress.exportedMessages))))
                }
                const phaseTotal = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : 100
                const phaseCurrent = Number.isFinite(progress.current) ? progress.current : 0
                const ratio = progress.phase === 'complete'
                  ? 1
                  : Math.max(0, Math.min(1, phaseCurrent / phaseTotal))
                activeSessionRatios.set(sessionId, ratio)
                emitProgress({
                  ...progress,
                  current: computeAggregateCurrent(),
                  total: sessionIds.length,
                  currentSession: sessionInfo.displayName,
                  currentSessionId: sessionId
                }, { force: progress.phase === 'complete' })
              }

              sessionProgress({
                current: 0,
                total: 100,
                currentSession: sessionInfo.displayName,
                phase: 'preparing',
                phaseLabel: '准备导出'
              })

              const safeName = buildSessionExportBaseName(sessionId, sessionInfo.displayName, effectiveOptions)
              const sessionNameWithTypePrefix = effectiveOptions.sessionNameWithTypePrefix !== false
              const sessionTypePrefix = sessionNameWithTypePrefix ? await this.context.getSessionFilePrefix(sessionId) : ''
              const fileNameWithPrefix = `${sessionTypePrefix}${safeName}`
              const useSessionFolder = sessionLayout === 'per-session'
              const sessionDirName = sessionNameWithTypePrefix ? `${sessionTypePrefix}${safeName}` : safeName
              const sessionDir = useSessionFolder ? path.join(exportBaseDir, sessionDirName) : exportBaseDir
              sessionDirs.set(sessionId, sessionDir)

              if (useSessionFolder) {
                await ensureTaskDir(sessionDir)
              }

              // ---- §10.1 ①：账本单元（会话 × 时间分片 × 产物）----------------
              // 分片维度取本次导出的日期范围：同一次运行里同一会话就是同一个分片，
              // 续跑时同样的选项算出同样的键，才能命中。
              const ledgerChunkStart = Number(effectiveOptions.dateRange?.start) || 0
              const ledgerChunkEnd = Number(effectiveOptions.dateRange?.end) || 0
              const ledgerArtifact = `${String(effectiveOptions.format || 'unknown')}#${optionsFingerprint({ account: conn.cleanedWxid, options: effectiveOptions })}#${this.nextLedgerDiscriminator(sessionId, ledgerSequence)}`
              const ledgerKey = unitKeyOf({
                sessionId,
                chunkStart: ledgerChunkStart,
                chunkEnd: ledgerChunkEnd,
                artifact: ledgerArtifact,
              })
              const ledgerRecord = ledgerIndex.get(ledgerKey)
              // 续跑：账本说这个单元完成过，且**磁盘上仍然是同一份内容**（bytes + sha256）才跳过。
              // 位置检查放在这里（preferredOutputPath 之前）：一旦命中就完全不碰新路径，
              // 避免两次运行因为文件名带时间戳而把同一份产物写到两个不同位置。
              if (sourceWatermark && ledgerRecord?.sourceFingerprint === sourceWatermark && ledgerRecord?.outputPath && !claimedOutputPaths.has(ledgerRecord.outputPath)) {
                const verification = await verifyArtifact(ledgerRecord.outputPath, {
                  bytes: ledgerRecord.bytes,
                  sha256: ledgerRecord.sha256,
                })
                if (verification.ok) {
                  if (ledgerRecord.messageCount !== undefined) exportedMessageHints.set(sessionId, ledgerRecord.messageCount)
                  successCount++
                  successSessionIds.push(sessionId)
                  sessionOutputPaths[sessionId] = ledgerRecord.outputPath
                  claimedOutputPaths.add(ledgerRecord.outputPath)
                  activeSessionRatios.delete(sessionId)
                  completedCount++
                  this.context.noteLedgerSkip()
                  emitProgress({
                    current: computeAggregateCurrent(),
                    total: sessionIds.length,
                    currentSession: sessionInfo.displayName,
                    currentSessionId: sessionId,
                    phase: 'complete',
                    phaseLabel: '账本已校验，跳过',
                    estimatedTotalMessages: Math.max(0, Math.floor(messageCountHint || 0)),
                    exportedMessages: Math.max(0, Math.floor(messageCountHint || 0))
                  }, { force: true })
                  return 'done'
                }
                // 文件不在/被改过 → 按"没导过"重导，并把这次的判定记下来
                this.context.noteLedgerMismatch(verification.reason || 'unknown')
              }
              // 账本里有记录但产物不符：沿用**账本里的落点**重导，让续跑真正落回同一个路径
              const resumeOutputPath = ledgerRecord?.outputPath && !claimedOutputPaths.has(ledgerRecord.outputPath)
                ? ledgerRecord.outputPath
                : ''

              let ext = '.json'
              if (effectiveOptions.format === 'chatlab-jsonl') ext = '.jsonl'
              else if (effectiveOptions.format === 'excel') ext = '.xlsx'
              else if (effectiveOptions.format === 'txt') ext = '.txt'
              else if (effectiveOptions.format === 'markdown') ext = '.md'
              else if (effectiveOptions.format === 'weclone') ext = '.csv'
              else if (effectiveOptions.format === 'html') ext = '.html'
              else if (effectiveOptions.format === 'sql') ext = '.sql'
              const computedOutputPath = path.join(sessionDir, `${fileNameWithPrefix}${ext}`)
              // 账本命中的单元已经有确定落点，不再参与"同名会话改名"的探测：
              // 探测会看磁盘上是否已有文件，中断重跑时那个半成品会把名字推成 `_2`，
              // 于是续跑永远命中不了第一次的产物。
              const preferredOutputPath = resumeOutputPath || computedOutputPath
              // Skipping requires the verified ledger above: source fingerprint,
              // export options and artifact hash. Count/latest-time hints cannot
              // detect older-message edits or a corrupted output file.

              const outputPath = conflictStrategy === 'rename'
                ? await reserveUniqueOutputPath(preferredOutputPath, reservedOutputPaths)
                : claimedOutputPaths.has(preferredOutputPath)
                  ? await reserveUniqueOutputPath(preferredOutputPath, claimedOutputPaths)
                  : preferredOutputPath
              // Reserve before the formatter awaits WCDB/file work. With a
              // bounded pool, two same-named chats can otherwise choose the
              // same path before either one records completion.
              claimedOutputPaths.add(outputPath)

              let result: { success: boolean; error?: string }
              if (effectiveOptions.format === 'json' || effectiveOptions.format === 'arkme-json') {
                result = await this.exportSessionToDetailedJson(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'chatlab' || effectiveOptions.format === 'chatlab-jsonl') {
                result = await this.exportSessionToChatLab(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'excel') {
                result = await this.exportSessionToExcel(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'txt') {
                result = await this.exportSessionToTxt(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'markdown') {
                result = await this.exportSessionToMarkdown(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'weclone') {
                result = await this.exportSessionToWeCloneCsv(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'html') {
                result = await this.exportSessionToHtml(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else if (effectiveOptions.format === 'sql') {
                result = await this.exportSessionToSql(sessionId, outputPath, effectiveOptions, sessionProgress, control)
              } else {
                result = { success: false, error: `不支持的格式: ${effectiveOptions.format}` }
              }

              if (!result.success && this.context.isStopError(result.error)) {
                activeSessionRatios.delete(sessionId)
                return 'stopped'
              }
              if (!result.success && this.context.isPauseError(result.error)) {
                activeSessionRatios.delete(sessionId)
                return 'paused'
              }

              if (!result.success && result.error === CONFIRMED_EMPTY_SESSION_SKIP) {
                // Do not let an empty skip leave a stale artifact/ledger unit that
                // would appear to represent the current source state.
                const priorArtifactExists = Boolean(ledgerRecord) || [outputPath, computedOutputPath, resumeOutputPath]
                  .filter(Boolean)
                  .some((candidate) => fs.existsSync(candidate as string))
                if (priorArtifactExists) {
                  result = { success: false, error: '已确认会话当前无消息，但账本或输出目录中存在旧产物；为保留旧文件，此次仍标记为失败' }
                } else {
                  claimedOutputPaths.delete(outputPath)
                  reservedOutputPaths.delete(outputPath)
                  emptySkippedSessionIds.push(sessionId)
                  successCount++
                  sessionProgress({
                    current: 100,
                    total: 100,
                    currentSession: sessionInfo.displayName,
                    currentSessionId: sessionId,
                    phase: 'complete',
                    phaseLabel: '已确认无消息，成功跳过',
                    estimatedTotalMessages: 0,
                    collectedMessages: 0,
                    exportedMessages: 0,
                  })
                  activeSessionRatios.delete(sessionId)
                  completedCount++
                  return 'done'
                }
              }

              if (result.success) {
                successCount++
                successSessionIds.push(sessionId)
                sessionOutputPaths[sessionId] = outputPath
                // ---- §10.1 ①：把完成的产物写进账本（写完 fsync 才返回）----------
                // 账本写失败不能让一次成功的导出变成失败：只是这次不能续跑跳过而已。
                try {
                  const fingerprint = await fingerprintFile(outputPath)
                  // 媒体清单只在开了媒体导出时收集（多一次遍历，但让续跑能按内容跳过复制）
                  const mediaHashes = exportMediaEnabled
                    ? await collectMediaHashes(exportBaseDir, sessionDir)
                    : undefined
                  const entry = await ledger.append({
                    taskId,
                    sessionId,
                    chunkStart: ledgerChunkStart,
                    chunkEnd: ledgerChunkEnd,
                    artifact: ledgerArtifact,
                    bytes: fingerprint.bytes,
                    sha256: fingerprint.sha256,
                    mediaHashes,
                    outputPath,
                    sourceFingerprint: sourceWatermark || undefined,
                    messageCount: exportedMessageHints.get(sessionId),
                  })
                  ledgerIndex.set(unitKeyOf(entry), entry)
                  if (mediaHashes && mediaHashes.length > 0) {
                    // 累积（不是覆盖）：续跑时后一个会话也能命中前面会话已写出的媒体
                    for (const mediaEntry of mediaHashes) {
                      if (!runMediaHashes.some((existing) => existing.path === mediaEntry.path)) {
                        runMediaHashes.push(mediaEntry)
                      }
                    }
                    // 同上：根必须是账本路径的基准目录（`exportBaseDir`），不是 `outputDir`
                    this.context.loadLedgerMediaIndex(runMediaHashes, exportBaseDir)
                  }
                } catch (ledgerError) {
                  console.warn(`[Export] 账本写入失败（不影响本次导出）: ${String(ledgerError)}`)
                }
                if (typeof messageCountHint === 'number' && messageCountHint >= 0) {
                  exportRecordService.saveRecord(sessionId, effectiveOptions.format, messageCountHint, {
                    sourceLatestMessageTimestamp: typeof latestTimestampHint === 'number' && latestTimestampHint > 0
                      ? latestTimestampHint
                      : undefined,
                    outputPath
                  }, conn.cleanedWxid)
                }
              } else {
                failCount++
                failedSessionIds.push(sessionId)
                failedSessionErrors[sessionId] = result.error || '导出失败'
                console.error(`导出 ${sessionId} 失败:`, result.error)
              }

              activeSessionRatios.delete(sessionId)
              completedCount++
              emitProgress({
                current: computeAggregateCurrent(),
                total: sessionIds.length,
                currentSession: sessionInfo.displayName,
                currentSessionId: sessionId,
                phase: 'complete',
                phaseLabel: result.success ? '完成' : '导出失败'
              }, { force: true })
              return 'done'
            } catch (error) {
              if (this.context.isStopError(error)) {
                activeSessionRatios.delete(sessionId)
                return 'stopped'
              }
              if (this.context.isPauseError(error)) {
                activeSessionRatios.delete(sessionId)
                return 'paused'
              }
              throw error
            }
          }

          const poolResult = await runBoundedPool(queue, {
            concurrency: sessionConcurrency,
            shouldStop: () => control?.shouldStop?.() === true,
            shouldPause: () => control?.shouldPause?.() === true,
          }, async (sessionId) => {
            activeSessionWorkers += 1
            peakSessionWorkers = Math.max(peakSessionWorkers, activeSessionWorkers)
            try {
              const runState = await runOne(sessionId)
              if (runState === 'stopped') {
                stopRequested = true
                return 'stopped'
              }
              if (runState === 'paused') {
                pauseRequested = true
                return 'paused'
              }
              return 'complete'
            } finally {
              activeSessionWorkers = Math.max(0, activeSessionWorkers - 1)
            }
          })
          queue = poolResult.pending
          stopRequested ||= poolResult.stopped
          pauseRequested ||= poolResult.paused

          const pendingSessionIds = [...queue]
          if (stopRequested && pendingSessionIds.length > 0) {
            return {
              success: true,
              successCount,
              failCount,
              stopped: true,
              pendingSessionIds,
              successSessionIds,
                emptySkippedSessionIds,
              failedSessionIds,
              failedSessionErrors,
              sessionOutputPaths,
              imageKeyMissingFiles: this.getRunImageKeyMissingCount(),
              voiceFailedFiles: this.getRunVoiceFailedCount()
            }
          }
          if (pauseRequested) {
            return {
              success: true,
              successCount,
              failCount,
              paused: true,
              pendingSessionIds,
              successSessionIds,
              emptySkippedSessionIds,
              failedSessionIds,
              failedSessionErrors,
              sessionOutputPaths,
              imageKeyMissingFiles: this.getRunImageKeyMissingCount(),
              voiceFailedFiles: this.getRunVoiceFailedCount()
            }
          }

          emitProgress({
            current: sessionIds.length,
            total: sessionIds.length,
            currentSession: '',
            currentSessionId: '',
            phase: 'complete'
          }, { force: true })
          progressEmitter.flush()
          // §10.1：目录级清单（原子写）。续跑跳过会话时，清单仍从**账本**汇总全部单元，
          // 因此"导出 60% 中断 → 续跑"与"一次性导出"得到同一份清单内容。
          //
          // 顺带把账本压一次：它是"一次追加一行"的 JSONL，而每次运行都要**整份读回再逐行解析**。
          // 跑得越多文件越大、续跑越慢。压缩走原子写并按唯一键去重，失败不影响产物。
          try {
            if (ledgerIndex.size > LEDGER_COMPACT_MIN_ENTRIES) {
              const kept = await ledger.compact()
              console.info(`[Export] 账本已压缩：保留 ${kept} 条（阈值 ${LEDGER_COMPACT_MIN_ENTRIES}）`)
            }
          } catch (compactError) {
            console.warn(`[Export] 账本压缩失败（不影响产物）: ${String(compactError)}`)
          }
          try {
            await this.writeExportRootManifest({
              outputDir,
              format: String(effectiveOptions.format || 'unknown'),
              taskId,
              ledgerIndex,
            })
          } catch (manifestError) {
            console.warn(`[Export] 清单写入失败（不影响产物）: ${String(manifestError)}`)
          }
          console.info(`[Export] session concurrency requested=${rawConcurrency} effective=${sessionConcurrency} peak=${peakSessionWorkers} sessions=${sessionIds.length}`)

          // ---- §10.2 ②：导出正确性自检 --------------------------------------
          // 位置在账本提交（每个会话 append 完）与目录清单之后：此时报告说的"产物"
          // 就是最终产物。**只在没被取消/暂停时跑** —— 取消的运行产物本身就是残缺的，
          // 报"少了 N 行"只会误导（取消路径另有清理逻辑）。
          // 自检失败绝不能让一次成功的导出变成失败：只记日志 + 落一份 ok:false 报告。
          if (!stopRequested && !pauseRequested && successSessionIds.length > 0) {
            const uniqueSuccessSessionIds = [...new Set(successSessionIds)]
            try {
              const integrityReport = await runIntegrityCheck({
                db: this.context.integrityDbAccess,
                wxid: String(conn.cleanedWxid || ''),
                outputRoot: outputDir,
                ledgerEntries: ledgerIndex.size,
                sessions: uniqueSuccessSessionIds.map((sessionId) => {
                  const artifactPath = sessionOutputPaths[sessionId]
                  const sessionDir = sessionDirs.get(sessionId)
                    || (artifactPath ? path.dirname(artifactPath) : exportBaseDir)
                  return {
                    sessionId,
                    artifactPath,
                    format: String(effectiveOptions.format || ''),
                    runExportedMessages: exportedMessageHints.get(sessionId),
                    sessionDir,
                    // 有时间范围或发送人筛选时产物只可能是全量计数的子集 → 只做上界校验。
                    scoped: !this.context.isUnboundedDateRange(effectiveOptions.dateRange)
                      || Boolean(String(effectiveOptions.senderUsername || '').trim()),
                    mediaRequested: {
                      enabled: exportMediaEnabled,
                      images: effectiveOptions.exportImages === true,
                      voices: effectiveOptions.exportVoices === true,
                      videos: effectiveOptions.exportVideos === true,
                      emojis: effectiveOptions.exportEmojis === true,
                      files: effectiveOptions.exportFiles === true,
                    },
                    artifactFingerprints: [...ledgerIndex.values()]
                      .filter((unit) => unit.sessionId === sessionId && Boolean(unit.outputPath))
                      .map((unit) => ({
                        path: unit.outputPath as string,
                        bytes: unit.bytes,
                        sha256: unit.sha256,
                      })),
                    imageKeyMissingFiles: this.getRunImageKeyMissingCount(),
                    voiceFailedFiles: this.getRunVoiceFailedCount(),
                  }
                }),
                // 运行级媒体计数（整次导出一个数）：报告里用它解释"为什么一个媒体都没产出"。
                mediaTelemetry: {
                  doneFiles: this.context.getMediaDoneFilesCount(),
                  imageKeyMissingFiles: this.getRunImageKeyMissingCount(),
                  voiceFailedFiles: this.getRunVoiceFailedCount(),
                },
              })
              console.info(`[Export] 自检完成 ok=${integrityReport.ok} 会话=${integrityReport.totals.sessions} 消息=${integrityReport.totals.messages} 缺失媒体=${integrityReport.totals.missingMedia} 重复=${integrityReport.totals.duplicates}`)
            } catch (integrityError) {
              console.warn(`[Export] 自检未完成（不影响产物）: ${String(integrityError)}`)
              await writeIntegrityFailureReport({
                wxid: String(conn.cleanedWxid || ''),
                outputRoot: outputDir,
                ledgerEntries: ledgerIndex.size,
                error: String(integrityError),
              }).catch(() => undefined)
            }
          }

          const allFailed = successCount === 0 && failCount > 0
          const failureSummary = allFailed
            ? Object.values(failedSessionErrors).slice(0, 3).join('；') || '所有会话导出失败'
            : undefined
          return {
            success: !allFailed,
            successCount,
            failCount,
            successSessionIds,
            emptySkippedSessionIds,
            failedSessionIds,
            failedSessionErrors,
            sessionOutputPaths,
            imageKeyMissingFiles: this.getRunImageKeyMissingCount(),
            voiceFailedFiles: this.getRunVoiceFailedCount(),
            error: failureSummary
          }
        } catch (e) {
          progressEmitter.flush()
          return { success: false, successCount, failCount, imageKeyMissingFiles: this.getRunImageKeyMissingCount(), voiceFailedFiles: this.getRunVoiceFailedCount(), error: String(e) }
        } finally {
          this.context.clearMediaRuntimeState()
        }
    }
}

