import { basename, join } from 'path'
import { existsSync } from 'fs'
import {
  verifyHexKeyForPage,
  listDbFiles,
  readPage1,
  parsePastedKeyInput,
  keyFingerprint,
  saltHexOf,
  verifyPageKey,
  type DbFileEntry,
  type PageKeyMode,
  type Page1ReadResult,
} from './wcdbPageKey'

/**
 * 密钥健康面板的引擎侧（V12 §10.4）。
 *
 * ## 它解决的问题
 *
 * 旧实现只有一个结论：密钥对不对。可用多库/多账号时，这句话没有信息量 ——
 * 用户看到"密钥无效"，却不知道是 22 个库里的哪一个坏了、坏的是"密钥错"还是
 * "库换了"，更不知道下一步该做什么。这里把结论拆到**每库一行**：
 *
 * | 状态 | 含义 | 用户该做什么 |
 * |---|---|---|
 * | `ok` | 存在一把能过 page 1 HMAC 的密钥 | 无 |
 * | `stale` | 存过密钥，但库的 salt 已变（库被替换/换账号） | 重新扫描 |
 * | `invalid` | 有密钥、salt 也没变，但 HMAC 不过 | 重新获取 |
 * | `missing` | 库文件不在 | 检查数据目录 |
 * | `unknown` | 没有这个库的密钥可验 | 扫描一次 |
 *
 * ## 三条硬规则（都有单测钉着）
 *
 * 1. **合并写入**：保存一个库的密钥绝不碰其它库/其它账号的既有条目。
 * 2. **无效的不覆盖有效的**：`verified !== true` 的更新一律拒绝；粘贴的密钥先用
 *    page 1 HMAC 验证，验不过就不写盘。
 * 3. **日志里只有指纹**：任何层级（错误信息、状态行、诊断）都不出现完整密钥，
 *    落盘值一律是 `safe:` 加密形态（与 `config.ts` 的 `safeEncrypt` 同一套）。
 */

/** 密钥来源。 */
export type KeySource = 'scan' | 'hook' | 'manual' | 'config'

/** 每库状态。 */
export type DbKeyStatus = 'ok' | 'stale' | 'invalid' | 'missing' | 'unknown'

/** 落盘条目（`key` 是 `safe:` 加密形态）。 */
export interface StoredDbKey {
  key: string
  salt?: string | null
  source: KeySource
  verified: boolean
  at: number
  fingerprint: string
}

/** 一个账号的密钥集合。 */
export interface StoredAccountKeys {
  dbKeys: Record<string, StoredDbKey>
  /** 账号级口令（`safe:`）—— 来自 Hook/手动/历史配置，用来覆盖所有库。 */
  passphrase?: string
  passphraseSource?: KeySource
  updatedAt?: number
}

/** 磁盘结构。 */
export interface DbKeyStoreFile {
  version: 1
  accounts: Record<string, StoredAccountKeys>
}

export function emptyDbKeyStore(): DbKeyStoreFile {
  return { version: 1, accounts: {} }
}

/** 一行健康状态（返回给 UI；`fingerprint` 只有 `ab12…cd34`）。 */
export interface DbKeyHealthEntry {
  id: string
  kind: string
  path: string
  status: DbKeyStatus
  source: KeySource | null
  verifiedAt: number | null
  fingerprint: string | null
  salt: string | null
  mode: PageKeyMode | null
  /** 一句话解释（为什么不是 ok）。 */
  reason?: string
  /** 一行可执行动作（不含"请重试"）。 */
  action?: string
}

export interface DbKeyHealthReport {
  success: boolean
  accountRef: string | null
  entries: DbKeyHealthEntry[]
  /** 汇总计数，UI 顶部一行用。 */
  summary: { ok: number; stale: number; invalid: number; missing: number; unknown: number }
  /**
   * Read-only history connection readiness. `true` means the session database and
   * every message/biz-message shard currently on disk have a page-1-verified key.
   * Media and auxiliary databases are reported separately because they do not
   * determine whether complete text history can be read.
   */
  connectionReady?: boolean
  connectionCoverage?: {
    required: number
    ready: number
    missing: string[]
    invalid: string[]
    mediaRequired: number
    mediaReady: number
  }
  /**
   * 前置条件自检里**没过**的项（微信没开 / 没提权 / 库被占用 …），每条自带一行动作。
   * §10.4 要的就是"把前置条件和下一步一起报出来"；以前这块永远是空的。
   */
  blockers?: Array<{ id: string; message: string; actionable: string }>
  error?: string
}

/** 加密编解码。生产用 `config.ts` 的 safeStorage 实现；单测注入内存实现。 */
export interface SecretCodec {
  available(): boolean
  /** 必须返回 `safe:` 前缀；拿不到系统密钥库时抛错（绝不落明文）。 */
  encrypt(plain: string): string
  decrypt(stored: string): string
}

/** 持久化后端。生产写 `Weport-config.json` 的 `dbKeyStore` 字段。 */
export interface DbKeyStorePersistence {
  read(): DbKeyStoreFile
  write(next: DbKeyStoreFile): void
}

export interface VerifiedDbKeyMaterial {
  id: string
  /** Raw SQLCipher page key, returned only for the immediate connection operation. */
  keyHex: string
}

/**
 * 「这个库的密钥是好的」判定结果记忆（只记命中）。
 *
 * 键 = 库路径 | page1 的 salt | 存的那把密钥的指纹。三个输入里任何一个变了（库被替换、
 * 密钥被换过/重新扫描过）键就变，缓存自动失效。
 *
 * 上限随手给的：键数不超过"库数 × 3"，多出来的按插入顺序淘汰最老的 —— 这个进程里库的数量
 * 是有上限的（几十），给 512 足够，又不至于在多账号来回切时无限长。
 */
const verdictCache = new Map<string, PageKeyMode>()

function rememberVerdict(key: string, mode: PageKeyMode | null): void {
  if (!mode) return
  if (verdictCache.size >= 512) {
    const oldest = verdictCache.keys().next().value
    if (typeof oldest === 'string') verdictCache.delete(oldest)
  }
  verdictCache.set(key, mode)
}

export interface KeyHealthDeps {
  codec: SecretCodec
  store: DbKeyStorePersistence
  listDbs: (dbStorageDir: string) => DbFileEntry[]
  readPage1: (path: string) => Page1ReadResult
  now: () => number
  /** 解析账号目录；生产走 ConfigService.getAccountDir。 */
  resolveAccountDir?: () => string | null
  /** 重新扫描（生产走 keyScanService 的免登录扫描）。 */
  rescanKeys?: (accountDir: string) => Promise<ScanResultLike>
  /**
   * 自检（生产走 keyPrerequisite + 平台 driver）：返回**没过的那几项**。
   *
   * 为什么挂在健康报告上：§10.4 的"把前置条件和下一步一起报出来"是这块面板的职责。以前
   * `toKeyHealthReport` 直接写死 `blockers: []`，于是"微信没开 / 没提权 / 库被占用"这些
   * 自检结果**永远到不了界面** —— 用户只看到一堆 `unknown`，看不到"该做什么"。
   * 这里只取失败的项，通过的项不占界面。
   */
  prereqFailures?: () => Promise<Array<{ id: string; message: string; actionable: string }>>
}

/** 扫描结果的**结构子集**（避免这个模块静态依赖 keyScanService/koffi）。 */
export interface ScanResultLike {
  success: boolean
  keys: Array<{ id: string; kind: string; path: string; keyHex: string; saltHex: string | null; mode: PageKeyMode; fingerprint: string }>
  error?: string
}

// === 纯逻辑：状态判定 ===

/** 判定一个"密钥候选"对某库是否有效（UI 与测试都用这一处）。 */
export function checkCandidate(
  page1: Buffer,
  key32: Buffer,
  modes: PageKeyMode[] = ['raw', 'passphrase']
): { ok: boolean; mode: PageKeyMode | null } {
  const verdict = verifyPageKey(page1, key32, modes)
  return { ok: verdict.mode !== null, mode: verdict.mode }
}

/** 账号目录下是否有可用的库文件（自检第 9 项 / 扫描前置）。 */
export function hasDbStorageFiles(accountDir: string): boolean {
  const dir = join(String(accountDir || ''), 'db_storage')
  try {
    return listDbFiles(dir, { maxFiles: 1, allowTruncated: true }).length > 0
  } catch {
    return false
  }
}

/**
 * 用页 1 HMAC 校验一把"账号级密钥"能不能解开该账号的库（K6/K7）。
 *
 * 两种形态都试：口令（4.1.10+ 的 password mode）与 raw（老版本）。命中任一个库
 * 即算有效，但会把"检查了几个、匹配了几个"一起报出去 —— 用户看到"密钥不匹配"
 * 时有具体数字可比。
 */
export function validateAccountKeyAgainstDbs(
  accountDir: string,
  keyHex: string
): { valid: boolean; checked: number; matched: number; dbs: string[]; error?: string } {
  const result = { valid: false, checked: 0, matched: 0, dbs: [] as string[] }
  const normalized = String(keyHex || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) return result
  const dir = join(String(accountDir || ''), 'db_storage')
  let dbs: DbFileEntry[] = []
  try {
    dbs = listDbFiles(dir)
  } catch (error) {
    return { ...result, error: String((error as Error)?.message || error) }
  }
  for (const db of dbs) {
    const loaded = readPage1(db.path)
    if (!loaded.ok || !loaded.page1) continue
    result.checked++
    // 先试 raw（便宜），再试 SQLCipher 口令文本（每次约 100 ms 的 PBKDF2）。
    if (verifyHexKeyForPage(loaded.page1, normalized)) {
      result.matched++
      result.valid = true
      result.dbs.push(db.id)
    }
  }
  return result
}

// === 合并写入 ===

export interface DbKeyUpdate {
  dbKeyId: string
  keyHex: string
  saltHex?: string | null
  source: KeySource
  /** 必须为 true（调用方已用 page 1 HMAC 验证过）才会写入。 */
  verified: boolean
  mode?: PageKeyMode | null
  at?: number
}

export interface MergeDbKeyResult {
  next: DbKeyStoreFile
  applied: string[]
  unchanged: string[]
  rejected: Array<{ dbKeyId: string; reason: string }>
}

/**
 * **合并写入**：只动 `updates` 里点名的库，其它账号/其它库原样保留。
 *
 * 拒绝规则（顺序即优先级）：
 * 1. 未验证的更新 —— 拒绝（"无效密钥绝不覆盖有效密钥"的落点）；
 * 2. 与现有条目完全相同的已验证密钥 —— 记 `unchanged`（不写盘、不刷新时间戳，
 *    这样"重新扫描"不会把 `verifiedAt` 变成噪声）；
 * 3. 其余情况替换该库条目，值走 `encrypt`（`safe:`）。
 */
export function mergeDbKeyUpdates(
  store: DbKeyStoreFile,
  accountRef: string,
  updates: DbKeyUpdate[],
  encrypt: (plain: string) => string,
  now: number
): MergeDbKeyResult {
  const next: DbKeyStoreFile = {
    version: 1,
    accounts: { ...store.accounts },
  }
  const current = store.accounts[accountRef]
  const account: StoredAccountKeys = {
    dbKeys: { ...(current?.dbKeys ?? {}) },
    passphrase: current?.passphrase,
    passphraseSource: current?.passphraseSource,
    updatedAt: current?.updatedAt,
  }
  const result: MergeDbKeyResult = { next, applied: [], unchanged: [], rejected: [] }

  for (const update of updates) {
    if (!update.dbKeyId || !/^[0-9a-f]{64}$/i.test(update.keyHex || '')) {
      result.rejected.push({ dbKeyId: update.dbKeyId || '(unknown)', reason: 'ignored' })
      continue
    }
    if (!update.verified) {
      result.rejected.push({ dbKeyId: update.dbKeyId, reason: 'unverified' })
      continue
    }
    const existing = account.dbKeys[update.dbKeyId]
    if (existing && existing.verified) {
      const existingPlain = existing.key
      if (existingPlain === update.keyHex || existingPlain === `safe:${update.keyHex}`) {
        result.unchanged.push(update.dbKeyId)
        continue
      }
      // 已验证 → 已验证（例如重新扫描拿到新密钥）：允许替换，但保留其它库
      if (existing.fingerprint === keyFingerprint(update.keyHex) && existing.salt === (update.saltHex ?? null)) {
        result.unchanged.push(update.dbKeyId)
        continue
      }
    }
    account.dbKeys[update.dbKeyId] = {
      key: encrypt(update.keyHex),
      salt: update.saltHex ?? null,
      source: update.source,
      verified: true,
      at: update.at ?? now,
      fingerprint: keyFingerprint(update.keyHex),
    }
    result.applied.push(update.dbKeyId)
  }

  account.updatedAt = now
  next.accounts[accountRef] = account
  return result
}

/** 设置账号级口令（同为 `safe:` 形态；不碰任何 per-DB 条目）。 */
export function mergeAccountPassphrase(
  store: DbKeyStoreFile,
  accountRef: string,
  passphraseHex: string,
  source: KeySource,
  encrypt: (plain: string) => string,
  now: number
): DbKeyStoreFile {
  const next: DbKeyStoreFile = { version: 1, accounts: { ...store.accounts } }
  const current = store.accounts[accountRef]
  next.accounts[accountRef] = {
    dbKeys: { ...(current?.dbKeys ?? {}) },
    passphrase: encrypt(passphraseHex),
    passphraseSource: source,
    updatedAt: now,
  }
  return next
}

/** 清除某些库的密钥（`clear` IPC）：只删点名的 key，**保留**账号级口令与其它库。 */
export function clearDbKeys(store: DbKeyStoreFile, accountRef: string, dbKeyIds: string[], now: number): DbKeyStoreFile {
  const next: DbKeyStoreFile = { version: 1, accounts: { ...store.accounts } }
  const current = store.accounts[accountRef]
  if (!current) return next
  const dbKeys = { ...current.dbKeys }
  for (const id of dbKeyIds) delete dbKeys[id]
  next.accounts[accountRef] = { ...current, dbKeys, updatedAt: now }
  return next
}

// === 服务 ===

/** 默认编解码：与 `config.ts` 的 `safeEncrypt` 同一套（`safe:` + safeStorage）。 */
export function createElectronCodec(): SecretCodec {
  const load = (): any => {
    // 惰性 require：单测（node 环境）不会因为加载这个模块而拉进 Electron。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cfg = require('./config')
    return cfg
  }
  return {
    available: () => {
      try {
        return load().isSecretEncryptionAvailable() === true
      } catch {
        return false
      }
    },
    encrypt: (plain: string) => {
      const mod = load()
      const value = mod.encryptSecret(plain)
      if (!value || !String(value).startsWith('safe:')) {
        throw new Error('系统密钥库不可用，拒绝以明文保存密钥')
      }
      return String(value)
    },
    decrypt: (stored: string) => {
      try {
        return load().decryptSecret(stored) as string
      } catch {
        return ''
      }
    },
  }
}

/** 默认持久化：`Weport-config.json` 的 `dbKeyStore` 字段（与老用户密钥同文件）。 */
export function createConfigStorePersistence(): DbKeyStorePersistence {
  const load = (): any => require('./config')
  return {
    read: () => {
      try {
        const raw = load().ConfigService.getInstance().get('dbKeyStore')
        if (!raw || typeof raw !== 'object') return emptyDbKeyStore()
        const file = raw as DbKeyStoreFile
        if (!file.accounts || typeof file.accounts !== 'object') return emptyDbKeyStore()
        return { version: 1, accounts: file.accounts }
      } catch {
        return emptyDbKeyStore()
      }
    },
    write: (next: DbKeyStoreFile) => {
      load().ConfigService.getInstance().set('dbKeyStore', next)
    },
  }
}

export interface KeyHealthServiceOptions {
  deps?: Partial<KeyHealthDeps>
}

/**
 * 健康面板的服务层：读库 → 判状态 → 合并写入。
 *
 * 所有 IO 都能注入，所以单测能覆盖"错密钥不覆盖好密钥""库换了报 stale"这些规则，
 * 而不需要真微信库。
 */
export class KeyHealthService {
  private deps: KeyHealthDeps

  constructor(options: KeyHealthServiceOptions = {}) {
    this.deps = {
      codec: createElectronCodec(),
      store: createConfigStorePersistence(),
      listDbs: (dir) => listDbFiles(dir),
      readPage1: (p) => readPage1(p),
      now: () => Date.now(),
      ...options.deps,
    }
  }

  private accountRef(accountDir: string): string {
    return basename(accountDir) || accountDir
  }

  private dbStorageDir(accountDir: string): string | null {
    try {
      if (basename(accountDir).toLowerCase() === 'db_storage' && existsSync(accountDir)) return accountDir
    } catch { /* noop */ }
    const dir = join(String(accountDir || ''), 'db_storage')
    // 目录不存在时返回 null（而不是"一个不存在的路径"）：否则调用方会拿到
    // success: true + 空列表，看起来像"这个账号没有库"，其实是没找对地方。
    try {
      return existsSync(dir) ? dir : null
    } catch {
      return null
    }
  }

  /** 逐库状态（`keyHealth:get`）。 */
  async getHealth(accountDirOverride?: string): Promise<DbKeyHealthReport> {
    const accountDir = String(accountDirOverride || this.deps.resolveAccountDir?.() || '').trim()
    if (!accountDir) {
      return {
        success: false,
        accountRef: null,
        entries: [],
        summary: { ok: 0, stale: 0, invalid: 0, missing: 0, unknown: 0 },
        connectionReady: false,
        connectionCoverage: { required: 0, ready: 0, missing: [], invalid: [], mediaRequired: 0, mediaReady: 0 },
        error: '还没有选择微信数据目录，无法检查密钥健康状态。',
      }
    }
    const dbStorage = this.dbStorageDir(accountDir)
    if (!dbStorage) {
      return {
        success: false,
        accountRef: this.accountRef(accountDir),
        entries: [],
        summary: { ok: 0, stale: 0, invalid: 0, missing: 0, unknown: 0 },
        connectionReady: false,
        connectionCoverage: { required: 0, ready: 0, missing: [], invalid: [], mediaRequired: 0, mediaReady: 0 },
        error: '数据目录里找不到 db_storage。',
      }
    }
    const accountRef = this.accountRef(accountDir)
    const store = this.deps.store.read()
    const account = store.accounts[accountRef]
    let dbs: DbFileEntry[]
    try {
      dbs = this.deps.listDbs(dbStorage)
    } catch (error) {
      return {
        success: false,
        accountRef,
        entries: [],
        summary: { ok: 0, stale: 0, invalid: 0, missing: 0, unknown: 0 },
        connectionReady: false,
        connectionCoverage: { required: 0, ready: 0, missing: [], invalid: [], mediaRequired: 0, mediaReady: 0 },
        blockers: await this.prereqFailures(),
        error: String((error as Error)?.message || error),
      }
    }
    const entries = dbs.map((db) => this.evaluateOne(db, account))
    const summary = { ok: 0, stale: 0, invalid: 0, missing: 0, unknown: 0 }
    for (const entry of entries) summary[entry.status]++
    const required = dbs.filter((db) =>
      db.kind === 'session' || db.kind.startsWith('message') || db.kind.startsWith('biz_message')
    )
    const hasSessionDb = required.some((db) =>
      db.kind === 'session' && /(^|\/)session\.db$/i.test(db.id.replace(/\\/g, '/'))
    )
    const media = dbs.filter((db) => db.kind.startsWith('media'))
    const healthById = new Map(entries.map((entry) => [entry.id, entry]))
    const missing = required.filter((db) => !healthById.get(db.id) || healthById.get(db.id)?.status === 'unknown')
      .map((db) => db.id)
    const invalid = required.filter((db) => ['invalid', 'stale', 'missing'].includes(healthById.get(db.id)?.status || ''))
      .map((db) => db.id)
    if (!hasSessionDb) missing.push('session/session.db')
    const requiredCount = required.length + (hasSessionDb ? 0 : 1)
    const ready = requiredCount - missing.length - invalid.length
    const hasMessageShards = required.some((db) => db.kind.startsWith('message') || db.kind.startsWith('biz_message'))
    const mediaReady = media.filter((db) => healthById.get(db.id)?.status === 'ok').length
    return {
      success: true,
      accountRef,
      entries,
      summary,
      connectionReady: hasSessionDb && hasMessageShards && ready === requiredCount,
      connectionCoverage: { required: requiredCount, ready, missing, invalid, mediaRequired: media.length, mediaReady },
      blockers: await this.prereqFailures(),
    }
  }

  /**
   * Return only per-DB keys that still pass page-1 HMAC against the current files.
   * This is an immediate connection payload: callers must not persist or log it.
   * Keys are normalized to raw encKey bytes even when a stored entry was entered
   * in passphrase form, so the mirror implementation has one unambiguous input.
   */
  getVerifiedDbKeyMaterial(accountDirOverride?: string): {
    success: boolean
    keys: VerifiedDbKeyMaterial[]
    missing: string[]
    invalid: string[]
    error?: string
  } {
    const accountDir = String(accountDirOverride || this.deps.resolveAccountDir?.() || '').trim()
    if (!accountDir) return { success: false, keys: [], missing: [], invalid: [], error: '还没有选择微信数据目录。' }
    const dbStorage = this.dbStorageDir(accountDir)
    if (!dbStorage) return { success: false, keys: [], missing: [], invalid: [], error: '数据目录里找不到 db_storage。' }
    const accountRef = this.accountRef(accountDir)
    const stored = this.deps.store.read().accounts[accountRef]
    const keys: VerifiedDbKeyMaterial[] = []
    const missing: string[] = []
    const invalid: string[] = []
    let dbs: DbFileEntry[]
    try {
      dbs = this.deps.listDbs(dbStorage)
    } catch (error) {
      return { success: false, keys: [], missing: [], invalid: [], error: String((error as Error)?.message || error) }
    }
    for (const db of dbs) {
      const loaded = this.deps.readPage1(db.path)
      if (!loaded.ok || !loaded.page1) {
        invalid.push(db.id)
        continue
      }
      const entry = stored?.dbKeys?.[db.id]
      // Match getHealth: an account passphrase may cover a DB without a per-DB entry.
      // Every returned page key is still authenticated against that database's current page.
      const storedSecret = entry?.key || stored?.passphrase
      if (!storedSecret) {
        missing.push(db.id)
        continue
      }
      const secret = storedSecret.startsWith('safe:') ? this.deps.codec.decrypt(storedSecret) : storedSecret
      const verified = verifyHexKeyForPage(loaded.page1, secret)
      if (!verified) {
        invalid.push(db.id)
        continue
      }
      keys.push({ id: db.id, keyHex: verified.pageKey.toString('hex') })
    }
    return { success: keys.length > 0, keys, missing, invalid }
  }

  /** 自检失败项。拿不到就当"没有额外前置条件"，但**不静默**：自检本身抛错时留下一条可见的说明。 */
  private async prereqFailures(): Promise<Array<{ id: string; message: string; actionable: string }>> {
    const probe = this.deps.prereqFailures
    if (!probe) return []
    try {
      return await probe()
    } catch (error) {
      return [
        {
          id: 'prereq-check-failed',
          message: `前置条件自检没有跑完：${String(error)}`,
          actionable: '打开诊断页看完整日志；这一步失败不会影响已保存的密钥。',
        },
      ]
    }
  }

  private evaluateOne(db: DbFileEntry, account: StoredAccountKeys | undefined): DbKeyHealthEntry {
    const loaded = this.deps.readPage1(db.path)
    const stored = account?.dbKeys?.[db.id] ?? null
    const now = this.deps.now()
    const base: DbKeyHealthEntry = {
      id: db.id,
      kind: db.kind,
      path: db.path,
      status: 'unknown',
      source: stored ? stored.source : null,
      verifiedAt: stored ? stored.at : null,
      fingerprint: stored ? stored.fingerprint : null,
      salt: loaded.ok && loaded.page1 ? saltHexOf(loaded.page1) : null,
      mode: null,
    }
    if (!loaded.ok || !loaded.page1) {
      return { ...base, status: 'missing', reason: loaded.message || '数据库文件读不到首页。' }
    }
    const page1 = loaded.page1
    const currentSalt = saltHexOf(page1)

    // ① 该库自己的 per-DB 密钥
    if (stored && stored.key) {
      /**
       * 判定记忆：`passphrase` 形态要跑 PBKDF2-HMAC-SHA512 256000 轮（本机 ~98 ms/库），
       * 22 个库就是两秒，而面板每次打开/刷新都会重算一遍（实测 `keyHealth:get` 1.6~1.9 秒，
       * 引擎事件循环整段被堵住）。键里带 page1 的 salt 与存的那把密钥的指纹：库换了或密钥换了，
       * 键就变、缓存自动失效；同一次面板会话里反复刷新则命中缓存。
       *
       * **只记命中**：没命中的库要继续走下面的 salt 比对与"读不出来"分支（都很便宜），
       * 把"没命中"也缓存掉会让"密钥刚被粘贴"这种状态在面板里迟迟不刷新。
       */
      const cacheKey = `${db.path}|${currentSalt}|${stored.fingerprint || ''}`
      const cached = verdictCache.get(cacheKey)
      if (cached) {
        return { ...base, status: 'ok', mode: cached, verifiedAt: stored.at }
      }
      const plain = stored.key.startsWith('safe:') ? this.deps.codec.decrypt(stored.key) : stored.key
      if (plain && /^[0-9a-f]{64}$/i.test(plain)) {
        const verdict = verifyHexKeyForPage(page1, plain)
        if (verdict) {
          rememberVerdict(cacheKey, verdict.mode)
          return { ...base, status: 'ok', mode: verdict.mode, verifiedAt: stored.at }
        }
        if (stored.salt && stored.salt !== currentSalt) {
          return {
            ...base,
            status: 'stale',
            reason: '库里记录的 salt 与文件当前 salt 不同（这个库被替换或换过账号）。',
            action: '点「重新扫描」重新取一次该库的密钥。',
          }
        }
        return {
          ...base,
          status: 'invalid',
          reason: '保存的密钥过不了该库首页的 HMAC 校验。',
          action: '点「重新扫描」重新获取；也可以把正确的密钥粘贴到这一行。',
        }
      }
      return {
        ...base,
        status: 'invalid',
        reason: '保存的密钥读不出来（系统密钥库变了或条目损坏）。',
        action: '点「重新扫描」重新获取该库密钥。',
      }
    }

    // ② 账号级密钥（配置里的 decryptKey）：口令模式下它能覆盖所有库
    if (account?.passphrase) {
      // 同样的记忆（键前缀区分来源）：没有 per-DB 密钥的库每个都要试一次账号口令，而口令形态
      // 一次就是 ~98ms 的 PBKDF2 —— 22 个库里若有十来个没存 per-DB 密钥，光这一段就是一秒。
      const accountCacheKey = `account|${db.path}|${currentSalt}|${account.updatedAt ?? 0}`
      const cachedAccount = verdictCache.get(accountCacheKey)
      if (cachedAccount) {
        return {
          ...base,
          status: 'ok',
          source: account.passphraseSource ?? 'config',
          mode: cachedAccount,
          verifiedAt: account.updatedAt ?? null,
        }
      }
      const plain = this.deps.codec.decrypt(account.passphrase)
      if (plain && /^[0-9a-f]{64}$/i.test(plain)) {
        const verdict = verifyHexKeyForPage(page1, plain)
        if (verdict) {
          rememberVerdict(accountCacheKey, verdict.mode)
          return {
            ...base,
            status: 'ok',
            source: account.passphraseSource ?? 'config',
            mode: verdict.mode,
            fingerprint: keyFingerprint(plain),
            verifiedAt: account.updatedAt ?? null,
          }
        }
      }
    }

    return {
      ...base,
      status: 'unknown',
      reason: '这个库还没有保存过密钥。',
      action: '点「重新扫描」取一次；微信只把当前打开的库的密钥放在内存里，所以有些库可能要等它被用过之后才扫得到。',
      source: null,
      fingerprint: null,
      verifiedAt: null,
      salt: currentSalt,
    }
  }

  /** 一键重新扫描（`keyHealth:rescan`）：扫描 + 合并写入，然后返回最新状态。 */
  async rescan(accountDirOverride?: string): Promise<DbKeyHealthReport & { scan?: { keys: number; failed?: string } }> {
    const accountDir = String(accountDirOverride || this.deps.resolveAccountDir?.() || '').trim()
    if (!accountDir) {
      const report = await this.getHealth(accountDirOverride)
      return { ...report, scan: { keys: 0, failed: '没有数据目录' } }
    }
    if (!this.deps.rescanKeys) {
      const report = await this.getHealth(accountDir)
      return { ...report, scan: { keys: 0, failed: '当前平台不支持免登录扫描' } }
    }
    let scanResult: ScanResultLike
    try {
      scanResult = await this.deps.rescanKeys(accountDir)
    } catch (e) {
      const report = await this.getHealth(accountDir)
      return { ...report, scan: { keys: 0, failed: e instanceof Error ? e.message : String(e) } }
    }
    if (scanResult.keys.length > 0) {
      const accountRef = this.accountRef(accountDir)
      const store = this.deps.store.read()
      const updates: DbKeyUpdate[] = scanResult.keys.map((k) => ({
        dbKeyId: k.id,
        keyHex: k.keyHex,
        saltHex: k.saltHex,
        source: 'scan',
        verified: true,
      }))
      const merged = mergeDbKeyUpdates(store, accountRef, updates, (plain) => this.deps.codec.encrypt(plain), this.deps.now())
      this.deps.store.write(merged.next)
    }
    const report = await this.getHealth(accountDir)
    return { ...report, scan: { keys: scanResult.keys.length, failed: scanResult.success ? undefined : scanResult.error } }
  }

  /**
   * 手动粘贴（`keyHealth:paste`）。
   *
   * 四种语法由 {@link parsePastedKeyInput} 归一化；**先验证再落盘**：
   * 对目标库（不给则对全部库）跑 page 1 HMAC，验不过就返回 rejected 且**不写盘**。
   */
  async paste(args: {
    accountDir?: string
    dbKeyId?: string
    text: string
  }): Promise<{ success: boolean; applied?: string[]; rejected?: string[]; error?: string; syntax?: string; fingerprint?: string }> {
    const parsed = parsePastedKeyInput(args.text)
    if (!parsed.ok) return { success: false, error: parsed.message }
    const accountDir = String(args.accountDir || this.deps.resolveAccountDir?.() || '').trim()
    if (!accountDir) return { success: false, error: '还没有选择微信数据目录。' }
    const dbStorage = this.dbStorageDir(accountDir)
    if (!dbStorage) return { success: false, error: '数据目录里找不到 db_storage。' }
    const dbs = this.deps.listDbs(dbStorage)
    // 面板传的是**种类**（`message_0`，那行上显示的东西），库 id 是 `message/message_0.db`。
    // 以前两边直接比字符串 → 单行粘贴永远"没有找到要写入的数据库行"，单行清除则删不掉
    // 任何东西却回 success。两种形态都认。
    const targets = args.dbKeyId ? dbs.filter((d) => d.id === args.dbKeyId || d.kind === args.dbKeyId) : dbs
    if (targets.length === 0) return { success: false, error: '没有找到要写入的数据库行。' }

    const verified: DbKeyUpdate[] = []
    const rejected: string[] = []
    for (const db of targets) {
      const loaded = this.deps.readPage1(db.path)
      if (!loaded.ok || !loaded.page1) {
        rejected.push(`${db.id}：${loaded.message || '读不到首页'}`)
        continue
      }
      const verdict = verifyHexKeyForPage(loaded.page1, parsed.keyHex)
      if (!verdict) {
        rejected.push(`${db.id}：密钥与这个库不匹配（page 1 HMAC 不过）`)
        continue
      }
      verified.push({
        dbKeyId: db.id,
        keyHex: parsed.keyHex,
        saltHex: parsed.saltHex ?? saltHexOf(loaded.page1),
        source: 'manual',
        verified: true,
        mode: verdict.mode,
      })
    }

    if (verified.length === 0) {
      // 关键：一条都没验过 → 一个字节都不写。这是"无效密钥绝不覆盖有效密钥"的落点。
      return { success: false, rejected, error: '粘贴的密钥没有通过任何数据库的校验，已保持原样未写入。', syntax: parsed.syntax }
    }

    const accountRef = this.accountRef(accountDir)
    const store = this.deps.store.read()
    const merged = mergeDbKeyUpdates(store, accountRef, verified, (plain) => this.deps.codec.encrypt(plain), this.deps.now())
    this.deps.store.write(merged.next)
    return { success: true, applied: merged.applied, rejected, syntax: parsed.syntax, fingerprint: keyFingerprint(parsed.keyHex) }
  }

  /** 清除（`keyHealth:clear`）：只删点名的库，账号级口令与其它库不动。 */
  async clear(args: { accountDir?: string; dbKeyId?: string }): Promise<{ success: boolean; removed: string[]; error?: string }> {
    const accountDir = String(args.accountDir || this.deps.resolveAccountDir?.() || '').trim()
    if (!accountDir) return { success: false, removed: [], error: '还没有选择微信数据目录。' }
    const accountRef = this.accountRef(accountDir)
    const store = this.deps.store.read()
    // 不点名 = 清掉这个账号的所有库密钥（面板的"全部清除"走这条路）。
    // 点名时把"种类"也认了：存储键是 `message/message_0.db`，面板给的是 `message_0`。
    const storedIds = Object.keys(store.accounts[accountRef]?.dbKeys ?? {})
    const ids = args.dbKeyId
      ? storedIds.filter((id) => id === args.dbKeyId || id.replace(/\\/g, '/').endsWith(`/${args.dbKeyId}.db`))
      : storedIds
    if (ids.length === 0) {
      return {
        success: false,
        removed: [],
        error: args.dbKeyId ? `这个账号的密钥库里没有 ${args.dbKeyId} 这一行。` : undefined,
      }
    }
    const next = clearDbKeys(store, accountRef, ids, this.deps.now())
    this.deps.store.write(next)
    return { success: true, removed: ids }
  }

  /**
   * 把一次扫描的结果并入密钥库（合并写入）。
   *
   * 与 {@link paste} 的区别：扫描结果在 `keyScanService` 里**已经是**逐库 page 1 HMAC
   * 校验过的，所以这里直接以 `verified: true` 合并；粘贴路径才需要现场验证。
   */
  mergeScannedKeys(
    accountDir: string,
    keys: Array<{ id: string; keyHex: string; saltHex: string | null; source?: KeySource }>
  ): { applied: string[]; unchanged: string[]; rejected: Array<{ dbKeyId: string; reason: string }> } {
    const accountRef = this.accountRef(String(accountDir || ''))
    const store = this.deps.store.read()
    const updates: DbKeyUpdate[] = keys.map((k) => ({
      dbKeyId: k.id,
      keyHex: k.keyHex,
      saltHex: k.saltHex,
      source: k.source ?? 'scan',
      verified: true,
    }))
    const merged = mergeDbKeyUpdates(store, accountRef, updates, (plain) => this.deps.codec.encrypt(plain), this.deps.now())
    this.deps.store.write(merged.next)
    return { applied: merged.applied, unchanged: merged.unchanged, rejected: merged.rejected }
  }

  /** 记录账号级口令（Hook/手动拿到的那种；健康面板据此显示它能覆盖哪些库）。 */
  setAccountPassphrase(accountDir: string, passphraseHex: string, source: KeySource): void {
    const normalized = String(passphraseHex || '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(normalized)) return
    const accountRef = this.accountRef(String(accountDir || ''))
    const store = this.deps.store.read()
    const next = mergeAccountPassphrase(store, accountRef, normalized, source, (plain) => this.deps.codec.encrypt(plain), this.deps.now())
    this.deps.store.write(next)
  }
}

/** 共享契约里的一行（`src/vite-env.d.ts` 的 `KeyHealthEntry`）。 */
export interface KeyHealthContractEntry {
  kind: string
  path: string
  status: DbKeyStatus
  source: KeySource | null
  verifiedAt?: number
  fingerprint?: string
  error?: string
  /** 扩展字段（契约里是可选）：内部 id 与一行动作，面板可直接显示。 */
  id?: string
  reason?: string
  action?: string
}

/** 共享契约（`src/vite-env.d.ts` 的 `KeyHealthReport`）。 */
export interface KeyHealthContractReport {
  success: boolean
  mode?: 'scan' | 'hook' | 'manual' | 'none'
  blockers?: Array<{ id: string; message: string; actionable: string }>
  connectionReady?: boolean
  connectionCoverage?: DbKeyHealthReport['connectionCoverage']
  databases: KeyHealthContractEntry[]
  error?: string
}

/**
 * 把引擎内部报告映射成**共享契约**形状（渲染层只认这一种）。
 *
 * 两处刻意的取舍：
 * 1. `mode` 由每库来源推断（scan > hook > manual > none）——契约只给一个字段，
 *    而 per-DB 来源本来就是扫描路径的产物。
 * 2. `kinds` 过滤只作用于返回的行，不影响"是否真的重扫"：一键重扫永远是全库扫描
 *    （微信内存里有哪些库不由我们决定），过滤只是"我只想看这几个"。
 */
export function toKeyHealthReport(
  report: DbKeyHealthReport,
  kinds?: string[]
): KeyHealthContractReport {
  const wanted = kinds && kinds.length > 0 ? new Set(kinds) : null
  const entries = report.entries.filter((e) => !wanted || wanted.has(e.kind))
  const sources = new Set(report.entries.map((e) => e.source))
  const mode: KeyHealthContractReport['mode'] = sources.has('scan')
    ? 'scan'
    : sources.has('hook')
      ? 'hook'
      : sources.has('manual')
        ? 'manual'
        : 'none'
  return {
    success: report.success,
    mode,
    connectionReady: report.connectionReady,
    connectionCoverage: report.connectionCoverage,
    // 自检失败项：以前这里写死 `[]`，前置条件（微信没开/没提权/库被占）永远到不了界面
    blockers: report.blockers ?? [],
    databases: entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      path: e.path,
      status: e.status,
      source: e.source,
      verifiedAt: e.verifiedAt ?? undefined,
      fingerprint: e.fingerprint ?? undefined,
      // 契约里 `error` 是"这一行为什么不是 ok"的那一句话；把原因与动作拼在一起，
      // 面板不必再回引擎要第二份文案。
      error: e.status === 'ok' ? undefined : [e.reason, e.action].filter(Boolean).join(' ') || undefined,
      reason: e.reason,
      action: e.action,
    })),
    error: report.error,
  }
}
