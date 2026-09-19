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
  statSync,
} from 'fs'
import { createInterface } from 'readline'
import {
  ConfigService,
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
import { removeTree } from './rmTree'
import {
  createFingerprintAccumulator,
  renderFingerprint,
  type WeCloneFingerprint,
} from './weCloneFingerprint'
import {
  WECLONE_MAP_SYSTEM_PROMPT,
  WECLONE_REDUCE_SYSTEM_PROMPT,
  WECLONE_MD_SYSTEM_PROMPT,
  WECLONE_FILTER_PROMPT,
  WECLONE_MD_KEYS,
  buildWeCloneChatSystemPrompt,
  buildWeCloneMapPrompt,
  buildWeCloneMdPrompt,
  buildWeCloneReducePrompt,
  buildWeCloneTurnAnchor,
  type WeCloneMdKey,
  type WeCloneRefusalMode,
} from './weClonePrompts'
import {
  buildRetrievedContext,
  rankDocs,
  topUpVoiceSamples,
  tokenize,
} from './ai/localRetrieval'
import { MAX_REDUCE_ROUNDS, planReduceStep } from './ai/reducePlan'
import {
  cloneMapCacheDir,
  cloneMapCacheEnabled,
  cloneMapCacheKey,
  readCloneMapCache,
  writeCloneMapCache,
} from './ai/cloneMapCache'

export type { WeCloneRefusalMode } from './weClonePrompts'

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
  /**
   * 语料是否被**硬护栏**截断过。
   *
   * v1.0.1 起这个字段几乎不会再为 true：阈值从"15 万条/会话、200 万条总数"
   * 提到"1200 万/6000 万"，正常使用碰不到。旧实现的阈值太低，一段长群聊就会
   * 触发，卡片上冒出「数据量过大已截断」—— 用户明确说过这不该发生。
   */
  truncated?: boolean
  /** 语料最早一条消息的日期（ISO），用于告诉模型"你记得多久以前的事" */
  corpusStart?: string
  /** 生成时是否做了敏感信息脱敏 */
  redacted?: boolean
  /** 生成时实际用了多少片（分片提炼），0 表示旧版单次采样 */
  shardCount?: number
  /** 分片提炼里失败的片数（失败片会用本地统计兜底，不会静默丢内容） */
  shardFailures?: number
  /** 本次生成消耗的 token（模型返回的 usage 之和，取不到时为 undefined） */
  tokensIn?: number
  tokensOut?: number
  /** 生成耗时（毫秒） */
  elapsedMs?: number
}

/**
 * 单个克隆自己的设置（`{cloneDir}/settings.json`）。
 *
 * 为什么要按克隆存而不是全局：一个人可能给"工作场合的自己"和"跟哥们聊天的
 * 自己"生成两份克隆，它们该用不同的说话方式与拒答策略。设置跟着它的档案和
 * 语料一起走 —— 删克隆就一起删掉，不会留下一份找不到主人的配置。
 */
export interface WeCloneSettings {
  /**
   * 拒答行为。
   *
   * - `character`（默认）：以本人的方式把敏感问题带过去；
   * - `off`：完全不设限，system prompt 里连"有些事你不说"这一节都不出现。
   */
  refusal: WeCloneRefusalMode
}

export const WECLONE_SETTINGS_DEFAULT: WeCloneSettings = { refusal: 'character' }

/** 一条对话里的一轮 */
export interface WeCloneChatTurn {
  role: 'user' | 'assistant'
  content: string
  at: number
  /** 出错的那一轮也存下来（用户能看到"上次是怎么失败的"），但不再进 model history */
  error?: boolean
  hint?: string
}

/**
 * 一条对话（一个话题）。
 *
 * 人格克隆以前关掉抽屉就什么都不剩：换一个话题等于把上一个话题丢掉。这里按
 * "对话"分组保存，标题可改、可删、可回看 —— 和微信/DSH 的会话列表同一套习惯。
 */
export interface WeCloneChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turns: WeCloneChatTurn[]
}

export interface WeCloneChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turnCount: number
  preview: string
}

/** 标题：取第一条用户消息，压掉换行、超长截断 */
function autoTitleFromTurns(turns: WeCloneChatTurn[]): string {
  const first = turns.find((t) => t.role === 'user' && t.content.trim())
  const raw = (first?.content || '新对话').replace(/\s+/g, ' ').trim()
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw || '新对话'
}

function previewOfChat(chat: WeCloneChat): string {
  const last = [...chat.turns].reverse().find((t) => t.content.trim())
  const raw = (last?.content || '').replace(/\s+/g, ' ').trim()
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw
}

/**
 * 极简语言探测：只分「中文 / 英文 / 混合」，看的是**字符构成**而不是词典。
 *
 * 为什么要它：人格克隆的 system prompt 一直是中文写的，模型于是永远用中文回答 ——
 * 哪怕用户的语料大半是英文。这里只用来给 prompt 一个默认值，真正的规则是
 * 「跟着对方这条消息的语言走」（见 WECLONE_CHAT_SYSTEM_PROMPT）。
 */
export function detectLanguage(text: string): 'zh' | 'en' | 'mixed' {
  const s = String(text || '')
  const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const latin = (s.match(/[A-Za-z]/g) || []).length
  if (cjk === 0 && latin === 0) return 'mixed'
  if (cjk >= latin * 0.6) return 'zh'
  if (latin >= cjk * 2) return 'en'
  return 'mixed'
}

const LANGUAGE_LABEL: Record<'zh' | 'en' | 'mixed', string> = {
  zh: '中文',
  en: '英文',
  mixed: '中英混合',
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

/**
 * 进度阶段。
 *
 * ailed 是 v1.0.1 补的：之前成功与失败**都**用 'done' 收尾（失败时消息写成
 * "生成失败：…"），于是任何只看 stage 的消费方都会把一次失败读成"完成"——
 * 实测就出现过面板写着「生成完成」而磁盘上的 metadata 还是上一版。
 * 终态必须是两个不同的值。
 */
export type WeCloneProgressStage = 'scan' | 'generate' | 'filter' | 'done' | 'failed'

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
    /**
     * 实际回答的这个模型与它的 provider。
     *
     * 为什么要回传：这一面曾经被**强制**绑到一个本机连不通的网关上，用户看到的是
     * 一句 "Internal server error"，无从判断到底是密钥、网络还是模型选错了。把
     * "谁答的"摆到界面上，用户一眼就能确认它用的就是自己在设置里配的那个服务。
     */
    model: string
    providerId: string
    /** 本轮判定出来的对方语言（zh/en/mixed）—— 回复应当跟着它走 */
    replyLanguage?: 'zh' | 'en' | 'mixed'
    /** 本轮检索到的**本人原话**条数（语气样本） */
    voiceSamples?: number
    /** 本轮生效的拒答行为 —— 让"它怎么什么都答"能被解释 */
    refusal?: WeCloneRefusalMode
  }
}

// 历史「强制 provider」的标识（v1.0 之前的 `WECLONE_FORCED_*`）。
//
// 现在**只**用于一次性清理：把当年代码自己创建的那个服务项从配置里删掉。
// 没有任何功能再引用它们，也不要再用它们去创建服务。
const LEGACY_FORCED_PROVIDER_ID = 'opencode-go'
const LEGACY_FORCED_MODEL = 'muse-spark-1.2-contributor'
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
/**
 * 单会话消息上限。
 *
 * **v1.0.1：从 15 万提到 1200 万，实际上等于取消。**
 * 旧值会在一段特别长的聊天（家人群、几个人的小群常年刷）上悄悄触发，
 * 卡片上就多出一行「数据量过大已截断」—— 用户的原话是"This should never
 * happen"。50 万条消息的语料落在 15 万这个数字附近并不难。
 *
 * 保留一个数值是为了防病态输入（表被撑爆 / 游标失控）把磁盘写满，
 * 而不是当作"正常使用会碰到"的边界。
 */
const PER_SESSION_MESSAGE_CAP = 12_000_000
/** 全量消息上限：同为病态输入护栏，不是正常边界 */
const TOTAL_MESSAGE_CAP = 60_000_000
/** 分块字符上限 */
const CHUNK_CHAR_LIMIT = 800
/**
 * 单份 MD 字符上限。
 *
 * v1.0.1：从 12_000 提到 120_000。旧值会在**模型还在写**的时候把结果从中间
 * 切掉（`.slice(0, MD_CHAR_LIMIT)`），一份丰富的人格档案被砍成半截，
 * 而界面上完全看不出来。现在它只是对抗模型失控输出的兜底。
 */
const MD_CHAR_LIMIT = 120_000

// ---------------------------------------------------------------------------
// 分片提炼（map-reduce）参数 —— 决定"克隆会花多少 token、跑多久"
//
// 用户的明确要求：**尽可能多花 token、多花时间**（"十分钟或再长一点也行，
// 没有时间限制"），并且**历史不能有任何一部分被丢弃**。
//
// 做法是把语料按**时间**切成 N 片，每片单独提炼一次（map），再把所有分片
// 归并（reduce）。关键性质：每一片覆盖一个不同的时间段，所以**整段历史里
// 每一段都至少有一次被模型看到的机会** —— 这跟旧实现"从全语料里随机抽 250
// 块喂给五份 MD"有本质区别，后者对 50 万条消息的语料只看了 0.5‰。
// ---------------------------------------------------------------------------

/**
 * 每片给模型的语料字符数（越大越贵、越细）。
 *
 * 24k 字符 ≈ 1.7 万 token 的正文。这个数字是**实测调上来的**：第一次真机跑
 * 用的是 20k，一次 13 片的生成花了 4.3 分钟 —— 用户明确说过"可以十分钟或再长
 * 一点，没有时间限制，要尽可能多花 token"，4 分钟属于明显没吃够。
 */
const MAP_SHARD_CONTEXT_CHARS = 24_000
/** 分片数上限：一次生成的模型调用次数与它成正比 */
const MAP_MAX_SHARDS = 60
/** 分片数下限：小语料也要有基本的分片覆盖 */
const MAP_MIN_SHARDS = 4
/**
 * 分片数的目标依据：按语料总字符数除以"每片想看多少语料"。
 *
 * 90k 是把 10 万条消息的语料切成约 37 片 —— 实测一次约 10-14 分钟、百万级
 * token 输入。用户的原话是"尽可能多花 token、多花时间"，所以这里取的是
 * **比"够用"高一档**的值，而不是能省则省。
 *
 * 用字符数而不是分块数：分块长度固定 800，两者等价，但字符数在进度文案里对
 * 用户更有意义（"这次一共读了 3.3M 字"）。
 */
const MAP_CHARS_PER_SHARD = 90_000
/** map 阶段的并发：DeepSeek 侧实测 3 路稳定，再高容易触发限流 */
const MAP_CONCURRENCY = 3
/** reduce 阶段第一层的并发 */
const REDUCE_CONCURRENCY = 2
/** 单次 reduce 调用能吃下的分片字符总量（超过就先做一层中间归并） */
const REDUCE_INPUT_CHAR_BUDGET = 80_000
/** 最终归并要求模型压到的篇幅 —— 归并结果要整段塞进**每一份** MD 的 prompt */
const MD_MATERIAL_TARGET_CHARS = 50_000
/** 整体材料的硬上限：万一模型没听话，也不能让 MD 调用顶穿上下文窗口 */
const MD_MATERIAL_CHAR_LIMIT = 90_000

/** 分片摘要的字符上限（兜底，防止某片输出失控） */
const DIGEST_CHAR_LIMIT = 8_000
/** 检索时扫描的语料行数上限（内存与耗时的兜底护栏） */
const CORPUS_SCAN_LINE_CAP = 4_000_000
/** 本地检索：取回的片段数 */
const RETRIEVE_TOP_K = 24
/** 本地检索：拼进 prompt 的检索内容字符上限 */
const RETRIEVED_CONTEXT_CHAR_LIMIT = 14_000
/** 语气样本（本人原话）：取回条数与字符上限 */
const VOICE_TOP_K = 14
const VOICE_CONTEXT_CHAR_LIMIT = 4_000
/** 聊天：带上的历史轮数 */
const CHAT_HISTORY_LIMIT = 20
/** 聊天：模型调用超时（本地检索已预先完成，这里只等模型） */
const CHAT_TIMEOUT_MS = 180_000
/** 生成：遇到瞬时网络故障时同一个服务最多尝试几次（含首次） */
const LLM_TRANSIENT_ATTEMPTS = 3
/** 生成：重试退避基数（第 n 次等 n×base） */
const LLM_RETRY_BASE_DELAY_MS = 4_000
/** 生成：单次模型调用的超时（分片提炼本来就是长请求） */
const LLM_CALL_TIMEOUT_MS = 600_000

/** 配置键：生成时是否做敏感信息脱敏（默认开） */
export const WECLONE_REDACT_CONFIG_KEY = 'wecloneRedact' as const

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class WeCloneService {
  private configService: ConfigService
  private providerProfiles: ProviderProfileService
  private runningController: AbortController | null = null
  /**
   * 本次生成的 token 用量累加器。
   *
   * 放在实例上而不是逐层回传：模型调用散在 map / reduce / MD / 二审四个阶段，
   * 一路带着一个可变对象穿参数只会让每个签名都变脏。生成开始时清零。
   */
  private usageAccumulator = { promptTokens: 0, completionTokens: 0 }
  /**
   * 本次生成轮的网关会话 id。
   *
   * map / reduce / MD / 二审这几百次调用共用一条会话，网关才能按会话复用提示缓存 ——
   * 实测缓存读的价格是未命中的 1/20 ~ 1/100（DeepSeek V4.1 Flash：$0.003 vs $0.15/M）。
   */
  private generationSession: string | null = null

  constructor() {
    this.configService = ConfigService.getInstance()
    this.providerProfiles = new ProviderProfileService(this.configService)
    // 启动即清理历史「强制 provider」（幂等，见 purgeLegacyForcedProfile）。
    this.purgeLegacyForcedProfile()
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
  // 生成选项：脱敏开关（导出时决定）
  // -------------------------------------------------------------------------

  /**
   * 生成时是否做敏感信息脱敏。**默认开**。
   *
   * 关掉之后：语料不替换占位符、生成 prompt 里的敏感信息条款整段消失、
   * 第二阶段的 LLM 审查也跳过。数据仍然不出本机 —— 关掉的只是"多一层遮蔽"，
   * 不是"多一条外发通道"。
   */
  getRedactEnabled(): boolean {
    const raw = this.cfgGet(WECLONE_REDACT_CONFIG_KEY)
    // 键缺失时默认 true：脱敏是默认行为，必须显式关掉
    if (raw === undefined || raw === null || raw === '') return true
    return raw !== false && String(raw) !== 'false'
  }

  setRedactEnabled(enabled: boolean): { success: boolean; redact: boolean } {
    const value = enabled !== false
    try {
      this.configService.set(WECLONE_REDACT_CONFIG_KEY, value)
    } catch (error) {
      console.warn('[WeClone] 保存脱敏开关失败:', error)
    }
    return { success: true, redact: value }
  }

  // -------------------------------------------------------------------------
  // 单个克隆自己的设置
  // -------------------------------------------------------------------------

  private settingsFile(dir: string): string {
    return join(dir, 'settings.json')
  }

  /** 读克隆设置。文件缺失/损坏一律回落到默认值，绝不抛错。 */
  private readSettings(dir: string): WeCloneSettings {
    const file = this.settingsFile(dir)
    if (!existsSync(file)) return { ...WECLONE_SETTINGS_DEFAULT }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WeCloneSettings>
      return {
        refusal: raw?.refusal === 'off' ? 'off' : 'character',
      }
    } catch {
      return { ...WECLONE_SETTINGS_DEFAULT }
    }
  }

  getSettings(cloneId: string): { success: boolean; settings?: WeCloneSettings; error?: string } {
    const dir = this.findCloneDir(String(cloneId || ''))
    if (!dir) return { success: false, error: '找不到该克隆' }
    return { success: true, settings: this.readSettings(dir) }
  }

  setSettings(
    cloneId: string,
    patch: { refusal?: string }
  ): { success: boolean; settings?: WeCloneSettings; error?: string } {
    const dir = this.findCloneDir(String(cloneId || ''))
    if (!dir) return { success: false, error: '找不到该克隆' }
    const current = this.readSettings(dir)
    const next: WeCloneSettings = {
      refusal: patch?.refusal === 'off' ? 'off' : patch?.refusal === 'character' ? 'character' : current.refusal,
    }
    try {
      this.atomicWriteFile(this.settingsFile(dir), JSON.stringify(next, null, 2))
    } catch (error) {
      return { success: false, error: `保存设置失败：${String((error as Error)?.message || error)}` }
    }
    return { success: true, settings: next }
  }

  /** 克隆使用哪一套拒答行为（生成时的默认值来自配置，之后由用户按克隆改） */
  private refusalForClone(dir: string): WeCloneRefusalMode {
    return this.readSettings(dir).refusal
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
        corpusStart: raw.corpusStart ? String(raw.corpusStart) : undefined,
        redacted: raw.redacted === true,
        shardCount: Number(raw.shardCount) || 0,
        shardFailures: Number(raw.shardFailures) || 0,
        tokensIn: Number(raw.tokensIn) || undefined,
        tokensOut: Number(raw.tokensOut) || undefined,
        elapsedMs: Number(raw.elapsedMs) || undefined,
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

  /**
   * 读取单个克隆（含 MD 内容预览）。
   *
   * 「档案预览」里多带两份**算出来的**材料（v1.0.1）：
   * - `fingerprint`：本地统计事实（标点/长度/高频片段），聊天时注入的就是它；
   * - `corpus`：一行摘要（多少条消息、多少会话、时间跨度、多少段、是否脱敏）。
   *
   * 为什么要给用户看这两样：人格档案本身是模型写的，用户没法判断它有没有漏；
   * 而"你那 10 万条消息到底被怎么处理的"是可以被验证的事实。把它们摆在档案
   * 旁边，用户才能自己回答"这次生成到底干了什么"。
   */
  getClone(id: string): {
    success: boolean
    clone?: WeCloneMeta
    mds?: Partial<WeCloneMds> & { fingerprint?: string; corpus?: string }
    error?: string
  } {
    const root = this.getStagingRoot()
    for (const entry of readdirSyncSafe(root)) {
      const dir = join(root, entry)
      const meta = this.readMeta(dir)
      if (!meta || meta.id !== id) continue
      const mds: Partial<WeCloneMds> & { fingerprint?: string; corpus?: string } = {}
      for (const { key, path } of this.mdFilePaths(dir)) {
        try {
          if (existsSync(path)) mds[key] = readFileSync(path, 'utf8')
        } catch { /* noop */ }
      }
      try {
        const fingerprintPath = join(dir, 'fingerprint.txt')
        if (existsSync(fingerprintPath)) mds.fingerprint = readFileSync(fingerprintPath, 'utf8')
      } catch { /* 老克隆没有这一份，正常 */ }
      mds.corpus = this.describeCorpus(meta)
      return { success: true, clone: meta, mds }
    }
    return { success: false, error: '找不到该克隆' }
  }

  /** 语料处理摘要 —— 「你那 10 万条消息到底被怎么处理的」的可验证答案 */
  private describeCorpus(meta: WeCloneMeta): string {
    const lines = [
      `消息条数：${meta.messageCount.toLocaleString('en-US')}（其中本人发言进入语气语料）`,
      `会话数：${meta.sessionCount.toLocaleString('en-US')}`,
      `语料分块：${meta.chunkCount.toLocaleString('en-US')}`,
      `时间跨度：${meta.corpusStart || '未知'} ~ ${meta.knowledgeCutoff || '未知'}`,
      `分段提炼：${meta.shardCount ? `${meta.shardCount} 段，失败 ${meta.shardFailures || 0} 段` : '（旧版单次采样，未分段）'}`,
      `敏感信息：${meta.redacted === false ? '生成时未脱敏' : `脱敏 ${meta.piiHits || 0} 处`}`,
      `耗时：${meta.elapsedMs ? `${Math.round(meta.elapsedMs / 1000)} 秒` : '未知'}`,
      `token：${meta.tokensIn || meta.tokensOut ? `输入 ${(meta.tokensIn || 0).toLocaleString('en-US')} / 输出 ${(meta.tokensOut || 0).toLocaleString('en-US')}` : '未记录'}`,
      `硬性截断：${meta.truncated ? '是（语料超过安全上限）' : '否'}`,
    ]
    return lines.join('\n')
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
   * 扫描全部会话并流式写 chunks.jsonl（+ 本人语气语料 voice.jsonl）。
   *
   * 三个产物在同一遍扫描里出来：
   *   - `chunks.jsonl`：全部文本消息，供检索（含他人的话，那是上下文）；
   *   - `voice.jsonl`：**只有本人说的话**，供按话题检索语气样本；
   *   - 风格指纹的累加器：标点/长度/表情/高频片段的统计量（纯本地计算）。
   *
   * 为什么要单独一份 voice.jsonl：人格克隆最容易做砸的地方是"语气不像"，
   * 而语气证据就是本人的原话。混在 chunks 里检索时，命中片段经常大半是别人
   * 在说话 —— 那些对"对方是谁、聊的是什么"有用，对"本人怎么说话"没用。
   */
  private async scanAllSessions(
    sessionIds: string[],
    jsonlPath: string,
    voicePath: string,
    signal: AbortSignal | undefined,
    onProgress: (completed: number, total: number, messages: number) => void,
    options?: { redact?: boolean }
  ): Promise<{
    messageCount: number
    voiceCount: number
    sessionCount: number
    cutoffTs: number
    startTs: number
    truncated: boolean
    fingerprint: WeCloneFingerprint
  }> {
    const myWxid = this.getMyWxid()
    const redact = options?.redact !== false
    let totalMessages = 0
    let voiceMessages = 0
    let completedSessions = 0
    let cutoffTs = 0
    let startTs = 0
    let truncated = false
    let chunkSeq = 0
    let voiceSeq = 0
    const fingerprint = createFingerprintAccumulator({ sessionCount: sessionIds.length })

    mkdirSync(dirname(jsonlPath), { recursive: true })
    mkdirSync(dirname(voicePath), { recursive: true })

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
            // 脱敏可以在导出时关掉（见 WECLONE_REDACT_CONFIG_KEY）。关掉之后
            // 语料里就是原文 —— 它仍然不出本机，只是"不多做一层遮蔽"。
            const text = redact ? redactSensitiveText(msg.text) : msg.text
            if (!text.trim()) continue
            const line = this.formatChunkLine(msg.isSend, msg.sender, myWxid, text)
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
            if (msg.ts > 0 && (startTs === 0 || msg.ts < startTs)) startTs = msg.ts

            // 本人的话：进 voice.jsonl + 进风格指纹
            if (msg.isSend) {
              voiceMessages += 1
              voiceSeq += 1
              const voice: WeCloneChunk = {
                id: `v_${String(voiceSeq).padStart(6, '0')}`,
                sid: sessionId,
                ts: msg.ts,
                talker: '我',
                text: text.replace(/\r?\n/g, ' '),
              }
              appendFileSync(voicePath, JSON.stringify(voice) + '\n', 'utf8')
              fingerprint.add(text)
            }
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

    return {
      messageCount: totalMessages,
      voiceCount: voiceMessages,
      sessionCount: completedSessions,
      cutoffTs,
      startTs,
      truncated,
      fingerprint: fingerprint.finish(),
    }
  }

  // -------------------------------------------------------------------------
  // 分片（map 阶段）：按时间切片，每一片都要覆盖到
  // -------------------------------------------------------------------------

  /**
   * 把语料按**时间**切成若干片，每片做一次模型提炼。
   *
   * 内存纪律：单遍流式读 JSONL，每个时间桶用**蓄水池抽样**保留至多
   * `perBucket` 条分块。峰值内存 = 桶数 × perBucket × 800 字符（≈ 10 MB），
   * 与语料总量无关 —— 50 万条消息和 5 万条消息占的内存一样。
   *
   * 为什么按时间而不是随机：随机抽样可能在某个年份一条都没抽到，那一年的
   * 事就永远不会进画像。按时间分桶保证**每一段时间都有代表**，这是"历史
   * 不能被截断"在采样层面的兑现。
   */
  private async buildTimeShards(
    jsonlPath: string,
    startTs: number,
    cutoffTs: number,
    shardCount: number,
    perBucket: number
  ): Promise<{ shards: WeCloneChunk[][]; total: number }> {
    const EMPTY: WeCloneChunk[][] = []
    if (!existsSync(jsonlPath)) return { shards: EMPTY, total: 0 }
    // 桶数 = 目标片数：一个桶就是一段时间片。等宽切分保证每片的时长相近，
    // 于是"聊得多的那几个月"不会独占所有分片名额。
    const buckets = Math.max(1, Math.min(96, shardCount))
    const span = Math.max(1, cutoffTs - startTs)
    const reservoir: WeCloneChunk[][] = Array.from({ length: buckets }, () => [])
    const seen: number[] = new Array(buckets).fill(0)
    let total = 0

    const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let chunk: WeCloneChunk
        try {
          chunk = JSON.parse(trimmed) as WeCloneChunk
        } catch {
          continue
        }
        if (!chunk || typeof chunk.text !== 'string') continue
        total += 1
        const ts = chunk.ts > 0 ? chunk.ts : startTs
        const ratio = Math.min(0.999999, Math.max(0, (ts - startTs) / span))
        const bucket = Math.floor(ratio * buckets)
        seen[bucket] += 1
        const bucketList = reservoir[bucket]
        if (bucketList.length < perBucket) {
          bucketList.push(chunk)
        } else {
          // 蓄水池抽样：让每片里的分块在时间上均匀分布，而不是只留最早的那些
          const j = Math.floor(Math.random() * seen[bucket])
          if (j < perBucket) bucketList[j] = chunk
        }
      }
    } finally {
      rl.close()
    }

    // 相邻桶合并成 shard（保持时间顺序）
    const shards: WeCloneChunk[][] = []
    const perShard = Math.max(1, Math.ceil(buckets / shardCount))
    for (let i = 0; i < buckets; i += perShard) {
      const merged: WeCloneChunk[] = []
      for (let k = i; k < Math.min(buckets, i + perShard); k += 1) merged.push(...reservoir[k])
      if (merged.length > 0) shards.push(merged)
    }
    return { shards, total }
  }

  /** 取分片的时间范围，用于告诉模型"这一片是什么时候的事" */
  private shardTimeRange(chunks: WeCloneChunk[]): { from: number; to: number } {
    let from = 0
    let to = 0
    for (const chunk of chunks) {
      if (chunk.ts <= 0) continue
      if (from === 0 || chunk.ts < from) from = chunk.ts
      if (chunk.ts > to) to = chunk.ts
    }
    return { from, to }
  }

  /**
   * 把一片分块拼成模型上下文（按时间排序，带日期与说话人）。
   *
   * 超出字符预算时**等间隔抽取**而不是取前 N 条：一片覆盖的时间段可能横跨
   * 好几个月，只取开头等于把这一片的后半段丢掉 —— 而"每段时间都要有代表"
   * 正是分片这件事的全部意义。抽出来的分块仍然按时间顺序排列，模型读到的是
   * 一段连贯的（稀疏）时间线。
   */
  private buildShardContext(chunks: WeCloneChunk[], sessionNames: Map<string, string>): string {
    const sorted = [...chunks].sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const render = (chunk: WeCloneChunk): { block: string; cost: number } => {
      const name = sessionNames.get(chunk.sid) || chunk.sid
      const when = chunk.ts ? new Date(chunk.ts * 1000).toISOString().slice(0, 10) : '未知日期'
      const block = `--- 「${name}」 ${when} ---\n${chunk.text}`
      return { block, cost: block.length + 1 }
    }

    const totalCost = sorted.reduce((sum, chunk) => sum + render(chunk).cost, 0)
    let chosen = sorted
    if (totalCost > MAP_SHARD_CONTEXT_CHARS) {
      // 按"每字节留几条"的步长等间隔取，直到装得下
      const step = Math.max(2, Math.ceil(totalCost / MAP_SHARD_CONTEXT_CHARS))
      chosen = sorted.filter((_, index) => index % step === 0)
    }

    const parts: string[] = []
    let used = 0
    for (const chunk of chosen) {
      const { block, cost } = render(chunk)
      if (used + cost > MAP_SHARD_CONTEXT_CHARS) break
      parts.push(block)
      used += cost
    }
    return parts.join('\n')
  }

  /**
   * 并发跑一批任务，保持结果顺序，任一失败不影响其它。
   *
   * 不用 Promise.all 直接铺开：分片数最多 60，一口气发 60 个请求会被限流，
   * 而且失败重试会互相叠加。
   */
  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
    signal?: AbortSignal
  ): Promise<Array<R | null>> {
    const results: Array<R | null> = new Array(items.length).fill(null)
    let next = 0
    const run = async (): Promise<void> => {
      while (next < items.length) {
        this.ensureNotAborted(signal)
        const index = next
        next += 1
        try {
          results[index] = await worker(items[index], index)
        } catch (e) {
          if ((e as Error)?.name === 'WeCloneAbortedError') throw e
          console.warn(`[WeClone] 第 ${index + 1} 项失败:`, e)
          results[index] = null
        }
      }
    }
    const lanes = Math.max(1, Math.min(concurrency, items.length))
    await Promise.all(Array.from({ length: lanes }, () => run()))
    return results
  }

  // -------------------------------------------------------------------------
  // 分片提炼（map → reduce）
  // -------------------------------------------------------------------------

  /**
   * 跑完 map 阶段：每片一次模型调用，得到结构化的分片摘要。
   *
   * 失败的片**不静默丢弃**：用这一片的本地统计（时间范围 + 分块数 +
   * 本人原话条数）拼一条最小摘要，并明确写"这一片提炼失败"。
   * 静默丢一片等于把那段历史从人格里删掉，而且用户无从察觉。
   */
  private async runMapPhase(
    shards: WeCloneChunk[][],
    sessionNames: Map<string, string>,
    providers: ProviderProfile[],
    signal: AbortSignal | undefined,
    onProgress: (done: number, total: number, message: string) => void
  ): Promise<{ digests: string[]; failures: number }> {
    let failures = 0
    const results = await this.mapWithConcurrency(
      shards,
      MAP_CONCURRENCY,
      async (chunks, index) => {
        const { from, to } = this.shardTimeRange(chunks)
        const range = `${this.formatDay(from)} ~ ${this.formatDay(to)}`
        const sessions = [...new Set(chunks.map((c) => sessionNames.get(c.sid) || c.sid))].slice(0, 12)
        const context = this.buildShardContext(chunks, sessionNames)
        const prompt = buildWeCloneMapPrompt({
          sessionLabel: sessions.join('、') || '未知会话',
          timeRange: range,
          context,
        })
        try {
          const digest = await this.callLlmWithFallback(
            providers,
            WECLONE_MAP_SYSTEM_PROMPT,
            prompt,
            signal,
            `分片 ${index + 1}/${shards.length}`
          )
          const cleaned = String(digest || '').trim().slice(0, DIGEST_CHAR_LIMIT)
          if (!cleaned) throw new Error('空摘要')
          return `【分片 ${index + 1}｜${range}】\n${cleaned}`
        } catch (error) {
          if ((error as Error)?.name === 'WeCloneAbortedError' || signal?.aborted) throw error
          failures += 1
          console.warn(`[WeClone] 分片 ${index + 1} 提炼失败，改用本地统计兜底:`, error)
          const ownLines = chunks.filter((c) => c.talker === '我').length
          return (
            `【分片 ${index + 1}｜${range}】\n` +
            `（这一片未能提炼：${String((error as Error)?.message || error)}）\n` +
            `已知事实：这一段历史含 ${chunks.length} 个语料分块，其中本人发言的分块 ${ownLines} 个，` +
            `涉及会话 ${sessions.join('、') || '未知'}。`
          )
        } finally {
          onProgress(index + 1, shards.length, `已提炼 ${index + 1}/${shards.length} 段历史`)
        }
      },
      signal
    )
    // mapWithConcurrency 会把异常项置 null（中止除外，那会直接抛出）
    const digests = results.filter((r): r is string => typeof r === 'string' && r.length > 0)
    return { digests, failures }
  }

  /**
   * 把分片摘要归并成一份能塞进单次调用的整体材料。
   *
   * **循环必须由 `planReduceStep` 决定，不能自己写 `while (太大) 再压一层`。**
   * 第一版就是这么写的，而且分组允许"一段超长摘要独占一组"—— 那一组调用只是把
   * 同一段摘要原样重写一遍，材料大小不变，循环永远出不去。实测跑到第 7 层还在继续
   * （十几分钟、十几次调用、都在花钱），只能人工掐掉。
   * 规划函数保证：每组至少两段、只剩两段时直接收尾、并且有层数上限；
   * 它的收敛性由 `reducePlan.test.ts` 用**不花调用**的模拟路径钉住。
   */
  private async reduceDigests(
    digests: string[],
    providers: ProviderProfile[],
    signal: AbortSignal | undefined,
    onProgress: (message: string) => void
  ): Promise<string> {
    let level = digests
    for (let round = 0; round < MAX_REDUCE_ROUNDS; round += 1) {
      const step = planReduceStep(level, REDUCE_INPUT_CHAR_BUDGET, round)
      if (step.kind === 'final') break

      onProgress(`正在归并第 ${round + 1} 层（${step.groups.length} 组）…`)
      const merged = await this.mapWithConcurrency(
        step.groups,
        REDUCE_CONCURRENCY,
        async (group, index) => {
          const text = await this.callLlmWithFallback(
            providers,
            WECLONE_REDUCE_SYSTEM_PROMPT,
            buildWeCloneReducePrompt(group),
            signal,
            `中间归并 ${index + 1}`
          )
          const cleaned = String(text || '').trim()
          if (!cleaned) throw new Error('归并结果为空')
          return cleaned
        },
        signal
      )
      const next = merged.filter((m): m is string => typeof m === 'string' && m.length > 0)
      // 这一层全失败就停在这里、用上一层的材料继续 —— 比抛错让整次生成白跑划算
      if (next.length === 0) {
        console.warn('[WeClone] 这一层归并全部失败，改用上一层材料继续')
        break
      }
      level = next
    }

    if (level.length === 1) return fitMaterial(level[0])
    onProgress(`正在做最终归并（${level.length} 份材料）…`)
    const final = await this.callLlmWithFallback(
      providers,
      WECLONE_REDUCE_SYSTEM_PROMPT,
      buildWeCloneReducePrompt(level, MD_MATERIAL_TARGET_CHARS),
      signal,
      '最终归并'
    )
    return fitMaterial(String(final || '').trim())
  }

  private formatDay(ts: number): string {
    if (!ts || ts <= 0) return '未知时间'
    return new Date(ts * 1000).toISOString().slice(0, 10)
  }

  // -------------------------------------------------------------------------
  // LLM 调用（复用 weportAiService 的 provider 配置）
  // -------------------------------------------------------------------------

  /**
   * 人格克隆该用哪个服务。
   *
   * `getForConsumer('weclone')` 在**没有单独指定**时回落到默认服务 —— 也就是顶栏
   * 那个模型（本机是 DeepSeek）。默认行为就是"用户配了什么就用什么"。
   *
   * v1.0 之前这里有一段 `ensureForcedProvider()`：它把人格克隆**锁死**在
   * `opencode-go / muse-spark-1.2-contributor` 上，还顺手往「设置 → AI 服务」里
   * 塞了一个用户从没加过的 "OpenCode Go · 人格克隆"。那个网关在本机按地区拒绝
   * （`This model is not available in your country.`），于是人格克隆的观感是
   * "永远 Internal server error"，而用户明明配好了可用的 DeepSeek —— 用户的原话
   * 是"为什么这里会有 muse spark 这个模型"。整段强制逻辑已删除。
   */
  private getActiveProfile(): ProviderProfile | null {
    return this.providerProfiles.getForConsumer('weclone')
  }

  /**
   * 一次性清理历史强制 provider。
   *
   * 只删**代码自己造出来的那一个**：providerId 与 model 都精确匹配历史常量。
   * 理由不是洁癖 —— 那个 profile 会出现在「设置 → AI 服务」里，是一个永远连不上
   * 的服务项；而且 `consumerProfiles.weclone` 还指着它，不清理的话删掉强制代码
   * 之后人格克隆仍然在用它。`remove()` 会顺手清掉指向它的功能面指定（见
   * providerProfiles.remove），因此清理之后 weclone 自动回到"跟随默认"。
   *
   * 幂等：跑完就没东西可删了；用户自己加的服务一律不碰。
   */
  private purgeLegacyForcedProfile(): void {
    try {
      const stale = this.providerProfiles
        .list()
        .filter(
          (profile) =>
            String(profile.providerId || '') === LEGACY_FORCED_PROVIDER_ID &&
            String(profile.model || '') === LEGACY_FORCED_MODEL
        )
      for (const profile of stale) {
        if (this.providerProfiles.remove(profile.id)) {
          console.log(`[WeClone] 已清理历史强制服务 ${profile.providerId}/${profile.model}（profile=${profile.id}）`)
        }
      }
    } catch (error) {
      // 清理失败不能影响启动：最坏情况只是多留一个用不上的服务项。
      console.warn('[WeClone] 清理历史强制服务失败:', error)
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
   * 单次模型调用（分片提炼 / 归并 / MD / 二审用）。
   *
   * 这里**不带回落**：调用方负责依次尝试候选服务（见 `callLlmWithFallback`），
   * 否则失败时会被最里层吞掉、外面看不出究竟试了谁。
   *
   * `reasoningEffort` 取用户设置里的值并**至少为 high**：人格提炼是"读一大堆
   * 材料再下判断"的活，推理预算直接决定摘要的密度。用户明确要求"让它尽可能
   * 多花 token"。
   */
  private async callLlm(
    profile: ProviderProfile,
    systemContent: string,
    userContent: string,
    signal?: AbortSignal,
    /** 网关会话 id（见 withGatewayHeaders 的说明）；缺省用当前生成轮的 id */
    gatewaySession?: string
  ): Promise<string> {
    const result = await getProviderAdapter(profile).stream({
      // 网关识别 header 一定要带上，否则 OpenCode 直接 400
      profile: withGatewayHeaders(profile, gatewaySession ?? this.generationSession ?? undefined),
      messages: [
        { role: 'system', content: this.sanitizeForApi(systemContent) },
        { role: 'user', content: this.sanitizeForApi(userContent) },
      ],
      tools: [],
      reasoningEffort: this.resolveReasoningEffort(),
      // 与 WeportAI 主链路一致：带上这个模型声明的输出上限。
      // 不传的话请求里**没有 max_tokens**，模型侧用默认值；归并那种"要压出五万字"的
      // 调用非常容易被默认上限截断（reasoning 还先吃掉一部分预算）。
      maxOutputTokens: profile.modelMaxOutputTokens,
      signal: signal ?? AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
      onReasoning: () => undefined,
      onText: () => undefined,
    })
    // token 用量累加：界面上要给出"这次生成本花了多少"的实话，
    // 取不到时保持 0（不编数字）。
    const usage = result.usage
    if (usage) {
      this.usageAccumulator.promptTokens += Number(usage.promptTokens) || 0
      this.usageAccumulator.completionTokens += Number(usage.completionTokens) || 0
    }
    const content = String(result.content || '')
    /**
     * 空回复必须当成**失败**，不能当成"成功但内容为空"。
     *
     * adapter 只在 `delta.content` 上累加，流被中途切断（本机实测频繁出现
     * `fetch failed`）或输出预算被 reasoning 吃光时，它会安静地返回 ''。
     * 上层于是抛出 "归并结果为空"，而 `callLlmWithFallback` 只在**异常**上重试 ——
     * 一次本可重试成功的网络抖动，就这样变成了整次生成失败
     * （实测：37 片 map 全部跑完，卡在归并上，`.building` 里只剩下语料）。
     */
    if (!content.trim()) {
      throw new Error(`空回复（finish_reason=${result.finishReason || 'none'}）`)
    }
    return content
  }

  /**
   * 推理预算。
   *
   * 用户的配置里可能是 `low`（他平时聊天用的档位），但人格提炼不该跟着降级 ——
   * 一次 60 片的分片提炼要是每片都只花几秒思考，出来的就是一堆套话。
   * 所以这里取"用户设置"与 `high` 中更费算力的那个。
   */
  private resolveReasoningEffort(): string {
    const configured = String(this.cfgGet('weportAiReasoningEffort') || 'high').toLowerCase()
    const order = ['minimal', 'low', 'medium', 'high']
    const rank = (value: string) => {
      const index = order.indexOf(value)
      return index < 0 ? order.indexOf('high') : index
    }
    return rank(configured) >= rank('high') ? configured : 'high'
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

          // 空回复是**可重试**的：它几乎总是流被截断，而不是"这个服务不可用"。
          // 不把它算进来的话，重试循环一次都不会跑（见 callLlm 里的说明）。
          const isEmptyReply = /^空回复/.test(lastError)
          if (!isProviderUnavailable(lastError) && !isEmptyReply) throw e

          const isTransient = isTransientNetworkError(lastError) || isEmptyReply
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
   * 生成时可用的服务列表：首选人格克隆这一面指定的服务，其次是聊天（默认）服务。
   *
   * 两个都拿不到才是真没配置。以前这里首选的是**强制**的 OpenCode Go，于是每次
   * 生成都会先去撞一次地区限制、白等一轮超时，再回落到真正可用的服务。
   * 现在没有强制项，首选就是用户自己配的那个（默认 DeepSeek）。
   */
  private resolveGenerationProviders(): ProviderProfile[] {
    const out: ProviderProfile[] = []
    const push = (profile: ProviderProfile | null) => {
      if (!profile) return
      if (!profile.apiKey && !getProviderCatalogEntry(profile.providerId)?.apiKeyOptional) return
      if (out.some((p) => p.id === profile.id)) return
      out.push(profile)
    }
    push(this.getActiveProfile())
    push(this.providerProfiles.getForConsumer('chat'))
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

  /**
   * 第二阶段敏感信息审查。
   *
   * **`redact === false` 时整段跳过**：脱敏开关关掉之后，"再检查一遍有没有
   * 敏感信息"这件事本身就不该做 —— 用户要的就是不做遮蔽。仍然返回原样的 MD，
   * `hits` 为 0，界面上不会出现"已脱敏 N 处"这种误导性的计数。
   */
  private async runSecondPassFilter(
    providers: ProviderProfile[],
    mds: WeCloneMds,
    signal: AbortSignal | undefined,
    onProgress: (message: string, pct: number) => void,
    redact = true
  ): Promise<{ mds: WeCloneMds; chunkPatches: Map<string, string>; hits: number }> {
    let hits = 0
    if (!redact) {
      return { mds, chunkPatches: new Map<string, string>(), hits: 0 }
    }

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

    // 3) 语料二次审查 —— v1.0 起**不再逐块调用模型**。
    //
    // 这里原来按 5% 抽样（16,038 块 → 约 800 次调用）逐块做 LLM 审查，把命中的
    // 改写记成 chunkPatches。但那批补丁**唯一的消费者是上传路径**（上传时把补丁
    // 应用进 payload）—— v1.0 不再上传，语料只在本机参与检索，于是这 800 次调用
    // 变成了完全没有产出的死功夫：实测它让一次生成从 ~2 分钟拖到小时级（跑满
    // 25 分钟轮询上限都没结束），而用户拿不到任何好处。
    //
    // 语料的隐私并不因此失去保障：入库时已经做过本地正则脱敏（见 scanAllSessions
    // 的 redactSensitiveText），二审查要保的是"没人能看到你的语料"——而语料现在
    // 根本不出本机，这一层在本地是冗余的。MD 的全量审查保留（那是要给模型看的）。
    const chunkPatches = new Map<string, string>()

    return { mds: filteredMds, chunkPatches, hits }
  }

  // -------------------------------------------------------------------------
  // 主管线：generateClone
  // -------------------------------------------------------------------------

  isGenerating(): boolean {
    return this.runningController !== null
  }

  /**
   * 生成一个克隆。
   *
   * ## 管线（v1.0.1）
   *
   * ```
   * 会话列表 → 游标扫描（脱敏可选）→ chunks.jsonl + voice.jsonl + 风格指纹
   *   → 按时间切片 → 逐片模型提炼（map，并发 3）
   *   → 分层归并（reduce）
   *   → 逐份生成 5 份 MD
   *   → 敏感信息二审（脱敏开启时）
   *   → 原子换上去
   * ```
   *
   * 与 v1.0 的关键差别：**旧版从全语料里随机抽 250 块**喂给五份 MD —— 一份
   * 50 万条消息的聊天记录，模型只看得到 0.5‰，画像于是全是放之四海而皆准的
   * 空话。现在是把语料按**时间**切成 N 片（最多 60 片），每片单独提炼，
   * 再归并 —— 每一段时间都有机会贡献证据，而且花的 token 多了一个数量级
   * （这正是用户要的："尽可能多花 token、多花时间，没有时间限制"）。
   */
  async generateClone(
    progressCb: ((progress: WeCloneProgress) => void) | undefined,
    externalSignal: AbortSignal | undefined,
    options?: { redact?: boolean }
  ): Promise<WeCloneGenerateResult> {
    if (this.runningController) {
      return { success: false, error: '已有克隆生成任务进行中' }
    }
    const ctrl = new AbortController()
    this.runningController = ctrl
    this.generationSession = newGatewaySession('gen')
    if (externalSignal) {
      const forward = () => { try { ctrl.abort() } catch { /* noop */ } }
      if (externalSignal.aborted) forward()
      else externalSignal.addEventListener('abort', forward, { once: true })
    }
    const signal = ctrl.signal
    const redact = options?.redact !== false
    const startedAt = Date.now()
    this.usageAccumulator = { promptTokens: 0, completionTokens: 0 }
    const report = (stage: WeCloneProgressStage, progress: number, message: string, detail?: Record<string, unknown>) => {
      try {
        progressCb?.({ stage, progress: Math.max(0, Math.min(100, Math.round(progress))), message, detail })
      } catch { /* noop */ }
    }

    const wxid = this.getMyWxid()
    const dir = this.getStagingDir(wxid)
    /**
     * 在**临时目录**里生成，全部成功后再原子换上去。
     *
     * 为什么不能直接写 dir：生成要几分钟，中途失败（网络断、模型报错、用户取消）
     * 时 dir 里会留下"新 MD + 旧 metadata"或"半数 MD"的混合体，用户下次打开看到
     * 的是一个说不清是哪个版本的分身。实测就撞上过这种状态。
     * 现在失败时 dir 完全没被碰过，旧克隆仍然可用。
     */
    const stageDir = `${dir}.building`
    const jsonlFinal = join(stageDir, 'chunks.jsonl')
    const jsonlPart = `${jsonlFinal}.part`
    const voiceFinal = join(stageDir, 'voice.jsonl')
    const voicePart = `${voiceFinal}.part`

    try {
      // 上一次失败留下的残留先清掉
      try { rmSync(stageDir, { recursive: true, force: true }) } catch { /* noop */ }

      // ---- 0. 前置检查 -----------------------------------------------------
      report('scan', 0, '正在检查配置…')
      // 候选服务列表（首选 + 默认），每次调用按顺序重试
      const providers = this.resolveGenerationProviders()
      // 把"这一轮到底用了哪个服务"写进日志：迭代循环里这是最常被问的问题
      console.log(
        `[WeClone] 生成使用：${providers.map((p) => `${p.providerId}/${p.model} @ ${p.baseUrl}`).join(' 或 ')}`
      )

      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        throw new Error(connectResult.error || '数据库连接失败')
      }

      // ---- 1. 会话列表 -----------------------------------------------------
      report('scan', 2, '正在读取会话列表…')
      const { ids, names } = await this.collectSessionIds()
      if (ids.length === 0) throw new Error('没有可用的聊天会话')

      // ---- 2. 游标扫描 → 脱敏 → 分块 → JSONL + 语气语料 + 风格指纹 ----------
      report('scan', 4, `开始扫描 ${ids.length} 个会话…`, { sessions: ids.length })
      const stats = await this.scanAllSessions(
        ids,
        jsonlPart,
        voicePart,
        signal,
        (completed, total, messages) => {
          report(
            'scan',
            4 + (completed / Math.max(1, total)) * 30,
            `扫描会话 ${completed}/${total}（${messages.toLocaleString()} 条消息）`,
            { completed, total, messages }
          )
        },
        { redact }
      )
      this.ensureNotAborted(signal)
      renameSync(jsonlPart, jsonlFinal) // 原子收尾
      if (existsSync(voicePart)) renameSync(voicePart, voiceFinal)
      if (stats.messageCount === 0) throw new Error('没有扫到可用的文本消息')

      // ---- 3. 按时间切片 ---------------------------------------------------
      /**
       * 分片数按语料规模自适应：越大越细，上限 60 片。
       *
       * 用户要"尽可能多花 token"，所以这里只设下限不设"够用就好"——
       * 语料有多少，就尽量让每一段都被单独读过。
       */
      const totalChars = stats.messageCount * 32 // 粗估：平均每条 ~32 字符
      const targetShards = Math.ceil(totalChars / MAP_CHARS_PER_SHARD)
      const shardCount = Math.max(MAP_MIN_SHARDS, Math.min(MAP_MAX_SHARDS, targetShards))
      report('generate', 36, `正在把 ${stats.messageCount.toLocaleString()} 条消息切成 ${shardCount} 段时间切片…`, {
        shards: shardCount,
      })      /**
       * 每个时间桶保留多少个分块。
       *
       * 70 个数字有两个作用：
       * - **小语料完全不丢**：桶内不足 70 块时蓄水池全收，所以"几千条消息"这种
       *   常见规模是逐块进入提炼的，不是抽样；
       * - **大语料均匀抽样**：70 块（约 5.6 万字符）远多于一片真正用得上的量
       *   （`MAP_SHARD_CONTEXT_CHARS` = 24k ≈ 30 块），多出来的部分给了
       *   `buildShardContext` 等间隔取舍的余地。
       */
      const perBucket = 70
      const { shards, total: scannedChunks } = await this.buildTimeShards(
        jsonlFinal,
        stats.startTs,
        stats.cutoffTs,
        shardCount,
        perBucket
      )
      if (shards.length === 0) throw new Error('语料切片失败：没有可用的分块')

      // ---- 4. map：逐片提炼 -------------------------------------------------
      report(
        'generate',
        40,
        `开始逐段提炼：${shards.length} 段 × 每段约 ${Math.round(MAP_SHARD_CONTEXT_CHARS / 1000)}k 字，并发 ${MAP_CONCURRENCY}`,
        { shards: shards.length }
      )
      /**
       * map 阶段：**能命中缓存就直接用**。
       *
       * 语料没变（size/mtime 未变）时分片摘要必然一样，重跑只是白烧约 40 分钟 ——
       * 而只要后面任何一步失败（reduce 空回复、网络抖动、取消、进程被杀），
       * 这一轮就白跑。实测被这个坑掉过三次完整生成。详见 ai/cloneMapCache.ts。
       */
      const mapCacheDir = cloneMapCacheDir(this.getStagingRoot())
      const mapCacheKey = cloneMapCacheKey(jsonlFinal, shards.length, perBucket)
      const cached = cloneMapCacheEnabled() ? readCloneMapCache(mapCacheDir, mapCacheKey) : null
      let mapResult: { digests: string[]; failures: number }
      if (cached) {
        mapResult = { digests: cached.digests, failures: cached.failures }
        report(
          'generate',
          74,
          `map 命中缓存（${cached.digests.length} 片，跳过提炼；缓存建于 ${cached.createdAt}）`,
          { shards: cached.digests.length, cached: true }
        )
      } else {
        mapResult = await this.runMapPhase(shards, names, providers, signal, (done, total, message) => {
          report('generate', 40 + (done / Math.max(1, total)) * 34, message, { done, total })
        })
        this.ensureNotAborted(signal)
        if (mapResult.digests.length > 0 && cloneMapCacheEnabled()) {
          try {
            const st = statSync(jsonlFinal)
            writeCloneMapCache(mapCacheDir, {
              key: mapCacheKey,
              createdAt: new Date().toISOString(),
              shardCount: shards.length,
              digests: mapResult.digests,
              failures: mapResult.failures,
              corpusBytes: st.size,
              corpusMtimeMs: Math.round(st.mtimeMs),
            })
          } catch {
            /* 缓存写失败不影响生成 */
          }
        }
      }
      if (mapResult.digests.length === 0) throw new Error('所有分段的提炼都失败了，请检查 AI 服务是否可用')

      // ---- 5. reduce：归并成整体材料 ---------------------------------------
      report('generate', 76, '正在把各段历史归并成整体材料…')
      const material = await this.reduceDigests(mapResult.digests, providers, signal, (message) => {
        report('generate', 78, message)
      })
      this.ensureNotAborted(signal)
      if (!material.trim()) throw new Error('归并结果为空，请重试')

      // ---- 6. 逐份生成 MD ---------------------------------------------------
      const fingerprintBlock = renderFingerprint(stats.fingerprint)
      const mdKeys = [...WECLONE_MD_KEYS] as WeCloneMdKey[]
      const mds: Partial<WeCloneMds> = {}
      for (let i = 0; i < mdKeys.length; i += 1) {
        const key = mdKeys[i]
        this.ensureNotAborted(signal)
        report('generate', 80 + (i / mdKeys.length) * 14, `正在生成 ${key}.md…`)
        const prompt = buildWeCloneMdPrompt(key, material, { redact, fingerprintBlock })
        const content = await this.callLlmWithFallback(
          providers,
          WECLONE_MD_SYSTEM_PROMPT,
          prompt,
          signal,
          `${key}.md`
        )
        const cleaned = String(content || '').trim().slice(0, MD_CHAR_LIMIT)
        if (!cleaned) throw new Error(`${key}.md 生成结果为空`)
        mds[key] = cleaned
      }
      const fullMds: WeCloneMds = {
        profile: mds.profile || '',
        relationships: mds.relationships || '',
        knowledge: mds.knowledge || '',
        timeline: mds.timeline || '',
        language: mds.language || '',
      }
      // 风格指纹是**算出来的**，直接追加到画像末尾 —— 不让模型转述一遍，
      // 转述必然引入偏差，而这批数字正是用来对账的。
      if (fingerprintBlock) {
        fullMds.profile = `${fullMds.profile}\n\n## 说话习惯（本地统计，非模型推断）\n${fingerprintBlock}`
      }

      // ---- 7. 第二阶段敏感信息审查（脱敏关闭时整段跳过）--------------------
      report('filter', 95, redact ? '正在进行二次隐私审查…' : '已关闭脱敏，跳过审查')
      const filterResult = await this.runSecondPassFilter(
        providers,
        fullMds,
        signal,
        (message) => {
          report('filter', 95, message)
        },
        redact
      )
      // MD 只在**全部审查通过之后**才落地，写进临时目录
      for (const { key, path } of this.mdFilePaths(stageDir)) {
        this.atomicWriteFile(path, filterResult.mds[key])
      }
      // 风格指纹单独存一份：它是可复现的基线，将来可以拿它给生成结果打分。
      // .txt 是**聊天时注入的那一份**（渲染好的文本，不随代码升级变化），
      // .json 是完整统计量（给将来的评估工具用）。
      this.atomicWriteFile(join(stageDir, 'fingerprint.json'), JSON.stringify(stats.fingerprint, null, 2))
      if (fingerprintBlock) this.atomicWriteFile(join(stageDir, 'fingerprint.txt'), fingerprintBlock)

      // ---- 8. 元数据 --------------------------------------------------------
      const now = new Date()
      const meta: WeCloneMeta = {
        id: `wc_${wxid}_${now.getTime().toString(36)}`,
        wxid,
        // 显示名默认「我」而不是 wxid：这是**用户自己**的分身，卡片上写
        // `wxid_gsnpwh6vh2z012` 既看不懂也不亲切。
        displayName: '我',
        knowledgeCutoff: stats.cutoffTs
          ? new Date(stats.cutoffTs * 1000).toISOString().slice(0, 10)
          : now.toISOString().slice(0, 10),
        corpusStart: stats.startTs ? new Date(stats.startTs * 1000).toISOString().slice(0, 10) : undefined,
        messageCount: stats.messageCount,
        sessionCount: stats.sessionCount,
        chunkCount: scannedChunks,
        generatedAt: now.toISOString(),
        piiHits: filterResult.hits,
        truncated: stats.truncated,
        redacted: redact,
        shardCount: mapResult.digests.length,
        shardFailures: mapResult.failures,
        tokensIn: this.usageAccumulator.promptTokens || undefined,
        tokensOut: this.usageAccumulator.completionTokens || undefined,
        elapsedMs: Date.now() - startedAt,
      }
      this.writeMeta(stageDir, meta)
      // 新克隆的拒答行为默认沿用"以本人方式拒答"，之后用户可以在卡片上改
      this.atomicWriteFile(this.settingsFile(stageDir), JSON.stringify(WECLONE_SETTINGS_DEFAULT, null, 2))

      // ---- 9. 原子换上去 ----------------------------------------------------
      // 到这里新克隆已经完整。先备份旧的（同名目录），再换名字。
      // 用 rename 而不是先把旧的删掉：rename 在同一个卷上是原子操作，
      // 中间任何一步失败都还能回滚到旧克隆。
      let backupDir: string | null = null
      if (existsSync(dir)) {
        backupDir = `${dir}.previous`
        try { rmSync(backupDir, { recursive: true, force: true }) } catch { /* noop */ }
        renameSync(dir, backupDir)
      }
      try {
        renameSync(stageDir, dir)
      } catch (e) {
        // 换名失败：把旧的放回去，保证用户至少还有一份可用的
        if (backupDir) {
          try { renameSync(backupDir, dir) } catch { /* noop */ }
        }
        throw e
      }
      if (backupDir) {
        try { rmSync(backupDir, { recursive: true, force: true }) } catch { /* noop */ }
      }

      try { this.configService.set('weCloneLastCutoff', meta.knowledgeCutoff) } catch { /* noop */ }

      const seconds = Math.round((Date.now() - startedAt) / 1000)
      report('done', 100, `克隆已在本地生成（${mapResult.digests.length} 段历史，用时 ${seconds}s）`, {
        local: true,
        shards: mapResult.digests.length,
        elapsedMs: Date.now() - startedAt,
      })
      return { success: true, clone: meta }
    } catch (e) {
      const aborted = (e as Error)?.name === 'WeCloneAbortedError' || signal.aborted
      const message = aborted ? '已取消' : String((e as Error)?.message || e)
      console.warn('[WeClone] 生成失败:', e)
      // 失败的临时目录直接清掉：旧克隆没被碰过，用户手上的档案仍然是完整的
      try { rmSync(stageDir, { recursive: true, force: true }) } catch { /* noop */ }
      // 失败用**自己的阶段**收尾：和成功共用 'done' 会让只看 stage 的消费方读错
      if (!aborted) report('failed', 100, `生成失败：${message}`)
      return { success: false, aborted, error: message }
    } finally {
      this.runningController = null
      this.generationSession = null
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
   *
   * ## 判定按"克隆还在不在"，不按"目录删干净没有"（v1.0.1 修的真实 bug）
   *
   * 用户报的是「删除失败，但其实已经删掉了（目录不为空）」。原因在 `rmTree.ts`
   * 顶部写清楚了：`rmSync` 删到一半遇到一个打不开的大文件（实时杀毒正好在扫
   * 刚写下的 23 MB 的 chunks.jsonl）就抛错，父目录 rmdir 随即 ENOTEMPTY。
   * 目录里 meta.json 早没了，克隆在列表里也确实消失了。
   *
   * 所以这里改成：
   *   1. 用带重试的 `removeTree`（Windows 上这类锁通常是瞬时的）；
   *   2. 删完之后**再问一次"这个克隆还在吗"** —— `findCloneDir(id)` 认的是
   *      meta.json，它没了就等于克隆没了。残留文件不该把一次成功的删除报成失败。
   */
  async deleteClone(id: string): Promise<{ success: boolean; error?: string }> {
    const target = this.findCloneDir(id)
    if (!target) return { success: false, error: '找不到该克隆' }
    const removal = removeTree(target)
    if (!removal.ok && this.findCloneDir(id)) {
      return { success: false, error: `删除失败：${removal.error || '目录仍被占用'}` }
    }
    if (!removal.ok) {
      // 克隆已不可见（meta.json 已删），只是文件系统里还剩些删不掉的碎片。
      // 这些碎片对用户不可见，下一次生成会把它 rename 成 .previous 再清理。
      console.warn('[WeClone] 克隆已删除，但目录里仍有残留：', target, removal.error)
    }
    // 对话历史跟着克隆一起消失：它们只对这个克隆有意义，留着就是一堆孤儿数据。
    try {
      rmSync(this.chatFile(id), { force: true })
    } catch {
      /* 历史文件删不掉不影响删除克隆本身 */
    }
    return { success: true }
  }

  // -------------------------------------------------------------------------
  // 对话历史（v1.0.1）
  //
  // 以前抽屉关掉就没了：用户看不到"上次聊到哪"，也没法留一个话题第二天接着问。
  // 每个克隆一个 JSON 文件（`{userData}/weclone-chats/<cloneId>.json`），整份重写 +
  // 原子替换 —— 聊天记录不大，用不着数据库。
  // -------------------------------------------------------------------------

  private chatRoot(): string {
    return join(app.getPath('userData'), 'weclone-chats')
  }

  /** 文件名只允许安全字符：cloneId 里有 UUID，但别赌它永远干净 */
  private chatFile(cloneId: string): string {
    const safe = String(cloneId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96)
    return join(this.chatRoot(), `${safe}.json`)
  }

  private readChatStore(cloneId: string): WeCloneChat[] {
    const file = this.chatFile(cloneId)
    if (!existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { chats?: WeCloneChat[] }
      const chats = Array.isArray(parsed?.chats) ? parsed.chats : []
      return chats.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.turns))
    } catch {
      // 坏文件不该让整个抽屉打不开：当作空历史，下一次写入会覆盖它。
      return []
    }
  }

  private writeChatStore(cloneId: string, chats: WeCloneChat[]): void {
    this.atomicWriteFile(this.chatFile(cloneId), JSON.stringify({ version: 1, chats }, null, 1))
  }

  /** 列表（不含正文，只给标题/时间/条数/最后一句预览） */
  listChats(cloneId: string): { success: boolean; chats: WeCloneChatSummary[] } {
    const chats = this.readChatStore(cloneId)
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        turnCount: c.turns.length,
        preview: previewOfChat(c),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { success: true, chats }
  }

  getChat(cloneId: string, chatId: string): { success: boolean; chat?: WeCloneChat; error?: string } {
    const chat = this.readChatStore(cloneId).find((c) => c.id === chatId)
    if (!chat) return { success: false, error: '这条对话已不存在' }
    return { success: true, chat }
  }

  /**
   * 新增/覆盖一条对话。
   *
   * 抽屉每轮回答后调用一次（整段 turns 一起写），所以不需要增量 diff：一轮对话
   * 最多几十条消息，整份重写的成本可以忽略，而"整份写"不会出现半条消息。
   */
  saveChat(input: {
    cloneId: string
    chatId?: string
    turns: WeCloneChatTurn[]
    title?: string
  }): { success: boolean; chatId?: string; title?: string; error?: string } {
    const cloneId = String(input.cloneId || '')
    if (!cloneId) return { success: false, error: '缺少克隆 id' }
    const turns = (Array.isArray(input.turns) ? input.turns : [])
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
      .map((t) => ({ role: t.role, content: t.content, at: Number(t.at) || Date.now() }))
    if (turns.length === 0) return { success: false, error: '没有内容可保存' }

    const chats = this.readChatStore(cloneId)
    const now = Date.now()
    const existing = input.chatId ? chats.find((c) => c.id === input.chatId) : undefined
    // 标题：用户改过就用用户的；否则用第一条用户消息（等同于微信/DSH 的习惯）
    const auto = autoTitleFromTurns(turns)
    if (existing) {
      existing.turns = turns
      existing.updatedAt = now
      if (input.title !== undefined && input.title.trim()) existing.title = input.title.trim().slice(0, 60)
      else if (!existing.title) existing.title = auto
      this.writeChatStore(cloneId, chats)
      return { success: true, chatId: existing.id, title: existing.title }
    }
    const chat: WeCloneChat = {
      id: `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: (input.title || '').trim().slice(0, 60) || auto,
      createdAt: now,
      updatedAt: now,
      turns,
    }
    chats.unshift(chat)
    // 只留最近 200 条，避免这个文件无限长（本地历史，不是归档）
    this.writeChatStore(cloneId, chats.slice(0, 200))
    return { success: true, chatId: chat.id, title: chat.title }
  }

  renameChat(cloneId: string, chatId: string, title: string): { success: boolean; title?: string; error?: string } {
    const clean = String(title || '').trim().slice(0, 60)
    if (!clean) return { success: false, error: '标题不能为空' }
    const chats = this.readChatStore(cloneId)
    const chat = chats.find((c) => c.id === chatId)
    if (!chat) return { success: false, error: '这条对话已不存在' }
    chat.title = clean
    this.writeChatStore(cloneId, chats)
    return { success: true, title: clean }
  }

  deleteChat(cloneId: string, chatId: string): { success: boolean; error?: string } {
    const chats = this.readChatStore(cloneId)
    const next = chats.filter((c) => c.id !== chatId)
    if (next.length === chats.length) return { success: false, error: '这条对话已不存在' }
    this.writeChatStore(cloneId, next)
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
        error: '本机还没有 WeClone',
        hint: '在「WeClone」页面点「生成克隆」—— 全程在本机完成，不需要任何服务器。',
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
      return { success: false, error: '人格档案不完整（profile.md 缺失）', hint: '请在「WeClone」里重新生成一次。' }
    }

    let retrieved: string[] = []
    let voiceSamples: string[] = []
    let corpusHits = 0
    let retrieveCostMs = 0
    const jsonlPath = join(dir, 'chunks.jsonl')
    const voicePath = join(dir, 'voice.jsonl')
    const t0 = Date.now()
    if (existsSync(jsonlPath)) {
      try {
        const r = await this.retrieveLocalChunks(jsonlPath, message, meta.wxid, {
          topK: RETRIEVE_TOP_K,
          charLimit: RETRIEVED_CONTEXT_CHAR_LIMIT,
        })
        retrieved = r.snippets
        corpusHits = r.hits
      } catch (e) {
        // 检索失败不该让聊天失败：退化成"只用人格档案回答"并留痕
        console.warn('[WeClone] 本地检索失败，退回仅人格档案:', e)
      }
    }
    /**
     * 语气样本：在**本人说过的话**里按同一个问题检索。
     *
     * 这是 v1.0.1 最重要的一处改动。旧版把 `language.md` 里的 30-50 条原句
     * 整段写进 system prompt 并标注"逐字模仿" —— 那是一份静态的示例清单：
     * 跟当前话题无关，模型要么整段照抄，要么完全忽略，而且每个克隆都不同、
     * 不可复现（用户明确反对 system prompt 里出现预设示例）。
     *
     * 改成检索之后：聊打游戏就取他打游戏时说过的原话，聊工作就取工作时的原话。
     * 样本每轮不同，且**不是 prompt 的一部分**，而是本轮输入的一部分。
     */
    if (existsSync(voicePath)) {
      try {
        const r = await this.retrieveLocalChunks(voicePath, message, meta.wxid, {
          topK: VOICE_TOP_K,
          charLimit: VOICE_CONTEXT_CHAR_LIMIT,
          // 语气样本要的是"本人怎么说"，不按说话人分组标注
          plainLines: true,
        })
        /**
         * 话题检索命中太少时用"最近说过的话"补齐。
         *
         * 对方只发"在吗""hi"或一个表情时，查询词在语料里几乎不存在 —— 检索
         * 结果可能为零，这一轮模型就完全没有语气参照，回复滑回通用助手腔。
         * 短消息恰恰最常见，所以这个兜底不是锦上添花。
         */
        voiceSamples = topUpVoiceSamples(r.lines, await this.recentVoiceLines(voicePath, VOICE_TOP_K), 6, VOICE_TOP_K)
      } catch (e) {
        console.warn('[WeClone] 语气样本检索失败（继续用档案回答）:', e)
      }
    }
    retrieveCostMs = Date.now() - t0

    const refusal = this.refusalForClone(dir)
    const systemPrompt = buildWeCloneChatSystemPrompt({
      displayName: meta.displayName || meta.wxid,
      knowledgeCutoff: meta.knowledgeCutoff,
      corpusRange:
        meta.corpusStart && meta.knowledgeCutoff ? `${meta.corpusStart} ~ ${meta.knowledgeCutoff}` : meta.knowledgeCutoff,
      refusal,
      // language.md 不进 system prompt（那是逐字语料）；它的作用已经由语气
      // 样本检索承担，画像/知识/时间线/关系这四份才是"背景资料"。
      mds: {
        profile: mds.profile,
        relationships: mds.relationships,
        knowledge: mds.knowledge,
        timeline: mds.timeline,
      },
      fingerprintBlock: this.readFingerprintBlock(dir),
      retrievedChunks: retrieved,
      voiceSamples,
      // 默认语言取**语料里本人逐字发言**的语言（language.md / voice 语料就是那些原句）。
      // profile/knowledge 这些是模型写的中文描述，拿它们探测只会永远得到"中文"。
      corpusLanguage: LANGUAGE_LABEL[
        detectLanguage(mds.language && mds.language.trim() ? mds.language : voiceSamples.join('\n'))
      ],
    })

    const history = Array.isArray(input.history)
      ? input.history.filter((h) => h && typeof h.content === 'string' && h.content.trim()).slice(-CHAT_HISTORY_LIMIT)
      : []
    /**
     * 转写里的说话人标签跟着语言走：对方用英文时把 `对方：`/`名字：` 换成 `Them:`/`Me:`，
     * 否则光是标签就足以把模型拉回中文（这是实测过的一种"越改越中文"的来源）。
     */
    const replyLanguage = detectLanguage(message)
    const english = replyLanguage === 'en'
    const selfLabel = english ? 'Me' : meta.displayName || meta.wxid
    const otherLabel = english ? 'Them' : '对方'
    /**
     * 本轮锚点放在 user 消息**最末尾**（紧邻生成位置）。
     *
     * 适配器只接受单条 user 消息，所以整段历史被压成一条文本，system prompt
     * 离生成位置有几千 token 远 —— 长对话里人格会漂回助手的默认腔调。
     * 在最近处再放一句极短的身份提醒，是最便宜的抑制手段。
     */
    const anchor = buildWeCloneTurnAnchor({
      displayName: meta.displayName || meta.wxid,
      refusal,
      language: replyLanguage,
    })
    const transcript = history.length
      ? `${history.map((h) => `${h.role === 'assistant' ? selfLabel : otherLabel}: ${h.content}`).join('\n')}\n${otherLabel}: ${message}\n\n${anchor}`
      : `${otherLabel}: ${message}\n\n${anchor}`

    const startedAt = Date.now()
    /**
     * 依次尝试的服务。
     *
     * 首选就是**用户自己在「设置 → AI 服务」里配的那一个**（本机是 DeepSeek），
     * 它同时也是 WeportAI 与 WeBot 用的那一个 —— 人格克隆不再有自己的一套服务。
     * 只有首选因为**服务方不可用**（地区限制 / 网关 5xx / 网络不通）失败时，才换
     * 下一个候选重试一次；密钥错、配额超限之类照旧原样上报，换服务也解决不了。
     */
    const attempts: Array<{ profile: ProviderProfile; label: string }> = []
    const pushIfUsable = (profile: ProviderProfile | null, label: string) => {
      if (!profile) return
      // 没有密钥就**不要**发请求：那样发出去的是一份空 Authorization，服务方回的是
      // "Authentication Fails"，用户会以为密钥写错了，而其实是根本没有密钥。
      // 真正的下一步是"去设置里填一个"，所以这里直接给出那句话。
      if (!profile.apiKey && !getProviderCatalogEntry(profile.providerId)?.apiKeyOptional) return
      if (attempts.some((a) => a.profile.id === profile.id)) return
      attempts.push({ profile, label })
    }
    pushIfUsable(this.getActiveProfile(), 'AI 服务')
    pushIfUsable(this.providerProfiles.getForConsumer('chat'), '默认服务')
    if (attempts.length === 0) {
      const resolved = this.getActiveProfile()
      return {
        success: false,
        error: resolved ? `服务「${resolved.name}」（${resolved.providerId}/${resolved.model}）没有可用的 API Key` : '没有可用的 AI 服务',
        hint: '到「设置 → AI 服务」填好提供商与密钥后重试。WeClone 和 WeportAI 共用这一份配置。',
      }
    }

    let lastError = ''
    let attemptsRun = 0
    for (const [index, attempt] of attempts.entries()) {
      attemptsRun += 1
      try {
        const reply = String(
          await this.callLlmWithSystem(
            attempt.profile,
            systemPrompt,
            transcript,
            input.signal,
            gatewaySessionForChat(meta.id)
          )
        ).trim()
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
            model: attempt.profile.model,
            providerId: attempt.profile.providerId,
            replyLanguage,
            voiceSamples: voiceSamples.length,
            refusal,
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
   * 最近说过的话（新 → 旧），最多 `limit` 条。
   *
   * 单遍流式读取、只保留一个长度 `limit` 的滑动窗口 —— 和检索一样，
   * 内存与语料大小无关。用于给"话题检索没命中"的短消息兜底语气样本。
   */
  private async recentVoiceLines(voicePath: string, limit: number): Promise<string[]> {
    if (!existsSync(voicePath) || limit <= 0) return []
    const window: string[] = []
    const rl = createInterface({ input: createReadStream(voicePath, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // 这一遍只要最近几句，不做 JSON.parse 全量解析而是直接取字段：
        // 语料行是固定结构（text 在最后），坏行跳过即可。
        try {
          const chunk = JSON.parse(trimmed) as WeCloneChunk
          const text = typeof chunk?.text === 'string' ? chunk.text.trim() : ''
          if (!text) continue
          window.push(text)
          if (window.length > limit) window.shift()
        } catch {
          continue
        }
      }
    } finally {
      rl.close()
    }
    // 新 → 旧（后面 push 的是更新的）
    return window.reverse()
  }

  /**
   * 读出风格的指纹块（生成时写好，可能不存在 —— 老克隆没有）。
   *
   * 存的是 fingerprint.json 的**渲染文本**而不是重新渲染统计对象：渲染规则
   * 改了以后老克隆的文字不该跟着变，否则"同一个克隆昨天和今天说的话不一样"
   * 会来自一次代码升级而不是语料。
   */
  private readFingerprintBlock(dir: string): string | undefined {
    try {
      const file = join(dir, 'fingerprint.txt')
      if (existsSync(file)) {
        const text = readFileSync(file, 'utf8').trim()
        if (text) return text
      }
    } catch { /* 缺了就是没有这一节，不影响回答 */ }
    return undefined
  }

  /**
   * 便宜的候选扫描（v1.0.1）。
   *
   * ## 为什么需要它
   *
   * 旧实现对本机 21,201 个分块**逐条 JSON.parse + 全量分词**，实测一次检索
   * 1.85–2.80 秒（10 万条消息的语料）。每次聊天都要先等这么久才轮到模型 ——
   * 而这台机器上的语料还会继续长。
   *
   * ## 怎么做到又快又准
   *
   * 关键观察：**正文是那一行 JSON 的子串**。查询词在原文里出现，必然也在原始
   * JSON 行里出现。所以先用一次 `includes` 做预筛，只有可能命中的行才值得
   * `JSON.parse` + 分词 —— 通常只占全部行的 1–5%。
   *
   * 精度上分三块，各自都有明确说法：
   * - **候选集**：**精确**。预筛是超集，再对解析出来的正文做一次判定，
   *   拿到的就是真正含查询词的文档。
   * - **df（查询词的文档频率）**：**精确**。只在解析过正文的行上统计。
   * - **文档长度**：非候选行用一次字符扫描估算 token 数（汉字算 1、拉丁词算 1），
   *   候选行用**真实**分词长度覆盖。BM25 的长度项只要量纲一致、单调即可，
   *   估算带来的偏差远小于它要修正的"长文档天然更容易命中"。
   */
  private async scanRetrievalCandidates(
    jsonlPath: string,
    queryTokens: string[]
  ): Promise<{
    df: Map<string, number>
    n: number
    avgdl: number
    lengths: number[]
    candidates: Array<{ index: number; tokens: string[] }>
  }> {
    const df = new Map<string, number>()
    const lengths: number[] = []
    const candidates: Array<{ index: number; tokens: string[] }> = []
    let n = 0
    let totalLen = 0

    const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (n >= CORPUS_SCAN_LINE_CAP) break
        const raw = line.trim()
        if (!raw) continue
        const index = n
        n += 1

        const lowerRaw = raw.toLowerCase()
        let maybe = false
        for (const token of queryTokens) {
          if (lowerRaw.includes(token)) {
            maybe = true
            break
          }
        }

        if (!maybe) {
          lengths[index] = estimateTokenCount(raw)
          totalLen += lengths[index]
          continue
        }

        let text = ''
        try {
          const chunk = JSON.parse(raw) as WeCloneChunk
          if (chunk && typeof chunk.text === 'string') text = chunk.text
        } catch {
          lengths[index] = estimateTokenCount(raw)
          totalLen += lengths[index]
          continue
        }
        const tokens = tokenize(text)
        lengths[index] = tokens.length
        totalLen += tokens.length

        const lowerText = text.toLowerCase()
        let matched = false
        for (const token of queryTokens) {
          if (!lowerText.includes(token)) continue
          matched = true
          df.set(token, (df.get(token) ?? 0) + 1)
        }
        if (matched) candidates.push({ index, tokens })
      }
    } finally {
      rl.close()
    }

    return { df, n, avgdl: n > 0 ? totalLen / n : 0, lengths, candidates }
  }

  /**
   * 读出候选行的原文（第二次读同一个文件，只取需要的那几行）。
   *
   * 仍然要整读一遍文件，但只对命中的行做 `JSON.parse` —— 21k 行里通常只有
   * 几百行命中。
   */
  private async readCandidateChunks(
    jsonlPath: string,
    wanted: Set<number>
  ): Promise<Array<{ index: number; chunk: WeCloneChunk }>> {
    const picked: Array<{ index: number; chunk: WeCloneChunk }> = []
    if (wanted.size === 0) return picked
    let lineNo = -1
    const rl = createInterface({ input: createReadStream(jsonlPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        lineNo += 1
        if (!wanted.has(lineNo)) continue
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const chunk = JSON.parse(trimmed) as WeCloneChunk
          if (chunk && typeof chunk.text === 'string') picked.push({ index: lineNo, chunk })
        } catch { /* 单行坏了就跳过 */ }
        if (picked.length >= wanted.size) break
      }
    } finally {
      rl.close()
    }
    return picked
  }

  /**
   * 本地语料检索：在 JSONL 上跑一遍 BM25（实现见 ai/localRetrieval.ts）。
   *
   * 两遍流式读取：第一遍只做**便宜的预筛**并算出 BM25 需要的统计量（见
   * `scanRetrievalCandidates`），第二遍回读命中的那几行原文。峰值内存与语料
   * 大小基本无关 —— 只有"候选元数据（每个约 40 字节）+ 长度数组"。
   *
   * 两种消费方式：
   * - `plainLines` 关（默认，检索 chunks.jsonl）：返回一段带日期/说话人的上下文块；
   * - `plainLines` 开（检索 voice.jsonl，本人原话）：返回**单行列表**，每行就是
   *   一句原话。语气样本不该带"「我」 2023-05-01"这种标注 —— 那是给"谁在什么时候
   *   说了什么"用的，而这里只要句子本身。
   */
  private async retrieveLocalChunks(
    jsonlPath: string,
    query: string,
    myWxid: string,
    options?: { topK?: number; charLimit?: number; plainLines?: boolean }
  ): Promise<{ snippets: string[]; lines: string[]; hits: number }> {
    const topK = Math.max(1, options?.topK ?? RETRIEVE_TOP_K)
    const charLimit = Math.max(200, options?.charLimit ?? RETRIEVED_CONTEXT_CHAR_LIMIT)
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return { snippets: [], lines: [], hits: 0 }

    const scan = await this.scanRetrievalCandidates(jsonlPath, queryTokens)
    if (scan.candidates.length === 0) return { snippets: [], lines: [], hits: 0 }

    const ranked = rankDocs(
      queryTokens,
      scan.candidates,
      { df: scan.df, n: scan.n, avgdl: scan.avgdl, lengths: scan.lengths },
      topK
    )
    if (!ranked.length) return { snippets: [], lines: [], hits: 0 }

    const wanted = new Set(ranked.map((h) => h.index))
    const read = await this.readCandidateChunks(jsonlPath, wanted)
    const picked = read.map(({ index, chunk }) => ({
      ts: chunk.ts,
      label: this.labelForTalker(chunk.talker, myWxid),
      text: chunk.text,
      index,
    }))

    if (options?.plainLines) {
      /**
       * 语气样本按**时间原序**排列，并去掉重复句 —— 同一句口头禅在语料里出现
       * 几十次，去重之后剩下的才是这个人真正多样的表达方式。
       */
      const seen = new Set<string>()
      const lines: string[] = []
      let used = 0
      for (const item of [...picked].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
        const text = item.text.trim()
        if (!text || seen.has(text)) continue
        seen.add(text)
        if (used + text.length > charLimit) break
        lines.push(text)
        used += text.length + 1
      }
      return { snippets: [], lines, hits: picked.length }
    }

    // 命中行按**分数**顺序回读（ranked 已排序），但拼上下文时按时间原序
    const byIndex = new Map(picked.map((p) => [p.index, p]))
    const ordered = ranked.map((h) => byIndex.get(h.index)).filter((p): p is NonNullable<typeof p> => Boolean(p))
    const context = buildRetrievedContext(ordered, charLimit)
    return { snippets: context ? [context] : [], lines: [], hits: picked.length }
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
    signal?: AbortSignal,
    /** 网关会话 id：同一段对话必须稳定（提示缓存按会话复用） */
    gatewaySession?: string
  ): Promise<string> {
    const reasoningEffort = String(this.cfgGet('weportAiReasoningEffort') || 'high')
    const result = await getProviderAdapter(profile).stream({
      // 网关识别 header 一定要带上，否则 OpenCode 直接 400
      profile: withGatewayHeaders(profile, gatewaySession),
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
 * 头值必须是**每个对话一个、且稳定**的 id —— 这不是可选项，是网关做**路由与提示
 * 缓存**的依据（docs/go：「Send a stable session ID in `x-opencode-session` for each
 * conversation so we can optimize routing and prompt caching」）。
 *
 * 以前这里固定用 `profile.id`：能过鉴权（网关不校验内容），但**所有对话都挤在
 * 同一条路由上**，提示缓存也没法按会话复用。现在由调用方给 id：
 *   - 聊天：每个克隆一条（`gatewaySessionForChat`），同一段对话里稳定；
 *   - 生成：每次生成一条（`generateClone` 里 minted），整轮 map/reduce/MD 共用。
 */
const OPENCODE_GATEWAYS = new Set(['opencode-zen', 'opencode-go'])

/** 每个克隆一条稳定的网关会话 id（键 = cloneId） */
const chatGatewaySessions = new Map<string, string>()

export function gatewaySessionForChat(cloneId: string): string {
  const key = String(cloneId || 'default')
  let id = chatGatewaySessions.get(key)
  if (!id) {
    id = newGatewaySession('chat')
    chatGatewaySessions.set(key, id)
  }
  return id
}

/** 造一个新的网关会话 id（无需依赖 crypto：网关只把它当路由标识） */
export function newGatewaySession(kind: string): string {
  return `weport-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function withGatewayHeaders(profile: ProviderProfile, sessionId?: string): ProviderProfile {
  if (!OPENCODE_GATEWAYS.has(profile.providerId)) return profile
  return { ...profile, headers: { 'x-opencode-session': sessionId || profile.id, ...(profile.headers || {}) } }
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

/**
 * 把整体材料限制在安全篇幅内。
 *
 * **不是截断**：超出时按**等间隔抽样**保留全文各处的段落，而不是掐掉尾巴 ——
 * 只留前半段等于把近半年的事从人格里删掉，而用户完全看不出。抽掉多少、剩多少
 * 都会明确写进材料里，模型据此知道"这是压缩过的材料"，不会对缺口瞎编。
 *
 * 正常情况下走不到这里：最终归并已经被要求压到 `MD_MATERIAL_TARGET_CHARS`。
 * 它是防"模型没听话"的兜底，而兜底的理由是 MD 调用会顶穿上下文窗口。
 */
function fitMaterial(material: string, limit = MD_MATERIAL_CHAR_LIMIT): string {
  const text = String(material || '')
  if (text.length <= limit) return text
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim())
  const step = Math.max(2, Math.ceil(text.length / limit))
  const kept: string[] = []
  let used = 0
  for (let i = 0; i < paragraphs.length; i += 1) {
    const paragraph = paragraphs[i]
    if (used + paragraph.length > limit) break
    // 等间隔抽段：保留的是"每一段历史都有一点"，不是"前面的全部"
    if (i % step !== 0) continue
    kept.push(paragraph)
    used += paragraph.length + 2
  }
  const note =
    `（说明：归并结果原本 ${text.length} 字，超出单次调用能承受的 ${limit} 字，` +
    `这里按等间隔保留了 ${kept.length}/${paragraphs.length} 段。缺的部分不是"这个人没有"，` +
    `只是这一次没有全部带上。）`
  return `${note}\n\n${kept.join('\n\n')}`
}

/**
 * 估算一段文本的 token 数（不做真正的分词）。
 *
 * 只给 BM25 的长度归一用：它需要的是"这篇文档比平均长还是短"，
 * 量纲一致、单调即可，不需要精确。规则与 `tokenize` 的口径对齐 ——
 * 汉字算 1 个 token（双字滑窗下 N 个汉字≈N 个 token），拉丁词算 1 个。
 *
 * 实现刻意逐字符走、不建数组：语料级调用（每次检索两万多行），
 * `String.match` 每行分配一个数组的开销比这里全部的计算还大。
 */
function estimateTokenCount(text: string): number {
  let count = 0
  let inLatin = false
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    // CJK 统一表意文字（含扩展 A）与兼容区
    if ((code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      count += 1
      inLatin = false
      continue
    }
    const isLatin = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
    if (isLatin) {
      if (!inLatin) count += 1
      inLatin = true
      continue
    }
    inLatin = false
  }
  return count
}

export const weCloneService = new WeCloneService()
