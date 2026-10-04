/**
 * 标签 / 收藏 / 标记 / 保存搜索（v1.2 §6，决策 D14）。
 *
 * ## 为什么是一个文件
 *
 * 这四样东西都是**用户手打的**、体量很小（几百条）、且互相引用（保存搜索里会
 * 存标签名）。分散到四个文件就得处理"四个文件写了一半"的部分提交；一个文件 +
 * 原子 rename 只有一个提交点，坏掉就整体回退到上一个自洽版本。
 *
 * 存储位置：`<userData>/annotations/accounts/<sha256>.json`；未选定账号时用
 * `<userData>/annotations/unbound.json`。旧版 `<userData>/annotations.json` 只供首个账号迁移，
 * **不写微信目录**、不写任何导出产物。
 *
 * ## 损坏容忍
 *
 * 文件坏了**不抛异常**：备份成 `annotations.json.corrupt-<时间戳>` 后从空库
 * 起步。理由：这个文件是唯一副本，如果读坏文件就抛，用户连"删掉重来"都做不到
 * —— 界面会一直卡在一个打不开的设置页上。备份保住最后的机会，空库保住可用性。
 *
 * ## 幂等
 *
 * 打同一个标签两次、收藏同一条消息两次，结果与一次完全相同（不产生重复项，
 * 也不刷新 `at`）。这样界面不必做去重，重试也不会让数据长胖。
 */
import { existsSync, mkdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, extname, join } from 'path'
import { readJsonTolerant, writeFileAtomic, writeJsonAtomic } from './atomicJson'

// ---------------------------------------------------------------------------
// 类型（与 IPC 契约 annotations:* 一一对应）
// ---------------------------------------------------------------------------

export interface AnnotationFavorite {
  /** 会话 username；localId === 0 且没有 messageId 表示"收藏整个会话" */
  sessionId: string
  /** Safe local_id (or 0 for session/server-ID favorites). */
  localId: number
  /** Exact local/server ID stored as text to preserve 64-bit server IDs. */
  messageId?: string
  idKind?: 'local' | 'server'
  db?: string
  table?: string
  /** Message time in seconds; session favorite time may be the session's latest message time. */
  ts: number
  note?: string
  /** 收藏时间（毫秒） */
  at: number
}

export interface AnnotationMark {
  sessionId: string
  localId: number
  messageId?: string
  idKind?: 'local' | 'server'
  db?: string
  table?: string
  ts: number
  note?: string
  at: number
}

export interface SavedSearch {
  id: string
  name: string
  query: string
  /** 与 search:query 的 scope 同构（原样存，原样用） */
  scope?: Record<string, unknown>
  createdAt: number
  lastRunAt?: number
  lastCount?: number
}

export interface AnnotationsStore {
  /** sessionId → 标签名（去重、排序）。契约字段，会话维度。 */
  tags: Record<string, string[]>
  /**
   * **派生视图**（扩展字段）：tag → sessionId[]。
   *
   * 契约把 `tags` 定义成 `Record<string, string[]>` 而没说键是哪一侧。引擎按
   * 会话存（打标以会话为单位、重命名要全量生效），同时把反向索引一并给出 ——
   * 「按标签形成虚拟文件夹」直接读这一份，页面不必自己转。
   */
  tagIndex: Record<string, string[]>
  favorites: AnnotationFavorite[]
  marks: AnnotationMark[]
  savedSearches: SavedSearch[]
}

export type AnnotationOp =
  | 'tag.add'
  | 'tag.remove'
  | 'fav.add'
  | 'fav.remove'
  | 'mark.add'
  | 'mark.remove'
  | 'search.save'
  | 'search.remove'
  | 'search.rename'

export interface AnnotationMutation {
  op: AnnotationOp
  payload?: Record<string, unknown>
}

export interface AnnotationMutateResult extends AnnotationsStore {
  success: boolean
  error?: string
}

export interface AnnotationExportResult {
  success: boolean
  path?: string
  error?: string
}

const STORE_VERSION = 1
const FILE_NAME = 'annotations.json'
const MAX_TAG_LENGTH = 40
const MAX_NAME_LENGTH = 80
const LEGACY_OWNER_FILE = 'annotations-legacy-owner.json'

function accountIdentity(value: unknown): string | null {
  const identity = String(value ?? '').trim().toLowerCase()
  return identity && identity !== 'default' && identity !== 'unknown' ? identity : null
}

export function annotationsAccountHash(accountId: string): string {
  return createHash('sha256').update(accountId.trim().toLowerCase(), 'utf8').digest('hex')
}

interface StoreFile {
  v: number
  updatedAt: number
  data: AnnotationsStore
}

export interface AnnotationsServiceOptions {
  /** `<userData>`; account-scoped stores and an isolated unbound store live under `annotations/`. */
  userDataDir: string
  /** Current WeChat account. Empty / `default` uses an isolated unbound store. */
  resolveAccountId?: () => string | null | undefined
  now?: () => number
  log?: (line: string) => void
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function emptyStore(): AnnotationsStore {
  return { tags: {}, tagIndex: {}, favorites: [], marks: [], savedSearches: [] }
}

/** tag → sessionId[]（从会话维度派生；排序稳定） */
function buildTagIndex(tags: Record<string, string[]>): Record<string, string[]> {
  const index: Record<string, string[]> = {}
  for (const [sessionId, list] of Object.entries(tags)) {
    for (const tag of list) {
      const bucket = index[tag]
      if (bucket) bucket.push(sessionId)
      else index[tag] = [sessionId]
    }
  }
  for (const bucket of Object.values(index)) bucket.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return index
}

function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * 消息时间统一成**秒**（契约口径），认两种来源。
 *
 * 渲染层给的是毫秒（`SearchHit.ts`，引擎那边 `doc.ts * 1000`），而 `formatTime` 导出时按秒
 * 再乘 1000 —— 两边口径不一致时，导出的收藏/标记日期会差 1000 倍（`2026-09-26` 变成
 * 公元五万多年，`toISOString` 甚至直接抛）。这里在入口统一：>= 1e11 一定是毫秒（秒到 1e11
 * 是公元 5138 年，消息时间不可能到那儿），除以 1000 即可。老库里已经存成毫秒的也一起修正。
 */
function toSeconds(value: number): number {
  return value >= 1e11 ? Math.floor(value / 1000) : value
}

function cleanName(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength)
}

/** 排序 + 去重：标签顺序稳定（否则每次 list 都像被重排过） */
function normalizeTags(tags: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = cleanName(raw, MAX_TAG_LENGTH)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return out
}

function safeNonnegativeInteger(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  const numeric = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
}

function normalizedDb(value: unknown): string {
  return String(value ?? '').trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase() || ''
}

function annotationKey(entry: Pick<AnnotationFavorite, 'sessionId' | 'localId' | 'messageId' | 'idKind' | 'db' | 'table' | 'ts'>): string {
  const ts = toSeconds(toInt(entry.ts, 0))
  if (entry.messageId && entry.idKind) {
    return JSON.stringify(['message', entry.sessionId, entry.idKind, entry.messageId, ts, normalizedDb(entry.db), String(entry.table || '').toLowerCase()])
  }
  return JSON.stringify(['legacy', entry.sessionId, entry.localId, ts])
}

function parseAnnotationIdentity(
  payload: Record<string, unknown>,
  options: { allowSessionFavorite?: boolean } = {},
): Omit<AnnotationFavorite, 'note' | 'at'> {
  const sessionId = String(payload.sessionId || '').trim()
  if (!sessionId) throw new Error('缺少 sessionId')
  const rawLocalId = payload.localId
  const localId = safeNonnegativeInteger(rawLocalId)
  const rawMessageId = String(payload.messageId ?? '').trim()
  const rawKind = String(payload.idKind ?? '').trim()
  if (rawKind && rawKind !== 'local' && rawKind !== 'server') throw new Error('idKind 必须是 local 或 server')
  const rawDb = String(payload.db ?? '').trim()
  const rawTable = String(payload.table ?? '').trim()
  const hasExactFields = Boolean(rawMessageId || rawKind || rawDb || rawTable)
  const hasRawLocalId = rawLocalId !== undefined && rawLocalId !== null && rawLocalId !== ''
  const rawLocalIdText = typeof rawLocalId === 'string' && /^\d+$/.test(rawLocalId.trim()) ? rawLocalId.trim() : ''
  if (hasRawLocalId && localId === null && !rawMessageId && !rawLocalIdText) {
    throw new Error('localId 超出安全整数范围；请使用 messageId 与 idKind 传递精确消息身份')
  }

  let messageId: string | undefined
  let idKind: 'local' | 'server' | undefined
  let storedLocalId = localId ?? 0
  if (hasExactFields) {
    idKind = (rawKind as 'local' | 'server') || (storedLocalId > 0 ? 'local' : 'server')
    messageId = rawMessageId || (localId !== null ? String(localId) : rawLocalIdText)
    if (!/^\d+$/.test(messageId) || messageId === '0') throw new Error('消息 ID 必须是非零十进制字符串')
    if (idKind === 'local') {
      const safeId = safeNonnegativeInteger(messageId)
      if (safeId !== null && safeId <= 0) throw new Error('local_id 无效')
      if (safeId !== null && storedLocalId > 0 && storedLocalId !== safeId) throw new Error('localId 与 messageId 不一致')
      // Preserve exact decimal text even if a legacy/local companion field was already rounded.
      storedLocalId = safeId ?? 0
      if (safeId !== null) messageId = String(safeId)
    } else {
      // Never round a server_id through Number().
      storedLocalId = 0
    }
  } else if (!storedLocalId && !options.allowSessionFavorite) {
    throw new Error('标记需要消息 ID')
  } else if (hasRawLocalId && localId === null) {
    throw new Error('localId 超出安全整数范围；请使用 messageId 与 idKind 传递精确消息身份')
  }

  const rawTs = payload.ts === undefined ? 0 : safeNonnegativeInteger(payload.ts)
  if (payload.ts !== undefined && rawTs === null) throw new Error('消息时间戳无效')
  return {
    sessionId,
    localId: storedLocalId,
    ...(messageId && idKind ? { messageId, idKind } : {}),
    ...(rawDb ? { db: rawDb } : {}),
    ...(rawTable ? { table: rawTable } : {}),
    ts: toSeconds(rawTs ?? 0),
  }
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  if (!/[",\r\n]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function sortFavorites(items: AnnotationFavorite[]): AnnotationFavorite[] {
  return [...items].sort((a, b) => b.at - a.at || b.ts - a.ts || annotationKey(a).localeCompare(annotationKey(b)))
}

function sortMarks(items: AnnotationMark[]): AnnotationMark[] {
  return [...items].sort((a, b) => b.at - a.at || b.ts - a.ts || annotationKey(a).localeCompare(annotationKey(b)))
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class AnnotationsService {
  private readonly options: Required<Pick<AnnotationsServiceOptions, 'userDataDir'>> & AnnotationsServiceOptions
  private store: AnnotationsStore = emptyStore()
  private loaded = false
  private dirty = false
  private lastError: string | undefined
  private activeAccountKey: string | null = null
  private activeAccountId: string | null = null
  private activeFilePath: string
  private readonly accountStates = new Map<string, { store: AnnotationsStore; loaded: boolean; dirty: boolean; lastError?: string }>()

  constructor(options: AnnotationsServiceOptions) {
    this.options = { ...options }
    this.activeFilePath = join(options.userDataDir, FILE_NAME)
  }

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private log(line: string): void {
    if (this.options.log) this.options.log(line)
    else console.log(`[annotations] ${line}`)
  }

  private resolveAccount(): string | null {
    try {
      return accountIdentity(this.options.resolveAccountId?.())
    } catch (error) {
      this.log(`无法读取当前账号标识，使用隔离的未绑定存储：${String((error as Error)?.message || error)}`)
      return null
    }
  }

  private pathForAccount(accountId: string | null): string {
    // Never expose the old global store before the user has selected an account.
    // The legacy file is read only by migrateLegacyForAccount for the first real owner.
    if (!accountId) return join(this.options.userDataDir, 'annotations', 'unbound.json')
    const hash = annotationsAccountHash(accountId)
    return join(this.options.userDataDir, 'annotations', 'accounts', `${hash}.json`)
  }

  /** Flush and switch the cached view before every public operation. */
  private activateAccount(): void {
    const accountId = this.resolveAccount()
    const nextKey = accountId ? `account:${annotationsAccountHash(accountId)}` : 'legacy-unscoped'
    if (this.activeAccountKey === nextKey) return

    if (this.activeAccountKey !== null) {
      if (this.dirty) this.flush()
      this.accountStates.set(this.activeAccountKey, {
        store: this.store,
        loaded: this.loaded,
        dirty: this.dirty,
        lastError: this.lastError,
      })
    }

    this.activeAccountKey = nextKey
    this.activeAccountId = accountId
    this.activeFilePath = this.pathForAccount(accountId)
    const cached = this.accountStates.get(nextKey)
    this.store = cached?.store ?? emptyStore()
    this.loaded = cached?.loaded ?? false
    this.dirty = cached?.dirty ?? false
    this.lastError = cached?.lastError
  }

  private get filePath(): string {
    return this.activeFilePath
  }

  /**
   * Legacy v1.2 builds stored a single global annotations.json. Assign it once to
   * the first real account that opens the upgraded app. The owner marker is written
   * before the account copy so a crash cannot let a second account claim the data;
   * the same owner can recover the copy from the retained legacy file on next run.
   */
  private migrateLegacyForAccount(accountId: string): AnnotationsStore | null {
    const legacyPath = join(this.options.userDataDir, FILE_NAME)
    const ownerPath = join(this.options.userDataDir, LEGACY_OWNER_FILE)
    const legacy = readJsonTolerant<StoreFile | AnnotationsStore>(legacyPath)
    if (legacy.missing || legacy.corrupt || !legacy.value) return null

    const ownerExists = existsSync(ownerPath)
    const ownerRead = readJsonTolerant<{ ownerHash?: string }>(ownerPath)
    const ownerHash = ownerRead.value?.ownerHash
    if (ownerRead.corrupt || (ownerExists && !/^[a-f0-9]{64}$/.test(String(ownerHash || '')))) {
      this.lastError = `旧标注归属标记无效${ownerRead.backedUpTo ? `，已备份到 ${ownerRead.backedUpTo}` : ''}；为防止账号间串数据，未迁移全局标注`
      return null
    }
    const hash = annotationsAccountHash(accountId)
    if (ownerHash && ownerHash !== hash) return null

    try {
      if (!ownerHash) writeJsonAtomic(ownerPath, { v: 1, ownerHash: hash, claimedAt: this.now }, { sync: true })
    } catch (error) {
      this.lastError = `无法固定旧标注的账号归属，未迁移：${String((error as Error)?.message || error)}`
      return null
    }
    const raw = (legacy.value as StoreFile).data ?? (legacy.value as unknown as AnnotationsStore)
    return this.normalizeStore(raw)
  }

  /** 首次访问时加载（惰性：没人用就不读磁盘） */
  private ensureLoaded(): void {
    this.activateAccount()
    if (this.loaded) return
    this.loaded = true
    if (this.activeAccountId && !existsSync(this.filePath)) {
      const migrated = this.migrateLegacyForAccount(this.activeAccountId)
      if (migrated) {
        this.store = migrated
        this.dirty = true
        const flushed = this.flush()
        if (!flushed.ok) this.lastError = flushed.error
        return
      }
    }
    const read = readJsonTolerant<StoreFile>(this.filePath)
    if (read.corrupt) {
      this.lastError = `标注文件损坏，已备份到 ${read.backedUpTo || '(备份失败)'}，已从空库起步`
      this.log(this.lastError)
      this.store = emptyStore()
      return
    }
    const file = read.value
    if (!file) {
      this.store = emptyStore()
      return
    }
    this.store = this.normalizeStore(file.data ?? (file as unknown as AnnotationsStore))
  }

  /** 落盘前把外部数据的形状收紧：坏字段不该把后续所有操作带崩 */
  private normalizeStore(raw: Partial<AnnotationsStore> | undefined): AnnotationsStore {
    const store = emptyStore()
    const tags = raw?.tags
    if (tags && typeof tags === 'object') {
      for (const [sessionId, list] of Object.entries(tags)) {
        const normalized = normalizeTags(list)
        if (sessionId && normalized.length > 0) store.tags[String(sessionId)] = normalized
      }
    }
    const seenFav = new Set<string>()
    for (const item of Array.isArray(raw?.favorites) ? raw!.favorites : []) {
      const sessionId = String(item?.sessionId || '').trim()
      let localId = safeNonnegativeInteger(item?.localId ?? 0)
      if (!sessionId) continue
      let messageId = cleanName(item?.messageId, 128) || undefined
      let idKind = item?.idKind === 'local' || item?.idKind === 'server' ? item.idKind : undefined
      if (messageId && !idKind) idKind = localId !== null && localId > 0 ? 'local' : 'server'
      if (localId === null) {
        if (!messageId || !idKind) {
          this.lastError ||= '标注包含超出安全整数范围的 localId，已跳过该条以免错误关联消息'
          continue
        }
        localId = 0
      }
      if (idKind === 'server' && !messageId && localId > 0) messageId = String(localId)
      if (idKind === 'server' && (!messageId || !/^\d+$/.test(messageId) || messageId === '0')) continue
      if (idKind === 'local' && messageId) {
        const exactLocalId = safeNonnegativeInteger(messageId)
        if (exactLocalId !== null && exactLocalId <= 0) continue
        if (exactLocalId !== null && localId > 0 && localId !== exactLocalId) continue
        if (exactLocalId === null && localId > 0) continue
        localId = exactLocalId ?? 0
        if (exactLocalId !== null) messageId = String(exactLocalId)
      }
      const entry: AnnotationFavorite = {
        sessionId,
        localId,
        ...(messageId && idKind ? { messageId, idKind } : {}),
        ...(typeof item?.db === 'string' && item.db.trim() ? { db: item.db.trim() } : {}),
        ...(typeof item?.table === 'string' && item.table.trim() ? { table: item.table.trim() } : {}),
        ts: toSeconds(toInt(item?.ts, 0)),
        ...(cleanName(item?.note, 500) ? { note: cleanName(item?.note, 500) } : {}),
        at: toInt(item?.at, this.now),
      }
      const key = annotationKey(entry)
      if (seenFav.has(key)) continue
      seenFav.add(key)
      store.favorites.push(entry)
    }
    const seenMark = new Set<string>()
    for (const item of Array.isArray(raw?.marks) ? raw!.marks : []) {
      const sessionId = String(item?.sessionId || '').trim()
      let localId = safeNonnegativeInteger(item?.localId ?? 0)
      if (!sessionId) continue
      let messageId = cleanName(item?.messageId, 128) || undefined
      let idKind = item?.idKind === 'local' || item?.idKind === 'server' ? item.idKind : undefined
      if (messageId && !idKind) idKind = localId !== null && localId > 0 ? 'local' : 'server'
      if (localId === null) {
        if (!messageId || !idKind) continue
        localId = 0
      }
      if (idKind === 'server' && !messageId && localId > 0) messageId = String(localId)
      if (idKind === 'server' && (!messageId || !/^\d+$/.test(messageId) || messageId === '0')) continue
      if (idKind === 'local' && messageId) {
        const exactLocalId = safeNonnegativeInteger(messageId)
        if (exactLocalId !== null && exactLocalId <= 0) continue
        if (exactLocalId !== null && localId > 0 && localId !== exactLocalId) continue
        if (exactLocalId === null && localId > 0) continue
        localId = exactLocalId ?? 0
        if (exactLocalId !== null) messageId = String(exactLocalId)
      }
      if (localId <= 0 && !messageId) continue
      const entry: AnnotationMark = {
        sessionId,
        localId,
        ...(messageId && idKind ? { messageId, idKind } : {}),
        ...(typeof item?.db === 'string' && item.db.trim() ? { db: item.db.trim() } : {}),
        ...(typeof item?.table === 'string' && item.table.trim() ? { table: item.table.trim() } : {}),
        ts: toSeconds(toInt(item?.ts, 0)),
        ...(cleanName(item?.note, 500) ? { note: cleanName(item?.note, 500) } : {}),
        at: toInt(item?.at, this.now),
      }
      const key = annotationKey(entry)
      if (seenMark.has(key)) continue
      seenMark.add(key)
      store.marks.push(entry)
    }
    const seenSearch = new Set<string>()
    for (const item of Array.isArray(raw?.savedSearches) ? raw!.savedSearches : []) {
      const id = String(item?.id || '').trim()
      if (!id || seenSearch.has(id)) continue
      seenSearch.add(id)
      store.savedSearches.push({
        id,
        name: cleanName(item?.name, MAX_NAME_LENGTH) || id,
        query: String(item?.query ?? ''),
        ...(item?.scope && typeof item.scope === 'object' ? { scope: item.scope as Record<string, unknown> } : {}),
        createdAt: toInt(item?.createdAt, this.now),
        ...(item?.lastRunAt !== undefined ? { lastRunAt: toInt(item.lastRunAt, 0) } : {}),
        ...(item?.lastCount !== undefined ? { lastCount: toInt(item.lastCount, 0) } : {}),
      })
    }
    store.favorites = sortFavorites(store.favorites)
    store.marks = sortMarks(store.marks)
    return store
  }

  /**
   * 只在真的改过之后写盘（读操作的幂等路径不该产生 IO）。
   *
   * 返回写盘结果而不是只记 `lastError`：调用方（`mutate` → IPC → 界面）必须知道"这次改动
   * 到底有没有落盘"。以前写盘失败只把原因塞进 `lastError`，`mutate` 照样回 `success:true` ——
   * 用户看到"已收藏"，重启后收藏没了，而且没有任何一处说过它没写成功。
   */
  private flush(): { ok: boolean; error?: string } {
    if (!this.dirty) return { ok: true }
    try {
      const file: StoreFile = { v: STORE_VERSION, updatedAt: this.now, data: this.store }
      writeJsonAtomic(this.filePath, file, { sync: true })
      this.dirty = false
      this.lastError = undefined
      return { ok: true }
    } catch (error) {
      this.lastError = `标注写入失败：${String((error as Error)?.message || error)}`
      console.error('[annotations]', this.lastError)
      return { ok: false, error: this.lastError }
    }
  }

  /** 对外快照（深拷贝：调用方改不坏内部状态） */
  list(): AnnotationsStore & { error?: string } {
    this.ensureLoaded()
    const snapshot: AnnotationsStore = {
      tags: {},
      tagIndex: {},
      favorites: this.store.favorites.map((item) => ({ ...item })),
      marks: this.store.marks.map((item) => ({ ...item })),
      savedSearches: this.store.savedSearches.map((item) => ({ ...item })),
    }
    for (const [sessionId, tags] of Object.entries(this.store.tags)) snapshot.tags[sessionId] = [...tags]
    snapshot.tagIndex = buildTagIndex(snapshot.tags)
    return this.lastError ? { ...snapshot, error: this.lastError } : snapshot
  }

  /** 变更（返回更新后的整份存储；op 不认识时 success:false 且不改数据） */
  mutate(mutation: AnnotationMutation): AnnotationMutateResult {
    this.ensureLoaded()
    const op = String(mutation?.op || '') as AnnotationOp
    const payload = (mutation?.payload || {}) as Record<string, unknown>
    try {
      switch (op) {
        case 'tag.add':
          this.applyTagAdd(payload)
          break
        case 'tag.remove':
          this.applyTagRemove(payload)
          break
        case 'fav.add':
          this.applyFavoriteAdd(payload)
          break
        case 'fav.remove':
          this.applyFavoriteRemove(payload)
          break
        case 'mark.add':
          this.applyMarkAdd(payload)
          break
        case 'mark.remove':
          this.applyMarkRemove(payload)
          break
        case 'search.save':
          this.applySearchSave(payload)
          break
        case 'search.remove':
          this.applySearchRemove(payload)
          break
        case 'search.rename':
          this.applySearchRename(payload)
          break
        default:
          return { ...this.list(), success: false, error: `未知操作：${String(mutation?.op || '')}` }
      }
      // 写盘失败必须如实回 unsuccessful：内存里的改动还在，但下次启动就没了
      const flushed = this.flush()
      if (!flushed.ok) return { ...this.list(), success: false, error: flushed.error }
      return { ...this.list(), success: true }
    } catch (error) {
      return { ...this.list(), success: false, error: String((error as Error)?.message || error) }
    }
  }

  // ---- 标签 ---------------------------------------------------------------

  /**
   * 打标签。payload:
   *   - `tag`: 标签名（必填）
   *   - `sessionIds`: 目标会话（可多个，批量打标）
   *   - `from`: **重命名**：把所有 `from` 标签替换成 `tag`（去重，不留旧名）
   */
  private applyTagAdd(payload: Record<string, unknown>): void {
    const tag = cleanName(payload.tag, MAX_TAG_LENGTH)
    if (!tag) throw new Error('缺少标签名')
    const from = cleanName(payload.from, MAX_TAG_LENGTH)
    const sessionIds = Array.isArray(payload.sessionIds)
      ? payload.sessionIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []

    if (from && from !== tag) {
      // 重命名：全量生效，不留旧名的引用（§6.3 验收）
      for (const [sessionId, tags] of Object.entries(this.store.tags)) {
        if (!tags.includes(from)) continue
        const next = normalizeTags(tags.map((item) => (item === from ? tag : item)))
        if (next.length > 0) this.store.tags[sessionId] = next
        else delete this.store.tags[sessionId]
        this.dirty = true
      }
      return
    }

    if (sessionIds.length === 0) throw new Error('缺少 sessionIds')
    for (const sessionId of sessionIds) {
      const current = this.store.tags[sessionId] || []
      if (current.includes(tag)) continue // 幂等：已有就是无操作
      this.store.tags[sessionId] = normalizeTags([...current, tag])
      this.dirty = true
    }
  }

  /** 移除标签：给 sessionIds 就从这些会话上摘掉，不给就全库摘掉（无残留引用） */
  private applyTagRemove(payload: Record<string, unknown>): void {
    const tag = cleanName(payload.tag, MAX_TAG_LENGTH)
    if (!tag) throw new Error('缺少标签名')
    const sessionIds = Array.isArray(payload.sessionIds)
      ? payload.sessionIds.map((id) => String(id || '').trim()).filter(Boolean)
      : null
    const targets = sessionIds ?? Object.keys(this.store.tags)
    for (const sessionId of targets) {
      const current = this.store.tags[sessionId]
      if (!current || !current.includes(tag)) continue
      const next = current.filter((item) => item !== tag)
      if (next.length > 0) this.store.tags[sessionId] = next
      else delete this.store.tags[sessionId]
      this.dirty = true
    }
  }

  // ---- 收藏 ---------------------------------------------------------------

  private applyFavoriteAdd(payload: Record<string, unknown>): void {
    const identity = parseAnnotationIdentity(payload, { allowSessionFavorite: true })
    const note = cleanName(payload.note, 500)
    const key = annotationKey(identity)
    const existing = this.store.favorites.find((item) => annotationKey(item) === key)
    if (existing) {
      // 幂等：已收藏就不动 `at`；只有显式给了新备注才更新备注
      if (note && existing.note !== note) {
        existing.note = note
        this.dirty = true
      }
      return
    }
    this.store.favorites = sortFavorites([
      ...this.store.favorites,
      { ...identity, ...(note ? { note } : {}), at: this.now },
    ])
    this.dirty = true
  }

  private applyFavoriteRemove(payload: Record<string, unknown>): void {
    const sessionId = String(payload.sessionId || '').trim()
    if (!sessionId) throw new Error('缺少 sessionId')
    const hasLocalId = payload.localId !== undefined && payload.localId !== null
    const exact = Boolean(payload.messageId || payload.idKind || payload.db || payload.table)
    let next: AnnotationFavorite[]
    if (exact) {
      const key = annotationKey(parseAnnotationIdentity(payload, { allowSessionFavorite: false }))
      next = this.store.favorites.filter((item) => !(item.sessionId === sessionId && annotationKey(item) === key))
    } else if (hasLocalId) {
      const localId = payload.localId === '' ? 0 : safeNonnegativeInteger(payload.localId)
      if (localId === null) throw new Error('localId 超出安全整数范围')
      next = this.store.favorites.filter((item) =>
        !(item.sessionId === sessionId && item.localId === localId && !item.messageId)
      )
    } else {
      next = this.store.favorites.filter((item) => item.sessionId !== sessionId)
    }
    if (next.length !== this.store.favorites.length) {
      this.store.favorites = next
      this.dirty = true
    }
  }

  // ---- 标记 ---------------------------------------------------------------

  private applyMarkAdd(payload: Record<string, unknown>): void {
    const identity = parseAnnotationIdentity(payload)
    const note = cleanName(payload.note, 500)
    const key = annotationKey(identity)
    const existing = this.store.marks.find((item) => annotationKey(item) === key)
    if (existing) {
      if (note && existing.note !== note) {
        existing.note = note
        this.dirty = true
      }
      return
    }
    this.store.marks = sortMarks([
      ...this.store.marks,
      { ...identity, ...(note ? { note } : {}), at: this.now },
    ])
    this.dirty = true
  }

  private applyMarkRemove(payload: Record<string, unknown>): void {
    const sessionId = String(payload.sessionId || '').trim()
    if (!sessionId) throw new Error('缺少 sessionId')
    const exact = Boolean(payload.messageId || payload.idKind || payload.db || payload.table)
    let next: AnnotationMark[]
    if (exact) {
      const key = annotationKey(parseAnnotationIdentity(payload))
      next = this.store.marks.filter((item) => !(item.sessionId === sessionId && annotationKey(item) === key))
    } else {
      const localId = safeNonnegativeInteger(payload.localId)
      if (localId === null) throw new Error('localId 超出安全整数范围')
      next = this.store.marks.filter((item) =>
        !(item.sessionId === sessionId && item.localId === localId && !item.messageId)
      )
    }
    if (next.length !== this.store.marks.length) {
      this.store.marks = next
      this.dirty = true
    }
  }

  // ---- 保存搜索 -----------------------------------------------------------

  /**
   * 保存/更新一条保存搜索。payload: `{ id?, name, query, scope?, lastRunAt?, lastCount? }`。
   * 带 `id` 时是"更新"（界面把最近一次运行结果写回来，用的还是同一个 op ——
   * 契约里的 op 集合是冻结的，不新增名字）。
   */
  private applySearchSave(payload: Record<string, unknown>): void {
    const name = cleanName(payload.name, MAX_NAME_LENGTH)
    const query = String(payload.query ?? '')
    if (!name) throw new Error('保存搜索需要名称')
    const scope = payload.scope && typeof payload.scope === 'object' ? (payload.scope as Record<string, unknown>) : undefined
    const id = String(payload.id || '').trim()
    const existing = id ? this.store.savedSearches.find((item) => item.id === id) : undefined
    const lastRunAt = payload.lastRunAt !== undefined ? toInt(payload.lastRunAt, 0) : undefined
    const lastCount = payload.lastCount !== undefined ? toInt(payload.lastCount, 0) : undefined

    if (existing) {
      existing.name = name
      existing.query = query
      if (scope) existing.scope = scope
      else delete existing.scope
      if (lastRunAt !== undefined) existing.lastRunAt = lastRunAt
      if (lastCount !== undefined) existing.lastCount = lastCount
      this.dirty = true
      return
    }
    const newId = id || `s${this.now.toString(36)}${this.store.savedSearches.length.toString(36)}`
    this.store.savedSearches.push({
      id: newId,
      name,
      query,
      ...(scope ? { scope } : {}),
      createdAt: this.now,
      ...(lastRunAt !== undefined ? { lastRunAt } : {}),
      ...(lastCount !== undefined ? { lastCount } : {}),
    })
    this.dirty = true
  }

  private applySearchRemove(payload: Record<string, unknown>): void {
    const id = String(payload.id || '').trim()
    if (!id) throw new Error('缺少 id')
    const next = this.store.savedSearches.filter((item) => item.id !== id)
    if (next.length !== this.store.savedSearches.length) {
      this.store.savedSearches = next
      this.dirty = true
    }
  }

  private applySearchRename(payload: Record<string, unknown>): void {
    const id = String(payload.id || '').trim()
    const name = cleanName(payload.name, MAX_NAME_LENGTH)
    if (!id || !name) throw new Error('重命名需要 id 与新名称')
    const item = this.store.savedSearches.find((entry) => entry.id === id)
    if (!item || item.name === name) return
    item.name = name
    this.dirty = true
  }

  // ---- 导出 ---------------------------------------------------------------

  /** 导出 json / csv / md。路径是文件路径；给目录时落到 `<dir>/annotations.<ext>` */
  export(format: 'json' | 'csv' | 'md', targetPath: string): AnnotationExportResult {
    this.ensureLoaded()
    const requested = String(targetPath || '').trim()
    if (!requested) return { success: false, error: '缺少导出路径' }
    let filePath = requested
    try {
      if (existsSync(requested) && statSync(requested).isDirectory()) {
        filePath = join(requested, `annotations.${format === 'md' ? 'md' : format}`)
      } else if (!extname(requested)) {
        filePath = `${requested}.${format === 'md' ? 'md' : format}`
      }
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const content = format === 'json' ? this.exportJson() : format === 'csv' ? this.exportCsv() : this.exportMarkdown()
      writeFileAtomic(filePath, content, { sync: true })
      return { success: true, path: filePath }
    } catch (error) {
      return { success: false, error: String((error as Error)?.message || error) }
    }
  }

  private exportJson(): string {
    const store = this.list()
    const payload = {
      v: STORE_VERSION,
      exportedAt: this.now,
      app: 'Weport',
      ...store,
    }
    return `${JSON.stringify(payload, null, 2)}\n`
  }

  private exportCsv(): string {
    const store = this.list()
    const header = ['kind', 'sessionId', 'localId', 'messageId', 'idKind', 'db', 'table', 'ts', 'tag', 'name', 'query', 'scope', 'note', 'at']
    const lines = [header.join(',')]
    const push = (values: Array<string | number>): void => {
      lines.push(values.map(csvCell).join(','))
    }
    for (const [sessionId, tags] of Object.entries(store.tags)) {
      for (const tag of tags) push(['tag', sessionId, '', '', '', '', '', '', tag, '', '', '', '', ''])
    }
    for (const item of store.favorites) {
      push(['favorite', item.sessionId, item.localId, item.messageId || '', item.idKind || '', item.db || '', item.table || '', item.ts, '', '', '', '', item.note || '', item.at])
    }
    for (const item of store.marks) {
      push(['mark', item.sessionId, item.localId, item.messageId || '', item.idKind || '', item.db || '', item.table || '', item.ts, '', '', '', '', item.note || '', item.at])
    }
    for (const item of store.savedSearches) {
      push([
        'savedSearch',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        item.name,
        item.query,
        item.scope ? JSON.stringify(item.scope) : '',
        '',
        item.lastRunAt || item.createdAt,
      ])
    }
    return `${lines.join('\r\n')}\r\n`
  }

  private exportMarkdown(): string {
    const store = this.list()
    const lines: string[] = []
    lines.push('# Weport 标注导出')
    lines.push('')
    lines.push(`导出时间：${new Date(this.now).toISOString()}`)
    lines.push('')
    lines.push(`## 标签（${Object.keys(store.tags).length} 个会话）`)
    lines.push('')
    const tagNames = [...new Set(Object.values(store.tags).flat())].sort()
    if (tagNames.length === 0) lines.push('_（无）_')
    for (const tag of tagNames) {
      const sessions = Object.entries(store.tags)
        .filter(([, tags]) => tags.includes(tag))
        .map(([sessionId]) => sessionId)
      lines.push(`- **${tag}**（${sessions.length}）：${sessions.join('、')}`)
    }
    lines.push('')
    lines.push(`## 收藏（${store.favorites.length}）`)
    lines.push('')
    lines.push('| 会话 | 消息 | 来源库/表 | 时间 | 备注 |')
    lines.push('|---|---|---|---|---|')
    for (const item of store.favorites) {
      lines.push(
        `| ${item.sessionId} | ${!item.localId && !item.messageId ? '(整会话)' : item.messageId || item.localId} | ${[item.db, item.table].filter(Boolean).join('/')} | ${formatTime(item.ts)} | ${item.note || ''} |`
      )
    }
    lines.push('')
    lines.push(`## 标记（${store.marks.length}）`)
    lines.push('')
    lines.push('| 会话 | 消息 | 来源库/表 | 时间 | 备注 |')
    lines.push('|---|---|---|---|---|')
    for (const item of store.marks) {
      lines.push(`| ${item.sessionId} | ${item.messageId || item.localId} | ${[item.db, item.table].filter(Boolean).join('/')} | ${formatTime(item.ts)} | ${item.note || ''} |`)
    }
    lines.push('')
    lines.push(`## 保存搜索（${store.savedSearches.length}）`)
    lines.push('')
    for (const item of store.savedSearches) {
      const scope = item.scope ? ` ｜ 条件：\`${JSON.stringify(item.scope)}\`` : ''
      const last = item.lastRunAt ? ` ｜ 上次：${formatTime(Math.floor(item.lastRunAt / 1000))}（${item.lastCount ?? 0} 条）` : ''
      lines.push(`- **${item.name}**：\`${item.query}\`${scope}${last}`)
    }
    lines.push('')
    return lines.join('\n')
  }

  /** 测试与诊断用：当前文件路径 */
  get storagePath(): string {
    this.activateAccount()
    return this.filePath
  }
}

function formatTime(seconds: number): string {
  if (!seconds) return ''
  try {
    return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19)
  } catch {
    return ''
  }
}

export const annotationsFileName = FILE_NAME
