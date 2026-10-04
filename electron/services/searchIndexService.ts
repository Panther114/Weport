/**
 * 全局搜索索引（v1.2 §6 引擎侧，D17）。
 *
 * ## 这个服务做什么
 *
 * 把**所有** `message_*.db` 里每一张 `Msg_*` 表的可读文本抽出来，落成一份本机
 * 索引，供 `Ctrl/Cmd+K` 的全局搜索用。文本解码**复用导出侧那条链**
 * （`export/parsers/contentDecoder` 解 blob + `ExportContext.parseMessageContent`
 * 出正文），不另写一份 —— 两套解码器必然分叉，然后"导出能看到的正文，搜索搜不到"。
 *
 * ## 为什么不是 FTS（D17）
 *
 * v1.2 明确不上 FTS5。这里的做法是"持久化的内存筛选"：磁盘只存压缩文本与
 * 位置，查询在内存里做子串匹配。代价说清楚 —— 查询是 O(文档数) 全扫描，10 万条
 * 几十毫秒，100 万条几百毫秒（见 `query()` 的注释）。真上量要换倒排索引（v1.3）。
 *
 * ## 目录布局（`<userData>/search-index/<wxid>/`）
 *
 * ```
 * manifest.json                        ← 提交点（唯一真相）
 * shards/message_0.db-b03-g7.json.gz   ← 分片命名：<db 文件名>-b<桶号>-g<世代>
 * ```
 *
 * - 分片按 **db 文件 × 16 个哈希桶** 切，不是"一表一文件"：上千个会话就上千张表，
 *   一表一文件会让一次加载开上千个文件；16 桶下最多 16×db 数 个文件，增量也只
 *   重写被碰到的桶。
 * - **manifest 是提交点**：分片先写成 `-g<新世代>` 的新文件，全部写完才
 *   rename manifest。中途取消/崩溃时 manifest 仍指向旧世代分片，旧索引依旧自洽
 *   —— 「半成品索引绝不会被加载」。本次没碰过的桶沿用旧世代文件名（文件还在，
 *   引用不断）。
 * - 每次成功提交后清理未被新 manifest 引用的分片（垃圾回收）。
 *
 * ## 增量
 *
 * manifest 按**表**记 `maxRowId`。本 schema 里 `local_id` 是 INTEGER PRIMARY KEY
 * （rowid 别名），所以 `rowid` 与 `local_id` 同值；`rowid` 取不到（WITHOUT ROWID
 * 表）时退回 `local_id`，选了哪个记在 `idColumn` 里。重建只取 `id > maxRowId` 的
 * 行，另外每张表**重新解析最新 tailRefreshRows 行**，用来吸收撤回/编辑（微信原地
 * 改行内容，`id > max` 看不见）。
 *
 * 明确不靠增量处理的变化：**表内删行**（删消息）与整表清空 —— 需要 `force` 重建。
 * 表本身消失会被记账移除（连同文档）。
 *
 * ## 只读约束
 *
 * 全程只发 SELECT，不建触发器、不写任何东西到微信目录；索引与标注一律落在
 * `%APPDATA%\Weport`。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { basename, join } from 'path'
import { createHash } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import * as fzstd from 'fzstd'
import { cleanupTmpFiles, fileSize, readJsonTolerant, writeFileAtomic, writeJsonAtomic } from './atomicJson'
import { tokenizeText } from './wordFrequency'

// ---------------------------------------------------------------------------
// 对外类型（IPC 契约 §6；通道在 appMain.ts 的 search:* 区块）
// ---------------------------------------------------------------------------

/**
 * 命中类型。
 *
 * 契约里 `scope.kinds` 的可选值是 `text|link|file|voice|image|quote` 六种；这里
 * 额外产出 `video|emoji|card|system|other` 五种**扩展值**（不是重命名）：视频/
 * 表情/名片/系统消息同样是索引文档，硬塞进那六种会让筛选器说谎。界面按六种筛选时
 * 扩展值只会出现在"不过滤"的结果里。
 */
export type SearchHitKind =
  | 'text'
  | 'link'
  | 'file'
  | 'voice'
  | 'image'
  | 'quote'
  | 'video'
  | 'emoji'
  | 'card'
  | 'system'
  | 'other'

/** 契约规定可筛选的六种（其余是本机扩展值） */
export const SEARCH_FILTERABLE_KINDS: readonly SearchHitKind[] = ['text', 'link', 'file', 'voice', 'image', 'quote']

export interface SearchHit {
  /** 微信 username / 会话 id（与 chatService 的 sessionId 同义） */
  sessionId: string
  /** 会话显示名；会话名未知时回落 sessionId 或"（已删除的会话）" */
  sessionName: string
  /**
   * 消息 id：**优先 `local_id`**；`local_id` 为 0（部分系统消息/旧数据）时用
   * `server_id` 顶替，并用 `idKind` 说明用的是哪一个 —— 阅读器需要一个能定位消息
   * 的键，而契约只给了这一个字段。
   *
   * 形态是**字符串**（渲染层与标注存储都按 key 用它）。数据库的 `server_id` 是 64 位，
   * 因此不能先转成 JavaScript number；`localIdNumber` 只保留安全整数，超范围时为 0。
   */
  localId: string
  localIdNumber: number
  idKind: 'local' | 'server'
  /** 消息时间，**毫秒** */
  ts: number
  senderUsername: string
  senderName: string
  kind: SearchHitKind
  snippet: string
  /** snippet 内的 [start,end) UTF-16 码元区间（可直接 slice 做高亮） */
  highlights: Array<[number, number]>
  score: number
  /** 扩展字段：消息所在库/表（会话名未知时的定位线索，也方便排查） */
  db: string
  table: string
}

export interface SearchScope {
  sessionIds?: string[]
  senders?: string[]
  /**
   * 起止时间，**毫秒**（渲染层口径，与 `hit.ts` 一致）。含端点。
   * 兼容传秒的老调用方：值 < 1e11 时按秒解释（1e11 秒 = 公元 5138 年，
   * 而毫秒时间戳现在已经是 1.7e12 —— 两条区间不重叠，误判不可能发生）。
   */
  from?: number
  to?: number
  kinds?: SearchHitKind[]
}

export interface SearchQueryRequest {
  text: string
  scope?: SearchScope
  limit?: number
  /** 上一页返回的游标；原样回传即可（也接受裸偏移量的数字/数字串） */
  cursor?: string | number | null
}

export interface SearchQueryResult {
  hits: SearchHit[]
  /**
   * **本次查询在已扫描范围内的命中总数**（精确值，不是本页条数）。
   * `truncated: true` 时它是下界：扫描被 MAX_SCAN_ALLOWED / 时间预算提前终止，
   * 真实命中只会更多。
   */
  total: number
  /** 下一页游标；没有更多可翻的页时为 null（与渲染层类型一致） */
  cursor: string | null
  elapsedMs: number
  /** 结果被截断（命中超过保留上限、扫描提前终止、或时间预算用尽） */
  truncated: boolean
  error?: string
}

export interface SearchIndexAccountStatus {
  wxid: string
  docs: number
  lastBuiltAt: number
  /** 库文件指纹（大小+mtime）与建索引时不一致 → 索引落后 */
  stale: boolean
}

export interface SearchIndexStatus {
  ready: boolean
  building: boolean
  /** 0..1 */
  progress: number
  stage: string
  docs: number
  lastBuiltAt: number
  accounts: SearchIndexAccountStatus[]
  error?: string
}

export interface SearchIndexProgress {
  stage: string
  /** 0..1（注意 taskStatusService 用 0..100，appMain 换算） */
  progress: number
  message: string
  docs: number
  detail?: Record<string, unknown>
}

export interface SearchIndexBuildResult {
  wxid: string
  docs: number
  /** 本次新增的文档数（增量第二次运行应为 0） */
  indexed: number
  /** 本次实际解码的行数（含 tail 重解析） */
  scanned: number
  elapsedMs: number
  truncated: boolean
  cancelled: boolean
  damagedShards: string[]
  /** 索引目录占用字节 */
  bytes: number
}

// ---------------------------------------------------------------------------
// 依赖注入（生产接线见 createExportContextDecoder / createSearchIndexDeps）
// ---------------------------------------------------------------------------

export interface SearchIndexSessionRow {
  username: string
  displayName?: string
}

/** 读库侧依赖。生产实现走 wcdbService（WCDB 宿主进程），测试用假数据。 */
export interface SearchIndexDocSource {
  /** 所有消息库的绝对路径（wcdbService.listMessageDbs） */
  listMessageDbs(): Promise<string[]>
  /** 某库的所有表名（wcdbService.listTables('message', dbPath)） */
  listTables(kind: string, dbPath: string): Promise<string[]>
  /** 只读查询（wcdbService.execQuery('message', dbPath, sql) 的 rows） */
  execQuery(dbPath: string, sql: string): Promise<Array<Record<string, unknown>>>
  /** 会话列表（username + 显示名），表名 → 会话反查用 */
  getSessions(): Promise<SearchIndexSessionRow[]>
  /** 联系人显示名（查询期给 senderName 用；失败当没有） */
  getDisplayNames?(usernames: string[]): Promise<Record<string, string>>
}

export interface DecodedRowContext {
  sessionId: string
  createTime: number
  /** Safe numeric companions retained for existing decoders. Unsafe IDs are 0. */
  localId: number
  serverId: number
  /** Exact decimal IDs from SQLite CAST(... AS TEXT). */
  localIdExact: string
  serverIdExact: string
  isSend: boolean
  localType: number
}

/** 一行原始消息 → 可显示文本（生产实现复用导出侧解码器） */
export interface DecodedRowText {
  text: string
  senderUsername?: string
  /** 解码器看得到原始 XML，可以顺手给出更准的类型（如 appmsg type=6 → file） */
  kindHint?: SearchHitKind
}

export interface SearchIndexServiceOptions {
  /** `<userData>/search-index`；每个 wxid 一个子目录 */
  rootDir: string
  source: SearchIndexDocSource
  /** 原始行 → 可显示文本；生产实现见 {@link createExportContextDecoder} */
  decodeText: (row: Record<string, unknown>, ctx: DecodedRowContext) => DecodedRowText
  /** 当前账号（wxid 可能被改配置，所以是函数） */
  resolveWxid: () => string
  /** 当前 db 根目录（只用于判定别的账号索引是否落后） */
  resolveDbPath?: () => string
  /** 语音转写缓存内容（`transcripts.json`）；没有就返回空对象 */
  loadVoiceTranscripts?: () => Record<string, string>
  now?: () => number
  /** 分片桶数（默认 16） */
  shardCount?: number
  /** 每表增量时额外重解析的最新行数（吸收撤回/编辑，默认 20） */
  tailRefreshRows?: number
  /** 单批取行数（默认 500） */
  batchSize?: number
  /** 文档数上限（默认 1_000_000），超出标注 truncated */
  maxDocs?: number
  /**
   * 语料**总文本字节**上限（默认 96 MB），超出同样标注 truncated。
   *
   * 只有条数上限是不够的：每条文档的文本最长 `maxTextLength`（默认 2000 字符），而且查询时
   * 还会为 ASCII 词建一份小写副本（`ensureLower`）—— 内存占用大约是"条数 × 文本 × 2"，
   * 1M 条理论上能到几 GB。所以再加一道字节闸：条数没到、但文本已经装不下时，停下来并如实标
   * truncated（用户看到的是"索引不完整"，而不是进程被吃光）。
   */
  maxTotalTextBytes?: number
  /** 单文档入库文本上限（默认 2000 字符） */
  maxTextLength?: number
  /** query 扫描时间预算（毫秒，默认 2500） */
  queryBudgetMs?: number
  /** 保留的候选命中上限（默认 2000） */
  maxKept?: number
  log?: (line: string) => void
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const KIND_TO_CODE: Record<SearchHitKind, number> = {
  text: 0,
  link: 1,
  file: 2,
  voice: 3,
  image: 4,
  quote: 5,
  video: 6,
  emoji: 7,
  card: 8,
  system: 9,
  other: 10,
}
const CODE_TO_KIND: SearchHitKind[] = (() => {
  const out: SearchHitKind[] = []
  for (const [kind, code] of Object.entries(KIND_TO_CODE) as Array<[SearchHitKind, number]>) out[code] = kind
  return out
})()

/** 纯占位符（"[图片]" 这类）不含任何可检索字符，不进索引 */
const SEARCHABLE_CHAR_RE = /[\p{L}\p{N}]/u
const MESSAGE_TABLE_RE = /^msg_/i
const MESSAGE_DB_RE = /^message_.+\.db$/i
const MESSAGE_DB_EXCLUDE_RE = /^message_(fts|resource)/i

const INDEX_VERSION = 2
const MANIFEST_FILE = 'manifest.json'
const SHARD_DIR = 'shards'

const DEFAULT_SHARD_COUNT = 16
const DEFAULT_TAIL_REFRESH = 20
const DEFAULT_BATCH_SIZE = 500
const DEFAULT_MAX_DOCS = 1_000_000
/** 语料总文本上限（字节）：见 maxTotalTextBytes 的说明。 */
const DEFAULT_MAX_TOTAL_TEXT_BYTES = 96 * 1024 * 1024
const DEFAULT_MAX_TEXT = 2000
const DEFAULT_QUERY_BUDGET_MS = 2500
const DEFAULT_MAX_KEPT = 2000
const VOCAB_LIMIT = 4000
/** 单次查询最多扫到这么多命中就停（病态查询的保护） */
const MAX_SCAN_ALLOWED = 200_000
const SNIPPET_BEFORE = 18
const SNIPPET_AFTER = 46
/** 会话名缓存有效期 */
const NAME_CACHE_TTL_MS = 60_000

// ---------------------------------------------------------------------------
// 磁盘格式
// ---------------------------------------------------------------------------

interface ManifestTableEntry {
  db: string
  dbFile: string
  table: string
  sessionId: string
  /** 本表已索引的最大行 id（rowid 或 local_id，见 idColumn） */
  maxRowId: number
  idColumn: 'rowid' | 'local_id'
  indexedAt: number
  docs: number
  shard: string
}

interface Manifest {
  v: number
  wxid: string
  builtAt: number
  /** 分片世代：每次提交 +1，文件名带它，于是旧世代文件天然还在 */
  generation: number
  docs: number
  truncated: boolean
  /** 库文件指纹（路径:大小:mtime），判定索引是否落后 */
  sourceSignature: string
  /** 建议词表（构建期用 wordFrequency 分词采出） */
  vocab: string[]
  /** 键是 `<db 文件名>#<表名>`：一个 db 文件里有多张 Msg_* 表 */
  perDb: Record<string, ManifestTableEntry>
}

interface ShardFile {
  v: number
  dbFile: string
  bucket: number
  generation: number
  sessions: string[]
  senders: string[]
  /**
   * 归属表字典（`<dbFile>#<table>`）。
   *
   * 为什么每行都要带表：一个分片桶里混着多张表，而"表"是增量记账、删表清理、
   * 命中里的 db/table 字段的唯一依据。早期版本靠"哪个 manifest 条目引用了我"
   * 反推，桶里第二张表起的文档就全被算到第一张表头上 —— 那会算错每表的文档数，
   * 甚至把还活着的表的文档当"表已消失"删掉。
   */
  tables: string[]
  /** [sessionIdx, senderIdx, exactId, ts, kindCode, text, tableIdx, idKindCode] */
  rows: Array<[number, number, string, number, number, string, number, number]>
}

interface IndexedDoc {
  sessionId: string
  sender: string
  /** Exact decimal ID: local_id, or server_id when local_id is 0. */
  id: string
  idKind: 'local' | 'server'
  ts: number
  kind: SearchHitKind
  text: string
  /** 归属分片桶 */
  bucket: number
  /** 归属表键 `<dbFile>#<table>`（删表清理与文档计数都靠它） */
  tableKey: string
  docKey: string
}

interface Corpus {
  wxid: string
  corpusDir: string
  manifest: Manifest
  docs: IndexedDoc[]
  /** 懒建的小写副本（只有含 ASCII 字母的查询需要），与 docs 等长 */
  lower: string[] | null
  /** 时间范围（分数里的"新近度"项用，避免每查询扫一遍） */
  tsMin: number
  tsMax: number
  damagedShards: string[]
  /** 分片损坏的表键：下次构建把它们的 maxRowId 归零，从头补（自愈） */
  damagedTables: string[]
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function safeDirName(value: string): string {
  return String(value || '').trim().replace(/[^A-Za-z0-9._@-]/g, '_') || 'default'
}

function quoteIdent(identifier: string): string {
  return `"${String(identifier || '').replace(/"/g, '""')}"`
}

function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** Preserve SQLite 64-bit identifiers; an unsafe JS number has already lost information. */
function exactUnsignedId(value: unknown): string | null {
  if (typeof value === 'bigint') {
    const text = value.toString(10)
    return /^\d+$/.test(text) ? text : null
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null
    return String(value)
  }
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  return text.replace(/^0+(?=\d)/, '')
}

function safeIdNumber(id: string): number {
  const value = Number(id)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function compareUnsignedIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left < right ? -1 : left > right ? 1 : 0
}

function pickField(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key]
  }
  return undefined
}

/**
 * 把 scope 的时间界换算成**秒**（库里是 create_time 秒）。
 *
 * 渲染层传毫秒（`Date.now()` 口径）；早期调用方可能传秒。两条区间不重叠
 * （1e11 秒 = 公元 5138 年，而毫秒时间戳现在已经是 1.7e12），所以按大小判口径
 * 是安全的 —— 比"约定一个单位然后静默返回空结果"强得多。
 */
function toSecondBound(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n < 1e11 ? n : n / 1000)
}

/** 分片桶：`<db 文件名>#<表名>` → [0, shardCount) */
function bucketOf(dbFile: string, table: string, shardCount: number): number {
  const text = `${dbFile}#${table}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % shardCount
}

function shardFileName(dbFile: string, bucket: number, generation: number): string {
  return `${safeDirName(dbFile)}-b${String(bucket).padStart(2, '0')}-g${generation}.json.gz`
}

/** manifest 里存的分片路径：相对索引目录（用 `/` 分隔，Windows/macOS/Linux 都认）。 */
function shardRef(shardName: string): string {
  return `${SHARD_DIR}/${shardName}`
}

/**
 * 文档主键：**表 + id**。
 *
 * 为什么不能用会话 + id：实测真实库里**同一个会话会有多张表**（同一 md5 的表出现在
 * 不同 message_*.db 里，或带后缀的第二张表），两张表里的 `local_id` 都从 1 开始。
 * 早先按 `会话#id` 去重，会把两张表的消息互相覆盖 —— 现场表现是"同一主键的文本来回
 * 翻转、每次增量都在重写分片"，而索引里那些会话少了一半消息。表名是 md5(session)，
 * 对同一会话是稳定的：库整理导致表消失时，旧表会走"已消失的表"清理路径。
 */
function docKeyOf(tableKey: string, idKind: 'local' | 'server', id: string): string {
  return `${tableKey}#${idKind[0]}${id}`
}

/**
 * 解压分片：识别 gzip（写侧用 node:zlib —— fzstd 只有 decompress 没有 compress）、
 * zstd（兼容将来的写侧）与纯 JSON 三种形态。
 */
function decodeShardBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer).toString('utf8')
  }
  if (buffer.length >= 4) {
    const magicLE = buffer.readUInt32LE(0)
    const magicBE = buffer.readUInt32BE(0)
    if (magicLE === 0xfd2fb528 || magicBE === 0xfd2fb528) {
      return Buffer.from(fzstd.decompress(buffer)).toString('utf8')
    }
  }
  return buffer.toString('utf8')
}

function encodeShard(value: ShardFile): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 6 })
}

/** 表名 → 会话：md5 全 32 位与 16 位前缀都认（与 chatService 的匹配规则一致） */
class SessionTableLookup {
  private full32 = new Map<string, string>()
  private short16 = new Map<string, string | null>()

  constructor(sessions: SearchIndexSessionRow[]) {
    for (const session of sessions) {
      const username = String(session?.username || '').trim()
      if (!username) continue
      const hash = createHash('md5').update(username).digest('hex').toLowerCase()
      this.full32.set(hash, username)
      const short = hash.slice(0, 16)
      const existing = this.short16.get(short)
      if (existing === undefined) this.short16.set(short, username)
      else if (existing !== username) this.short16.set(short, null)
    }
  }

  match(tableName: string): string {
    const normalized = String(tableName || '').trim().toLowerCase()
    if (!normalized.startsWith('msg_')) return ''
    const suffix = normalized.slice(4)
    const direct = this.full32.get(suffix)
    if (direct) return direct
    if (suffix.length >= 16) {
      const short = this.short16.get(suffix.slice(0, 16))
      if (typeof short === 'string') return short
    }
    const hexMatch = normalized.match(/[a-f0-9]{32}|[a-f0-9]{16}/i)
    if (!hexMatch) return ''
    const hex = hexMatch[0].toLowerCase()
    if (hex.length >= 32) {
      const full = this.full32.get(hex)
      if (full) return full
    }
    const short = this.short16.get(hex.slice(0, 16))
    return typeof short === 'string' ? short : ''
  }
}

/** 顶 K 名的最小堆：命中全排序在 10 万条量级会形成明显卡顿 */
class TopKHeap {
  private heap: Array<{ index: number; score: number }> = []

  constructor(private readonly capacity: number) {}

  push(index: number, score: number): void {
    const capacity = this.capacity
    if (capacity <= 0) return
    if (this.heap.length < capacity) {
      this.heap.push({ index, score })
      let i = this.heap.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (this.heap[i].score >= this.heap[parent].score) break
        const tmp = this.heap[i]
        this.heap[i] = this.heap[parent]
        this.heap[parent] = tmp
        i = parent
      }
      return
    }
    if (score <= this.heap[0].score) return
    this.heap[0] = { index, score }
    let i = 0
    for (;;) {
      const left = i * 2 + 1
      const right = left + 1
      let smallest = i
      if (left < this.heap.length && this.heap[left].score < this.heap[smallest].score) smallest = left
      if (right < this.heap.length && this.heap[right].score < this.heap[smallest].score) smallest = right
      if (smallest === i) break
      const tmp = this.heap[i]
      this.heap[i] = this.heap[smallest]
      this.heap[smallest] = tmp
      i = smallest
    }
  }

  get items(): Array<{ index: number; score: number }> {
    return this.heap
  }

  get size(): number {
    return this.heap.length
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** 消息类型 → 命中类型。`rawContent` 给得出 appmsg 细分时用它（只有分类，不碰正文） */
export function classifyKind(localType: number, rawContent = ''): SearchHitKind {
  switch (localType) {
    case 1:
      return 'text'
    case 3:
      return 'image'
    case 34:
      return 'voice'
    case 43:
      return 'video'
    case 47:
      return 'emoji'
    case 42:
      return 'card'
    case 10000:
    case 10002:
    case 266287972401:
      return 'system'
    case 49: {
      const appType = /<type>\s*(\d+)/i.exec(rawContent || '')?.[1]
      switch (appType) {
        case '6':
          return 'file'
        case '57':
          return 'quote'
        case '19':
          return 'other'
        case '3':
        case '5':
        case '33':
        case '36':
        case '49':
          return 'link'
        default:
          return 'link'
      }
    }
    default:
      return 'other'
  }
}

/** 语音转写缓存有三代键写法（见 chatService.getVoiceCacheKey），逐个试 */
function lookupTranscript(
  transcripts: Record<string, string>,
  sessionId: string,
  createTime: number,
  localId: string,
  serverId: string
): string {
  if (!transcripts || !sessionId) return ''
  const candidates = [
    `${sessionId}_${createTime}_${localId}`,
    `${sessionId}_${createTime}_${serverId}`,
    `${sessionId}_${createTime}`,
  ]
  for (const key of candidates) {
    const value = transcripts[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 片段与高亮：以第一个命中词为锚点取一段；前缀省略号计入偏移 */
function buildSnippet(text: string, terms: string[]): { snippet: string; highlights: Array<[number, number]> } {
  const haystack = /[A-Z]/.test(text) ? text.toLowerCase() : text
  let anchor = -1
  let anchorTerm = ''
  for (const term of terms) {
    const at = haystack.indexOf(term)
    if (at >= 0) {
      anchor = at
      anchorTerm = term
      break
    }
  }
  if (anchor < 0) {
    return { snippet: text.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER), highlights: [] }
  }
  let start = Math.max(0, anchor - SNIPPET_BEFORE)
  let end = Math.min(text.length, anchor + anchorTerm.length + SNIPPET_AFTER)
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start -= 1
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end += 1

  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const snippet = `${prefix}${text.slice(start, end)}${suffix}`
  const offset = prefix.length - start
  const bodyEnd = snippet.length - suffix.length
  const highlights: Array<[number, number]> = []
  for (const term of terms) {
    let at = haystack.indexOf(term)
    while (at >= 0) {
      const from = Math.max(prefix.length, offset + at)
      const to = Math.min(bodyEnd, offset + at + term.length)
      if (to > from) highlights.push([from, to])
      at = haystack.indexOf(term, at + term.length)
    }
  }
  highlights.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return { snippet, highlights }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class SearchIndexService {
  private readonly options: SearchIndexServiceOptions & {
    shardCount: number
    tailRefreshRows: number
    batchSize: number
    maxDocs: number
    maxTextLength: number
  maxTotalTextBytes: number
    queryBudgetMs: number
    maxKept: number
  }

  private corpus: Corpus | null = null
  private loadError: string | undefined

  private building = false
  private buildStage = ''
  private buildProgress = 0
  private cancelled = false
  private activeTaskId: string | undefined

  private sessionNameCache: { at: number; map: Map<string, string> } | null = null

  constructor(options: SearchIndexServiceOptions) {
    this.options = {
      ...options,
      shardCount: Math.max(1, options.shardCount || DEFAULT_SHARD_COUNT),
      tailRefreshRows: Math.max(0, options.tailRefreshRows ?? DEFAULT_TAIL_REFRESH),
      batchSize: Math.max(50, options.batchSize || DEFAULT_BATCH_SIZE),
      maxDocs: Math.max(1000, options.maxDocs || DEFAULT_MAX_DOCS),
      maxTextLength: Math.max(64, options.maxTextLength || DEFAULT_MAX_TEXT),
    maxTotalTextBytes: Math.max(64 * 1024, options.maxTotalTextBytes || DEFAULT_MAX_TOTAL_TEXT_BYTES),
      queryBudgetMs: Math.max(200, options.queryBudgetMs || DEFAULT_QUERY_BUDGET_MS),
      maxKept: Math.max(50, options.maxKept || DEFAULT_MAX_KEPT),
    }
  }

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private log(line: string): void {
    if (this.options.log) this.options.log(line)
    else console.log(`[search-index] ${line}`)
  }

  private accountDir(wxid: string): string {
    return join(this.options.rootDir, safeDirName(wxid))
  }

  get isBuilding(): boolean {
    return this.building
  }

  get taskId(): string | undefined {
    return this.activeTaskId
  }

  /** 用户取消（下一批之前生效；已写的新世代分片不会被引用，等于没发生） */
  requestCancel(): void {
    if (this.building) this.cancelled = true
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  status(): SearchIndexStatus {
    const wxid = String(this.options.resolveWxid() || '').trim()
    const corpus = this.corpus && this.corpus.wxid === wxid ? this.corpus : null
    const ready = Boolean(corpus && corpus.manifest.docs > 0)
    let error = this.loadError
    if (corpus && corpus.damagedShards.length > 0) {
      error = `索引分片损坏已跳过：${corpus.damagedShards.slice(0, 3).join(', ')}（重新构建可修复）`
    }
    return {
      ready,
      building: this.building,
      progress: this.building ? this.buildProgress : ready ? 1 : 0,
      stage: this.building ? this.buildStage : ready ? 'ready' : 'idle',
      docs: corpus?.manifest.docs || 0,
      lastBuiltAt: corpus?.manifest.builtAt || 0,
      accounts: this.listAccountStatuses(),
      error,
    }
  }

  /** 扫描 `<root>/<wxid>/manifest.json`：多账号索引状态（只读 manifest，不加载分片） */
  private listAccountStatuses(): SearchIndexAccountStatus[] {
    const out: SearchIndexAccountStatus[] = []
    const root = this.options.rootDir
    let entries: string[] = []
    try {
      if (!existsSync(root)) return out
      entries = readdirSync(root)
    } catch {
      return out
    }
    const dbPath = this.options.resolveDbPath ? this.options.resolveDbPath() : ''
    for (const entry of entries) {
      const manifestPath = join(root, entry, MANIFEST_FILE)
      if (!existsSync(manifestPath)) continue
      const read = readJsonTolerant<Manifest>(manifestPath, { backupOnCorrupt: false })
      const manifest = read.value
      if (!manifest) continue
      const wxid = String(manifest.wxid || entry)
      out.push({
        wxid,
        docs: toInt(manifest.docs, 0),
        lastBuiltAt: toInt(manifest.builtAt, 0),
        stale: this.accountIsStale(wxid, manifest, dbPath),
      })
    }
    out.sort((a, b) => b.docs - a.docs || (a.wxid < b.wxid ? -1 : a.wxid > b.wxid ? 1 : 0))
    return out
  }

  /** 库文件指纹变了 → 索引落后（目录不存在时不妄下结论） */
  private accountIsStale(wxid: string, manifest: Manifest, dbPath: string): boolean {
    if (!dbPath) return false
    try {
      const messageDir = join(dbPath, safeDirName(wxid), 'db_storage', 'message')
      if (!existsSync(messageDir)) return false
      const paths: string[] = []
      for (const name of readdirSync(messageDir)) {
        if (this.isMessageDbFile(name)) paths.push(join(messageDir, name))
      }
      if (paths.length === 0) return false
      return this.signatureOf(paths) !== String(manifest.sourceSignature || '')
    } catch {
      return false
    }
  }

  private isMessageDbFile(name: string): boolean {
    return MESSAGE_DB_RE.test(name) && !MESSAGE_DB_EXCLUDE_RE.test(name)
  }

  private signatureOf(paths: string[]): string {
    const parts: string[] = []
    for (const dbPath of [...paths].sort()) {
      try {
        const stat = statSync(dbPath)
        parts.push(`${dbPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
      } catch {
        parts.push(`${dbPath}:missing`)
      }
    }
    return parts.join('|')
  }

  private indexBytes(corpus: Corpus): number {
    let total = fileSize(join(corpus.corpusDir, MANIFEST_FILE))
    const dir = join(corpus.corpusDir, SHARD_DIR)
    try {
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) total += fileSize(join(dir, name))
      }
    } catch {
      /* 体积上报失败不重要 */
    }
    return total
  }

  // -------------------------------------------------------------------------
  // 加载
  // -------------------------------------------------------------------------

  /** 惰性加载当前账号的索引（查询、建议、增量构建共用一份内存副本） */
  async ensureLoaded(): Promise<Corpus> {
    const wxid = String(this.options.resolveWxid() || '').trim()
    if (this.corpus && this.corpus.wxid === wxid) return this.corpus
    const corpus = await this.loadCorpus(wxid)
    this.corpus = corpus
    return corpus
  }

  private emptyManifest(wxid: string): Manifest {
    return {
      v: INDEX_VERSION,
      wxid,
      builtAt: 0,
      generation: 0,
      docs: 0,
      truncated: false,
      sourceSignature: '',
      vocab: [],
      perDb: {},
    }
  }

  private emptyCorpus(wxid: string): Corpus {
    return {
      wxid,
      corpusDir: this.accountDir(wxid),
      manifest: this.emptyManifest(wxid),
      docs: [],
      lower: null,
      tsMin: 0,
      tsMax: 0,
      damagedShards: [],
      damagedTables: [],
    }
  }

  private async loadCorpus(wxid: string): Promise<Corpus> {
    const corpusDir = this.accountDir(wxid)
    const manifestPath = join(corpusDir, MANIFEST_FILE)
    cleanupTmpFiles(corpusDir)
    cleanupTmpFiles(join(corpusDir, SHARD_DIR))

    const read = readJsonTolerant<Manifest>(manifestPath)
    if (read.corrupt) {
      this.loadError = `索引 manifest 损坏，已备份到 ${read.backedUpTo || '(备份失败)'}；下次构建将重建`
      this.log(this.loadError)
      const corpus = this.emptyCorpus(wxid)
      corpus.corpusDir = corpusDir
      return corpus
    }

    const loadedManifest = read.value
    if (loadedManifest && toInt(loadedManifest.v, 0) !== INDEX_VERSION) {
      this.loadError = `搜索索引格式已升级（v${toInt(loadedManifest.v, 0)} → v${INDEX_VERSION}），重新构建后可继续搜索`
      this.log(this.loadError)
      const corpus = this.emptyCorpus(wxid)
      corpus.corpusDir = corpusDir
      return corpus
    }
    const manifest = loadedManifest || this.emptyManifest(wxid)
    if (!manifest.perDb || typeof manifest.perDb !== 'object') manifest.perDb = {}
    if (!Array.isArray(manifest.vocab)) manifest.vocab = []

    const docs: IndexedDoc[] = []
    const damagedShards: string[] = []
    const damagedTables: string[] = []
    const seenShards = new Set<string>()
    let shardsRead = 0

    for (const [key, entry] of Object.entries(manifest.perDb)) {
      const shard = String(entry?.shard || '')
      if (!shard) {
        // 空表（一条可检索文本都没有）本来就没有分片：不算损坏，也不用重建
        if (toInt(entry?.docs, 0) > 0) damagedTables.push(key)
        continue
      }
      if (seenShards.has(shard)) continue
      seenShards.add(shard)
      // 分片是 `readFileSync` + gunzip，**都是同步的**：几百个分片连着跑会把主线程占满，
      // 窗口、托盘和所有别的 IPC 一起卡住（这个函数虽然是 async，但循环里从不 await）。
      // 每 4 个分片让出一次事件循环，界面在这段时间还能响应。
      if (shardsRead > 0 && shardsRead % 4 === 0) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      const shardPath = join(corpusDir, shard)
      if (!existsSync(shardPath)) {
        damagedShards.push(shard)
        damagedTables.push(key)
        continue
      }
      try {
        const parsed = JSON.parse(decodeShardBuffer(readFileSync(shardPath) as Buffer)) as ShardFile
        if (!parsed || !Array.isArray(parsed.rows)) throw new Error('分片结构不正确')
        const sessions = Array.isArray(parsed.sessions) ? parsed.sessions.map(String) : []
        const senders = Array.isArray(parsed.senders) ? parsed.senders.map(String) : []
        const tableKeys = Array.isArray(parsed.tables) ? parsed.tables.map(String) : []
        const bucket = toInt(parsed.bucket, 0)
        for (const row of parsed.rows) {
          if (!Array.isArray(row) || row.length < 6) continue
          const sessionId = sessions[toInt(row[0], 0)] || ''
          const sender = senders[toInt(row[1], 0)] || ''
          const id = exactUnsignedId(row[2])
          if (id === null) continue
          const ts = toInt(row[3], 0)
          const text = String(row[5] || '')
          if (!text) continue
          const tableKey = tableKeys[toInt(row[6], -1)] || key
          const legacyIdKind: 'local' | 'server' = id !== '0' ? 'local' : 'server'
          const idKind: 'local' | 'server' = toInt(row[7], -1) === 1
            ? 'server'
            : toInt(row[7], -1) === 0
              ? 'local'
              : legacyIdKind
          docs.push({
            sessionId,
            sender,
            id,
            idKind,
            ts,
            kind: CODE_TO_KIND[toInt(row[4], KIND_TO_CODE.other)] || 'other',
            text,
            bucket,
            tableKey,
            docKey: docKeyOf(tableKey, idKind, id),
          })
        }
      } catch (error) {
        damagedShards.push(shard)
        damagedTables.push(key)
        this.log(`分片损坏已跳过：${shard}（${String((error as Error)?.message || error)}）`)
      }
      shardsRead += 1
    }

    // 损坏分片对应的表：maxRowId 归零，下次构建从头补（自愈）
    for (const tableKey of damagedTables) {
      const entry = manifest.perDb[tableKey]
      if (entry) {
        entry.maxRowId = 0
        entry.shard = ''
      }
    }

    this.loadError = undefined
    this.log(`加载索引 wxid=${wxid} docs=${docs.length} 分片=${seenShards.size}`)
    const corpus: Corpus = {
      wxid,
      corpusDir,
      manifest,
      docs,
      lower: null,
      tsMin: 0,
      tsMax: 0,
      damagedShards,
      damagedTables,
    }
    this.refreshTimeRange(corpus)
    return corpus
  }

  private refreshTimeRange(corpus: Corpus): void {
    let min = 0
    let max = 0
    for (const doc of corpus.docs) {
      if (!doc.ts) continue
      if (min === 0 || doc.ts < min) min = doc.ts
      if (doc.ts > max) max = doc.ts
    }
    corpus.tsMin = min
    corpus.tsMax = max
    corpus.lower = null
  }

  // -------------------------------------------------------------------------
  // 构建
  // -------------------------------------------------------------------------

  /**
   * 构建（`force: true` 从零重写）。
   *
   * 增量语义见文件头注释；这里额外说明**取消**：取消发生在写分片与写 manifest
   * 之间时，新世代分片不会被任何 manifest 引用，磁盘上的索引仍是上一次提交的
   * 完整状态；内存副本会被丢弃，下次访问从头加载（于是取消不会留下任何可见痕迹）。
   */
  async build(options?: {
    force?: boolean
    wxid?: string
    onProgress?: (progress: SearchIndexProgress) => void
    shouldCancel?: () => boolean
    taskId?: string
  }): Promise<SearchIndexBuildResult> {
    if (this.building) throw new Error('索引构建已在进行中')
    const started = Date.now()
    const wxid = String(options?.wxid || this.options.resolveWxid() || '').trim()
    if (!wxid) throw new Error('未指定账号（wxid），无法建立索引')
    this.building = true
    this.cancelled = false
    this.activeTaskId = options?.taskId
    const emit = (progress: SearchIndexProgress): void => {
      this.buildStage = progress.stage
      this.buildProgress = progress.progress
      try {
        options?.onProgress?.(progress)
      } catch {
        /* 进度回调不该影响构建 */
      }
    }
    const shouldCancel = (): boolean => this.cancelled || Boolean(options?.shouldCancel?.())

    try {
      const force = options?.force === true
      let corpus: Corpus
      if (force) {
        corpus = this.emptyCorpus(wxid)
      } else {
        // manifest 损坏/缺失时 loadCorpus 返回空语料：下面走的就是一次全新构建
        corpus = await this.ensureLoaded()
        if (corpus.wxid !== wxid) throw new Error(`索引账号不一致：${corpus.wxid} ≠ ${wxid}`)
      }

      const outcome = await this.buildOnce(corpus, emit, shouldCancel)
      const docs = corpus.docs.length
      corpus.manifest.docs = docs
      corpus.manifest.wxid = wxid
      corpus.manifest.truncated = force
        // 强制重建是从零来的：上一轮那个"曾经超限"不该跟着粘住，否则一次 `force` 之后界面
        // 仍然永远显示"结果已截断"，而实际这次装得下。
        ? Boolean(outcome.truncated)
        : Boolean(corpus.manifest.truncated || outcome.truncated)
      if (outcome.cancelled) {
        // 取消：丢弃内存副本，磁盘上仍是上一次提交的完整索引
        this.corpus = null
        this.log('构建已取消，索引保持上一次提交的状态')
        return {
          wxid,
          docs: 0,
          indexed: outcome.indexed,
          scanned: outcome.scanned,
          elapsedMs: Date.now() - started,
          truncated: false,
          cancelled: true,
          damagedShards: [],
          bytes: 0,
        }
      }
      this.corpus = corpus
      this.refreshTimeRange(corpus)
      this.loadError = undefined
      return {
        wxid,
        docs,
        indexed: outcome.indexed,
        scanned: outcome.scanned,
        elapsedMs: Date.now() - started,
        truncated: Boolean(corpus.manifest.truncated),
        cancelled: false,
        damagedShards: corpus.damagedShards,
        bytes: this.indexBytes(corpus),
      }
    } finally {
      this.building = false
      this.buildStage = ''
      this.activeTaskId = undefined
    }
  }

  private async buildOnce(
    corpus: Corpus,
    emit: (progress: SearchIndexProgress) => void,
    shouldCancel: () => boolean
  ): Promise<{ indexed: number; scanned: number; cancelled: boolean; truncated: boolean }> {
    emit({ stage: 'scan', progress: 0.02, message: '正在枚举消息库…', docs: corpus.docs.length })
    await new Promise((resolve) => setImmediate(resolve))

    const sessions = await this.options.source.getSessions().catch(() => [] as SearchIndexSessionRow[])
    const lookup = new SessionTableLookup(sessions)
    const sessionNames = new Map<string, string>()
    for (const session of sessions) {
      const username = String(session?.username || '').trim()
      if (username) sessionNames.set(username, String(session?.displayName || '').trim())
    }
    this.sessionNameCache = { at: this.now, map: sessionNames }

    const allDbs = await this.options.source.listMessageDbs().catch(() => [] as string[])
    const dbPaths = allDbs
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((dbPath) => this.isMessageDbFile(basename(dbPath)))
      .sort()
    if (dbPaths.length === 0) {
      throw new Error('未找到任何 message_*.db —— 数据库未连接或路径不正确')
    }

    const transcripts = this.options.loadVoiceTranscripts ? this.options.loadVoiceTranscripts() : {}

    interface TableTask {
      dbPath: string
      dbFile: string
      table: string
      key: string
      sessionId: string
      idColumn: 'rowid' | 'local_id'
      tableMaxRowId: number
      fromId: number
      startFrom: number
      bucket: number
    }

    // ---- 阶段 1：枚举表结构 -------------------------------------------------
    emit({
      stage: 'scan',
      progress: 0.05,
      message: `正在读取 ${dbPaths.length} 个消息库的表结构…`,
      docs: corpus.docs.length,
    })
    const tasks: TableTask[] = []
    const aliveKeys = new Set<string>()
    const damagedTables = new Set(corpus.damagedTables)

    for (const dbPath of dbPaths) {
      const dbFile = basename(dbPath)
      let tables: string[] | null = null
      try {
        tables = (await this.options.source.listTables('message', dbPath)).map(String)
      } catch (error) {
        // 列不出表就别记账：这个库的已有索引保持不动（宁可旧，不可丢）
        this.log(`跳过 ${dbFile}：列出消息表失败（${String((error as Error)?.message || error)}）`)
        for (const key of Object.keys(corpus.manifest.perDb)) {
          if (key.startsWith(`${dbFile}#`)) aliveKeys.add(key)
        }
        continue
      }
      for (const table of tables.filter((name) => MESSAGE_TABLE_RE.test(name))) {
        if (shouldCancel()) return { indexed: 0, scanned: 0, cancelled: true, truncated: false }
        const key = `${dbFile}#${table}`
        aliveKeys.add(key)
        const info = await this.tableInfo(dbPath, table)
        if (!info) continue // 读不到表信息：保留它的旧索引，不重写
        const previous = corpus.manifest.perDb[key]
        const sameColumn = Boolean(previous && previous.idColumn === info.idColumn)
        const damaged = damagedTables.has(key)
        if (damaged) damagedTables.delete(key)
        const fromId = damaged || !sameColumn ? 0 : toInt(previous?.maxRowId, 0)
        /**
         * tail 重解析：撤回/编辑是**原地改行**，`id > max` 看不见它们，所以每张表
         * 每次构建都重读最后 tailRefreshRows 行。
         *
         * 取 `min(fromId, tableMax - tail)` 而不是 `max`：已追平的表的 `fromId`
         * 就等于 `tableMax`，用 `max` 会让 tail 永远不生效（曾经就是这样，等于
         * 写了一个从不触发的开关）。首次索引（fromId=0）自然仍是全量。
         */
        const hasPreviousIndex = Boolean(previous) && sameColumn && !damaged
        const startFrom = hasPreviousIndex && info.maxRowId > 0
          ? Math.max(0, Math.min(fromId, info.maxRowId - this.options.tailRefreshRows))
          : fromId
        tasks.push({
          dbPath,
          dbFile,
          table,
          key,
          sessionId: lookup.match(table),
          idColumn: info.idColumn,
          tableMaxRowId: info.maxRowId,
          fromId,
          startFrom,
          bucket: bucketOf(dbFile, table, this.options.shardCount),
        })
      }
    }

    // 消失的表（库还在、表没了）→ 连同文档一起移除，并重写它所在的桶
    const removedKeys = Object.keys(corpus.manifest.perDb).filter((key) => !aliveKeys.has(key))
    const dirty = new Set<number>()
    if (removedKeys.length > 0) {
      const removed = new Set(removedKeys)
      const kept: IndexedDoc[] = []
      for (const doc of corpus.docs) {
        if (removed.has(doc.tableKey)) dirty.add(doc.bucket)
        else kept.push(doc)
      }
      corpus.docs = kept
      for (const key of removedKeys) {
        const bucket = bucketOf(
          corpus.manifest.perDb[key]?.dbFile || '',
          corpus.manifest.perDb[key]?.table || '',
          this.options.shardCount
        )
        dirty.add(bucket)
        delete corpus.manifest.perDb[key]
      }
      this.log(`移除已消失的表 ${removedKeys.length} 个`)
    }

    // ---- 阶段 2：逐表取行、解码 --------------------------------------------
    const docIndex = new Map<string, number>()
    for (let i = 0; i < corpus.docs.length; i += 1) docIndex.set(corpus.docs[i].docKey, i)

    const vocab = new Map<string, number>()
    for (const word of corpus.manifest.vocab || []) vocab.set(word, 1)

    let indexed = 0
    let scanned = 0
    let changedDebug = 0
    let truncated = false
    /**
     * 已入库文本的总字节数（`maxTotalTextBytes` 那道闸）。
     * 起始值先量一次磁盘上已有的语料：增量构建是在**原有语料**上继续加，只数本轮新增会低估。
     */
    let textBytes = corpus.docs.reduce((sum, doc) => sum + doc.text.length, 0)

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex]
      if (shouldCancel()) return { indexed, scanned, cancelled: true, truncated }
      const progress = 0.05 + 0.8 * (taskIndex / Math.max(1, tasks.length))

      // tail 重解析：撤回/编辑是原地改行，`id > max` 看不见它们
      let cursor = task.startFrom
      /**
       * 这张表这轮**有没有没读完**。
       *
       * 读失败还照旧提交 `maxRowId = 表尾` 的后果是：没读到的那一段被当成"已索引"，
       * 之后每一轮增量都从表尾开始 —— 中间那些消息**永远进不了索引，而且没有任何提示**。
       * 所以失败时只提交真的读到的那一格，下一轮从断点接着读。
       */
      let readFailed = false

      for (;;) {
        if (shouldCancel()) return { indexed, scanned, cancelled: true, truncated }
        if (corpus.docs.length >= this.options.maxDocs) {
          truncated = true
          break
        }
        // 字节闸：条数没到但文本已经装不下时也要停（见 maxTotalTextBytes 的说明）。
        // 按已入库文本累计，而不是"攒够再判"—— 一条 2000 字符的文档也要算进去。
        if (textBytes >= this.options.maxTotalTextBytes) {
          truncated = true
          this.log(`语料文本已达上限 ${this.options.maxTotalTextBytes} 字节，本表剩余消息未索引（force 重建可重新计算）`)
          break
        }
        const sql = [
          `SELECT *, CAST(local_id AS TEXT) AS __weport_local_id_text, CAST(server_id AS TEXT) AS __weport_server_id_text FROM ${quoteIdent(task.table)}`,
          `WHERE ${task.idColumn} > ${cursor}`,
          `ORDER BY ${task.idColumn} ASC`,
          `LIMIT ${this.options.batchSize}`,
        ].join(' ')
        let rows: Array<Record<string, unknown>> = []
        try {
          rows = await this.options.source.execQuery(task.dbPath, sql)
        } catch (error) {
          this.log(`读取失败 ${task.key}：${String((error as Error)?.message || error)}`)
          readFailed = true
          break
        }
        if (!Array.isArray(rows) || rows.length === 0) break

        for (const row of rows) {
          scanned += 1
          const doc = this.decodeRow(row, task, transcripts)
          if (!doc) continue
          const existing = docIndex.get(doc.docKey)
          if (existing === undefined) {
            docIndex.set(doc.docKey, corpus.docs.length)
            corpus.docs.push(doc)
            textBytes += doc.text.length
            indexed += 1
            // 只有**真的变了**才把桶标脏：tail 重解析不该让每次增量都重写全部分片
            dirty.add(doc.bucket)
          } else {
            const prev = corpus.docs[existing]
            if (prev.text !== doc.text || prev.ts !== doc.ts || prev.kind !== doc.kind || prev.sender !== doc.sender) {
              if (process.env.SEARCH_INDEX_DEBUG_CHANGES === '1' && changedDebug < 12) {
                changedDebug += 1
                this.log(
                  `变更 ${doc.docKey} text=${prev.text === doc.text ? '同' : `${prev.text.slice(0, 24)} → ${doc.text.slice(0, 24)}`} ` +
                    `ts=${prev.ts === doc.ts ? '同' : `${prev.ts}→${doc.ts}`} kind=${prev.kind === doc.kind ? '同' : `${prev.kind}→${doc.kind}`} ` +
                    `sender=${prev.sender === doc.sender ? '同' : `${prev.sender}→${doc.sender}`}`
                )
              }
              corpus.docs[existing] = { ...doc, bucket: prev.bucket }
              dirty.add(doc.bucket)
            }
          }
          for (const word of tokenizeText(doc.text, 6)) {
            vocab.set(word, (vocab.get(word) || 0) + 1)
          }
        }

        const last = rows[rows.length - 1]
        cursor = Math.max(cursor, toInt(pickField(last, [task.idColumn, 'local_id', 'rowid']), cursor))
        if (rows.length < this.options.batchSize) break
        await new Promise((resolve) => setImmediate(resolve))
        emit({
          stage: 'index',
          progress,
          message: `正在索引 ${taskIndex + 1}/${tasks.length}：${corpus.docs.length} 条`,
          docs: corpus.docs.length,
          detail: { table: task.table, db: task.dbFile },
        })
      }

      corpus.manifest.perDb[task.key] = {
        db: task.dbPath,
        dbFile: task.dbFile,
        table: task.table,
        sessionId: task.sessionId,
        // 没读完就**不推进到表尾**（见上面 readFailed 的说明），下一轮从这里继续。
        maxRowId: readFailed ? Math.max(cursor, task.fromId) : Math.max(task.tableMaxRowId, cursor, task.fromId),
        idColumn: task.idColumn,
        indexedAt: this.now,
        docs: 0,
        shard: corpus.manifest.perDb[task.key]?.shard || '',
      }
      emit({
        stage: 'index',
        progress: 0.05 + 0.8 * ((taskIndex + 1) / Math.max(1, tasks.length)),
        message: `已索引 ${taskIndex + 1}/${tasks.length} 张表（${corpus.docs.length} 条）`,
        docs: corpus.docs.length,
        detail: { table: task.table, db: task.dbFile },
      })
    }

    // ---- 阶段 3：写脏桶 + 提交 ---------------------------------------------
    const generation = toInt(corpus.manifest.generation, 0) + 1
    const shardsDir = join(corpus.corpusDir, SHARD_DIR)
    const bucketMembers = new Map<number, number[]>()
    for (let i = 0; i < corpus.docs.length; i += 1) {
      const bucket = corpus.docs[i].bucket
      const list = bucketMembers.get(bucket)
      if (list) list.push(i)
      else bucketMembers.set(bucket, [i])
    }

    const writtenShards = new Map<number, string>()
    const bucketsToWrite = [...dirty].filter((bucket) => (bucketMembers.get(bucket) || []).length > 0).sort((a, b) => a - b)
    /**
     * 诊断开关（`SEARCH_INDEX_DEBUG_CHANGES=1`）：打印"这次为什么要重写分片"。
     *
     * 它就是这么抓到一个真实缺陷的：同一会话拆在多张表里时 `local_id` 会撞，
     * 现场表现就是"每次增量都重写 7 个分片、同一主键的文本来回翻转"。
     * 平时不打（构建路径已经很安静，这几行只在需要排查时开）。
     */
    if (process.env.SEARCH_INDEX_DEBUG_CHANGES === '1') {
      this.log(
        `写分片：dirty=${dirty.size} 非空=${bucketsToWrite.length} indexed=${indexed} scanned=${scanned} ` +
          `移除表=${removedKeys.length} 文档=${corpus.docs.length}`
      )
    }
    for (let i = 0; i < bucketsToWrite.length; i += 1) {
      if (shouldCancel()) return { indexed, scanned, cancelled: true, truncated }
      const bucket = bucketsToWrite[i]
      const members = bucketMembers.get(bucket) || []
      const dbFile = this.fileNameOfDoc(corpus, members[0])
      const shardName = shardFileName(dbFile, bucket, generation)
      const sessions: string[] = []
      const senders: string[] = []
      const tableKeys: string[] = []
      const sessionIndex = new Map<string, number>()
      const senderIndex = new Map<string, number>()
      const tableIndex = new Map<string, number>()
      const rows: ShardFile['rows'] = []
      for (const member of members) {
        const doc = corpus.docs[member]
        let sid = sessionIndex.get(doc.sessionId)
        if (sid === undefined) {
          sid = sessions.length
          sessions.push(doc.sessionId)
          sessionIndex.set(doc.sessionId, sid)
        }
        let senderIdx = senderIndex.get(doc.sender)
        if (senderIdx === undefined) {
          senderIdx = senders.length
          senders.push(doc.sender)
          senderIndex.set(doc.sender, senderIdx)
        }
        let tableIdx = tableIndex.get(doc.tableKey)
        if (tableIdx === undefined) {
          tableIdx = tableKeys.length
          tableKeys.push(doc.tableKey)
          tableIndex.set(doc.tableKey, tableIdx)
        }
        rows.push([
          sid,
          senderIdx,
          doc.id,
          doc.ts,
          KIND_TO_CODE[doc.kind] ?? KIND_TO_CODE.other,
          doc.text,
          tableIdx,
          doc.idKind === 'server' ? 1 : 0,
        ])
      }
      const payload: ShardFile = { v: INDEX_VERSION, dbFile, bucket, generation, sessions, senders, tables: tableKeys, rows }
      /**
       * `sync: true`：manifest 是**唯一的提交点**（下面 `writeJsonAtomic(..., { sync: true })`）。
       * 分片不落盘就等于"manifest 指向了从没写出去的字节" —— 断电之后那些表会被当成损坏分片
       * 静默跳过，搜索里少掉一整块，而且没有任何提示。少一次 fsync 省下的时间远小于这个风险。
       */
      writeFileAtomic(join(shardsDir, shardName), encodeShard(payload), { sync: true })
      writtenShards.set(bucket, shardName)
      emit({
        stage: 'write',
        progress: 0.85 + 0.13 * ((i + 1) / Math.max(1, bucketsToWrite.length)),
        message: `正在写入索引分片 ${i + 1}/${bucketsToWrite.length}`,
        docs: corpus.docs.length,
      })
    }

    // 未被重写的桶沿用旧世代分片（文件还在、引用不断）
    for (const entry of Object.values(corpus.manifest.perDb)) {
      const bucket = bucketOf(entry.dbFile || '', entry.table || '', this.options.shardCount)
      const fresh = writtenShards.get(bucket)
      if (fresh) entry.shard = shardRef(fresh)
    }

    // 每张表的文档数（按 tableKey 精确统计）；没有文档的表不引用任何分片
    const perTableDocs = new Map<string, number>()
    for (const doc of corpus.docs) perTableDocs.set(doc.tableKey, (perTableDocs.get(doc.tableKey) || 0) + 1)
    for (const [key, entry] of Object.entries(corpus.manifest.perDb)) {
      entry.docs = perTableDocs.get(key) || 0
      if (entry.docs === 0) entry.shard = ''
    }

    // 本次没写任何分片（第二次增量就是这种情况）就别动世代号：文件名含义才不会漂
    corpus.manifest.generation = writtenShards.size > 0 ? generation : toInt(corpus.manifest.generation, 0)
    corpus.manifest.docs = corpus.docs.length
    corpus.manifest.wxid = corpus.wxid
    corpus.manifest.builtAt = this.now
    corpus.manifest.truncated = Boolean(corpus.manifest.truncated || truncated)
    corpus.manifest.vocab = [...vocab.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, VOCAB_LIMIT)
      .map(([word]) => word)
    corpus.manifest.sourceSignature = this.signatureOf(dbPaths)

    if (shouldCancel()) return { indexed, scanned, cancelled: true, truncated }

    emit({ stage: 'commit', progress: 0.99, message: '正在提交索引…', docs: corpus.docs.length })
    writeJsonAtomic(join(corpus.corpusDir, MANIFEST_FILE), corpus.manifest, { pretty: false })

    const referenced = new Set<string>()
    for (const entry of Object.values(corpus.manifest.perDb)) {
      // 引用一律按"分片文件名"比较（manifest 里存的是 `shards/<name>` 相对路径）
      if (entry.shard) referenced.add(basename(entry.shard))
    }
    this.pruneShards(corpus.corpusDir, referenced)

    emit({
      stage: 'done',
      progress: 1,
      message: `索引完成：${corpus.docs.length} 条消息`,
      docs: corpus.docs.length,
    })
    this.log(
      `构建完成 docs=${corpus.docs.length} indexed=${indexed} scanned=${scanned} 表=${tasks.length} 分片=${writtenShards.size}`
    )
    return { indexed, scanned, cancelled: false, truncated }
  }

  private fileNameOfDoc(corpus: Corpus, docIndex: number): string {
    const doc = corpus.docs[docIndex]
    if (doc?.tableKey) {
      const [dbFile] = doc.tableKey.split('#')
      if (dbFile) return dbFile
    }
    const first = Object.values(corpus.manifest.perDb)[0]
    return first?.dbFile || 'unknown.db'
  }

  private pruneShards(corpusDir: string, referenced: Set<string>): void {
    const dir = join(corpusDir, SHARD_DIR)
    if (!existsSync(dir)) return
    let removed = 0
    try {
      for (const name of readdirSync(dir)) {
        if (referenced.has(name)) continue
        if (!/\.json(\.gz|\.zst)?$/.test(name)) continue
        try {
          rmSync(join(dir, name), { force: true })
          removed += 1
        } catch {
          /* 删不掉留着也不影响正确性 */
        }
      }
    } catch {
      return
    }
    if (removed > 0) this.log(`清理旧世代分片 ${removed} 个`)
  }

  /** 某张表的 id 列与最大 id；表结构不认就返回 null（调用方保持旧索引不动） */
  private async tableInfo(
    dbPath: string,
    table: string
  ): Promise<{ idColumn: 'rowid' | 'local_id'; maxRowId: number } | null> {
    try {
      const probe = await this.options.source.execQuery(
        dbPath,
        `SELECT max(rowid) AS rowid_max, max(local_id) AS local_max FROM ${quoteIdent(table)}`
      )
      const row = probe[0] || {}
      const rowidMax = pickField(row, ['rowid_max'])
      const localMax = pickField(row, ['local_max'])
      if (rowidMax !== undefined && rowidMax !== null) {
        return { idColumn: 'rowid', maxRowId: toInt(rowidMax, 0) }
      }
      return { idColumn: 'local_id', maxRowId: toInt(localMax, 0) }
    } catch {
      try {
        const probe = await this.options.source.execQuery(
          dbPath,
          `SELECT max(local_id) AS local_max FROM ${quoteIdent(table)}`
        )
        const row = probe[0] || {}
        return { idColumn: 'local_id', maxRowId: toInt(pickField(row, ['local_max']), 0) }
      } catch (error) {
        this.log(`表信息读取失败 ${basename(dbPath)}#${table}：${String((error as Error)?.message || error)}`)
        return null
      }
    }
  }

  /** 一行原始消息 → IndexedDoc（文本为空/纯占位符 → null） */
  private decodeRow(
    row: Record<string, unknown>,
    task: { dbFile: string; table: string; key: string; sessionId: string; bucket: number },
    transcripts: Record<string, string>
  ): IndexedDoc | null {
    const localIdExact = exactUnsignedId(pickField(row, ['__weport_local_id_text', 'local_id', 'localId'])) ?? '0'
    const serverIdExact = exactUnsignedId(pickField(row, ['__weport_server_id_text', 'server_id', 'serverId'])) ?? '0'
    const localId = safeIdNumber(localIdExact)
    const serverId = safeIdNumber(serverIdExact)
    const localType = toInt(pickField(row, ['local_type', 'localType']), 1)
    const createTime = toInt(pickField(row, ['create_time', 'createTime', 'msg_time']), 0)
    const isSend = toInt(pickField(row, ['computed_is_send', 'is_send']), 0) === 1
    const ctx: DecodedRowContext = {
      sessionId: task.sessionId,
      createTime,
      localId,
      serverId,
      localIdExact,
      serverIdExact,
      isSend,
      localType,
    }
    let decoded: DecodedRowText
    try {
      decoded = this.options.decodeText(row, ctx)
    } catch (error) {
      this.log(`解码失败 ${task.key} local_id=${localId}：${String((error as Error)?.message || error)}`)
      return null
    }
    let text = String(decoded?.text || '').trim()
    if (localType === 34) {
      const transcript = lookupTranscript(transcripts, task.sessionId, createTime, localIdExact, serverIdExact)
      if (transcript) text = transcript
    }
    if (!text || !SEARCHABLE_CHAR_RE.test(text)) return null
    if (text.length > this.options.maxTextLength) text = text.slice(0, this.options.maxTextLength)
    const hasLocalId = localIdExact !== '0'
    const id = hasLocalId ? localIdExact : serverIdExact
    const idKind: 'local' | 'server' = hasLocalId ? 'local' : 'server'
    return {
      sessionId: task.sessionId,
      sender: String(decoded?.senderUsername || '').trim(),
      id,
      idKind,
      ts: createTime,
      kind: decoded?.kindHint || classifyKind(localType),
      text,
      bucket: task.bucket,
      tableKey: task.key,
      docKey: docKeyOf(task.key, idKind, id),
    }
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /**
   * 查询。
   *
   * 算法：所有词 lowercase 后对文档文本做 `indexOf` 子串匹配（多词 AND，与微信
   * 搜索一致）；进度用最小堆只留前 K 个候选，最后再按
   * `(score 降, ts 降, sessionId 升, localId 升)` 全序排 — 同一条件两次执行结果
   * 完全一致（含排序）。
   *
   * 复杂度 O(D × (L + 词数))，D = 文档数、L = 平均文本长度：
   *   - 10 万条 × 约 60 字 ≈ 几十毫秒（实测见交付报告）；
   *   - 100 万条 ≈ 10 倍，几百毫秒 —— **这是本设计的退化点**（D17 不上 FTS 的
   *     直接代价）。含 ASCII 的查询会先建一份小写副本（一次性 O(D)），之后复用。
   * 两处保护：扫描到 MAX_SCAN_ALLOWED 命中或超时间预算即停（`truncated` 说实话），
   * 候选命中封顶 `maxKept`。
   */
  async query(request: SearchQueryRequest): Promise<SearchQueryResult> {
    const startedAt = Date.now()
    const text = String(request?.text || '').trim()
    const limit = Math.max(1, Math.min(200, toInt(request?.limit, 30)))
    const cursor = this.parseCursor(request?.cursor, text)
    if (!text) return { hits: [], total: 0, cursor: null, elapsedMs: 0, truncated: false }

    let corpus: Corpus
    try {
      corpus = await this.ensureLoaded()
    } catch (error) {
      return {
        hits: [],
        total: 0,
        cursor: null,
        elapsedMs: Date.now() - startedAt,
        truncated: false,
        error: `索引不可用：${String((error as Error)?.message || error)}`,
      }
    }
    /**
     * 索引层面的问题（坏 manifest / 坏分片）**不走**这里：`ensureLoaded()` 不抛，它把坏档
     * 备份掉、返回空/部分语料，原因记在 `loadError` / `damagedShards`，由 `status().error`
     * 报给界面（搜索页的索引状态条会渲染它）。查询本身仍然可用 —— 坏掉的那几个桶查不到，
     * 其余照常能查，所以这里保持"结果里不带 error"，免得和状态条重复报同一件事。
     */

    const terms = this.tokenizeQuery(text)
    const scope = request?.scope || {}
    const sessionFilter = scope.sessionIds && scope.sessionIds.length > 0 ? new Set(scope.sessionIds.map(String)) : null
    const senderFilter = scope.senders && scope.senders.length > 0 ? new Set(scope.senders.map(String)) : null
    const kindFilter = scope.kinds && scope.kinds.length > 0 ? new Set<SearchHitKind>(scope.kinds) : null
    // 毫秒 ↔ 秒：单位弄错会让结果"莫名其妙为空"，所以这里认两种口径（见 SearchScope 注释）
    const from = toSecondBound(scope.from)
    const to = toSecondBound(scope.to)

    const lower = terms.some((term) => /[a-z]/.test(term)) ? this.ensureLower(corpus) : null
    const keep = Math.min(this.options.maxKept, Math.max(200, cursor.offset + limit * 2))
    const heap = new TopKHeap(keep)
    const deadline = startedAt + this.options.queryBudgetMs

    let total = 0
    let truncated = false

    for (let index = 0; index < corpus.docs.length; index += 1) {
      const doc = corpus.docs[index]
      if (sessionFilter && !sessionFilter.has(doc.sessionId)) continue
      if (senderFilter && !senderFilter.has(doc.sender)) continue
      if (kindFilter && !kindFilter.has(doc.kind)) continue
      if (from > 0 && doc.ts < from) continue
      if (to > 0 && doc.ts > to) continue

      const haystack = lower ? lower[index] : doc.text
      let score = 0
      let matched = true
      for (const term of terms) {
        const at = haystack.indexOf(term)
        if (at < 0) {
          matched = false
          break
        }
        let occurrences = 0
        let found = at
        while (found >= 0 && occurrences < 5) {
          occurrences += 1
          found = haystack.indexOf(term, found + term.length)
        }
        score += 10 + occurrences
      }
      if (!matched) continue

      total += 1
      if (total > MAX_SCAN_ALLOWED) {
        truncated = true
        break
      }
      if ((total & 1023) === 0 && Date.now() > deadline) {
        truncated = true
        break
      }
      heap.push(index, score + this.recencyBonus(doc.ts, corpus))
    }

    const ordered = heap.items.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const left = corpus.docs[a.index]
      const right = corpus.docs[b.index]
      if (right.ts !== left.ts) return right.ts - left.ts
      if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1
      const idOrder = compareUnsignedIds(left.id, right.id)
      if (idOrder !== 0) return idOrder
      return left.tableKey < right.tableKey ? -1 : left.tableKey > right.tableKey ? 1 : 0
    })
    if (total > ordered.length) truncated = true

    const end = cursor.offset + limit
    const pageItems = ordered.slice(cursor.offset, end)
    const sessionNames = await this.ensureSessionNames()
    const senderNames = await this.resolveSenderNames(pageItems.map((item) => corpus.docs[item.index]))

    const hits: SearchHit[] = pageItems.map((item) => {
      const doc = corpus.docs[item.index]
      const built = buildSnippet(doc.text, terms)
      const [dbFile, table] = doc.tableKey.split('#')
      const sessionName = doc.sessionId
        ? sessionNames.get(doc.sessionId) || doc.sessionId
        : dbFile
          ? `（已删除的会话 · ${dbFile}）`
          : '（已删除的会话）'
      return {
        sessionId: doc.sessionId,
        sessionName,
        localId: doc.id,
        localIdNumber: safeIdNumber(doc.id),
        idKind: doc.idKind,
        // 毫秒（渲染层口径）：库里是 create_time 秒，这里换算一次，界面不再各算各的
        ts: doc.ts * 1000,
        senderUsername: doc.sender,
        senderName: senderNames.get(doc.sender) || doc.sender || sessionName,
        kind: doc.kind,
        snippet: built.snippet,
        highlights: built.highlights,
        score: Math.round(item.score * 100) / 100,
        db: dbFile || '',
        table: table || '',
      }
    })

    const nextOffset = cursor.offset + hits.length
    return {
      hits,
      total,
      cursor: nextOffset < ordered.length ? this.encodeCursor(text, nextOffset) : null,
      elapsedMs: Date.now() - startedAt,
      truncated,
      error: cursor.invalid ? '游标与本次查询不匹配，已从第一页返回' : undefined,
    }
  }

  /** 会话显示名（60 秒缓存；查询路径上唯一一次额外的会话表读取） */
  private async ensureSessionNames(): Promise<Map<string, string>> {
    const cached = this.sessionNameCache
    if (cached && this.now - cached.at <= NAME_CACHE_TTL_MS) return cached.map
    const map = new Map<string, string>()
    try {
      const sessions = await this.options.source.getSessions()
      for (const session of sessions) {
        const username = String(session?.username || '').trim()
        if (!username) continue
        const displayName = String(session?.displayName || '').trim()
        if (displayName) map.set(username, displayName)
      }
    } catch {
      /* 会话名拿不到就回落 username：搜索仍然可用 */
    }
    this.sessionNameCache = { at: this.now, map }
    return map
  }

  /** 联系人名（只查本页用到的发送者） */
  private async resolveSenderNames(pageDocs: IndexedDoc[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unknown = [...new Set(pageDocs.map((doc) => doc.sender).filter((name) => name))].slice(0, 200)
    if (unknown.length === 0 || !this.options.source.getDisplayNames) return out
    try {
      const resolved = await this.options.source.getDisplayNames(unknown)
      for (const [username, name] of Object.entries(resolved || {})) {
        if (name) out.set(username, String(name))
      }
    } catch {
      /* 名字拿不到就回落 username，不是错误 */
    }
    return out
  }

  /** 懒建小写副本：只有含 ASCII 字母的查询需要 */
  private ensureLower(corpus: Corpus): string[] {
    if (!corpus.lower || corpus.lower.length !== corpus.docs.length) {
      corpus.lower = corpus.docs.map((doc) => doc.text.toLowerCase())
    }
    return corpus.lower
  }

  private recencyBonus(ts: number, corpus: Corpus): number {
    if (!ts || corpus.tsMax <= corpus.tsMin) return 0
    return ((ts - corpus.tsMin) / (corpus.tsMax - corpus.tsMin)) * 3
  }

  private tokenizeQuery(text: string): string[] {
    return text
      .split(/\s+/)
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8)
  }

  private parseCursor(cursor: string | number | null | undefined, text: string): { offset: number; invalid: boolean } {
    if (cursor === undefined || cursor === null) return { offset: 0, invalid: false }
    const raw = String(cursor).trim()
    if (!raw) return { offset: 0, invalid: false }
    // 裸数字 = 偏移量（渲染层如果只想要"第 N 条起"，不需要理解游标编码）
    if (/^\d+$/.test(raw)) return { offset: Number(raw), invalid: false }
    try {
      const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: number; o?: number; q?: string }
      if (toInt(decoded?.v, 0) !== 1) return { offset: 0, invalid: true }
      if (String(decoded?.q || '') !== this.queryHash(text)) return { offset: 0, invalid: true }
      return { offset: Math.max(0, toInt(decoded?.o, 0)), invalid: false }
    } catch {
      return { offset: 0, invalid: true }
    }
  }

  private encodeCursor(text: string, offset: number): string {
    return Buffer.from(JSON.stringify({ v: 1, q: this.queryHash(text), o: offset }), 'utf8').toString('base64url')
  }

  private queryHash(text: string): string {
    let hash = 2166136261
    const normalized = text.trim().toLowerCase()
    for (let i = 0; i < normalized.length; i += 1) {
      hash ^= normalized.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16)
  }

  /**
   * 建议词：来自构建期用同一个分词器（wordFrequency.tokenizeText）采出的词表。
   * 不做"最近搜索"——那属于标注存储（savedSearches）与页面层。
   */
  async suggest(prefix: string, limit = 8): Promise<string[]> {
    const normalized = String(prefix || '').trim().toLowerCase()
    if (!normalized) return []
    const corpus = await this.ensureLoaded().catch(() => null)
    if (!corpus) return []
    const max = Math.max(1, Math.min(50, limit || 8))
    const out: string[] = []
    for (const word of corpus.manifest.vocab || []) {
      if (!word) continue
      if (word.toLowerCase().startsWith(normalized)) {
        out.push(word)
        if (out.length >= max) break
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// 生产接线（只在主进程调用；测试不碰这里）
// ---------------------------------------------------------------------------

/**
 * 把原始行变成可显示文本 —— **复用导出侧解码器**，不另写第二份：
 *   1. `decodeMessageContent(message_content, compress_content)`
 *      负责 zstd/hex/base64 → 字符串（导出与统计服务同源）；
 *   2. `ExportContext.parseMessageContent(content, localType, …)`
 *      负责 XML / 引用 / 链接标题 / 文件名 → 人类可读文本。
 *
 * 两者都是懒引入：本模块被 vitest import 时不会拉起导出侧的重依赖。
 */
export function createExportContextDecoder(
  parseMessageContent: (
    content: string,
    localType: number,
    sessionId?: string,
    createTime?: number,
    myWxid?: string,
    senderWxid?: string,
    isSend?: boolean
  ) => string | null,
  myWxid: string
): (row: Record<string, unknown>, ctx: DecodedRowContext) => DecodedRowText {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { decodeMessageContent } = require('./export/parsers/contentDecoder') as {
    decodeMessageContent: (messageContent: unknown, compressContent: unknown) => string
  }
  return (row, ctx) => {
    let raw = ''
    try {
      raw = decodeMessageContent(row.message_content, row.compress_content)
    } catch {
      raw = ''
    }
    if (!raw && row.content !== undefined && row.content !== null) raw = String(row.content)
    const senderUsername = String(row.sender_username ?? row.senderUsername ?? '').trim()
    let text: string | null = null
    try {
      text = parseMessageContent(raw, ctx.localType, ctx.sessionId, ctx.createTime, myWxid, senderUsername, ctx.isSend)
    } catch {
      text = null
    }
    if (!text) text = raw
    // 类型细分只对 appmsg（type=49）有意义，并且要看原始 XML 而不是解出来的正文
    const kindHint = ctx.localType === 49 ? classifyKind(49, raw) : undefined
    return { text: String(text || ''), senderUsername, kindHint }
  }
}

export const searchIndexConstants = {
  INDEX_VERSION,
  MANIFEST_FILE,
  SHARD_DIR,
  DEFAULT_SHARD_COUNT,
  VOCAB_LIMIT,
} as const
