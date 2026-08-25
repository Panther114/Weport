/**
 * WeClone 人格克隆服务（v0.9.10）。
 *
 * 管线：chatService.getSessions → wcdbService 消息游标扫描（批 500 / 并发 2 /
 * 单会话 15 万条上限）→ 本地 PII 正则脱敏 → 800 字符分块 → 流式 JSONL 落盘
 * （userData/weclone-staging/<wxid>/chunks.jsonl，原子写）→ 强制 provider
 * （opencode-go / muse-spark-1.2-contributor，复用 weportAiProfilesBlob 加密
 * 存储，见 ensureForcedProvider）逐份生成 MD（profile/relationships/knowledge/
 * timeline/language）→ LLM 二次 PII 审查（MD 全量 + 抽样 5% 语料）→ 上传 Railway
 * 私有服务（未配置则 local_only）。
 *
 * 内存纪律：全量历史从不一次性驻留 RAM —— 扫描阶段只保留当前批次与分块缓冲，
 * 上传阶段用 readline 流式回读 JSONL。WCDB 宿主约束不变（复用现有游标协议）。
 */
import { app } from 'electron'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  createReadStream,
  appendFileSync,
} from 'fs'
import { createInterface } from 'readline'
import { gzipSync } from 'zlib'
import {
  ConfigService,
  getWeCloneServerConfig,
  WECLONE_DEFAULT_SERVER_URL,
  WECLONE_FORCED_PROVIDER_ID,
  WECLONE_FORCED_BASE_URL,
  WECLONE_FORCED_MODEL,
} from './config'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import type { ChatSession } from './chatService'
import { ProviderProfileService } from './ai/providerProfiles'
import { getProviderAdapter, makeDefaultProfile } from './ai/providerAdapters'
import { getProviderCatalogEntry } from './ai/providerCatalog'
import type { ProviderProfile } from './ai/providerTypes'
import { decodeMessageContent } from './export/parsers/contentDecoder'
import { redactSensitiveText, scanSensitiveText } from './weClonePiiFilter'
import {
  WECLONE_SYSTEM_PROMPT,
  WECLONE_MD_PROMPTS,
  WECLONE_FILTER_PROMPT,
  buildWeCloneChatSystemPrompt,
} from './weClonePrompts'
import { computeVoiceDna, renderVoiceSheet } from './weCloneVoice'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface WeCloneChunk {
  id: string
  sid: string
  ts: number
  talker: string
  text: string
}

export interface WeCloneMds {
  profile: string
  relationships: string
  knowledge: string
  timeline: string
  language: string
}

export type WeCloneVisibility = 'private' | 'public' | 'link'

export interface WeCloneMeta {
  id: string
  wxid: string
  displayName: string
  /** ISO 日期（YYYY-MM-DD），最后一条消息的时间 */
  knowledgeCutoff: string
  messageCount: number
  sessionCount: number
  chunkCount: number
  generatedAt: string
  visibility: WeCloneVisibility
  uploaded: boolean
  uploadStatus?: 'local_only' | 'uploaded' | 'failed'
  serverId?: string
  piiHits?: number
  truncated?: boolean
}

export interface WeCloneListItem extends WeCloneMeta {
  source: 'local' | 'remote' | 'both'
  shareUrl?: string
}

export type WeCloneProgressStage = 'scan' | 'generate' | 'filter' | 'upload' | 'done' | 'error' | 'cancelled'

/** 任务状态：running 生成中 / done 成功 / error 失败 / cancelled 已取消 */
export type WeCloneProgressStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface WeCloneProgress {
  stage: WeCloneProgressStage
  /** 总进度 0-100 */
  progress: number
  message: string
  detail?: Record<string, unknown>
  /** 任务状态（内存回放用；推送载荷同样携带） */
  status?: WeCloneProgressStatus
  /** 该条进度的时间戳（ms） */
  ts?: number
}

/** 兼容别名：WeCloneProgressInfo 与 WeCloneProgress 等价 */
export type WeCloneProgressInfo = WeCloneProgress

export interface WeCloneGenerateOptions {
  /** 跳过上传，仅本地生成 */
  localOnly?: boolean
}

export interface WeCloneGenerateResult {
  success: boolean
  clone?: WeCloneMeta
  status?: 'local_only' | 'uploaded' | 'failed'
  aborted?: boolean
  error?: string
}

export interface WeCloneServerStatus {
  configured: boolean
  enabled: boolean
  baseUrl: string
  hasToken: boolean
  online?: boolean
  version?: string
  error?: string
}

/** 强制 provider 状态（渲染侧安全，不含明文 key） */
export interface WeCloneForcedProviderStatus {
  providerId: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  isForced: boolean
  activeProfileSummary?: {
    id: string
    name: string
    providerId: string
    baseUrl: string
    model: string
    hasApiKey: boolean
    apiKeyHint: string
  }
}

class WeCloneAbortedError extends Error {
  constructor() {
    super('已取消')
    this.name = 'WeCloneAbortedError'
  }
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 消息游标每批条数 */
const CURSOR_BATCH_SIZE = 500
/** 扫描并发（WCDB 宿主串行队列友好） */
const SCAN_CONCURRENCY = 2
/** 单会话消息上限（与 wordFrequency 对齐） */
const PER_SESSION_MESSAGE_CAP = 150_000
/** 全量消息软上限：达到后优雅截断 */
const TOTAL_MESSAGE_CAP = 2_000_000
/** 分块字符上限 */
const CHUNK_CHAR_LIMIT = 800
/** 上传 chunks 预算（gzip 前，UTF-8 字节） */
const MAX_CHUNKS_UPLOAD_BYTES = 20 * 1024 * 1024
/** 单份 MD 字符上限 */
const MD_CHAR_LIMIT = 12_000
/** 生成上下文采样：随机 + 最近（gen3：扩大覆盖，配合模型降级链兜底长上下文） */
const SAMPLE_RANDOM_CHUNKS = 400
const SAMPLE_RECENT_CHUNKS = 120
/** 生成上下文总字符上限 */
const GENERATION_CONTEXT_CHAR_LIMIT = 180_000
// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class WeCloneService {
  private configService: ConfigService
  private providerProfiles: ProviderProfileService
  private runningController: AbortController | null = null
  private lastProgress: WeCloneProgressInfo | null = null
  private progressHistory: WeCloneProgressInfo[] = []
  private progressRetentionTimer: NodeJS.Timeout | null = null

  constructor() {
    this.configService = ConfigService.getInstance()
    this.providerProfiles = new ProviderProfileService(this.configService)
  }

  // -------------------------------------------------------------------------
  // 配置读取（键缺失时优雅兜底）
  // -------------------------------------------------------------------------

  private cfgGet(key: string): unknown {
    try {
      return (this.configService as unknown as Record<string, (k: string) => unknown>).get(key)
    } catch {
      return undefined
    }
  }

  private getServerConfig(): { enabled: boolean; baseUrl: string; token: string; configured: boolean } {
    try {
      const cfg = getWeCloneServerConfig()
      // 硬编码兜底：历史空配置直接回退固定地址，避免 local_only
      if (!cfg.baseUrl) return { ...cfg, baseUrl: WECLONE_DEFAULT_SERVER_URL, configured: cfg.enabled }
      return cfg
    } catch {
      const enabled = this.cfgGet('weCloneEnabled') !== false
      let baseUrl = String(this.cfgGet('weCloneServerUrl') || '').trim().replace(/\/+$/, '')
      if (!baseUrl) baseUrl = WECLONE_DEFAULT_SERVER_URL
      const token = String(this.cfgGet('weCloneServerToken') || '').trim()
      return { enabled, baseUrl, token, configured: enabled && !!baseUrl }
    }
  }

  private getMyWxid(): string {
    return String(this.configService.getMyWxidCleaned() || this.configService.get('myWxid') || '').trim() || 'unknown'
  }

  // -------------------------------------------------------------------------
  // 目录与元数据
  // -------------------------------------------------------------------------

  getStagingRoot(): string {
    return join(app.getPath('userData'), 'weclone-staging')
  }

  private getStagingDir(wxid?: string): string {
    return join(this.getStagingRoot(), wxid || this.getMyWxid())
  }

  private mdFilePaths(dir: string): Array<{ key: keyof WeCloneMds; path: string }> {
    return [
      { key: 'profile', path: join(dir, 'profile.md') },
      { key: 'relationships', path: join(dir, 'relationships.md') },
      { key: 'knowledge', path: join(dir, 'knowledge.md') },
      { key: 'timeline', path: join(dir, 'timeline.md') },
      { key: 'language', path: join(dir, 'language.md') },
    ]
  }

  /** 原子写：tmp + rename，崩溃不留半个文件 */
  private atomicWriteFile(target: string, content: string): void {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, target)
  }

  private readMeta(dir: string): WeCloneMeta | null {
    const metaPath = join(dir, 'metadata.json')
    if (!existsSync(metaPath)) return null
    try {
      const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<WeCloneMeta>
      if (!raw || typeof raw !== 'object' || !raw.id) return null
      return {
        id: String(raw.id),
        wxid: String(raw.wxid || ''),
        displayName: String(raw.displayName || ''),
        knowledgeCutoff: String(raw.knowledgeCutoff || ''),
        messageCount: Number(raw.messageCount) || 0,
        sessionCount: Number(raw.sessionCount) || 0,
        chunkCount: Number(raw.chunkCount) || 0,
        generatedAt: String(raw.generatedAt || ''),
        visibility: raw.visibility === 'public' || raw.visibility === 'link' ? raw.visibility : 'private',
        uploaded: raw.uploaded === true,
        uploadStatus: raw.uploadStatus === 'uploaded' || raw.uploadStatus === 'failed' ? raw.uploadStatus : 'local_only',
        serverId: raw.serverId ? String(raw.serverId) : undefined,
        piiHits: Number(raw.piiHits) || 0,
        truncated: raw.truncated === true,
      }
    } catch {
      return null
    }
  }

  private writeMeta(dir: string, meta: WeCloneMeta): void {
    this.atomicWriteFile(join(dir, 'metadata.json'), JSON.stringify(meta, null, 2))
  }

  listLocalClones(): WeCloneMeta[] {
    const root = this.getStagingRoot()
    if (!existsSync(root)) return []
    const out: WeCloneMeta[] = []
    try {
      for (const entry of readdirSync(root)) {
        const dir = join(root, entry)
        try {
          if (!existsSync(join(dir, 'metadata.json'))) continue
          const meta = this.readMeta(dir)
          if (meta) out.push(meta)
        } catch { /* noop */ }
      }
    } catch { /* noop */ }
    out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    return out
  }

  /** 读取单个克隆（含 MD 内容预览） */
  getClone(id: string): { success: boolean; clone?: WeCloneMeta; mds?: Partial<WeCloneMds>; error?: string } {
    const root = this.getStagingRoot()
    for (const entry of readdirSyncSafe(root)) {
      const dir = join(root, entry)
      const meta = this.readMeta(dir)
      if (!meta || meta.id !== id) continue
      const mds: Partial<WeCloneMds> = {}
      for (const { key, path } of this.mdFilePaths(dir)) {
        try {
          if (existsSync(path)) mds[key] = readFileSync(path, 'utf8')
        } catch { /* noop */ }
      }
      return { success: true, clone: meta, mds }
    }
    return { success: false, error: '找不到该克隆' }
  }

  // -------------------------------------------------------------------------
  // 取消
  // -------------------------------------------------------------------------

  cancel(): void {
    const ctrl = this.runningController
    this.runningController = null
    if (ctrl) {
      try { ctrl.abort() } catch { /* noop */ }
    }
  }

  private ensureNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted || this.runningController?.signal.aborted) throw new WeCloneAbortedError()
  }

  // -------------------------------------------------------------------------
  // 扫描：会话列表 → 游标分批 → 脱敏 → 分块 → JSONL
  // -------------------------------------------------------------------------

  private async collectSessionIds(): Promise<{ ids: string[]; names: Map<string, string> }> {
    const result = await chatService.getSessions()
    if (!result.success || !Array.isArray(result.sessions)) {
      throw new Error(result.error || '获取会话列表失败')
    }
    const sessions = result.sessions as ChatSession[]
    const names = new Map<string, string>()
    let ids = sessions
      .map((s) => String(s.username || '').trim())
      .filter((sid) => sid && !sid.startsWith('gh_'))
    for (const s of sessions) {
      if (s.username && s.displayName) names.set(s.username, s.displayName)
    }
    // 过滤无消息会话（公众号/空聊天室没有消息表，游标会报 -3）。失败则不过滤。
    try {
      const countsResult = await wcdbService.getSessionMessageCounts(ids)
      if (countsResult.success && countsResult.counts) {
        ids = ids.filter((sid) => Number(countsResult.counts?.[sid] || 0) > 0)
      }
    } catch { /* noop */ }
    return { ids, names }
  }

  /**
   * 从 WCDB 游标行提取一条可训练文本。媒体/XML/系统消息跳过。
   * 返回 null 表示该行不可用。
   */
  private extractMessageText(row: Record<string, unknown>): { ts: number; isSend: boolean; sender: string; text: string } | null {
    const localType = parseInt(String(row.local_type ?? row.type ?? '1'), 10)
    if (Number.isFinite(localType) && localType === 10000) return null // 系统消息
    const createTimeRaw = row.create_time ?? row.createTime ?? row.create_time_ms ?? '0'
    let ts = parseInt(String(createTimeRaw), 10)
    if (!Number.isFinite(ts) || ts <= 0) ts = 0
    if (ts > 1e12) ts = Math.floor(ts / 1000)

    const isSendRaw = row.computed_is_send ?? row.is_send ?? row.isSend ?? row.WCDB_CT_is_send
    const normalized = String(isSendRaw).trim().toLowerCase()
    const isSend = isSendRaw === 1 || isSendRaw === true || normalized === '1' || normalized === 'true'

    const sender = String(row.sender_username || row.senderUsername || row.sender || row.talker || '').trim()

    const content = decodeMessageContent(row.message_content, row.compress_content).trim()
    if (!content) return null
    // XML/多媒体结构化内容不进语料（保留 [图片] 这类短标签）
    if (content.startsWith('<?xml') || content.startsWith('<msg') || /^<[^>]{2,40}>/.test(content.slice(0, 60))) return null
    if (content.length > 2000) return null // 超长转发/聊天记录不适合语气克隆

    return { ts, isSend, sender, text: content }
  }

  private formatChunkLine(isSend: boolean, sender: string, myWxid: string, text: string): string {
    const who = isSend ? '我' : sender && sender !== myWxid ? sender : '对方'
    // 群聊 message_content 自带 "发送者: " 前缀，与我们的行前缀重复 → 去重
    let body = text.replace(/\r?\n/g, ' ')
    if (sender) {
      const prefix = `${sender}: `
      if (body.startsWith(prefix)) body = body.slice(prefix.length).trimStart()
    }
    return `${who}: ${body}`
  }

  /**
   * 扫描全部会话并流式写 chunks.jsonl。
   * 返回统计信息；JSONL 由调用方负责改名收尾。
   */
  private async scanAllSessions(
    sessionIds: string[],
    jsonlPath: string,
    signal: AbortSignal | undefined,
    onProgress: (completed: number, total: number, messages: number) => void
  ): Promise<{ messageCount: number; sessionCount: number; cutoffTs: number; truncated: boolean }> {
    const myWxid = this.getMyWxid()
    let totalMessages = 0
    let completedSessions = 0
    let cutoffTs = 0
    let truncated = false
    let chunkSeq = 0

    mkdirSync(dirname(jsonlPath), { recursive: true })

    const scanSession = async (sessionId: string): Promise<void> => {
      this.ensureNotAborted(signal)
      let sessionMessages = 0
      let chunkBuffer: string[] = []
      let chunkChars = 0
      let chunkFirstTs = 0
      let chunkTalker = ''

      const flushChunk = () => {
        if (chunkBuffer.length === 0) return
        chunkSeq += 1
        const chunk: WeCloneChunk = {
          id: `c_${String(chunkSeq).padStart(6, '0')}`,
          sid: sessionId,
          ts: chunkFirstTs,
          talker: chunkTalker,
          text: chunkBuffer.join('\n'),
        }
        appendFileSync(jsonlPath, JSON.stringify(chunk) + '\n', 'utf8')
        chunkBuffer = []
        chunkChars = 0
        chunkFirstTs = 0
        chunkTalker = ''
      }

      const cursorResult = await wcdbService.openMessageCursor(sessionId, CURSOR_BATCH_SIZE, true, 0, 0)
      if (!cursorResult.success || !cursorResult.cursor) return
      try {
        let hasMore = true
        let batchCount = 0
        while (hasMore) {
          this.ensureNotAborted(signal)
          if (sessionMessages >= PER_SESSION_MESSAGE_CAP || totalMessages >= TOTAL_MESSAGE_CAP) {
            truncated = true
            break
          }
          const batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
          if (!batch.success || !batch.rows) break
          for (const row of batch.rows as Array<Record<string, unknown>>) {
            if (sessionMessages >= PER_SESSION_MESSAGE_CAP || totalMessages >= TOTAL_MESSAGE_CAP) {
              truncated = true
              break
            }
            const msg = this.extractMessageText(row)
            if (!msg) continue
            const redacted = redactSensitiveText(msg.text)
            if (!redacted.trim()) continue
            const line = this.formatChunkLine(msg.isSend, msg.sender, myWxid, redacted)
            if (chunkChars + line.length + 1 > CHUNK_CHAR_LIMIT && chunkBuffer.length > 0) flushChunk()
            if (chunkBuffer.length === 0) {
              chunkFirstTs = msg.ts
              chunkTalker = msg.isSend ? '我' : msg.sender
            }
            chunkBuffer.push(line)
            chunkChars += line.length + 1
            sessionMessages += 1
            totalMessages += 1
            if (msg.ts > cutoffTs) cutoffTs = msg.ts
          }
          hasMore = batch.hasMore === true
          batchCount += 1
          // 定期让出事件循环，避免长批次阻塞主进程
          if (batchCount % 10 === 0) await new Promise((resolve) => setImmediate(resolve))
        }
      } finally {
        flushChunk()
        await wcdbService.closeMessageCursor(cursorResult.cursor).catch(() => undefined)
      }
      completedSessions += 1
      onProgress(completedSessions, sessionIds.length, totalMessages)
    }

    // 并发 2 的简单工作池：宿主进程游标数量有限（LRU 8），不宜更高
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < sessionIds.length) {
        this.ensureNotAborted(signal)
        if (totalMessages >= TOTAL_MESSAGE_CAP) {
          truncated = true
          return
        }
        const index = nextIndex
        nextIndex += 1
        try {
          await scanSession(sessionIds[index])
        } catch (e) {
          if ((e as Error)?.name === 'WeCloneAbortedError') throw e
          console.warn(`[WeClone] 会话 ${sessionIds[index]} 扫描失败:`, e)
        }
      }
    }
    await Promise.all([worker(), worker()])

    return { messageCount: totalMessages, sessionCount: completedSessions, cutoffTs, truncated }
  }

  // -------------------------------------------------------------------------
  // 语料采样与生成上下文（流式，不全量驻留）
  // -------------------------------------------------------------------------

  /**
   * 流式扫描 JSONL：水库抽样 randomCount 条 + 最近 recentCount 条。
   * RAM 占用 ≈ (randomCount + recentCount) × 800 字符 ≈ 200 KB。
   */
  private async sampleChunksFromJsonl(
    jsonlPath: string,
    randomCount: number,
    recentCount: number
  ): Promise<{ sampled: WeCloneChunk[]; total: number }> {
    const reservoir: WeCloneChunk[] = []
    const recentDeque: WeCloneChunk[] = []
    let total = 0
    if (!existsSync(jsonlPath)) return { sampled: [], total: 0 }

    const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let chunk: WeCloneChunk
        try {
          chunk = JSON.parse(trimmed) as WeCloneChunk
        } catch { continue }
        if (!chunk || typeof chunk.text !== 'string') continue
        total += 1
        recentDeque.push(chunk)
        if (recentDeque.length > recentCount) recentDeque.shift()
        if (reservoir.length < randomCount) {
          reservoir.push(chunk)
        } else {
          const j = Math.floor(Math.random() * total)
          if (j < randomCount) reservoir[j] = chunk
        }
      }
    } finally {
      rl.close()
    }
    const seen = new Set<string>()
    const sampled: WeCloneChunk[] = []
    for (const chunk of [...reservoir, ...recentDeque]) {
      if (seen.has(chunk.id)) continue
      seen.add(chunk.id)
      sampled.push(chunk)
    }
    return { sampled, total }
  }

  /** 把采样块拼成生成上下文（按时间排序 + 会话名标注），限制总字符 */
  private buildGenerationContext(chunks: WeCloneChunk[], sessionNames: Map<string, string>): string {
    const sorted = [...chunks].sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const parts: string[] = []
    let used = 0
    for (const chunk of sorted) {
      const name = sessionNames.get(chunk.sid) || chunk.sid
      const when = chunk.ts ? new Date(chunk.ts * 1000).toISOString().slice(0, 10) : '未知日期'
      const block = `--- 「${name}」 ${when} ---\n${chunk.text}`
      if (used + block.length > GENERATION_CONTEXT_CHAR_LIMIT) break
      parts.push(block)
      used += block.length
    }
    return parts.join('\n')
  }

  // -------------------------------------------------------------------------
  // LLM 调用（复用 weportAiService 的 provider 配置）
  // -------------------------------------------------------------------------

  private getActiveProfile(): ProviderProfile | null {
    return this.providerProfiles.getActive()
  }

  // -------------------------------------------------------------------------
  // 强制 provider（opencode-go / muse-spark-1.2-contributor，与 WeportAI 同款配置）
  // -------------------------------------------------------------------------

  /** 当前激活 profile 是否已满足强制配置（provider + baseUrl + model + apiKey 全匹配） */
  private isForcedProfile(profile: ProviderProfile | null): boolean {
    return Boolean(
      profile &&
      profile.providerId === WECLONE_FORCED_PROVIDER_ID &&
      profile.baseUrl === WECLONE_FORCED_BASE_URL &&
      profile.model === WECLONE_FORCED_MODEL &&
      profile.apiKey
    )
  }

  /**
   * 锁定 WeClone 生成到 opencode-go / muse-spark-1.2-contributor。
   * 复用 ProviderProfileService（加密存储 weportAiProfilesBlob），绝不直接读写
   * legacy weportAiApiKey。apiKeyInput 为空时沿用现有 key；两者皆空则抛错。
   */
  async ensureForcedProvider(apiKeyInput?: string): Promise<ProviderProfile> {
    const active = this.getActiveProfile()
    if (!apiKeyInput && this.isForcedProfile(active)) {
      console.debug(`[WeClone] 强制 provider 已就绪: ${WECLONE_FORCED_PROVIDER_ID}/${WECLONE_FORCED_MODEL} (profile=${active?.id})`)
      return active as ProviderProfile
    }

    const catalog = getProviderCatalogEntry(WECLONE_FORCED_PROVIDER_ID)
    const apiKey = String(apiKeyInput || '').trim() || String(active?.apiKey || '').trim()
    if (!apiKey) {
      throw new Error('请在人格克隆设置内填入 OpenCode Go API Key (muse-spark-1.2-contributor)')
    }

    // 同 provider+model 的既有 profile 原地更新，否则用目录骨架新建
    const existing = this.providerProfiles.list().find(
      (p) => p.providerId === WECLONE_FORCED_PROVIDER_ID && p.model === WECLONE_FORCED_MODEL
    )
    const skeleton = makeDefaultProfile({
      providerId: WECLONE_FORCED_PROVIDER_ID,
      name: catalog?.name || 'OpenCode Go',
      baseUrl: WECLONE_FORCED_BASE_URL,
      model: WECLONE_FORCED_MODEL,
    })
    const saved = this.providerProfiles.save({
      id: existing?.id || skeleton.id,
      name: `${catalog?.name || 'OpenCode Go'} · WeClone`,
      providerId: skeleton.providerId,
      protocol: skeleton.protocol,
      baseUrl: skeleton.baseUrl,
      model: skeleton.model,
      apiKey,
    })
    this.providerProfiles.activate(saved.id)
    console.log(
      `[WeClone] 已锁定强制 provider ${WECLONE_FORCED_PROVIDER_ID}/${WECLONE_FORCED_MODEL} ` +
      `(profile=${saved.id}, ${existing ? 'updated' : 'created'})`
    )
    const profile = this.providerProfiles.getById(saved.id)
    if (!profile) throw new Error('强制 provider 配置写入失败')
    return profile
  }

  /** 渲染侧安全状态（不含明文 key） */
  getForcedProviderStatus(): WeCloneForcedProviderStatus {
    const active = this.getActiveProfile()
    return {
      providerId: WECLONE_FORCED_PROVIDER_ID,
      baseUrl: WECLONE_FORCED_BASE_URL,
      model: WECLONE_FORCED_MODEL,
      hasApiKey: Boolean(active?.apiKey),
      isForced: this.isForcedProfile(active),
      activeProfileSummary: active
        ? {
            id: active.id,
            name: active.name,
            providerId: active.providerId,
            baseUrl: active.baseUrl,
            model: active.model,
            hasApiKey: Boolean(active.apiKey),
            apiKeyHint: active.apiKey.length <= 8
              ? `${active.apiKey.slice(0, 2)}•••`
              : `${active.apiKey.slice(0, 4)}•••${active.apiKey.slice(-4)}`,
          }
        : undefined,
    }
  }

  private assertProfileReady(profile: ProviderProfile | null): void {
    if (!profile) throw new Error('未配置 AI 服务，请先在 WeportAI 设置中添加服务配置')
    if (!profile.apiKey && !getProviderCatalogEntry(profile.providerId)?.apiKeyOptional) {
      throw new Error('未配置 AI API Key，请先在 WeportAI 设置中添加服务配置')
    }
    if (!profile.baseUrl) throw new Error('未配置 AI 服务地址，请先在 WeportAI 设置中完善服务配置')
  }

  /** 清除孤立代理对（DeepSeek Rust 后端拒绝不完整 UTF-16 转义） */
  private sanitizeForApi(s: string): string {
    return String(s)
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
      .replace(/(?<![\uD800-\uDFFF])[\uDC00-\uDFFF]/g, '\uFFFD')
  }

  /** 克隆固定使用强制 provider 的模型（muse-spark-1.2-contributor）。
   * gen3 起不做跨模型降级：不同模型语气差异会污染人格一致性（用户明确要求）。 */
  private resolveCloneModel(profile: ProviderProfile): string {
    return (
      String(this.cfgGet('weCloneModel') || '').trim() ||
      profile.model ||
      WECLONE_FORCED_MODEL
    )
  }

  /**
   * 固定模型的流式调用（单模型，不降级）。
   * 返回实际使用的模型名。失败时原样抛出上游错误。
   */
  private async streamLlm(input: {
    profile: ProviderProfile
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    reasoningEffort: string
    signal?: AbortSignal
    onText?: (chunk: string) => void
  }): Promise<{ content: string; model: string }> {
    const model = this.resolveCloneModel(input.profile)
    if (input.signal?.aborted) throw new WeCloneAbortedError()
    const result = await getProviderAdapter({ ...input.profile, model }).stream({
      profile: { ...input.profile, model },
      messages: input.messages as never,
      tools: [],
      reasoningEffort: input.reasoningEffort,
      signal: input.signal ?? AbortSignal.timeout(300_000),
      onText: (chunk: string) => {
        try { input.onText?.(chunk) } catch { /* noop */ }
      },
      onReasoning: () => undefined,
    })
    const content = String(result?.content || '').trim()
    console.log(`[WeClone] LLM 调用成功 model=${model} chars=${content.length}`)
    return { content, model }
  }

  private async callLlm(
    profile: ProviderProfile,
    systemContent: string,
    userContent: string,
    signal?: AbortSignal,
    onText?: (chunk: string) => void
  ): Promise<string> {
    const reasoningEffort = String(this.cfgGet('weportAiReasoningEffort') || 'high')
    const { content } = await this.streamLlm({
      profile,
      messages: [
        { role: 'system', content: this.sanitizeForApi(systemContent) },
        { role: 'user', content: this.sanitizeForApi(userContent) },
      ],
      reasoningEffort,
      signal,
      onText: onText
        ? (chunk: string) => {
            try { onText(String(chunk)) } catch { /* noop */ }
          }
        : undefined,
    })
    return content
  }

  // -------------------------------------------------------------------------
  // 第二阶段 PII 审查（LLM 全量 MD + 抽样语料；失败回退纯正则）
  // -------------------------------------------------------------------------

  private applyLlmSpans(text: string, spans: Array<{ start: number; end: number; type?: string }>): { text: string; applied: number } {
    const valid = spans
      .map((s) => ({
        start: Math.max(0, Math.min(text.length, Math.floor(Number(s.start)))),
        end: Math.max(0, Math.min(text.length, Math.floor(Number(s.end)))),
        type: String(s.type || '敏感信息'),
      }))
      .filter((s) => s.end > s.start && s.end - s.start <= 400)
      .sort((a, b) => b.start - a.start)
    let out = text
    let applied = 0
    for (const span of valid) {
      out = out.slice(0, span.start) + `[已脱敏:${span.type}]` + out.slice(span.end)
      applied += 1
    }
    return { text: out, applied }
  }

  private parseFilterResponse(content: string): Array<{ start: number; end: number; type?: string }> {
    let raw = String(content || '').trim()
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
    if (fence) raw = fence[1].trim()
    const startIdx = raw.indexOf('{')
    const endIdx = raw.lastIndexOf('}')
    if (startIdx < 0 || endIdx <= startIdx) return []
    try {
      const parsed = JSON.parse(raw.slice(startIdx, endIdx + 1)) as { hasPII?: boolean; spans?: unknown }
      if (!parsed || parsed.hasPII !== true || !Array.isArray(parsed.spans)) return []
      return parsed.spans
        .filter((s): s is { start: number; end: number; type?: string } =>
          Boolean(s) && typeof (s as { start?: unknown }).start === 'number' && typeof (s as { end?: unknown }).end === 'number')
    } catch {
      return []
    }
  }

  private async runSecondPassFilter(
    profile: ProviderProfile,
    mds: WeCloneMds,
    jsonlPath: string,
    signal: AbortSignal | undefined,
    onProgress: (message: string, pct: number) => void
  ): Promise<{ mds: WeCloneMds; chunkPatches: Map<string, string>; hits: number }> {
    let hits = 0

    // 1) 本地正则复审 MD（零成本兜底）
    const filteredMds: WeCloneMds = { ...mds }
    for (const key of Object.keys(filteredMds) as Array<keyof WeCloneMds>) {
      const scan = scanSensitiveText(filteredMds[key])
      if (scan.hitCount > 0) {
        filteredMds[key] = scan.text
        hits += scan.hitCount
      }
    }

    // 2) LLM 二审 MD（逐份；失败静默回退正则结果）
    for (const key of Object.keys(filteredMds) as Array<keyof WeCloneMds>) {
      this.ensureNotAborted(signal)
      onProgress(`LLM 审查 ${key}.md`, 0)
      try {
        const content = WECLONE_FILTER_PROMPT.replace('{content}', filteredMds[key])
        const response = await this.callLlm(profile, '你是严格的隐私审查器，只输出 JSON。', content, signal)
        const spans = this.parseFilterResponse(response)
        if (spans.length > 0) {
          const applied = this.applyLlmSpans(filteredMds[key], spans)
          filteredMds[key] = applied.text
          hits += applied.applied
        }
      } catch (e) {
        if ((e as Error)?.name === 'WeCloneAbortedError') throw e
        console.warn(`[WeClone] ${key}.md LLM 二审失败，保留正则结果:`, e)
      }
    }

    // 3) 抽样 5% 语料做 LLM 二审；命中只记录补丁（上传时应用），不重写 JSONL
    const chunkPatches = new Map<string, string>()
    try {
      const counted = await this.sampleChunksFromJsonl(jsonlPath, 0, 0)
      const sampleCount = Math.max(20, Math.ceil(counted.total * 0.05))
      const { sampled } = await this.sampleChunksFromJsonl(jsonlPath, sampleCount, 0)
      for (const chunk of sampled) {
        this.ensureNotAborted(signal)
        try {
          const response = await this.callLlm(profile, '你是严格的隐私审查器，只输出 JSON。', WECLONE_FILTER_PROMPT.replace('{content}', chunk.text), signal)
          const spans = this.parseFilterResponse(response)
          if (spans.length > 0) {
            const applied = this.applyLlmSpans(chunk.text, spans)
            if (applied.text !== chunk.text) {
              chunkPatches.set(chunk.id, applied.text)
              hits += applied.applied
            }
          }
        } catch (e) {
          if ((e as Error)?.name === 'WeCloneAbortedError') throw e
          break // 采样审查失败即停止该阶段，不阻塞主流程
        }
      }
    } catch (e) {
      if ((e as Error)?.name === 'WeCloneAbortedError') throw e
      console.warn('[WeClone] 语料抽样二审失败:', e)
    }

    return { mds: filteredMds, chunkPatches, hits }
  }

  // -------------------------------------------------------------------------
  // 主管线：generateClone
  // -------------------------------------------------------------------------

  isGenerating(): boolean {
    return this.runningController !== null
  }

  getLastProgress(): WeCloneProgressInfo | null {
    return this.lastProgress
  }

  getProgressHistory(): WeCloneProgressInfo[] {
    return [...this.progressHistory]
  }

  getProgressSnapshot(): { lastProgress: WeCloneProgressInfo | null; history: WeCloneProgressInfo[]; isGenerating: boolean } {
    return { lastProgress: this.lastProgress, history: [...this.progressHistory], isGenerating: this.isGenerating() }
  }

  private recordProgress(p: WeCloneProgressInfo): void {
    p.ts = Date.now()
    this.lastProgress = p
    this.progressHistory.push(p)
    if (this.progressHistory.length > 50) this.progressHistory.shift()
  }

  private scheduleProgressRetention(): void {
    if (this.progressRetentionTimer) {
      clearTimeout(this.progressRetentionTimer)
      this.progressRetentionTimer = null
    }
    this.progressRetentionTimer = setTimeout(() => {
      this.lastProgress = null
      this.progressRetentionTimer = null
    }, 5 * 60 * 1000)
    const maybeUnref = this.progressRetentionTimer as unknown as { unref?: () => void }
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref()
  }

  async generateClone(
    progressCb: ((progress: WeCloneProgress) => void) | undefined,
    externalSignal: AbortSignal | undefined,
    options: WeCloneGenerateOptions = {}
  ): Promise<WeCloneGenerateResult> {
    if (this.runningController) {
      return { success: false, error: '已有克隆生成任务进行中' }
    }
    const ctrl = new AbortController()
    this.runningController = ctrl
    if (externalSignal) {
      const forward = () => { try { ctrl.abort() } catch { /* noop */ } }
      if (externalSignal.aborted) forward()
      else externalSignal.addEventListener('abort', forward, { once: true })
    }
    const signal = ctrl.signal
    if (this.progressRetentionTimer) {
      clearTimeout(this.progressRetentionTimer)
      this.progressRetentionTimer = null
    }
    this.progressHistory = []
    this.lastProgress = null
    const report = (
      stage: WeCloneProgressStage,
      progress: number,
      message: string,
      detail?: Record<string, unknown>,
      status: WeCloneProgressStatus = 'running'
    ) => {
      const p: WeCloneProgressInfo = {
        stage,
        progress: Math.max(0, Math.min(100, Math.round(progress))),
        message,
        detail,
        status,
        ts: Date.now(),
      }
      this.recordProgress(p)
      try {
        progressCb?.(p)
      } catch { /* noop */ }
    }
    report('scan', 0, '开始生成', undefined, 'running')

    const wxid = this.getMyWxid()
    const dir = this.getStagingDir(wxid)
    const jsonlFinal = join(dir, 'chunks.jsonl')
    const jsonlPart = `${jsonlFinal}.part`

    try {
      // ---- 0. 前置检查 -----------------------------------------------------
      report('scan', 0, '正在检查配置…')
      const profile = await this.ensureForcedProvider()
      this.assertProfileReady(profile)

      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        throw new Error(connectResult.error || '数据库连接失败')
      }

      // ---- 1. 会话列表 -----------------------------------------------------
      report('scan', 2, '正在读取会话列表…')
      const { ids, names } = await this.collectSessionIds()
      if (ids.length === 0) throw new Error('没有可用的聊天会话')

      // ---- 2. 游标扫描 → 脱敏 → 分块 → JSONL -------------------------------
      try { rmSync(jsonlPart, { force: true }) } catch { /* noop */ }
      report('scan', 4, `开始扫描 ${ids.length} 个会话…`, { sessions: ids.length })
      const stats = await this.scanAllSessions(ids, jsonlPart, signal, (completed, total, messages) => {
        report('scan', (completed / Math.max(1, total)) * 30, `扫描会话 ${completed}/${total}（${messages.toLocaleString()} 条消息）`, { completed, total, messages })
      })
      this.ensureNotAborted(signal)
      renameSync(jsonlPart, jsonlFinal) // 原子收尾
      if (stats.messageCount === 0) throw new Error('没有扫到可用的文本消息')

      // ---- 3. Voice DNA + 采样 + 逐份生成 MD --------------------------------
      report('generate', 30, '正在计算语音硬指标（Voice DNA）…')
      const voiceDna = await computeVoiceDna(jsonlFinal)
      this.ensureNotAborted(signal)
      const voiceSheet = renderVoiceSheet(voiceDna)
      try {
        this.atomicWriteFile(join(dir, 'voice.json'), JSON.stringify(voiceDna, null, 2))
      } catch { /* 诊断文件，失败不阻塞 */ }
      console.log(`[WeClone] Voice DNA 样本 ${voiceDna.sampleCount} 条，中位长度 ${voiceDna.length.p50} 字符`)
      report('generate', 30, '正在采样语料…')
      const { sampled } = await this.sampleChunksFromJsonl(jsonlFinal, SAMPLE_RANDOM_CHUNKS, SAMPLE_RECENT_CHUNKS)
      const contextBase = `${voiceSheet}\n\n${this.buildGenerationContext(sampled, names)}`
      const mdKeys = Object.keys(WECLONE_MD_PROMPTS) as Array<keyof WeCloneMds>
      const mds: Partial<WeCloneMds> = {}
      for (let i = 0; i < mdKeys.length; i += 1) {
        const key = mdKeys[i]
        this.ensureNotAborted(signal)
        const baseProgress = 30 + (i / mdKeys.length) * 40
        report('generate', baseProgress, `正在生成 ${key}.md…`)
        const prompt = WECLONE_MD_PROMPTS[key].replace('{context}', contextBase)
        let streamedChars = 0
        let lastSubEmit = 0
        const onText = (chunk: string) => {
          streamedChars += chunk.length
          const now = Date.now()
          if (now - lastSubEmit < 100) return
          lastSubEmit = now
          const sub = Math.min(7.5, (streamedChars / MD_CHAR_LIMIT) * 8)
          report('generate', baseProgress + sub, `正在生成 ${key}.md…`)
        }
        const content = await this.callLlm(profile, WECLONE_SYSTEM_PROMPT, prompt, signal, onText)
        let cleaned = content.trim().slice(0, MD_CHAR_LIMIT)
        if (!cleaned) throw new Error(`${key}.md 生成结果为空`)
        // gen3：language.md 机器前置 Voice DNA 硬指标段（聊天端语气锚点，
        // 不依赖 LLM 是否复写数字；随上传原样带到服务端）
        if (key === 'language' && !cleaned.includes('## Voice DNA 硬指标')) {
          cleaned = `${voiceSheet}\n\n${cleaned}`.slice(0, MD_CHAR_LIMIT + 2_600)
        }
        mds[key] = cleaned
        this.atomicWriteFile(join(dir, `${key}.md`), cleaned)
        // ensure stage end snaps to next boundary
        report('generate', 30 + ((i + 1) / mdKeys.length) * 40, `已生成 ${key}.md`)
      }
      const fullMds: WeCloneMds = {
        profile: mds.profile || '',
        relationships: mds.relationships || '',
        knowledge: mds.knowledge || '',
        timeline: mds.timeline || '',
        language: mds.language || '',
      }

      // ---- 4. 第二阶段 PII 审查 --------------------------------------------
      report('filter', 70, '正在进行二次隐私审查…')
      let filterSteps = 0
      const filterResult = await this.runSecondPassFilter(profile, fullMds, jsonlFinal, signal, (message) => {
        filterSteps += 1
        // 70 -> 85 across ~6 steps (5 MD + sampling headroom)
        const pct = 70 + Math.min(15, (filterSteps / 6) * 15)
        report('filter', pct, message)
      })
      for (const { key, path } of this.mdFilePaths(dir)) {
        this.atomicWriteFile(path, filterResult.mds[key])
      }

      // ---- 5. 元数据（先落本地，无论是否上传） ------------------------------
      const now = new Date()
      const meta: WeCloneMeta = {
        id: `wc_${wxid}_${now.getTime().toString(36)}`,
        wxid,
        displayName: wxid,
        knowledgeCutoff: stats.cutoffTs
          ? new Date(stats.cutoffTs * 1000).toISOString().slice(0, 10)
          : now.toISOString().slice(0, 10),
        messageCount: stats.messageCount,
        sessionCount: stats.sessionCount,
        chunkCount: 0,
        generatedAt: now.toISOString(),
        visibility: 'private',
        uploaded: false,
        uploadStatus: 'local_only',
        piiHits: filterResult.hits,
        truncated: stats.truncated,
      }
      meta.chunkCount = (await this.sampleChunksFromJsonl(jsonlFinal, 0, 0)).total
      this.writeMeta(dir, meta)
      try { this.configService.set('weCloneLastCutoff', meta.knowledgeCutoff) } catch { /* noop */ }

      // ---- 6. 上传 ----------------------------------------------------------
      let status: 'local_only' | 'uploaded' | 'failed' = 'local_only'
      const serverCfg = this.resolveUploadServerConfig()
      if (options.localOnly !== true && serverCfg.configured) {
        report('upload', 85, '正在上传到私有服务…')
        try {
          const serverId = await this.uploadToServer(serverCfg, meta, filterResult.mds, jsonlFinal, filterResult.chunkPatches, signal)
          meta.serverId = serverId
          meta.uploaded = true
          meta.uploadStatus = 'uploaded'
          status = 'uploaded'
          this.writeMeta(dir, meta)
          report('upload', 98, '上传完成')
        } catch (e) {
          if ((e as Error)?.name === 'WeCloneAbortedError') throw e
          meta.uploadStatus = 'failed'
          this.writeMeta(dir, meta)
          console.warn('[WeClone] 上传失败（克隆已保存在本地）:', e)
          report('upload', 98, '上传失败，已保存在本地')
        }
      }

      report('done', 100, status === 'uploaded' ? '克隆生成并上传完成' : '克隆已在本地生成', { status }, 'done')
      return { success: true, clone: meta, status }
    } catch (e) {
      const aborted = (e as Error)?.name === 'WeCloneAbortedError' || signal.aborted
      const message = aborted ? '已取消' : String((e as Error)?.message || e)
      console.warn('[WeClone] 生成失败:', e)
      if (aborted) {
        const p: WeCloneProgressInfo = {
          stage: 'cancelled',
          progress: (this.lastProgress as WeCloneProgressInfo | null)?.progress ?? 99,
          message,
          status: 'cancelled',
          ts: Date.now(),
        }
        this.recordProgress(p)
        try { progressCb?.(p) } catch { /* noop */ }
      } else {
        const p: WeCloneProgressInfo = {
          stage: 'error',
          progress: (this.lastProgress as WeCloneProgressInfo | null)?.progress ?? 99,
          message: `生成失败：${message}`,
          status: 'error',
          ts: Date.now(),
        }
        this.recordProgress(p)
        try { progressCb?.(p) } catch { /* noop */ }
      }
      return { success: false, aborted, error: message }
    } finally {
      this.scheduleProgressRetention()
      this.runningController = null
      try { rmSync(jsonlPart, { force: true }) } catch { /* noop */ }
    }
  }

  // -------------------------------------------------------------------------
  // 上传 / 服务端交互
  // -------------------------------------------------------------------------

  private normalizeBaseUrl(url: string): string {
    return String(url || '').trim().replace(/\/+$/, '')
  }

  private isHtmlBody(text: string): boolean {
    const t = String(text || '').trim().toLowerCase()
    return t.startsWith('<!doctype') || t.startsWith('<html')
  }

  private buildHtmlError(baseUrl: string): string {
    const u = this.normalizeBaseUrl(baseUrl)
    return `服务器返回 HTML 而非 JSON — Railway 可能部署的是 Weport 主应用而非 weclone 服务，请检查根 Dockerfile 是否为 weclone-server 构建 (当前访问 ${u} 返回 HTML)`
  }

  private buildNotFoundHtmlError(): string {
    return '服务未找到 (404) — 请确认 Railway 服务已部署且健康检查 /health 通过'
  }

  private async fetchWithTimeout(url: string, init: Parameters<typeof fetch>[1], timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const onExternalAbort = () => ctrl.abort()
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    try {
      return await fetch(url, { ...init, signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  private authHeaders(token: string): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  /**
   * 流式回读 chunks.jsonl 组装上传 payload（应用二审补丁），gzip 后 POST。
   * chunks 预算 gzip 前 ≤ 20 MB，超出优雅截断。
   */
  private async uploadToServer(
    serverCfg: { baseUrl: string; token: string },
    meta: WeCloneMeta,
    mds: WeCloneMds,
    jsonlPath: string,
    chunkPatches: Map<string, string>,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const lines: string[] = []
    let bytes = 0
    let truncated = false
    const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let chunk: WeCloneChunk | null = null
        try { chunk = JSON.parse(trimmed) as WeCloneChunk } catch { chunk = null }
        const text = chunk && chunkPatches.has(chunk.id) ? JSON.stringify({ ...(chunk as WeCloneChunk), text: chunkPatches.get(chunk.id) }) : trimmed
        const size = Buffer.byteLength(text, 'utf8') + 1
        if (bytes + size > MAX_CHUNKS_UPLOAD_BYTES) {
          truncated = true
          break
        }
        lines.push(text)
        bytes += size
      }
    } finally {
      rl.close()
    }

    const payload = {
      meta: {
        wxid: meta.wxid,
        displayName: meta.displayName,
        knowledgeCutoff: meta.knowledgeCutoff,
        createdAt: Date.now(),
        clientVersion: app.getVersion(),
        messageCount: meta.messageCount,
        sessionCount: meta.sessionCount,
        chunkCount: lines.length,
        chunksTruncated: truncated,
        piiHits: meta.piiHits || 0,
      },
      mds: {
        'profile.md': mds.profile,
        'relationships.md': mds.relationships,
        'knowledge.md': mds.knowledge,
        'timeline.md': mds.timeline,
        'language.md': mds.language,
      },
      chunks: lines.map((line) => JSON.parse(line) as WeCloneChunk),
      visibility: meta.visibility,
    }

    const body = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
    const normalizedBaseUrl = this.normalizeBaseUrl(serverCfg.baseUrl)
    const url = `${normalizedBaseUrl}/api/weclone/upload`
    const resp = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(serverCfg.token),
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
        body: new Uint8Array(body),
      },
      120_000,
      signal
    )
    const text = await resp.text().catch(() => '')
    const contentType = resp.headers.get('content-type') || ''
    const isHtmlCt = contentType.toLowerCase().includes('text/html')
    const bodyIsHtml = this.isHtmlBody(text)
    if (!resp.ok) {
      if (resp.status === 404 && (isHtmlCt || bodyIsHtml)) {
        throw new Error(this.buildNotFoundHtmlError())
      }
      if (isHtmlCt || bodyIsHtml) {
        throw new Error(this.buildHtmlError(normalizedBaseUrl))
      }
      throw new Error(`上传失败 HTTP ${resp.status}${text ? `：${text.slice(0, 200)}` : ''}`)
    }
    if (isHtmlCt || bodyIsHtml) {
      throw new Error(this.buildHtmlError(normalizedBaseUrl))
    }
    let parsed: { success?: boolean; id?: string; error?: string } = {}
    try {
      parsed = JSON.parse(text) as { success?: boolean; id?: string; error?: string }
    } catch (e) {
      if (bodyIsHtml) throw new Error(this.buildHtmlError(normalizedBaseUrl))
      throw new Error(`上传响应解析失败：${String((e as Error)?.message || e)}`)
    }
    if (parsed.success === false) throw new Error(parsed.error || '服务端拒绝上传')
    const serverId = String(parsed.id || '').trim()
    if (!serverId) throw new Error('服务端未返回 clone id')
    return serverId
  }

  /**
   * 上传前确保存在 ownerToken：服务端 /upload 要求 Bearer（owner 身份即 token）。
   * 历史版本允许留空，这里首次上传时自动生成并持久化（safeStorage 加密），
   * 之后所有上传/删除/可见性操作都用同一身份。
   */
  private resolveUploadServerConfig(): { configured: boolean; baseUrl: string; token: string } {
    const cfg = this.getServerConfig()
    let token = cfg.token
    if (!token) {
      token = `wc_${randomUUID()}`
      try {
        this.configService.set('weCloneServerToken', token)
        console.log('[WeClone] 已自动生成 ownerToken 并写入配置（safeStorage 加密）')
      } catch (e) {
        console.warn('[WeClone] ownerToken 持久化失败（本次上传仍会使用内存值）:', e)
      }
    }
    return { configured: cfg.configured, baseUrl: this.normalizeBaseUrl(cfg.baseUrl), token }
  }

  /**
   * 上传一个已存在的本地克隆（v0.9.10 补充能力）：
   * 直接复用 staging 目录里的 mds/*.md + chunks.jsonl（无二审补丁可应用），
   * 让「Railway 已部署但克隆是 local_only」的老档案无需重新生成即可分享。
   */
  async uploadExistingClone(id: string): Promise<{ success: boolean; serverId?: string; error?: string }> {
    const root = this.getStagingRoot()
    let targetDir: string | null = null
    let meta: WeCloneMeta | null = null
    for (const entry of readdirSyncSafe(root)) {
      const dir = join(root, entry)
      const m = this.readMeta(dir)
      if (m && m.id === id) {
        targetDir = dir
        meta = m
        break
      }
    }
    if (!targetDir || !meta) return { success: false, error: '找不到该克隆' }

    const serverCfg = this.resolveUploadServerConfig()
    if (!serverCfg.configured || !serverCfg.baseUrl) {
      return { success: false, error: '未配置克隆服务器（weport.up.railway.app 不可达或被禁用）' }
    }

    // 读取本地 MD
    const mds: Partial<WeCloneMds> = {}
    for (const { key, path } of this.mdFilePaths(targetDir)) {
      try {
        if (existsSync(path)) (mds as Record<string, string>)[key] = readFileSync(path, 'utf8')
      } catch { /* 单份缺失不阻断 */ }
    }
    if (!mds.profile && !mds.relationships && !mds.knowledge) {
      return { success: false, error: '本地档案缺少知识文件（profile/relationships/knowledge 至少需要一份）' }
    }
    const jsonlPath = join(targetDir, 'chunks.jsonl')
    if (!existsSync(jsonlPath)) {
      return { success: false, error: '本地档案缺少语料文件 chunks.jsonl，无法上传' }
    }

    const fullMds: WeCloneMds = {
      profile: mds.profile || '',
      relationships: mds.relationships || '',
      knowledge: mds.knowledge || '',
      timeline: mds.timeline || '',
      language: mds.language || '',
    }

    try {
      const serverId = await this.uploadToServer(
        { baseUrl: serverCfg.baseUrl, token: serverCfg.token },
        meta,
        fullMds,
        jsonlPath,
        new Map<string, string>(),
        undefined
      )
      meta.serverId = serverId
      meta.uploaded = true
      meta.uploadStatus = 'uploaded'
      this.writeMeta(targetDir, meta)
      console.log(`[WeClone] 本地克隆 ${id} 已上传为 serverId=${serverId}`)
      return { success: true, serverId }
    } catch (e) {
      const message = String((e as Error)?.message || e)
      console.warn(`[WeClone] 本地克隆 ${id} 上传失败:`, e)
      try {
        meta.uploadStatus = 'failed'
        this.writeMeta(targetDir, meta)
      } catch { /* noop */ }
      return { success: false, error: message }
    }
  }

  async deleteClone(id: string, remote: boolean): Promise<{ success: boolean; error?: string }> {
    const root = this.getStagingRoot()
    let targetDir: string | null = null
    let meta: WeCloneMeta | null = null
    for (const entry of readdirSyncSafe(root)) {
      const dir = join(root, entry)
      const m = this.readMeta(dir)
      if (m && m.id === id) {
        targetDir = dir
        meta = m
        break
      }
    }
    if (!targetDir || !meta) return { success: false, error: '找不到该克隆' }

    const serverCfg = this.getServerConfig()
    if (remote && serverCfg.configured && meta.serverId) {
      try {
        const normalizedBaseUrl = this.normalizeBaseUrl(serverCfg.baseUrl)
        const resp = await this.fetchWithTimeout(
          `${normalizedBaseUrl}/api/weclone/${encodeURIComponent(meta.serverId)}`,
          { method: 'DELETE', headers: this.authHeaders(serverCfg.token) },
          30_000
        )
        if (!resp.ok && resp.status !== 404) {
          const text = await resp.text().catch(() => '')
          const ct = resp.headers.get('content-type') || ''
          const isHtml = ct.toLowerCase().includes('text/html') || this.isHtmlBody(text)
          if (isHtml) {
            const msg = resp.status === 404 ? this.buildNotFoundHtmlError() : this.buildHtmlError(normalizedBaseUrl)
            return { success: false, error: `服务端删除失败：${msg}` }
          }
          return { success: false, error: `服务端删除失败 HTTP ${resp.status}` }
        }
      } catch (e) {
        return { success: false, error: `服务端删除失败：${String((e as Error)?.message || e)}` }
      }
    }
    try {
      rmSync(targetDir, { recursive: true, force: true })
    } catch (e) {
      return { success: false, error: `本地目录删除失败：${String((e as Error)?.message || e)}` }
    }
    return { success: true }
  }

  async setVisibility(id: string, visibility: string): Promise<{ success: boolean; shareUrl?: string; error?: string }> {
    const v = String(visibility || '')
    if (!['private', 'public', 'link'].includes(v)) return { success: false, error: '无效的可见性' }
    const root = this.getStagingRoot()
    for (const entry of readdirSyncSafe(root)) {
      const dir = join(root, entry)
      const meta = this.readMeta(dir)
      if (!meta || meta.id !== id) continue
      meta.visibility = v as WeCloneVisibility
      this.writeMeta(dir, meta)
      const serverCfg = this.getServerConfig()
      const remoteId = meta.serverId
      if (serverCfg.configured && remoteId) {
        try {
          const normalizedBaseUrl = this.normalizeBaseUrl(serverCfg.baseUrl)
          const resp = await this.fetchWithTimeout(
            `${normalizedBaseUrl}/api/weclone/${encodeURIComponent(remoteId)}/visibility`,
            {
              method: 'PATCH',
              headers: { ...this.authHeaders(serverCfg.token), 'Content-Type': 'application/json' },
              body: JSON.stringify({ visibility: v }),
            },
            30_000
          )
          const text = await resp.text().catch(() => '')
          const ct = resp.headers.get('content-type') || ''
          const isHtmlCt = ct.toLowerCase().includes('text/html')
          const bodyIsHtml = this.isHtmlBody(text)
          if (!resp.ok) {
            if (resp.status === 404 && (isHtmlCt || bodyIsHtml)) {
              return { success: false, error: `服务端更新失败：${this.buildNotFoundHtmlError()}` }
            }
            if (isHtmlCt || bodyIsHtml) {
              return { success: false, error: `服务端更新失败：${this.buildHtmlError(normalizedBaseUrl)}` }
            }
            return { success: false, error: `服务端更新失败 HTTP ${resp.status}` }
          }
          if (isHtmlCt || bodyIsHtml) {
            return { success: false, error: `服务端更新失败：${this.buildHtmlError(normalizedBaseUrl)}` }
          }
          try {
            const parsed = JSON.parse(text) as { shareUrl?: string }
            if (parsed.shareUrl) return { success: true, shareUrl: parsed.shareUrl }
          } catch (e) {
            if (bodyIsHtml) return { success: false, error: `服务端更新失败：${this.buildHtmlError(normalizedBaseUrl)}` }
            // JSON parse failure on success is non-fatal; treat as success without shareUrl
          }
        } catch (e) {
          return { success: false, error: `服务端更新失败：${String((e as Error)?.message || e)}` }
        }
      }
      return { success: true }
    }
    return { success: false, error: '找不到该克隆' }
  }

  /** 合并本地 + 远端克隆列表 — 远端失败仅记 remoteError，仍回退到本地档案 */
  async getClones(): Promise<{ success: boolean; clones: WeCloneListItem[]; error?: string }> {
    const local = this.listLocalClones().map<WeCloneListItem>((m) => ({ ...m, source: 'local' }))
    const serverCfg = this.getServerConfig()
    if (!serverCfg.configured) return { success: true, clones: local }

    type RemoteRow = { id?: string; displayName?: string; cutoff?: string; visibility?: string; createdAt?: number }
    let remoteRows: RemoteRow[] = []
    let remoteError: string | undefined
    const normalizedBaseUrl = this.normalizeBaseUrl(serverCfg.baseUrl)
    try {
      const resp = await this.fetchWithTimeout(
        `${normalizedBaseUrl}/api/weclone/list`,
        { method: 'GET', headers: this.authHeaders(serverCfg.token) },
        15_000
      )
      const text = await resp.text().catch(() => '')
      const contentType = resp.headers.get('content-type') || ''
      const isHtmlCt = contentType.toLowerCase().includes('text/html')
      const bodyIsHtml = this.isHtmlBody(text)

      if (!resp.ok) {
        if (resp.status === 404 && (isHtmlCt || bodyIsHtml)) {
          throw new Error(this.buildNotFoundHtmlError())
        }
        if (isHtmlCt || bodyIsHtml) {
          throw new Error(this.buildHtmlError(normalizedBaseUrl))
        }
        throw new Error(`HTTP ${resp.status}${text ? `：${text.slice(0, 200)}` : ''}`)
      }

      // resp.ok — still verify not HTML before parsing
      if (isHtmlCt) {
        throw new Error(this.buildHtmlError(normalizedBaseUrl))
      }
      if (bodyIsHtml) {
        throw new Error(this.buildHtmlError(normalizedBaseUrl))
      }

      let parsed: { clones?: RemoteRow[] }
      try {
        parsed = JSON.parse(text) as { clones?: RemoteRow[] }
      } catch (e) {
        if (bodyIsHtml || isHtmlCt) {
          throw new Error(this.buildHtmlError(normalizedBaseUrl))
        }
        // Re-check raw body prefix even if content-type missing
        const trimmed = String(text || '').trim().toLowerCase()
        if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
          throw new Error(this.buildHtmlError(normalizedBaseUrl))
        }
        throw new Error(`响应解析失败：${String((e as Error)?.message || e)}`)
      }
      remoteRows = Array.isArray(parsed.clones) ? parsed.clones : []
    } catch (e) {
      const msg = String((e as Error)?.message || e)
      remoteError = msg
      // Ensure confusing JSON parse error never surfaces as raw "Unexpected token '<'"
      console.warn(`[WeClone] 远端列表获取失败 (baseUrl=${normalizedBaseUrl})：`, msg, e)
    }

    const byServerId = new Map(local.filter((m) => m.serverId).map((m) => [m.serverId as string, m]))
    const merged: WeCloneListItem[] = local.map((m) => ({ ...m }))
    for (const row of remoteRows) {
      const rid = String(row.id || '').trim()
      if (!rid) continue
      const existing = byServerId.get(rid)
      if (existing) {
        existing.source = 'both'
        if (row.visibility === 'public' || row.visibility === 'link' || row.visibility === 'private') {
          existing.visibility = row.visibility
        }
        if (row.displayName) existing.displayName = row.displayName
      } else {
        merged.push({
          id: `remote_${rid}`,
          wxid: '',
          displayName: String(row.displayName || rid),
          knowledgeCutoff: String(row.cutoff || ''),
          messageCount: 0,
          sessionCount: 0,
          chunkCount: 0,
          generatedAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
          visibility: row.visibility === 'public' || row.visibility === 'link' ? row.visibility : 'private',
          uploaded: true,
          uploadStatus: 'uploaded',
          serverId: rid,
          source: 'remote',
        })
      }
    }
    return { success: true, clones: merged, error: remoteError }
  }

  async getServerStatus(): Promise<WeCloneServerStatus> {
    const cfg = this.getServerConfig()
    const normalizedBaseUrl = this.normalizeBaseUrl(cfg.baseUrl)
    const base: WeCloneServerStatus = {
      configured: cfg.configured,
      enabled: cfg.enabled,
      baseUrl: normalizedBaseUrl,
      hasToken: Boolean(cfg.token),
    }
    if (!cfg.configured) return base
    try {
      const resp = await this.fetchWithTimeout(`${normalizedBaseUrl}/health`, { method: 'GET' }, 8_000)
      const text = await resp.text().catch(() => '')
      const ct = resp.headers.get('content-type') || ''
      const isHtmlCt = ct.toLowerCase().includes('text/html')
      const bodyIsHtml = this.isHtmlBody(text)
      if (!resp.ok) {
        if (resp.status === 404 && (isHtmlCt || bodyIsHtml)) {
          return { ...base, online: false, error: this.buildNotFoundHtmlError() }
        }
        if (isHtmlCt || bodyIsHtml) {
          return { ...base, online: false, error: this.buildHtmlError(normalizedBaseUrl) }
        }
        return { ...base, online: false, error: `HTTP ${resp.status}` }
      }
      if (isHtmlCt || bodyIsHtml) {
        return { ...base, online: false, error: this.buildHtmlError(normalizedBaseUrl) }
      }
      try {
        const parsed = JSON.parse(text) as { ok?: boolean; version?: string }
        return { ...base, online: parsed.ok !== false, version: parsed.version }
      } catch {
        if (bodyIsHtml) return { ...base, online: false, error: this.buildHtmlError(normalizedBaseUrl) }
        return { ...base, online: resp.ok }
      }
    } catch (e) {
      return { ...base, online: false, error: String((e as Error)?.message || e) }
    }
  }

  // -------------------------------------------------------------------------
  // 本地对话（不走 Railway，复用强制 provider 直接在本地跑 agent）
  // -------------------------------------------------------------------------

  private tokenizeForLocalSearch(text: string): string[] {
    const s = String(text || '').toLowerCase().trim()
    if (!s) return []
    const tokens: string[] = []
    // 空白分词
    for (const part of s.split(/\s+/)) {
      if (!part) continue
      if (/[\u4e00-\u9fff]/.test(part)) {
        // CJK 按字 + 二元组
        for (let i = 0; i < part.length; i += 1) tokens.push(part[i])
        for (let i = 0; i < part.length - 1; i += 1) tokens.push(part.slice(i, i + 2))
      } else {
        tokens.push(part)
      }
    }
    return tokens
  }

  private scoreChunkLocal(queryTokens: string[], chunkText: string): number {
    const chunkLower = chunkText.toLowerCase()
    let score = 0
    for (const tok of queryTokens) {
      if (!tok) continue
      if (chunkLower.includes(tok)) score += tok.length > 1 ? 2 : 1
    }
    // 长度惩罚：超长 chunk 轻微惩罚
    const len = chunkText.length
    if (len > 1000) score *= 0.9
    return score
  }

  async chatLocal(
    id: string,
    message: string,
    history: Array<{ role: string; content: string }> = [],
    onDelta?: (delta: string) => void,
    externalSignal?: AbortSignal
  ): Promise<{ success: boolean; reply?: string; error?: string }> {
    const msg = String(message || '').trim()
    if (!msg) return { success: false, error: '消息为空' }
    // 定位克隆目录
    const root = this.getStagingRoot()
    let targetDir: string | null = null
    let meta: WeCloneMeta | null = null
    for (const entry of readdirSyncSafe(root)) {
      const dir = join(root, entry)
      const m = this.readMeta(dir)
      if (m && m.id === id) {
        targetDir = dir
        meta = m
        break
      }
    }
    if (!targetDir || !meta) return { success: false, error: '找不到该克隆' }

    // 读取 MD
    const mds: Partial<Record<'profile' | 'relationships' | 'knowledge' | 'timeline' | 'language', string>> = {}
    for (const { key, path } of this.mdFilePaths(targetDir)) {
      try {
        if (existsSync(path)) (mds as Record<string, string>)[key] = readFileSync(path, 'utf8')
      } catch (e) {
        console.warn(`[WeClone] 读取 ${key}.md 失败:`, e)
      }
    }
    // 读取 chunks 并检索 top 8
    const jsonlPath = join(targetDir, 'chunks.jsonl')
    const allChunks: WeCloneChunk[] = []
    if (existsSync(jsonlPath)) {
      try {
        const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
        for await (const line of rl) {
          const t = line.trim()
          if (!t) continue
          try {
            const c = JSON.parse(t) as WeCloneChunk
            if (c && typeof c.text === 'string') allChunks.push(c)
          } catch { /* noop */ }
          if (allChunks.length > 5000) break
        }
        rl.close()
      } catch { /* noop */ }
    }
    const queryTokens = this.tokenizeForLocalSearch(msg)
    const scored = allChunks
      .map((c) => ({ c, score: this.scoreChunkLocal(queryTokens, c.text) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.c.text.slice(0, 800))

    // 若无匹配，取最近 3 条作兜底
    const retrieved = scored.length > 0 ? scored : allChunks.slice(-3).map((c) => c.text.slice(0, 800))
    console.log(`[WeClone] chatLocal id=${id} mdsKeys=${Object.keys(mds).join(',')} allChunks=${allChunks.length} queryTokens=${queryTokens.length} retrieved=${retrieved.length}`)

    const systemPrompt = buildWeCloneChatSystemPrompt({
      displayName: meta.displayName || meta.wxid || '我',
      knowledgeCutoff: meta.knowledgeCutoff,
      mds: mds as Partial<Record<'profile' | 'relationships' | 'knowledge' | 'timeline' | 'language', string>>,
      retrievedChunks: retrieved,
    })

    // 强制 provider
    let profile: ProviderProfile | null = null
    try {
      profile = await this.ensureForcedProvider()
      this.assertProfileReady(profile)
    } catch (e) {
      return { success: false, error: String((e as Error)?.message || e) }
    }

    const historyMessages = (Array.isArray(history) ? history : [])
      .filter((h) => h && typeof h.role === 'string' && typeof h.content === 'string')
      .slice(-20)
      .map((h) => ({ role: h.role as 'user' | 'assistant', content: String(h.content).slice(0, 4000) }))

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: this.sanitizeForApi(systemPrompt) },
      ...historyMessages.map((h) => ({ role: h.role as 'user' | 'assistant', content: this.sanitizeForApi(h.content) })),
      { role: 'user', content: this.sanitizeForApi(msg) },
    ]

    const abortCtrl = new AbortController()
    const onExternalAbort = () => abortCtrl.abort()
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    const timeout = setTimeout(() => abortCtrl.abort(), 120_000)
    let full = ''
    try {
      const { content, model } = await this.streamLlm({
        profile: profile as ProviderProfile,
        messages,
        reasoningEffort: String(this.cfgGet('weportAiReasoningEffort') || 'high'),
        signal: abortCtrl.signal as unknown as AbortSignal,
        onText: (chunk: string) => {
          const d = String(chunk || '')
          if (!d) return
          full += d
          try { onDelta?.(d) } catch { /* noop */ }
        },
      })
      void model
      const reply = String(content || full || '').trim()
      if (!reply) return { success: false, error: '模型未返回内容' }
      return { success: true, reply }
    } catch (e) {
      console.error('[WeClone] chatLocal LLM error:', e)
      if ((e as Error)?.name === 'AbortError' || (e as Error)?.name === 'WeCloneAbortedError' || abortCtrl.signal.aborted || externalSignal?.aborted) {
        return { success: false, error: '已取消' }
      }
      const msg = String((e as Error)?.message || e)
      // 常见：API Key 未配置、网络、模型不存在
      if (msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
        return { success: false, error: 'API Key 无效或未配置，请在 人格克隆 → OpenCode Go API Key 中设置 muse-spark-1.2-contributor 的 Key' }
      }
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        return { success: false, error: `模型或服务未找到：${msg}（已固定为 opencode-go/muse-spark-1.2-contributor，请检查服务是否可用）` }
      }
      if (/internal server error|HTTP 5\d{2}|500/i.test(msg)) {
        return {
          success: false,
          error: `上游模型 muse-spark-1.2-contributor 暂时不可用（${msg}）。这是 OpenCode Go 网关侧的故障，与本地配置无关 — 请稍后重试`,
        }
      }
      return { success: false, error: msg }
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  // 兼容别名：供旧调用方或测试使用的远端拉取入口
  async getRemoteClones(): Promise<{ success: boolean; clones: WeCloneListItem[]; error?: string }> {
    return this.getClones()
  }

  async fetchRemote(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
    const cfg = this.getServerConfig()
    const normalizedBaseUrl = this.normalizeBaseUrl(cfg.baseUrl)
    const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${String(path || '')}`
    const url = `${normalizedBaseUrl}${normalizedPath}`
    const resp = await this.fetchWithTimeout(url, init as Parameters<typeof fetch>[1], timeoutMs)
    const ct = resp.headers.get('content-type') || ''
    // 预检 HTML 以便调用方获得更清晰的错误（仍返回 Response 供上层决定）
    if (ct.toLowerCase().includes('text/html')) {
      const text = await resp.clone().text().catch(() => '')
      if (this.isHtmlBody(text)) {
        console.warn(`[WeClone] fetchRemote 收到 HTML 响应 (${url}) — ${this.buildHtmlError(normalizedBaseUrl)}`)
      }
    }
    return resp
  }
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return existsSync(dir) ? readdirSync(dir) : []
  } catch {
    return []
  }
}

export const weCloneService = new WeCloneService()
