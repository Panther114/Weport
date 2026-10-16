import { closeSync, openSync, readSync, readdirSync, statSync, type Dirent } from 'fs'
import { basename, join, relative, sep } from 'path'
import crypto from 'crypto'

/**
 * SQLCipher 页面密钥工具（**纯函数 + 只读文件访问**，不依赖 Electron / koffi）。
 *
 * ## 为什么单独一个模块
 *
 * 「密钥对不对」这个问题在 Weport 里出现过三种互不相同的实现（WCDB 引擎开库、
 * 扫描结果判定、手动粘贴判定），判据一旦不一致就会出现"面板说 OK、导出说错钥"
 * 这种最难查的故障。这里把判据收敛成**一处**：SQLCipher page 1 的 HMAC。
 *
 * Page layout follows SQLCipher's documented format; supported compatibility
 * parameters are checked by page-1 HMAC rather than inferred from key shape.
 *
 * ```
 * pageSize = 4096, reserve = 80（IV 16 + HMAC-SHA512 64）
 * page1    = [0:16] salt | [16:4016] ciphertext | [4016:4032] IV | [4032:4096] HMAC
 * 校验      : HMAC-SHA512(macKey, page1[16:4032] || LE32(1)) == page1[4032:4096]
 *   macKey = PBKDF2-HMAC-SHA512(encKey, salt ^ 0x3a, 2, 32)
 *   encKey = raw ? key32 : PBKDF2-HMAC-SHA512(passphrase, salt, 256000, 32)
 * ```
 *
 * Do not use the decrypted first 16 bytes as a validity check: page 1 stores
 * the salt in that position, so SQLCipher skips it during page decryption.
 */

/** SQLCipher page size used by the supported WeChat database format. */
export const SQLCIPHER_PAGE_SIZE = 4096
/** Reserved page tail: IV (16 bytes) + HMAC-SHA512 (64 bytes). */
export const SQLCIPHER_RESERVE = 80
/** HMAC-SHA512 的存放偏移（`pageSize - 64`）。 */
export const SQLCIPHER_HMAC_OFFSET = SQLCIPHER_PAGE_SIZE - 64
/** HMAC-SHA512 的长度。 */
export const SQLCIPHER_HMAC_BYTES = 64
/** 口令模式 KDF 迭代数。证据：报告 §1.2（多来源一致 + 本机逐字节复现）。 */
export const SQLCIPHER_KDF_ITERATIONS = 256000
/** SQLCipher raw key length: 32 bytes. */
export const KEY_BYTES = 32
/** SQLCipher page salt length: 16 bytes. */
export const SALT_BYTES = 16

/**
 * 一把密钥的两种形态。
 *
 * - `raw`：32 字节 key 直接当 encKey（扫描得到的 page key）。
 * - `passphrase`：口令字节串先 PBKDF2 再当 encKey。配置里的 64 位 hex 账号口令
 *   在 Windows 原生账号 API 中先 hex-decode 成 32 字节再派生；显式 UTF-8
 *   文本口令是另一种编码。调用者必须按真实编码传入字节串，不能混为一谈。
 *
 * 扫描拿到的是**每库 page key（raw）**，Hook 抓到的是**口令（passphrase）**，
 * 两者都要能判定 —— 少了任一形态，判据就会把有效密钥判成无效。
 */
export type PageKeyMode = 'raw' | 'passphrase'

/** 一把密钥相对某个库的判定结果。 */
export interface PageKeyVerdict {
  /** 命中的形态；两种都不命中为 null。 */
  mode: PageKeyMode | null
  /** 已验证的形态列表（少数情况下两者都成立，例如全零密钥）。 */
  modes: PageKeyMode[]
}

/** 读 page 1 失败的原因，供上层转成用户文案。 */
export interface Page1ReadResult {
  ok: boolean
  page1?: Buffer
  error?: 'missing' | 'unreadable' | 'too-small' | 'not-sqlcipher'
  message?: string
}

/**
 * **只读**打开库并读第 1 页（4096 字节）。
 *
 * 硬约束：Weport 绝不写用户的微信数据目录，因此这里一律 `'r'`（不创建、不补齐、
 * 不碰 `-wal` / `-shm`）。文件小于一页时直接判定为"不是 SQLCipher 库"，
 * 而不是当成坏密钥 —— 两者对用户的含义完全不同。
 */
export function readPage1(dbPath: string): Page1ReadResult {
  let fd: number | null = null
  try {
    let size = 0
    try {
      size = statSync(dbPath).size
    } catch {
      return { ok: false, error: 'missing', message: '数据库文件不存在' }
    }
    if (size < SQLCIPHER_PAGE_SIZE) {
      return { ok: false, error: 'too-small', message: '数据库文件不完整（小于一页）' }
    }
    fd = openSync(dbPath, 'r')
    const page1 = Buffer.alloc(SQLCIPHER_PAGE_SIZE)
    const read = readSync(fd, page1, 0, SQLCIPHER_PAGE_SIZE, 0)
    if (read !== SQLCIPHER_PAGE_SIZE) {
      return { ok: false, error: 'unreadable', message: '读取数据库首页失败' }
    }
    return { ok: true, page1 }
  } catch (e) {
    return {
      ok: false,
      error: 'unreadable',
      message: e instanceof Error ? e.message : String(e),
    }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* noop */ }
    }
  }
}

/** 由 salt 派生 macKey（PBKDF2-HMAC-SHA512(encKey, salt^0x3a, 2, 32)）。 */
export function deriveMacKey(encKey: Buffer, salt: Buffer): Buffer {
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a))
  return crypto.pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512')
}

/** 由口令 + salt 派生 encKey（password mode）。 */
export function deriveEncKeyFromPassphrase(passphrase: Buffer, salt: Buffer, iterations = SQLCIPHER_KDF_ITERATIONS): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha512')
}

/** Shared persisted-key contract for KeyHealth and Diagnostics. No secrets leave the caller. */
export function verifyHexKeyForPage(page1: Buffer, keyHex: string): { mode: PageKeyMode; pageKey: Buffer } | null {
  const normalized = String(keyHex || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) return null
  const raw = Buffer.from(normalized, 'hex')
  if (verifyPageKey(page1, raw, ['raw']).mode === 'raw') return { mode: 'raw', pageKey: raw }
  // Windows account APIs decode hex before PBKDF2; legacy text passphrases remain supported.
  for (const passphrase of [raw, Buffer.from(normalized, 'utf8')]) {
    const pageKey = deriveEncKeyFromPassphrase(passphrase, page1.subarray(0, SALT_BYTES))
    if (verifyPageKey(page1, pageKey, ['raw']).mode === 'raw') return { mode: 'passphrase', pageKey }
  }
  return null
}

/**
 * 判定「这把 32 字节密钥 + 这个形态」能否解开这一页。
 *
 * 纯函数、无 IO，因此可以被单测用正/负向量直接钉住（K11）。
 */
export function pageKeyMatches(page1: Buffer, key: Buffer, mode: PageKeyMode, iterations = SQLCIPHER_KDF_ITERATIONS): boolean {
  if (page1.length < SQLCIPHER_PAGE_SIZE || key.length === 0) return false
  if (mode === 'raw' && key.length !== KEY_BYTES) return false
  if (mode === 'passphrase' && key.length > 4096) return false
  const salt = page1.subarray(0, SALT_BYTES)
  const encKey = mode === 'raw' ? key : deriveEncKeyFromPassphrase(key, salt, iterations)
  const macKey = deriveMacKey(encKey, salt)
  const mac = crypto.createHmac('sha512', macKey)
  // ⚠️ MAC 覆盖到 `pageSize - 64`（即 4032），不是 `pageSize - reserve`（4016）：
  // 保留的 80 字节 = IV(16) + HMAC(64)，而 IV 是**参与** MAC 计算的。
  // 这里曾写错成 4016，表现为"参考实现能验通、本实现全判 false"（见
  // The IV is part of the authenticated range; the salt is not.
  mac.update(page1.subarray(SALT_BYTES, SQLCIPHER_HMAC_OFFSET))
  const pageNo = Buffer.alloc(4)
  pageNo.writeUInt32LE(1, 0)
  mac.update(pageNo)
  const expected = mac.digest()
  const actual = page1.subarray(SQLCIPHER_HMAC_OFFSET, SQLCIPHER_HMAC_OFFSET + SQLCIPHER_HMAC_BYTES)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

/**
 * 对一个库试几种形态；返回命中情况。
 *
 * Stop after the first match. Passphrase checks run PBKDF2 and are more
 * expensive than raw-key checks, so testing additional modes after a match is
 * unnecessary.
 *
 * 副作用：`modes` 从"全部命中的形态"变成"到第一个命中为止"。仓库里没有任何调用方读它
 * （`verdict.mode` 才是契约字段），单测也只用 `mode`。
 */
export function verifyPageKey(page1: Buffer, key: Buffer, modes: PageKeyMode[] = ['raw', 'passphrase']): PageKeyVerdict {
  const hits: PageKeyMode[] = []
  for (const mode of modes) {
    if (!pageKeyMatches(page1, key, mode)) continue
    hits.push(mode)
    break
  }
  return { mode: hits[0] ?? null, modes: hits }
}

/** 从 hex 字符串解出 32 字节密钥；非法返回 null。 */
export function keyBufferFromHex(keyHex: string): Buffer | null {
  const normalized = String(keyHex || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) return null
  return Buffer.from(normalized, 'hex')
}

/**
 * 日志/界面里唯一允许出现的密钥形态：`ab12…cd34`。
 *
 * 硬约束：**完整密钥永远不进日志、不进诊断包、不进 UI 文本**（D5 / §10.4）。
 * 指纹足够回答"这把和那把是不是同一把"，但推不回密钥。
 */
export function keyFingerprint(keyHex: string): string {
  const normalized = String(keyHex || '').trim().toLowerCase()
  if (!normalized) return ''
  if (normalized.length <= 8) return normalized
  return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`
}

/** 从 page 1 读出库自己的 salt（hex）。 */
export function saltHexOf(page1: Buffer): string {
  return page1.subarray(0, SALT_BYTES).toString('hex')
}

// === 粘贴语法（§10.4：4 种） ===

/** 四种受支持的粘贴语法 + 两种宽容变体。 */
export type PasteSyntax =
  | 'raw64'        // ① 裸 64 位 hex
  | 'hex-0x'       // ② 0x 前缀的 64 位 hex
  | 'wcdb-x'       // ③ WCDB 的 x'…' 形式（不带/带 salt 均可）
  | 'key+salt-96'  // ④ <key><salt> 96 位 hex
  | 'key+salt-128' // ⑤ 宽容变体：<key32字节><salt32字节> 128 位 hex
  | 'pragma'       // ⑥ 宽容变体：整段 `PRAGMA key = "x'…'";`

export interface ParsedPastedKey {
  ok: true
  keyHex: string
  saltHex?: string
  syntax: PasteSyntax
  /** 规范化后的建议展示形态（`x'…'`）。 */
  normalized: string
}

export interface ParsedPastedKeyError {
  ok: false
  /** 稳定错误码，便于单测与 UI 分支；文案不含"请重试"。 */
  code: 'empty' | 'not-hex' | 'bad-length'
  message: string
}

const HEX_RUN = /^[0-9a-f]+$/i

/**
 * 解析用户粘贴的密钥。覆盖 §10.4 要求的 4 种语法，外加两种真实世界里会遇到的
 * 宽容形式（128 位 hex、整段 PRAGMA 语句）。
 *
 * 只做**语法**判定，不做有效性判定 —— 有效性一律由 {@link pageKeyMatches}
 * 对着真实库的 page 1 裁决（否则用户会看到"格式对了但库打不开"的静默失败）。
 */
export function parsePastedKeyInput(raw: unknown): ParsedPastedKey | ParsedPastedKeyError {
  const text = String(raw ?? '').trim()
  if (!text) {
    return { ok: false, code: 'empty', message: '请先粘贴密钥再保存。' }
  }

  let body = text
  let syntax: PasteSyntax | null = null

  // ⑥ 整段 SQL：从里面抽出 x'…'（真实用户经常把整行 PRAGMA 复制过来）
  const pragma = /pragma\s+key\s*=\s*"([^"]+)"/i.exec(body)
  if (pragma) {
    body = pragma[1].trim()
    syntax = 'pragma'
  }

  // ③ WCDB 形式：x'…' / X'…'
  const wcdb = /^[xX]'([^']*)'$/.exec(body)
  if (wcdb) {
    body = wcdb[1].trim()
    syntax = 'wcdb-x'
  } else {
    // 宽容：整串里包含 x'…' 时也认（例如前后带引号的复制结果）
    const embedded = /[xX]'([0-9a-fA-F]{64,192})'/.exec(body)
    if (embedded) {
      body = embedded[1]
      syntax = syntax ?? 'wcdb-x'
    }
  }

  // ② 0x 前缀
  if (/^0[xX]/.test(body)) {
    body = body.replace(/^0[xX]/, '')
    syntax = syntax ?? 'hex-0x'
  }

  body = body.replace(/[\s_-]/g, '')
  if (!HEX_RUN.test(body)) {
    return {
      ok: false,
      code: 'not-hex',
      message: '密钥里出现了非十六进制字符。请粘贴 64 位 hex（可带 0x 前缀或 x\'\' 包裹）。',
    }
  }

  if (body.length === 64) {
    return {
      ok: true,
      keyHex: body.toLowerCase(),
      syntax: syntax ?? 'raw64',
      normalized: `x'${body.toLowerCase()}'`,
    }
  }
  if (body.length === 96) {
    const keyHex = body.slice(0, 64).toLowerCase()
    const saltHex = body.slice(64).toLowerCase()
    return {
      ok: true,
      keyHex,
      saltHex,
      syntax: syntax === 'wcdb-x' ? 'wcdb-x' : (syntax ?? 'key+salt-96'),
      normalized: `x'${keyHex}${saltHex}'`,
    }
  }
  if (body.length === 128) {
    // 宽容变体：32 字节 key + 32 字节 salt 的纯 hex 形式
    const keyHex = body.slice(0, 64).toLowerCase()
    const saltHex = body.slice(64).toLowerCase()
    return { ok: true, keyHex, saltHex, syntax: 'key+salt-128', normalized: `x'${keyHex}${saltHex}'` }
  }

  return {
    ok: false,
    code: 'bad-length',
    message: `密钥长度不对（当前 ${body.length} 位十六进制）。需要 64 位（32 字节），带 salt 时为 96 位。`,
  }
}

// === 库枚举与分类 ===

/** 一个待判定的库文件（相对账号目录的稳定 id + 分类）。 */
export interface DbFileEntry {
  /** 相对 `db_storage` 的路径，正斜杠分隔，例如 `message/message_0.db`。 */
  id: string
  /** 分类标签，例如 `message_0` / `session` / `contact` / `general`。 */
  kind: string
  /** 绝对路径。 */
  path: string
  /**
   * 粗分组。UI 按组折叠；`core` 是连接/导出必需的四类。
   */
  group: 'core' | 'message' | 'aux'
}

/** `db_storage` 下一个库文件的分类：message_0..N / biz_message_0..N / media_0..N / 目录名。 */
export function dbKindOf(id: string): string {
  const rel = String(id || '').replace(/\\/g, '/')
  const stem = basename(rel).replace(/\.db$/i, '')
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (!parent) return stem
  // `message/message_0.db` 这类：目录名是分组名，短名（`message_0`）才是这一行的身份
  if (parent === stem || parent === 'message') return stem
  return `${parent}_${stem}`
}

const CORE_KINDS = ['session', 'contact', 'general']

function groupOf(kind: string): DbFileEntry['group'] {
  if (CORE_KINDS.includes(kind)) return 'core'
  if (/^(message|biz_message|media)_\d+$/.test(kind) || kind.startsWith('message')) return 'message'
  return 'aux'
}

export class DbFileEnumerationLimitError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`db_storage 数据库文件数超过安全上限 ${limit}，无法确认完整覆盖。`)
    this.name = 'DbFileEnumerationLimitError'
    this.limit = limit
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * 递归枚举 `db_storage` 下的 `*.db`（**只读**，只 `readdir`/`stat`）。
 *
 * 这决定面板上会列出哪些库：微信 4.x 一个账号有 22 个库，密钥**逐库不同**，
 * 所以"每库一行"必须真的逐库枚举，不能只列四个核心库。
 * 默认超过 `maxFiles` 会抛错，避免把截断的前缀当作完整覆盖；只有存在性检查或明确采样才可传 `allowTruncated`。
 */
export function listDbFiles(dbStorageDir: string, options: { maxFiles?: number; allowTruncated?: boolean } = {}): DbFileEntry[] {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 400))
  const out: DbFileEntry[] = []
  const allowTruncated = options.allowTruncated === true
  let truncated = false
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > 3) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!/\.db$/i.test(entry.name)) continue
      if (out.length >= maxFiles) {
        truncated = true
        return
      }
      const id = relative(dbStorageDir, full).split(sep).join('/')
      const kind = dbKindOf(id)
      out.push({ id, kind, path: full, group: groupOf(kind) })
      if (allowTruncated && out.length >= maxFiles) {
        truncated = true
        return
      }
    }
  }
  walk(dbStorageDir, 0)
  if (truncated && !allowTruncated) throw new DbFileEnumerationLimitError(maxFiles)
  // 稳定排序：核心库在前，其余按 id —— 面板每次刷新顺序不变，用户才能"看同一行"。
  const rank = (e: DbFileEntry) => (e.group === 'core' ? 0 : e.group === 'message' ? 1 : 2)
  out.sort((a, b) => (rank(a) - rank(b)) || a.id.localeCompare(b.id))
  return out
}
