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
} from './weClonePrompts'

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

export type WeCloneProgressStage = 'scan' | 'generate' | 'filter' | 'upload' | 'done'

export interface WeCloneProgress {
  stage: WeCloneProgressStage
  /** 总进度 0-100 */
  progress: number
  message: string
  detail?: Record<string, unknown>
}

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
/** 生成上下文采样：随机 + 最近 */
const SAMPLE_RANDOM_CHUNKS = 200
const SAMPLE_RECENT_CHUNKS = 50
/** 生成上下文总字符上限 */
const GENERATION_CONTEXT_CHAR_LIMIT = 120_000

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class WeCloneService {
  private configService: ConfigService
  private providerProfiles: ProviderProfileService
  private runningController: AbortController | null = null

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
      return cfg
    } catch {
      const enabled = this.cfgGet('weCloneEnabled') !== false
      const baseUrl = String(this.cfgGet('weCloneServerUrl') || '').trim().replace(/\/+$/, '')
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
    return `${who}: ${text.replace(/\r?\n/g, ' ')}`
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

  private async callLlm(
    profile: ProviderProfile,
    systemContent: string,
    userContent: string,
    signal?: AbortSignal
  ): Promise<string> {
    const reasoningEffort = String(this.cfgGet('weportAiReasoningEffort') || 'high')
    const result = await getProviderAdapter(profile).stream({
      profile,
      messages: [
        { role: 'system', content: this.sanitizeForApi(systemContent) },
        { role: 'user', content: this.sanitizeForApi(userContent) },
      ],
      tools: [],
      reasoningEffort,
      signal: signal ?? AbortSignal.timeout(300_000),
      onReasoning: () => undefined,
      onText: () => undefined,
    })
    return String(result.content || '')
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
    const report = (stage: WeCloneProgressStage, progress: number, message: string, detail?: Record<string, unknown>) => {
      try {
        progressCb?.({ stage, progress: Math.max(0, Math.min(100, Math.round(progress))), message, detail })
      } catch { /* noop */ }
    }

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
        report('scan', 4 + (completed / Math.max(1, total)) * 46, `扫描会话 ${completed}/${total}（${messages.toLocaleString()} 条消息）`, { completed, total, messages })
      })
      this.ensureNotAborted(signal)
      renameSync(jsonlPart, jsonlFinal) // 原子收尾
      if (stats.messageCount === 0) throw new Error('没有扫到可用的文本消息')

      // ---- 3. 采样 + 逐份生成 MD -------------------------------------------
      report('generate', 52, '正在采样语料…')
      const { sampled } = await this.sampleChunksFromJsonl(jsonlFinal, SAMPLE_RANDOM_CHUNKS, SAMPLE_RECENT_CHUNKS)
      const contextBase = this.buildGenerationContext(sampled, names)
      const mdKeys = Object.keys(WECLONE_MD_PROMPTS) as Array<keyof WeCloneMds>
      const mds: Partial<WeCloneMds> = {}
      for (let i = 0; i < mdKeys.length; i += 1) {
        const key = mdKeys[i]
        this.ensureNotAborted(signal)
        report('generate', 54 + (i / mdKeys.length) * 28, `正在生成 ${key}.md…`)
        const prompt = WECLONE_MD_PROMPTS[key].replace('{context}', contextBase)
        const content = await this.callLlm(profile, WECLONE_SYSTEM_PROMPT, prompt, signal)
        const cleaned = content.trim().slice(0, MD_CHAR_LIMIT)
        if (!cleaned) throw new Error(`${key}.md 生成结果为空`)
        mds[key] = cleaned
        this.atomicWriteFile(join(dir, `${key}.md`), cleaned)
      }
      const fullMds: WeCloneMds = {
        profile: mds.profile || '',
        relationships: mds.relationships || '',
        knowledge: mds.knowledge || '',
        timeline: mds.timeline || '',
        language: mds.language || '',
      }

      // ---- 4. 第二阶段 PII 审查 --------------------------------------------
      report('filter', 84, '正在进行二次隐私审查…')
      const filterResult = await this.runSecondPassFilter(profile, fullMds, jsonlFinal, signal, (message) => {
        report('filter', 85, message)
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
      const serverCfg = this.getServerConfig()
      if (options.localOnly !== true && serverCfg.configured) {
        report('upload', 90, '正在上传到私有服务…')
        try {
          const serverId = await this.uploadToServer(serverCfg, meta, filterResult.mds, jsonlFinal, filterResult.chunkPatches, signal)
          meta.serverId = serverId
          meta.uploaded = true
          meta.uploadStatus = 'uploaded'
          status = 'uploaded'
          this.writeMeta(dir, meta)
        } catch (e) {
          if ((e as Error)?.name === 'WeCloneAbortedError') throw e
          meta.uploadStatus = 'failed'
          this.writeMeta(dir, meta)
          console.warn('[WeClone] 上传失败（克隆已保存在本地）:', e)
        }
      }

      report('done', 100, status === 'uploaded' ? '克隆生成并上传完成' : '克隆已在本地生成', { status })
      return { success: true, clone: meta, status }
    } catch (e) {
      const aborted = (e as Error)?.name === 'WeCloneAbortedError' || signal.aborted
      const message = aborted ? '已取消' : String((e as Error)?.message || e)
      console.warn('[WeClone] 生成失败:', e)
      if (!aborted) report('done', 100, `生成失败：${message}`)
      return { success: false, aborted, error: message }
    } finally {
      this.runningController = null
      try { rmSync(jsonlPart, { force: true }) } catch { /* noop */ }
    }
  }

  // -------------------------------------------------------------------------
  // 上传 / 服务端交互
  // -------------------------------------------------------------------------

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
    const url = `${serverCfg.baseUrl}/api/weclone/upload`
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
    if (!resp.ok) {
      throw new Error(`上传失败 HTTP ${resp.status}${text ? `：${text.slice(0, 200)}` : ''}`)
    }
    let parsed: { success?: boolean; id?: string; error?: string } = {}
    try { parsed = JSON.parse(text) as { success?: boolean; id?: string; error?: string } } catch { /* noop */ }
    if (parsed.success === false) throw new Error(parsed.error || '服务端拒绝上传')
    const serverId = String(parsed.id || '').trim()
    if (!serverId) throw new Error('服务端未返回 clone id')
    return serverId
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
        const resp = await this.fetchWithTimeout(
          `${serverCfg.baseUrl}/api/weclone/${encodeURIComponent(meta.serverId)}`,
          { method: 'DELETE', headers: this.authHeaders(serverCfg.token) },
          30_000
        )
        if (!resp.ok && resp.status !== 404) {
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
          const resp = await this.fetchWithTimeout(
            `${serverCfg.baseUrl}/api/weclone/${encodeURIComponent(remoteId)}/visibility`,
            {
              method: 'PATCH',
              headers: { ...this.authHeaders(serverCfg.token), 'Content-Type': 'application/json' },
              body: JSON.stringify({ visibility: v }),
            },
            30_000
          )
          const text = await resp.text().catch(() => '')
          if (!resp.ok) return { success: false, error: `服务端更新失败 HTTP ${resp.status}` }
          try {
            const parsed = JSON.parse(text) as { shareUrl?: string }
            if (parsed.shareUrl) return { success: true, shareUrl: parsed.shareUrl }
          } catch { /* noop */ }
        } catch (e) {
          return { success: false, error: `服务端更新失败：${String((e as Error)?.message || e)}` }
        }
      }
      return { success: true }
    }
    return { success: false, error: '找不到该克隆' }
  }

  /** 合并本地 + 远端克隆列表 */
  async getClones(): Promise<{ success: boolean; clones: WeCloneListItem[]; error?: string }> {
    const local = this.listLocalClones().map<WeCloneListItem>((m) => ({ ...m, source: 'local' }))
    const serverCfg = this.getServerConfig()
    if (!serverCfg.configured) return { success: true, clones: local }

    type RemoteRow = { id?: string; displayName?: string; cutoff?: string; visibility?: string; createdAt?: number }
    let remoteRows: RemoteRow[] = []
    let remoteError: string | undefined
    try {
      const resp = await this.fetchWithTimeout(
        `${serverCfg.baseUrl}/api/weclone/list`,
        { method: 'GET', headers: this.authHeaders(serverCfg.token) },
        15_000
      )
      const text = await resp.text().catch(() => '')
      if (resp.ok) {
        const parsed = JSON.parse(text) as { clones?: RemoteRow[] }
        remoteRows = Array.isArray(parsed.clones) ? parsed.clones : []
      } else {
        remoteError = `HTTP ${resp.status}`
      }
    } catch (e) {
      remoteError = String((e as Error)?.message || e)
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
    const base: WeCloneServerStatus = {
      configured: cfg.configured,
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      hasToken: Boolean(cfg.token),
    }
    if (!cfg.configured) return base
    try {
      const resp = await this.fetchWithTimeout(`${cfg.baseUrl}/health`, { method: 'GET' }, 8_000)
      const text = await resp.text().catch(() => '')
      if (!resp.ok) return { ...base, online: false, error: `HTTP ${resp.status}` }
      try {
        const parsed = JSON.parse(text) as { ok?: boolean; version?: string }
        return { ...base, online: parsed.ok !== false, version: parsed.version }
      } catch {
        return { ...base, online: resp.ok }
      }
    } catch (e) {
      return { ...base, online: false, error: String((e as Error)?.message || e) }
    }
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
