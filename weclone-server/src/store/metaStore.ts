/**
 * metaStore —— 克隆元数据 JSON 文件存储（v0.9.10）。
 *
 * 刻意不用 SQLite / better-sqlite3：native 模块在 Railway(alpine/musl) 上
 * 需要 node-gyp 编译（构建易卡死），且常驻内存更高。这里用单文件
 * data/meta.json + 内存 Map 缓存：
 * - 惰性加载：首次访问才读盘，启动零 IO；
 * - 原子写：tmp + rename（同目录保证同分区，rename 原子生效）；
 * - ownerToken 只存 SHA-256 哈希，绝不落明文；
 * - mds 正文随记录冗余存储（≤40KB/clone），chat 组装 prompt 零二次磁盘 IO。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type CloneVisibility = 'private' | 'public' | 'link'

/** 一条克隆记录（data/meta.json 内的单行） */
export interface CloneRecord {
  id: string
  displayName: string
  wxid: string
  knowledgeCutoff: string
  generatedAt: string
  visibility: CloneVisibility
  /** visibility=link 时的 16-hex 分享密钥；其余为 null */
  secret: string | null
  /** ownerToken 的 SHA-256 hex */
  ownerTokenHash: string
  messageCount: number
  /** 知识文件正文 json：{ 'profile.md': '...', ... } */
  mds: Record<string, string>
  createdAt: string
}

interface MetaFileShape {
  clones: CloneRecord[]
}

export class MetaStore {
  private readonly file: string
  private map = new Map<string, CloneRecord>()
  private loaded = false

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'meta.json')
  }

  get kind(): 'json' {
    return 'json'
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as MetaFileShape
      for (const row of Array.isArray(parsed?.clones) ? parsed.clones : []) {
        if (row && typeof row.id === 'string') this.map.set(row.id, row)
      }
    } catch (err) {
      // 损坏的 meta.json 不阻断启动 —— 备份后从空库开始
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* ignore */ }
      console.warn('[metaStore] meta.json unreadable, starting empty:', (err as Error).message)
    }
  }

  /** 原子写：写 tmp 再 rename 覆盖（Node 在 Windows 上也以 REPLACE_EXISTING 执行） */
  private persist(): void {
    const payload = JSON.stringify({ clones: [...this.map.values()] } satisfies MetaFileShape)
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, this.file)
  }

  // ------------------------------------------------------------------
  // 公开 API
  // ------------------------------------------------------------------

  create(record: CloneRecord): void {
    this.ensureLoaded()
    this.map.set(record.id, record)
    this.persist()
  }

  get(id: string): CloneRecord | null {
    this.ensureLoaded()
    return this.map.get(id) ?? null
  }

  /** 公开克隆列表（visibility=public，createdAt DESC），limit 上限 50 */
  listPublic(limit = 50, offset = 0, q?: string): CloneRecord[] {
    this.ensureLoaded()
    const cap = Math.min(Math.max(1, Math.floor(limit)), 50)
    const start = Math.max(0, Math.floor(offset))
    const needle = q?.trim().toLowerCase()
    let rows = [...this.map.values()]
      .filter((r) => r.visibility === 'public')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    if (needle) rows = rows.filter((r) => r.displayName.toLowerCase().includes(needle))
    return rows.slice(start, start + cap)
  }

  listByOwner(ownerTokenHash: string): CloneRecord[] {
    this.ensureLoaded()
    return [...this.map.values()]
      .filter((r) => r.ownerTokenHash === ownerTokenHash)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  countByOwner(ownerTokenHash: string): number {
    this.ensureLoaded()
    let n = 0
    for (const r of this.map.values()) if (r.ownerTokenHash === ownerTokenHash) n += 1
    return n
  }

  delete(id: string): boolean {
    this.ensureLoaded()
    const ok = this.map.delete(id)
    if (ok) this.persist()
    return ok
  }

  updateVisibility(id: string, visibility: CloneVisibility, secret: string | null): boolean {
    this.ensureLoaded()
    const row = this.map.get(id)
    if (!row) return false
    row.visibility = visibility
    row.secret = secret
    this.persist()
    return true
  }

  close(): void {
    /* JSON 存储无长连接，无需 flush */
  }
}
