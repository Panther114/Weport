/**
 * WeClone 人格克隆服务（v1.0 **纯本地**）。
 *
 * 管线：chatService.getSessions → wcdbService 消息游标扫描（批 500 / 并发 2 /
 * 单会话 15 万条上限）→ 本地 PII 正则脱敏 → 800 字符分块 → 流式 JSONL 落盘
 * （userData/weclone-staging/<wxid>/chunks.jsonl，原子写）→ 强制 provider 逐份
 * 生成 MD（profile/relationships/knowledge/timeline/language）→ LLM 二次 PII 审查。
 *
 * **边界（v1.0）：数据不出本机。** 这里原先把生成好的 MD + 语料 gzip 上传到一个
 * `weclone-server`，聊天时再向它发 HTTP。那条路径整体移除了 —— 上传、远端删除、
 * 可见性、服务器状态、本地服务自动拉起、HTTP 聊天全部删除；`chatWithClone` 改为
 * **本机**完成（人格 MD 注入上下文 + 本地 BM25 检索语料片段，见 ai/localRetrieval.ts）。
 * 唯一的外呼是用户自己配置的模型 API。
 *
 * 内存纪律：全量历史从不一次性驻留 RAM —— 扫描阶段只保留当前批次与分块缓冲；
 * 检索阶段单遍流式读 JSONL，只把 token 与长度留在内存，原文等 top-K 定了再回读。
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
import {
  ConfigService,
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
import {
  buildRetrievedContext,
  createCorpusBuilder,
  rankDocs,
  tokenize,
} from './ai/localRetrieval'

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
  piiHits?: number
  truncated?: boolean
}

/**
 * 列表项。
 *
 * v1.0 只有本地克隆，因此 `source` 恒为 `'local'`（保留字段是为了 UI 分组
 * 逻辑不用改），也不再需要 `shareUrl` —— 没有服务器就没有分享链接。
 */
export interface WeCloneListItem extends WeCloneMeta {
  source: 'local'
}

export type WeCloneProgressStage = 'scan' | 'generate' | 'filter' | 'done'

export interface WeCloneProgress {
  stage: WeCloneProgressStage
  /** 总进度 0-100 */
  progress: number
  message: string
  detail?: Record<string, unknown>
}

export interface WeCloneGenerateResult {
  success: boolean
  clone?: WeCloneMeta
  aborted?: boolean
  error?: string
}

/**
 * 本机对话的结果。
 *
 * `meta` 里带上检索统计（命中条数、耗时）而不是只回一句话：本地检索是这个功能
 * 里唯一会悄悄退化的环节（语料被删、检索没命中），把它暴露出来才能区分"模型
 * 没答好"和"根本没检索到东西"。
 */
export interface LocalChatResult {
  success: boolean
  reply?: string
  elapsedMs?: number
  error?: string
  hint?: string
  meta?: {
    cloneId: string
    displayName: string
    retrievedChunks: number
    corpusHits: number
    retrieveCostMs: number
  }
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
/** 本地检索：扫描的语料行数上限（内存与耗时的兜底护栏） */
const CORPUS_SCAN_LINE_CAP = 400_000
/** 本地检索：取回的片段数 */
const RETRIEVE_TOP_K = 24
/** 本地检索：拼进 prompt 的检索内容字符上限 */
const RETRIEVED_CONTEXT_CHAR_LIMIT = 12_000
/** 聊天：带上的历史轮数 */
const CHAT_HISTORY_LIMIT = 20
/** 聊天：模型调用超时（本地检索已预先完成，这里只等模型） */
const CHAT_TIMEOUT_MS = 180_000
/** 生成：遇到瞬时网络故障时同一个服务最多尝试几次（含首次） */
const LLM_TRANSIENT_ATTEMPTS = 3
/** 生成：重试退避基数（第 n 次等 n×base） */
const LLM_RETRY_BASE_DELAY_MS = 4_000

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
      // 老 metadata.json 里还留着 visibility/uploaded/uploadStatus/serverId
      // （上传时代的字段）。这里只挑当前模型认识的键：多出来的键直接忽略，
      // 不读、不写回，下一次 writeMeta 自然清掉，无需迁移脚本。
      return {
        id: String(raw.id),
        wxid: String(raw.wxid || ''),
        displayName: String(raw.displayName || ''),
        knowledgeCutoff: String(raw.knowledgeCutoff || ''),
        messageCount: Number(raw.messageCount) || 0,
        sessionCount: Number(raw.sessionCount) || 0,
        chunkCount: Number(raw.chunkCount) || 0,
        generatedAt: String(raw.generatedAt || ''),
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
    // WeClone 有自己的服务指向（默认跟随「默认服务」）。v1.0.1 之前它读的是全局
    // active —— 而它自己又会 activate 一个强制 profile，于是"打开一次人格克隆"
    // 就把 WeportAI 的服务换掉了。
    return this.providerProfiles.getForConsumer('weclone')
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
      name: `${catalog?.name || 'OpenCode Go'} · 人格克隆`,
      providerId: skeleton.providerId,
      protocol: skeleton.protocol,
      baseUrl: skeleton.baseUrl,
      model: skeleton.model,
      apiKey,
    })
    // 只把**人格克隆**指向这个 profile，不再抢占全局默认服务：默认服务是
    // WeportAI 与 WeBot 共用的，改它等于替用户改了另外两处。
    this.providerProfiles.assign('weclone', saved.id)
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

  /**
   * 单次模型调用（生成 MD / 二审用）。
   *
   * 这里**不带回落**：调用方负责依次尝试候选服务（见 generateClone 里的
   * `callLlmWithFallback`），否则失败时会被最里层吞掉、外面看不出究竟试了谁。
   */
  private async callLlm(
    profile: ProviderProfile,
    systemContent: string,
    userContent: string,
    signal?: AbortSignal
  ): Promise<string> {
    const reasoningEffort = String(this.cfgGet('weportAiReasoningEffort') || 'high')
    const result = await getProviderAdapter(profile).stream({
      // 网关识别 header 一定要带上，否则 OpenCode 直接 400
      profile: withGatewayHeaders(profile),
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

  /**
   * 按顺序在候选服务上重试同一次调用，返回首个成功的结果。
   *
   * 只在"服务方不可用"的错误上换下一个（地区限制、网关 5xx、网络不通）——
   * 密钥错 / 配额超限换服务也解决不了，原样抛出让用户看到真实原因。
   *
   * 为什么生成也要回落：默认的 OpenCode Go 在本机实测会按地区拒绝
   * （`This model is not available in your country.`），没有回落就等于
   * 人格克隆生成永远失败，而用户明明已经配好了可用的默认服务。
   */
  /**
   * 跨服务 + 跨重试的一次模型调用。
   *
   * 两层容错，对应两类完全不同的失败：
   *
   * 1. **服务方不可用**（地区限制 / 网关 5xx）→ 换下一个候选服务。
   * 2. **瞬时网络故障**（`fetch failed` / 连接被重置 / 超时）→ 同一个服务重试。
   *
   * 第 2 层是实测加的：一次生成里 `knowledge.md` 这一步报了 `fetch failed`，
   * 整条生成直接失败、前四份 MD 白生成。生成一份上下文 12 万字符的请求本来
   * 就慢，偶发断连不该把几分钟的工作一起丢掉。重试带退避，且**每个候选服务
   * 每个错误各试一次重试**，不做无限循环。
   *
   * 明确的失败不重试：密钥错、配额超限、模型不存在 —— 那些重试只是让用户多等。
   */
  private async callLlmWithFallback(
    candidates: ProviderProfile[],
    systemContent: string,
    userContent: string,
    signal?: AbortSignal,
    label = ''
  ): Promise<string> {
    const tag = label ? `（${label}）` : ''
    let lastError = ''
    for (const [index, profile] of candidates.entries()) {
      const isLastProvider = index === candidates.length - 1
      for (let attempt = 0; attempt < LLM_TRANSIENT_ATTEMPTS; attempt += 1) {
        try {
          return await this.callLlm(profile, systemContent, userContent, signal)
        } catch (e) {
          if ((e as Error)?.name === 'WeCloneAbortedError' || signal?.aborted) throw e
          lastError = String((e as Error)?.message || e)

          if (!isProviderUnavailable(lastError)) throw e

          const isTransient = isTransientNetworkError(lastError)
          const canRetrySameProvider = isTransient && attempt < LLM_TRANSIENT_ATTEMPTS - 1
          if (canRetrySameProvider) {
            const waitMs = LLM_RETRY_BASE_DELAY_MS * (attempt + 1)
            console.warn(`[WeClone]${tag} ${profile.model} 瞬时失败（${lastError}），${waitMs}ms 后重试第 ${attempt + 2} 次`)
            await new Promise((r) => setTimeout(r, waitMs))
            continue
          }
          if (isLastProvider) break
          console.warn(`[WeClone]${tag} ${profile.model} 不可用（${lastError}），回落到下一个服务`)
          break
        }
      }
    }
    throw new Error(lastError || '没有可用的 AI 服务')
  }

  /**
   * 生成时可用的服务列表：首选人格克隆指定的服务，其次是默认（聊天）服务。
   *
   * `ensureForcedProvider` 在没有强制 key 时会抛 —— 那种情况不该让整条生成
   * 流程失败，直接用默认服务即可。
   */
  private async resolveGenerationProviders(): Promise<ProviderProfile[]> {
    const out: ProviderProfile[] = []
    try {
      const primary = await this.ensureForcedProvider()
      this.assertProfileReady(primary)
      out.push(primary)
    } catch (e) {
      console.warn('[WeClone] 首选生成服务不可用，使用默认服务:', String((e as Error)?.message || e))
    }
    const fallback = this.providerProfiles.getForConsumer('chat')
    if (fallback && !out.some((p) => p.id === fallback.id)) out.push(fallback)
    if (out.length === 0) {
      throw new Error('没有可用的 AI 服务：请到「设置 → AI 服务」添加提供商与密钥')
    }
    return out
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
    providers: ProviderProfile[],
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
        const response = await this.callLlmWithFallback(providers, '你是严格的隐私审查器，只输出 JSON。', content, signal)
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
          const response = await this.callLlmWithFallback(providers, '你是严格的隐私审查器，只输出 JSON。', WECLONE_FILTER_PROMPT.replace('{content}', chunk.text), signal)
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
    externalSignal: AbortSignal | undefined
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
      // 候选服务列表（首选 + 默认），每次调用按顺序重试
      const providers = await this.resolveGenerationProviders()

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
        const content = await this.callLlmWithFallback(providers, WECLONE_SYSTEM_PROMPT, prompt, signal, `${key}.md`)
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
      const filterResult = await this.runSecondPassFilter(providers, fullMds, jsonlFinal, signal, (message) => {
        report('filter', 85, message)
      })
      for (const { key, path } of this.mdFilePaths(dir)) {
        this.atomicWriteFile(path, filterResult.mds[key])
      }

      // ---- 5. 元数据 --------------------------------------------------------
      // v1.0 数据不出本机，所以这里就是终点：写 metadata.json，没有第 6 步上传。
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
        piiHits: filterResult.hits,
        truncated: stats.truncated,
      }
      meta.chunkCount = (await this.sampleChunksFromJsonl(jsonlFinal, 0, 0)).total
      this.writeMeta(dir, meta)
      try { this.configService.set('weCloneLastCutoff', meta.knowledgeCutoff) } catch { /* noop */ }

      report('done', 100, '克隆已在本地生成', { local: true })
      return { success: true, clone: meta }
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

  /**
   * 列出本地克隆，按生成时间倒序。
   *
   * v1.0 起**只有本地**：没有远端列表可合并，也就没有 `remote_` 合成 id 和
   * "仅服务器"这种来源。每个克隆就是 userData 下的一个目录。
   */
  async getClones(): Promise<{ success: boolean; clones: WeCloneListItem[]; error?: string }> {
    return { success: true, clones: this.listLocalClones().map((m) => ({ ...m, source: 'local' as const })) }
  }

  /** 克隆目录定位（id → 目录） */
  private findCloneDir(id: string): string | null {
    const root = this.getStagingRoot()
    for (const entry of readdirSyncSafe(root)) {
      const dir = join(root, entry)
      const meta = this.readMeta(dir)
      if (meta && meta.id === id) return dir
    }
    return null
  }

  /**
   * 删除一个本地克隆。
   *
   * 本地是唯一副本（不再有服务器上的另一份），所以这里**直接删目录**，包括
   * 生成的 MD 与语料 chunks.jsonl。没有远端分支可走。
   */
  async deleteClone(id: string): Promise<{ success: boolean; error?: string }> {
    const target = this.findCloneDir(id)
    if (!target) return { success: false, error: '找不到该克隆' }
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (e) {
      return { success: false, error: `删除失败：${String((e as Error)?.message || e)}` }
    }
    return { success: true }
  }

  /**
   * 和分身对话 —— **完全在本机完成**。
   *
   * 三步，全部离线可解释：
   *   1. 读出生成时落盘的五份 MD（人格画像/关系图谱/知识库/时间线/语言样例）；
   *   2. 在本机语料 chunks.jsonl 上做一次词面检索（BM25），挑出跟这句话最相关的片段；
   *   3. 用 buildWeCloneChatSystemPrompt 拼出 system prompt，交给用户自己配置的
   *      AI 提供商生成回复。
   *
   * 唯一的外呼是模型 API —— 与 WeportAI / WeBot 共用同一份 provider 配置。
   * **语料、人格档案、聊天记录都不出本机**，没有检索服务、没有上传。
   */
  async chatWithClone(input: {
    cloneId: string
    message: string
    history?: Array<{ role: string; content: string }>
    signal?: AbortSignal
  }): Promise<LocalChatResult> {
    const message = String(input.message || '').trim()
    if (!message) return { success: false, error: '消息不能为空' }

    const listed = this.listLocalClones()
    if (listed.length === 0) {
      return {
        success: false,
        error: '本机还没有人格克隆',
        hint: '在「人格克隆」页面点「生成克隆」—— 全程在本机完成，不需要任何服务器。',
      }
    }
    // 没指定就用最新那个；指定了但找不到也退回最新（比报错更不容易卡住用户）
    const meta = listed.find((m) => m.id === input.cloneId) || listed[0]
    const dir = this.findCloneDir(meta.id)
    if (!dir) return { success: false, error: '克隆目录已丢失，请重新生成' }

    const mds: Partial<WeCloneMds> = {}
    for (const { key, path } of this.mdFilePaths(dir)) {
      try {
        if (existsSync(path)) mds[key] = readFileSync(path, 'utf8')
      } catch { /* 单份缺失不致命，prompt 里对应小节为空 */ }
    }
    if (!mds.profile) {
      return { success: false, error: '人格档案不完整（profile.md 缺失）', hint: '请在「人格克隆」里重新生成一次。' }
    }

    let retrieved: string[] = []
    let corpusHits = 0
    let retrieveCostMs = 0
    const jsonlPath = join(dir, 'chunks.jsonl')
    if (existsSync(jsonlPath)) {
      const t0 = Date.now()
      try {
        const r = await this.retrieveLocalChunks(jsonlPath, message, meta.wxid)
        retrieved = r.snippets
        corpusHits = r.hits
      } catch (e) {
        // 检索失败不该让聊天失败：退化成"只用人格档案回答"并留痕
        console.warn('[WeClone] 本地检索失败，退回仅人格档案:', e)
      }
      retrieveCostMs = Date.now() - t0
    }

    const systemPrompt = buildWeCloneChatSystemPrompt({
      displayName: meta.displayName || meta.wxid,
      knowledgeCutoff: meta.knowledgeCutoff,
      mds,
      retrievedChunks: retrieved,
    })

    const history = Array.isArray(input.history)
      ? input.history.filter((h) => h && typeof h.content === 'string' && h.content.trim()).slice(-CHAT_HISTORY_LIMIT)
      : []
    const transcript = history.length
      ? `${history.map((h) => `${h.role === 'assistant' ? meta.displayName : '对方'}：${h.content}`).join('\n')}\n对方：${message}`
      : message

    const startedAt = Date.now()
    /**
     * 依次尝试的模型。
     *
     * 首选是「人格克隆」这一面被指定的服务（默认就是 OpenCode Go）；但如果它是
     * 因为**服务方不可用**而失败，就回落到用户的一般默认服务重试一次。
     *
     * 为什么必须这样：实测 OpenCode Go 会按地区拒绝 ——
     * `This model is not available in your country.`。那种情况下把错误直接抛给
     * 用户等于"人格克隆永远用不了"，而用户明明已经配好了另一个可用的服务
     * （顶栏那个模型）。这里只在**可用性**错误上回落，密钥错、配额错之类照旧
     * 原样上报 —— 那些换服务也解决不了，沉默重试只会掩盖真实原因。
     */
    const attempts: Array<{ profile: ProviderProfile; label: string }> = []
    /**
     * 首选「人格克隆」被指定的服务。
     *
     * `ensureForcedProvider` 在**没有强制 key**时会抛（它的提示文案是"请在人格
     * 克隆设置内填入 OpenCode Go API Key"）。这里不能让它把整个流程带走 ——
     * 那会跳过回落，用户明明配好了可用服务却看到"两个服务都不可用"。
     * 拿不到首选就只试回落。
     */
    try {
      const primary = await this.ensureForcedProvider()
      this.assertProfileReady(primary)
      attempts.push({ profile: primary, label: '人格克隆服务' })
    } catch (e) {
      console.warn('[WeClone] 首选服务不可用，直接使用默认服务:', String((e as Error)?.message || e))
    }
    // 回落用「聊天」这一面的服务（没单独指定时就是默认服务）。刻意不用
    // 'weclone'：那已经被强制 profile 占了，回落等于重试同一个东西。
    const fallback = this.providerProfiles.getForConsumer('chat')
    if (fallback && !attempts.some((a) => a.profile.id === fallback.id)) {
      attempts.push({ profile: fallback, label: '默认服务' })
    }
    if (attempts.length === 0) {
      return {
        success: false,
        error: '没有可用的 AI 服务',
        hint: '到「设置 → AI 服务」添加一个提供商与密钥后重试。人格克隆和 WeportAI 共用这份配置。',
      }
    }

    let lastError = ''
    let attemptsRun = 0
    for (const [index, attempt] of attempts.entries()) {
      attemptsRun += 1
      try {
        const reply = String(await this.callLlmWithSystem(attempt.profile, systemPrompt, transcript, input.signal)).trim()
        if (!reply) {
          // 空回复按"这个服务没给出东西"处理，值得换下一个试
          lastError = `${attempt.label}（${attempt.profile.model}）返回了空内容`
          continue
        }
        return {
          success: true,
          reply,
          elapsedMs: Date.now() - startedAt,
          meta: {
            cloneId: meta.id,
            displayName: meta.displayName || meta.wxid,
            retrievedChunks: retrieved.length,
            corpusHits,
            retrieveCostMs,
          },
        }
      } catch (e) {
        lastError = String((e as Error)?.message || e)
        const isLast = index === attempts.length - 1
        if (isLast || !isProviderUnavailable(lastError)) break
        console.warn(`[WeClone] ${attempt.label} 不可用（${lastError}），回落到下一个服务重试`)
      }
    }
    return {
      success: false,
      error: lastError,
      hint:
        attemptsRun > 1
          ? `已依次尝试 ${attempts.map((a) => a.profile.model).join(' 与 ')}；到「设置 → AI 服务」确认提供商与密钥。`
          : '检查「设置 → AI 服务」里的提供商与密钥是否可用。',
    }
  }

  /**
   * 本地语料检索：在 chunks.jsonl 上跑一遍 BM25（实现见 ai/localRetrieval.ts）。
   *
   * 单遍流式读取 —— 只把每条分块的 token 与长度留在内存，原文等 top-K 定了再
   * 回读那几行。峰值内存与语料大小基本无关，2M 条消息也不会把主进程撑爆；
   * 这正是"离线可用"必须守住的纪律。
   */
  private async retrieveLocalChunks(
    jsonlPath: string,
    query: string,
    myWxid: string
  ): Promise<{ snippets: string[]; hits: number }> {
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return { snippets: [], hits: 0 }

    const builder = createCorpusBuilder()
    const docs: Array<{ index: number; tokens: string[] }> = []
    let scanned = 0
    const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (scanned >= CORPUS_SCAN_LINE_CAP) break
        const trimmed = line.trim()
        if (!trimmed) continue
        let chunk: WeCloneChunk
        try {
          chunk = JSON.parse(trimmed) as WeCloneChunk
        } catch {
          continue
        }
        if (!chunk || typeof chunk.text !== 'string') continue
        const tokens = tokenize(chunk.text)
        builder.add(tokens)
        docs.push({ index: scanned, tokens })
        scanned += 1
      }
    } finally {
      rl.close()
    }
    if (!docs.length) return { snippets: [], hits: 0 }

    const ranked = rankDocs(queryTokens, docs, builder.finish(), RETRIEVE_TOP_K)
    if (!ranked.length) return { snippets: [], hits: 0 }

    // 回读命中行（第二次读同一个文件，只取需要的那几行）
    const wanted = new Set(ranked.map((h) => h.index))
    const picked: Array<{ ts: number; label: string; text: string }> = []
    let lineNo = -1
    const rl2 = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of rl2) {
        lineNo += 1
        if (!wanted.has(lineNo)) continue
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const chunk = JSON.parse(trimmed) as WeCloneChunk
          if (chunk && typeof chunk.text === 'string') {
            picked.push({ ts: chunk.ts, label: this.labelForTalker(chunk.talker, myWxid), text: chunk.text })
          }
        } catch { /* 单行坏了就跳过 */ }
        if (picked.length >= ranked.length) break
      }
    } finally {
      rl2.close()
    }

    const context = buildRetrievedContext(picked, RETRIEVED_CONTEXT_CHAR_LIMIT)
    return { snippets: context ? [context] : [], hits: picked.length }
  }

  /**
   * 带自定义 system prompt 的模型调用（聊天用）。
   *
   * 与生成用的 callLlm 分开：那个只发"system + 单条 user"，而聊天需要把多轮
   * 历史压进 user 侧（适配器只接受单条 user，历史在这里被格式化成一段对话记录）。
   */
  private async callLlmWithSystem(
    profile: ProviderProfile,
    systemContent: string,
    userContent: string,
    signal?: AbortSignal
  ): Promise<string> {
    const reasoningEffort = String(this.cfgGet('weportAiReasoningEffort') || 'high')
    const result = await getProviderAdapter(profile).stream({
      // 网关识别 header 一定要带上，否则 OpenCode 直接 400
      profile: withGatewayHeaders(profile),
      messages: [
        { role: 'system', content: this.sanitizeForApi(systemContent) },
        { role: 'user', content: this.sanitizeForApi(userContent) },
      ],
      tools: [],
      reasoningEffort,
      signal: signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS),
      onReasoning: () => undefined,
      onText: () => undefined,
    })
    return String(result.content || '')
  }

  /**
   * 语料里的 talker → 显示名。
   *
   * 本人（talker 等于自己的 wxid）显示成「我」；其余保持原始标识（群聊里就是
   * 发言人昵称/wxid）。检索片段带这个标签，模型才知道哪句是"自己说的"——
   * 这正是人格克隆的语气依据。
   */
  private labelForTalker(talker: string, myWxid: string): string {
    const t = String(talker || '')
    if (!t || t === myWxid) return '我'
    return t
  }
}

/**
 * OpenCode 网关要求带 `x-opencode-session` 才能被路由，否则直接 400：
 * `Request is missing x-opencode-session and cannot be routed efficiently`
 * （这条实测踩过两次：先是对话标题生成，后是人格克隆聊天）。
 *
 * 头值用 profile.id —— 网关只把它当路由标识，不校验内容。
 * 用户自定义的同名 header 优先（合并顺序保证）。
 */
const OPENCODE_GATEWAYS = new Set(['opencode-zen', 'opencode-go'])

function withGatewayHeaders(profile: ProviderProfile): ProviderProfile {
  if (!OPENCODE_GATEWAYS.has(profile.providerId)) return profile
  return { ...profile, headers: { 'x-opencode-session': profile.id, ...(profile.headers || {}) } }
}

/**
 * 这个错误是不是"服务方不可用"（换一个服务就有可能成功）。
 *
 * 只在这种错误上做回落重试。**密钥错、配额超限、模型不存在**这些刻意排除在外：
 * 换服务也解决不了，而且真正需要用户知道的就是这类信息，沉默重试会把它盖掉。
 *
 * 实测触发过的原文：`This model is not available in your country.`
 * （OpenCode Go 按地区拒绝）。
 */
function isProviderUnavailable(message: string): boolean {
  const m = String(message || '').toLowerCase()
  if (!m) return false
  // 明确不是"服务不可用"的：不必重试，原样上报
  if (/invalid api key|incorrect api key|unauthorized|401|403 forbidden|quota|rate limit|insufficient|余额|密钥无效|未配置/.test(m)) {
    return false
  }
  return /not available in your country|not available in your region|region|country|unavailable|service unavailable|503|502|bad gateway|econnrefused|enotfound|etimedout|network|fetch failed|socket hang up/.test(m)
}

/**
 * 这个错误是不是"瞬时网络故障"（同一个服务重试就可能成功）。
 *
 * 与 `isProviderUnavailable` 的差别在**要不要换服务**：地区限制换服务才有意义，
 * 断连则在原地重试更划算（换服务要重建连接、且可能同样断）。
 * 实测触发：生成 `knowledge.md` 时 `fetch failed`。
 */
function isTransientNetworkError(message: string): boolean {
  const m = String(message || '').toLowerCase()
  return /fetch failed|socket hang up|econnreset|econnaborted|etimedout|network|terminated|und_err|other side closed|connection.*(reset|closed)/.test(m)
}

function readdirSyncSafe(dir: string): string[] {  try {
    return existsSync(dir) ? readdirSync(dir) : []
  } catch {
    return []
  }
}

export const weCloneService = new WeCloneService()
