/**
 * 导出账本（v1.2 §10.1 ①，可续跑 / resumable ledger）。
 *
 * 位置：`<导出根目录>/.weport-export-ledger.jsonl`（导出**根目录**，不是格式子目录）。
 * 形状：每完成一个"单元"（会话 × 时间分片 × 产物，见 `unitKeyOf`）追加一行 JSON。
 *
 * 为什么是 JSONL 而不是一个 JSON 文件：崩溃点可能在任意字节，JSON 一旦被切断就是
 * 整个文件不可解析 —— 账本会连"已经完成的部分"一起丢掉。JSONL 的损坏被限制在最后
 * 一行，前面的行仍然可用（`read()` 只忽略**被截断的最后一行**）。
 *
 * 崩溃安全：
 * - 追加：`appendFile` + 文件 fsync（句柄用后即关，避免长时间持有）；
 * - 重写（compact / reset）：写临时文件 → fsync → `os.replace`，绝不在原文件上原地改；
 * - 只读方（read）永远不抛出：账本坏了最多退化成"全量重导"，不能让整个导出失败。
 *
 * 版本：`v` 与 `LEDGER_VERSION` 不一致的行**一律丢弃**（不猜测旧格式的语义）。
 * 代价是升级后第一次导出会全量重跑一次，换来的是"绝不会把不兼容的记录当成已完成"
 * —— 对导出工具来说，重跑一次远好过静默漏导。
 */
import * as fs from 'fs'
import * as path from 'path'
import crypto from 'crypto'
import { atomicWriteText } from './atomicWrite'

export const LEDGER_VERSION = 1
export const LEDGER_FILE_NAME = '.weport-export-ledger.jsonl'

export interface LedgerMediaEntry {
  /** 相对导出根目录的媒体路径（POSIX 分隔符，便于跨平台比对）。 */
  path: string
  /** 媒体内容 sha256（用于续跑时跳过重复复制/重复转码）。 */
  sha256: string
  bytes: number
}

export interface LedgerUnit {
  v: number
  taskId: string
  outputRoot: string
  sessionId: string
  /** 时间分片起点（秒）；不分片时为 0。 */
  chunkStart: number
  chunkEnd: number
  /** 产物类型：导出格式（txt/json/...）或 'media' 之类的辅助产物。 */
  artifact: string
  bytes: number
  sha256: string
  mediaHashes?: LedgerMediaEntry[]
  /** epoch 毫秒。 */
  at: number
  /** 产物绝对路径。续跑时直接复用这个路径，避免时间戳/重命名造成位置漂移。 */
  outputPath?: string
  sourceFingerprint?: string
  messageCount?: number
}

export interface UnitKey {
  sessionId: string
  chunkStart: number
  chunkEnd: number
  artifact: string
}

export interface LedgerReadResult {
  entries: LedgerUnit[]
  /** 被丢弃的行的原因统计（调试/自检用）。 */
  discarded: { truncatedTail: boolean; badJson: number; versionMismatch: number }
}

/** 单元键：会话 × 时间分片 × 产物。所有账本查询都归一化到这个键。 */
export function unitKeyOf(unit: UnitKey): string {
  return [
    String(unit.sessionId || ''),
    Number.isFinite(unit.chunkStart) ? Math.floor(unit.chunkStart) : 0,
    Number.isFinite(unit.chunkEnd) ? Math.floor(unit.chunkEnd) : 0,
    String(unit.artifact || ''),
  ].join('\u001f')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function coerceMediaHashes(value: unknown): LedgerMediaEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: LedgerMediaEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const relPath = String(item.path || '')
    const sha = String(item.sha256 || '')
    if (!relPath || !sha) continue
    out.push({
      path: relPath,
      sha256: sha,
      bytes: Number.isFinite(Number(item.bytes)) ? Math.max(0, Math.floor(Number(item.bytes))) : 0,
    })
  }
  return out.length > 0 ? out : undefined
}

function parseLine(line: string): { entry?: LedgerUnit; badJson?: boolean; versionMismatch?: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { badJson: true }
  }
  if (!isRecord(parsed)) return { badJson: true }
  if (Number(parsed.v) !== LEDGER_VERSION) return { versionMismatch: true }
  const sessionId = String(parsed.sessionId || '')
  const artifact = String(parsed.artifact || '')
  if (!sessionId || !artifact) return { badJson: true }
  return {
    entry: {
      v: LEDGER_VERSION,
      taskId: String(parsed.taskId || ''),
      outputRoot: String(parsed.outputRoot || ''),
      sessionId,
      chunkStart: Number.isFinite(Number(parsed.chunkStart)) ? Math.floor(Number(parsed.chunkStart)) : 0,
      chunkEnd: Number.isFinite(Number(parsed.chunkEnd)) ? Math.floor(Number(parsed.chunkEnd)) : 0,
      artifact,
      bytes: Number.isFinite(Number(parsed.bytes)) ? Math.max(0, Math.floor(Number(parsed.bytes))) : 0,
      sha256: String(parsed.sha256 || ''),
      mediaHashes: coerceMediaHashes(parsed.mediaHashes),
      at: Number.isFinite(Number(parsed.at)) ? Math.floor(Number(parsed.at)) : 0,
      outputPath: typeof parsed.outputPath === 'string' ? parsed.outputPath : undefined,
      sourceFingerprint: typeof parsed.sourceFingerprint === 'string' ? parsed.sourceFingerprint : undefined,
      messageCount: Number.isFinite(parsed.messageCount) ? Math.max(0, Math.floor(Number(parsed.messageCount))) : undefined,
    },
  }
}

/** POSIX 风格相对路径：账本要跨平台可比（Windows 的 `\` 与 POSIX 的 `/` 不能混）。 */
export function toLedgerRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/')
}

export class ExportLedger {
  public readonly ledgerPath: string
  private readonly outputRoot: string

  constructor(outputRoot: string) {
    this.outputRoot = path.resolve(outputRoot)
    this.ledgerPath = path.join(this.outputRoot, LEDGER_FILE_NAME)
  }

  get root(): string {
    return this.outputRoot
  }

  /**
   * 读账本。坏文件/坏行不抛异常：账本不可用只意味着"这次全量重导"。
   * 被截断的最后一行（没有以 \n 收尾且解析失败）直接忽略 —— 崩溃正好发生在写得一半。
   */
  async read(): Promise<LedgerReadResult> {
    const discarded = { truncatedTail: false, badJson: 0, versionMismatch: 0 }
    let raw: string
    try {
      raw = await fs.promises.readFile(this.ledgerPath, 'utf-8')
    } catch {
      return { entries: [], discarded }
    }
    if (!raw) return { entries: [], discarded }

    const lines = raw.split('\n')
    // 最后一段只有在文件以 \n 收尾时才是空串（正常）；否则它可能是被截断的半行
    const lastIsPartial = !raw.endsWith('\n')
    const entries: LedgerUnit[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const isLast = i === lines.length - 1
      const line = lines[i]
      if (!line) continue
      if (isLast && lastIsPartial) {
        // 半行：解析成功就接受（内容恰好完整），失败则忽略
        const parsed = parseLine(line)
        if (parsed.entry) {
          entries.push(parsed.entry)
        } else {
          discarded.truncatedTail = true
        }
        continue
      }
      const parsed = parseLine(line)
      if (parsed.entry) {
        entries.push(parsed.entry)
      } else if (parsed.versionMismatch) {
        discarded.versionMismatch += 1
      } else {
        discarded.badJson += 1
      }
    }
    return { entries, discarded }
  }

  /** 已完成单元索引：键 → 最后一条记录（后写的覆盖先写的）。 */
  async buildIndex(): Promise<Map<string, LedgerUnit>> {
    const { entries } = await this.read()
    const index = new Map<string, LedgerUnit>()
    for (const entry of entries) {
      index.set(unitKeyOf(entry), entry)
    }
    return index
  }

  /**
   * 追加一个已完成单元：写入 + fsync 之后才返回。
   * 只有 fsync 成功返回，调用方才敢认为"这个单元可以跳过"。
   */
  async append(unit: Omit<LedgerUnit, 'v' | 'at' | 'outputRoot'> & { v?: number; at?: number; outputRoot?: string }): Promise<LedgerUnit> {
    const entry: LedgerUnit = {
      v: LEDGER_VERSION,
      taskId: String(unit.taskId || ''),
      outputRoot: String(unit.outputRoot || this.outputRoot),
      sessionId: String(unit.sessionId || ''),
      chunkStart: Number.isFinite(unit.chunkStart) ? Math.floor(unit.chunkStart) : 0,
      chunkEnd: Number.isFinite(unit.chunkEnd) ? Math.floor(unit.chunkEnd) : 0,
      artifact: String(unit.artifact || ''),
      bytes: Number.isFinite(unit.bytes) ? Math.max(0, Math.floor(unit.bytes)) : 0,
      sha256: String(unit.sha256 || ''),
      mediaHashes: coerceMediaHashes(unit.mediaHashes),
      at: Number.isFinite(unit.at) ? Math.floor(Number(unit.at)) : Date.now(),
      outputPath: unit.outputPath ? path.resolve(unit.outputPath) : undefined,
      sourceFingerprint: unit.sourceFingerprint,
      messageCount: Number.isFinite(unit.messageCount) ? Math.max(0, Math.floor(Number(unit.messageCount))) : undefined,
    }
    if (!entry.sessionId || !entry.artifact) {
      throw new Error('export ledger: sessionId/artifact 不能为空')
    }
    await fs.promises.mkdir(this.outputRoot, { recursive: true })
    const handle = await fs.promises.open(this.ledgerPath, 'a')
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return entry
  }

  /** 压缩账本：只保留每个单元的最后一条记录（重写走 tmp → os.replace）。 */
  async compact(): Promise<number> {
    const index = await this.buildIndex()
    const lines = [...index.values()].map((entry) => JSON.stringify(entry))
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : ''
    await atomicWriteText(this.ledgerPath, body)
    return lines.length
  }

  /** 清空账本（"全量重导"用）。走原子写，避免把文件截成半截。 */
  async reset(): Promise<void> {
    await atomicWriteText(this.ledgerPath, '')
  }
}

export interface ArtifactVerification {
  ok: boolean
  reason?: 'missing' | 'size-mismatch' | 'sha-mismatch'
  bytes?: number
  sha256?: string
}

/**
 * 校验磁盘产物是否仍是账本里那一个。
 * 续跑跳过的唯一依据是"账本里有记录 **且** 磁盘上还是同一份内容"：
 * 缺文件、字节数不符、哈希不符一律当作没完成（重导），绝不因为"账本说完成了"就跳过。
 */
export async function verifyArtifact(artifactPath: string, expected: { bytes?: number; sha256?: string }): Promise<ArtifactVerification> {
  let buffer: Buffer
  try {
    buffer = await fs.promises.readFile(artifactPath)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  const bytes = buffer.byteLength
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  if (Number.isFinite(expected.bytes) && Number(expected.bytes) >= 0 && bytes !== Math.floor(Number(expected.bytes))) {
    return { ok: false, reason: 'size-mismatch', bytes, sha256 }
  }
  if (expected.sha256 && sha256 !== expected.sha256) {
    return { ok: false, reason: 'sha-mismatch', bytes, sha256 }
  }
  return { ok: true, bytes, sha256 }
}

/** 计算结果文件的 `{ bytes, sha256 }`（写完后立即调用，避免二次读整文件算大小）。 */
export async function fingerprintFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const hash = crypto.createHash('sha256')
    const stream = handle.createReadStream()
    let bytes = 0
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      bytes += buf.byteLength
      hash.update(buf)
    }
    return { bytes, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

export function sha256OfBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}
