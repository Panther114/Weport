/**
 * 媒体去重与解密缓存（v1.2 §10.1 ①："媒体去重：按哈希跳过 / 解密缓存"）。
 *
 * 两件事，都只做"记住 + 跳过"，不做任何库访问：
 *
 * 1. **媒体去重（`mediaHashes`）**：导出账本按会话记录每条已导出媒体的
 *    `{ 相对路径, sha256, bytes }`。续跑时先查这份清单：路径命中且磁盘上
 *    **内容哈希一致** → 不重复复制/不重复转码，直接把这条媒体标成"已完成"。
 *    判定用内容哈希而不是路径 —— 路径会因为重命名/换导出目录而失效。
 *
 * 2. **解密结果缓存**：键是 `(源路径, mtime, size, 密钥指纹)`。
 *    库没变（mtime+size 相同）且密钥没变（指纹相同）时，同一张图片/同一段语音
 *    不必再解一次。**密钥本身绝不进这个模块**：调用方传进来的只有
 *    `keyFingerprint`（见 `fingerprintKey`），缓存条目里也只存指纹。
 *
 * 红线：本模块所有路径都只写 `<目标导出目录>` 与 `<userData>/media-cache`，
 * 绝不写微信数据目录。
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { LedgerMediaEntry } from './ledger'
import { atomicWriteText } from './atomicWrite'

/**
 * 密钥指纹：sha256(域分隔 + 密钥原文)，取前 16 位 hex。
 * 单向、不可逆、长度固定 —— 因此可以安全地进缓存键、进日志、进账本。
 */
export function fingerprintKey(rawKey: string | null | undefined): string {
  const normalized = String(rawKey ?? '')
  if (!normalized) return 'no-key'
  return `k${crypto.createHash('sha256').update(`weport-media-key\u001f${normalized}`).digest('hex').slice(0, 16)}`
}

export interface MediaContentHash {
  sha256: string
  bytes: number
}

/** 流式计算文件内容哈希（大文件不吃内存）。 */
export async function hashFileContent(filePath: string): Promise<MediaContentHash | null> {
  try {
    const handle = await fs.promises.open(filePath, 'r')
    try {
      const hash = crypto.createHash('sha256')
      let bytes = 0
      const stream = handle.createReadStream()
      for await (const chunk of stream) {
        const buf = chunk as Buffer
        bytes += buf.byteLength
        hash.update(buf)
      }
      return { sha256: hash.digest('hex'), bytes }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export interface MediaDedupeStats {
  /** 命中账本哈希清单、直接跳过复制/转码的条数。 */
  ledgerSkips: number
  /** 命中"内容相同"的已导出目标、用 hardlink 复用的条数。 */
  contentReuses: number
  /** 解密缓存命中条数。 */
  decryptCacheHits: number
  /** 解密缓存未命中、实际解了一条的条数。 */
  decryptCacheMisses: number
  /** 因为目标文件与账本记录不符（大小/哈希不同）而必须重做的条数。 */
  mismatches: number
}

/**
 * 账本媒体清单 → 查询索引。续跑时用它判断"这条媒体是不是已经导过了"。
 * 校验顺序：路径 → 字节数 → sha256（任何一项不符都当作没导过）。
 */
export class MediaHashIndex {
  private readonly byPath = new Map<string, LedgerMediaEntry>()
  private readonly bySha = new Map<string, string[]>()
  /** 记录这些相对路径是相对哪个绝对根目录算出来的。 */
  private readonly rootDir: string

  constructor(entries: LedgerMediaEntry[] = [], rootDir = '') {
    this.rootDir = String(rootDir || '')
    for (const entry of entries) {
      const relPath = normalizeRelPath(entry.path)
      if (!relPath) continue
      this.byPath.set(relPath, { ...entry, path: relPath })
      const list = this.bySha.get(entry.sha256)
      if (list) list.push(relPath)
      else this.bySha.set(entry.sha256, [relPath])
    }
  }

  get size(): number {
    return this.byPath.size
  }

  getRootDir(): string {
    return this.rootDir
  }

  /**
   * 把账本里的相对路径还原成绝对路径（POSIX 分隔符 → 本机分隔符）。
   *
   * 还原之后**必须确认还在导出根目录里**：账本里的相对路径如果带 `..`（或者根目录本身
   * 变了），`path.join` 会拼出导出目录之外的文件，那条记录随后会被拿去算 sha256 并作为
   * `reusePath` 交给导出器 —— 也就是"从导出目录外搬一个文件进来"。认不出来就返回 null。
   */
  resolveAbsolute(relPath: string): string | null {
    const normalized = normalizeRelPath(relPath)
    if (!normalized || !this.rootDir) return null
    const root = path.resolve(this.rootDir)
    const absolute = path.resolve(root, ...normalized.split('/'))
    const withSep = root.endsWith(path.sep) ? root : root + path.sep
    if (absolute !== root && !absolute.startsWith(withSep)) return null
    return absolute
  }

  has(relPath: string): boolean {
    return this.byPath.has(normalizeRelPath(relPath))
  }

  get(relPath: string): LedgerMediaEntry | undefined {
    return this.byPath.get(normalizeRelPath(relPath))
  }

  /** 同一个内容哈希已经在别处导出过吗？（跨会话去重用） */
  pathsWithHash(sha256: string): string[] {
    return [...(this.bySha.get(sha256) || [])]
  }

  /** 全部条目（按相对路径排序，保证遍历顺序稳定）。 */
  listAll(): LedgerMediaEntry[] {
    return [...this.byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  /** 按谓词筛选条目。 */
  find(predicate: (entry: LedgerMediaEntry) => boolean): LedgerMediaEntry[] {
    return this.listAll().filter(predicate)
  }
}

export function normalizeRelPath(relPath: string): string {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
}

export interface MediaDedupeDecision {
  /** 已在账本里且磁盘校验通过 → 真跳过。 */
  skip: boolean
  reason: 'no-record' | 'verified' | 'not-found' | 'size-mismatch' | 'sha-mismatch' | 'unreadable' | 'path-mismatch'
}

/**
 * 判断某条媒体是否"已经导出过且现在仍然一致"。
 * `entry` 里的路径是**相对导出根目录**的路径，所以这里必须收到绝对路径 `absolutePath`：
 * 导出有 shared / per-session 两种布局，媒体可能在 `<root>/media`、也可能在
 * `<root>/<会话目录>/media` 下，相对路径无法自己还原出根目录，
 * 用 `path.dirname(destPath)` 硬猜会把两种布局里的一种算错。
 */
export async function verifyMediaAgainstLedger(absolutePath: string, entry: LedgerMediaEntry | undefined): Promise<MediaDedupeDecision> {
  if (!entry) return { skip: false, reason: 'no-record' }
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(absolutePath)
  } catch {
    return { skip: false, reason: 'not-found' }
  }
  if (entry.bytes > 0 && stat.size !== entry.bytes) return { skip: false, reason: 'size-mismatch' }
  const hash = await hashFileContent(absolutePath)
  if (!hash) return { skip: false, reason: 'unreadable' }
  if (entry.sha256 && hash.sha256 !== entry.sha256) return { skip: false, reason: 'sha-mismatch' }
  return { skip: true, reason: 'verified' }
}

export interface MediaDedupeCacheEntry {
  /** 源文件绝对路径。 */
  sourcePath: string
  mtimeMs: number
  size: number
  /** 密钥指纹（见 `fingerprintKey`）—— 永远不是密钥本身。 */
  keyFingerprint: string
  /** 解密/转码后的产物路径。 */
  cachedPath: string
  sha256: string
  at: number
}

export interface MediaDedupeCacheFile {
  v: number
  entries: MediaDedupeCacheEntry[]
}

export const MEDIA_DEDUPE_CACHE_VERSION = 1
export const MEDIA_DEDUPE_CACHE_FILE = 'media-dedupe-cache.json'

/**
 * 解密/转码结果缓存，键 = `(path, mtime, size, keyFingerprint)`。
 *
 * 落盘在 `<cacheDir>/media-dedupe-cache.json`（调用方传 `userData` 下的目录），
 * 重写走 tmp → fsync → os.replace（同一套原子写），坏了就整份丢掉重来。
 */
export class MediaDedupeCache {
  private readonly cachePath: string
  private entries = new Map<string, MediaDedupeCacheEntry>()
  private loaded = false
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null
  private readonly maxEntries: number

  constructor(cacheDir: string, maxEntries = 20000) {
    this.cachePath = path.join(cacheDir, MEDIA_DEDUPE_CACHE_FILE)
    this.maxEntries = Math.max(128, maxEntries)
  }

  static cacheKeyOf(input: { sourcePath: string; mtimeMs: number; size: number; keyFingerprint: string }): string {
    const normalized = path.resolve(input.sourcePath)
    return [
      normalized,
      String(Math.floor(input.mtimeMs)),
      String(Math.floor(input.size)),
      String(input.keyFingerprint || 'no-key'),
    ].join('\u001f')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.promises.readFile(this.cachePath, 'utf-8')
      const parsed = JSON.parse(raw) as MediaDedupeCacheFile
      if (parsed?.v !== MEDIA_DEDUPE_CACHE_VERSION || !Array.isArray(parsed.entries)) return
      for (const entry of parsed.entries) {
        if (!entry?.sourcePath || !entry?.cachedPath || typeof entry.keyFingerprint !== 'string') continue
        this.entries.set(MediaDedupeCache.cacheKeyOf(entry), entry)
      }
    } catch {
      /* 缓存不是数据源：读不到就是没命中 */
    }
  }

  size(): number {
    return this.entries.size
  }

  /** 查一条：命中且产物仍在磁盘上才返回路径。 */
  async get(input: { sourcePath: string; mtimeMs: number; size: number; keyFingerprint: string }): Promise<MediaDedupeCacheEntry | null> {
    await this.load()
    const entry = this.entries.get(MediaDedupeCache.cacheKeyOf(input))
    if (!entry) return null
    try {
      await fs.promises.access(entry.cachedPath)
    } catch {
      this.entries.delete(MediaDedupeCache.cacheKeyOf(input))
      this.dirty = true
      return null
    }
    return entry
  }

  async put(input: { sourcePath: string; mtimeMs: number; size: number; keyFingerprint: string; cachedPath: string; sha256: string }): Promise<void> {
    await this.load()
    this.entries.set(MediaDedupeCache.cacheKeyOf(input), {
      sourcePath: path.resolve(input.sourcePath),
      mtimeMs: Math.floor(input.mtimeMs),
      size: Math.floor(input.size),
      keyFingerprint: String(input.keyFingerprint || 'no-key'),
      cachedPath: input.cachedPath,
      sha256: input.sha256,
      at: Date.now(),
    })
    this.dirty = true
    this.trim()
    this.scheduleFlush()
  }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return
    const sorted = [...this.entries.values()].sort((a, b) => b.at - a.at).slice(0, this.maxEntries)
    this.entries = new Map(sorted.map((entry) => [MediaDedupeCache.cacheKeyOf(entry), entry]))
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush().catch(() => { /* 缓存写失败不影响导出 */ })
    }, 500)
    this.flushTimer.unref?.()
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const payload: MediaDedupeCacheFile = {
      v: MEDIA_DEDUPE_CACHE_VERSION,
      entries: [...this.entries.values()],
    }
    try {
      await fs.promises.mkdir(path.dirname(this.cachePath), { recursive: true })
      await atomicWriteText(this.cachePath, JSON.stringify(payload))
    } catch {
      /* 缓存写失败不影响导出 */
    }
  }

  /** 供测试断言：缓存条目里绝不出现密钥原文。 */
  snapshotForDiagnostics(): MediaDedupeCacheEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }))
  }
}

/** 解密缓存命中/未命中的统计（进账本审核/进度遥测用）。 */
export class MediaDedupeCounter {
  private stats: MediaDedupeStats = {
    ledgerSkips: 0,
    contentReuses: 0,
    decryptCacheHits: 0,
    decryptCacheMisses: 0,
    mismatches: 0,
  }

  note(partial: Partial<MediaDedupeStats>): void {
    for (const [key, value] of Object.entries(partial)) {
      const k = key as keyof MediaDedupeStats
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) continue
      this.stats[k] += Math.max(0, Math.floor(numeric))
    }
  }

  snapshot(): MediaDedupeStats {
    return { ...this.stats }
  }

  reset(): void {
    this.stats = { ledgerSkips: 0, contentReuses: 0, decryptCacheHits: 0, decryptCacheMisses: 0, mismatches: 0 }
  }
}
