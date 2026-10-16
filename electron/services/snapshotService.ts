/**
 * 写前自动快照（v1.2 §10.3 ③："所有写操作走显式确认流程：自动快照 → 写入 → 可一键回滚"）。
 *
 * 快照落在 `<userData>/snapshots/<timestamp>-<reason>/`，包含：
 * - 被影响的库文件**连同一份 `-wal`/`-shm`**（WAL 里可能有未合并的已提交数据，
 *   只拷 `.db` 会在恢复时丢掉最近的改动 —— 这是"快照看起来对、恢复回去少数据"的经典坑）；
 * - `manifest.json`：文件清单、大小、sha256、原因、创建时间与恢复说明。
 *
 * 保留策略：只留最近 10 份（`RETENTION`），按目录名里的时间戳排序，更老的整目录删除。
 *
 * 红线：快照只**读**用户的库、只写 `<userData>/snapshots`；恢复时也只写回用户
 * 明确点名的库文件（这是"回滚"这个动作本身的定义），并且在恢复前先把现场
 * 另存一份 `<dir>/_restore-backup-<ts>/`，避免回滚本身不可逆。
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteText } from './export/atomicWrite'

export const SNAPSHOT_DIR_NAME = 'snapshots'
export const SNAPSHOT_MANIFEST_NAME = 'manifest.json'
/** 保留最近多少份快照（§10.3 要求"保留最近 10 个"）。 */
export const SNAPSHOT_RETENTION = 10

export type SnapshotReason =
  | 'anti-revoke-install'
  | 'anti-revoke-uninstall'
  | 'sns-block-delete'
  | 'sns-delete'
  | 'session-read-status'
  | 'manual'
  | string

export interface SnapshotFileEntry {
  /** 源绝对路径。 */
  source: string
  /** 快照目录内的文件名（同名文件加后缀去重）。 */
  file: string
  bytes: number
  sha256: string
  /** 'main' = 库主体；'wal' / 'shm' = 附属文件；'other' = 其它。 */
  role: 'main' | 'wal' | 'shm' | 'other'
}

export interface SnapshotManifest {
  v: number
  id: string
  reason: SnapshotReason
  createdAt: string
  createdAtMs: number
  /** 涉及的主库路径（绝对）。 */
  databases: string[]
  files: SnapshotFileEntry[]
  totalBytes: number
  /** 恢复说明（人类可读，也供诊断页直接展示）。 */
  restoreInstructions: string
}

export interface SnapshotResult {
  ok: boolean
  dir?: string
  manifest?: SnapshotManifest
  error?: string
}

export interface SnapshotOptions {
  /** 快照根目录：`<userData>/snapshots`。 */
  rootDir: string
  reason: SnapshotReason
  /** 涉及的主库路径（`session.db` / `sns.db` / contact 库等）。 */
  databasePaths: string[]
}

const SNAPSHOT_VERSION = 1

function timestampId(date: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    pad(date.getMilliseconds(), 3),
  ].join('')
}

function sanitizeReason(reason: string): string {
  const cleaned = String(reason || 'write')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'write'
}

async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
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
}

function roleOf(sourcePath: string, mainPath: string): SnapshotFileEntry['role'] {
  if (sourcePath === mainPath) return 'main'
  if (sourcePath === `${mainPath}-wal`) return 'wal'
  if (sourcePath === `${mainPath}-shm`) return 'shm'
  return 'other'
}

/** 主库 + `-wal` / `-shm`。顺序固定，便于测试与人工核对。 */
export function snapshotFileCandidates(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
}

export interface AccountDatabaseLayout {
  /** 账号目录（如 `D:\\xwechat_files\\wxid_xxx_abcd`）。 */
  accountDir: string
  /** 该账号下实际存在的库主文件（session / contact / sns 等）。 */
  databasePaths: string[]
  /** 解析过程中发现的库文件数量上限是否被触发（库特别多时只快照前 N 个）。 */
  truncated: boolean
}

/** 库文件命名的白名单形状：只认 `.db`，避免把媒体/日志也当库快照进来。 */
const MAX_SNAPSHOT_DATABASES = 40
const MAX_SNAPSHOT_DEPTH = 4

/**
 * 解析账号目录下所有"库文件"（`.db`）。
 *
 * 为什么不只快照 `session.db`：一次写操作可能落在 `session.db`，也可能落在
 * `contact.db` / `sns.db` / 消息分片表所在的其它 `.db` 上（SNS 删除、改备注等）。
 * 快照漏了哪个库，回滚就不完整。深度与数量都有上限，避免极端目录结构下
 * 快照变成"全盘拷贝"。
 */
export async function resolveAccountDatabasePaths(accountDir: string): Promise<AccountDatabaseLayout> {
  const root = path.resolve(accountDir)
  const storageRoot = path.join(root, 'db_storage')
  const databasePaths: string[] = []
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > MAX_SNAPSHOT_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.db$/i.test(entry.name)) continue
      if (databasePaths.length >= MAX_SNAPSHOT_DATABASES) {
        truncated = true
        return
      }
      databasePaths.push(full)
    }
  }
  // Snapshots/restores are restricted to WeChat's database storage tree. The
  // account root also contains cache and media databases that must not enter
  // the restore allowlist.
  await walk(storageRoot, 0)
  databasePaths.sort((a, b) => a.localeCompare(b))
  return { accountDir: root, databasePaths, truncated }
}

interface SnapshotSourceFingerprint {
  metadata: string
  bytes: number
  sha256: string
}

function sourceStatSignature(stat: fs.Stats): string {
  // Access time is intentionally excluded because reading a source can update it.
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.blksize,
    stat.blocks,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.birthtimeMs,
  ].join(':')
}

async function captureSnapshotSource(filePath: string): Promise<SnapshotSourceFingerprint> {
  const before = await fs.promises.stat(filePath)
  if (!before.isFile()) throw new Error(`快照来源不是普通文件：${filePath}`)
  let content: { sha256: string; bytes: number }
  let after: fs.Stats
  try {
    content = await sha256File(filePath)
    after = await fs.promises.stat(filePath)
  } catch (error) {
    // Only ENOENT from the initial stat means that an optional sidecar was
    // absent. Disappearance after it was observed is a source change.
    if (isNotFound(error)) throw new Error(`快照来源在校验期间消失：${filePath}`)
    throw error
  }
  if (!after.isFile() || sourceStatSignature(before) !== sourceStatSignature(after) || content.bytes !== after.size) {
    throw new Error(`快照来源在校验期间发生变化：${filePath}`)
  }
  return { metadata: sourceStatSignature(after), ...content }
}

function sameSnapshotSource(left: SnapshotSourceFingerprint, right: SnapshotSourceFingerprint): boolean {
  return left.metadata === right.metadata && left.bytes === right.bytes && left.sha256 === right.sha256
}

/**
 * Write a complete snapshot. Every enumerated main DB must exist; only a missing
 * WAL/SHM sidecar may be omitted. Source metadata and hashes are checked around
 * the copies so a concurrent write cannot produce a mixed snapshot.
 */
export async function createSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const rootDir = path.resolve(options.rootDir)
  const reason = sanitizeReason(options.reason)
  const createdAt = new Date()
  const id = `${timestampId(createdAt)}-${reason}`
  const dir = path.join(rootDir, id)
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    const files: SnapshotFileEntry[] = []
    const databases: string[] = []
    const usedNames = new Set<string>()
    const sourceFingerprints = new Map<string, SnapshotSourceFingerprint>()

    for (const databasePath of options.databasePaths) {
      const normalized = path.resolve(databasePath)
      if (databases.includes(normalized)) continue
      databases.push(normalized)
      for (const candidate of snapshotFileCandidates(normalized)) {
        let fingerprint: SnapshotSourceFingerprint
        try {
          fingerprint = await captureSnapshotSource(candidate)
        } catch (error) {
          if (roleOf(candidate, normalized) !== 'main' && isNotFound(error)) continue
          const role = roleOf(candidate, normalized)
          const detail = String((error as Error)?.message || error)
          throw new Error(role === 'main'
            ? `主数据库不可用，无法创建完整快照：${candidate}（${detail}）`
            : `数据库附属文件不可用，无法创建一致快照：${candidate}（${detail}）`)
        }
        sourceFingerprints.set(candidate, fingerprint)
      }
    }

    if (databases.length === 0) throw new Error('至少需要一个可快照的主数据库')

    for (const databasePath of databases) {
      for (const candidate of snapshotFileCandidates(databasePath)) {
        const sourceFingerprint = sourceFingerprints.get(candidate)
        if (!sourceFingerprint) continue
        let fileName = path.basename(candidate)
        if (usedNames.has(fileName)) {
          fileName = `${usedNames.size}-${fileName}`
        }
        usedNames.add(fileName)
        const target = path.join(dir, fileName)
        await fs.promises.copyFile(candidate, target)
        const copied = await captureSnapshotSource(target)
        if (copied.bytes !== sourceFingerprint.bytes || copied.sha256 !== sourceFingerprint.sha256) {
          throw new Error(`快照拷贝内容不符：${candidate}`)
        }
        files.push({
          source: candidate,
          file: fileName,
          bytes: copied.bytes,
          sha256: copied.sha256,
          role: roleOf(candidate, databasePath),
        })
      }
    }

    // Re-enumerate all three paths after copying. This catches added/removed
    // sidecars as well as DB/WAL/SHM writes during the copy window.
    for (const databasePath of databases) {
      for (const candidate of snapshotFileCandidates(databasePath)) {
        const initial = sourceFingerprints.get(candidate)
        let current: SnapshotSourceFingerprint | undefined
        try {
          current = await captureSnapshotSource(candidate)
        } catch (error) {
          if (roleOf(candidate, databasePath) !== 'main' && isNotFound(error)) {
            if (initial) throw new Error(`快照来源在复制期间消失：${candidate}`)
            continue
          }
          throw new Error(`快照来源在复制期间不可用或发生变化：${candidate}（${String((error as Error)?.message || error)}）`)
        }
        if (!initial || !sameSnapshotSource(initial, current)) {
          throw new Error(`快照来源在复制期间发生变化：${candidate}`)
        }
      }
    }

    const totalBytes = files.reduce((sum, entry) => sum + entry.bytes, 0)
    const manifest: SnapshotManifest = {
      v: SNAPSHOT_VERSION,
      id,
      reason,
      createdAt: createdAt.toISOString(),
      createdAtMs: createdAt.getTime(),
      databases,
      files,
      totalBytes,
      restoreInstructions:
        '恢复：关闭微信与 Weport 后，把本目录内每个文件的 sha256 与 manifest.json 中对应条目核对一致，'
        + '再按 "file" 字段覆盖回 "source" 指向的原路径（`.db` / `.db-wal` / `.db-shm` 必须一起覆盖，'
        + '只覆盖 `.db` 会丢掉 WAL 中未合并的已提交数据）。恢复前建议再手工备份一次现场。',
    }
    await atomicWriteText(path.join(dir, SNAPSHOT_MANIFEST_NAME), JSON.stringify(manifest, null, 2))
    return { ok: true, dir, manifest }
  } catch (error) {
    return { ok: false, dir, error: String((error as Error)?.message || error) }
  }
}

export interface SnapshotInfo {
  id: string
  dir: string
  reason: string
  createdAt: string
  createdAtMs: number
  files: number
  totalBytes: number
  databases: string[]
}

/** 列出快照（新→旧）。manifest 坏掉的目录会被跳过，但不删除。 */
export async function listSnapshots(rootDir: string): Promise<SnapshotInfo[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(path.resolve(rootDir), { withFileTypes: true })
  } catch {
    return []
  }
  const out: SnapshotInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(path.resolve(rootDir), entry.name)
    try {
      const raw = await fs.promises.readFile(path.join(dir, SNAPSHOT_MANIFEST_NAME), 'utf-8')
      const manifest = JSON.parse(raw) as SnapshotManifest
      if (!manifest?.id || !Array.isArray(manifest.files)) continue
      out.push({
        id: String(manifest.id),
        dir,
        reason: String(manifest.reason || ''),
        createdAt: String(manifest.createdAt || ''),
        createdAtMs: Number(manifest.createdAtMs) || 0,
        files: manifest.files.length,
        totalBytes: Number(manifest.totalBytes) || manifest.files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0),
        databases: Array.isArray(manifest.databases) ? manifest.databases.map(String) : [],
      })
    } catch {
      continue
    }
  }
  out.sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id))
  return out
}

/** 只保留最近 `keep` 份，返回被删除的目录。 */
export async function applyRetention(rootDir: string, keep: number = SNAPSHOT_RETENTION): Promise<string[]> {
  const keepCount = Math.max(1, Math.floor(keep))
  const snapshots = await listSnapshots(rootDir)
  const removed: string[] = []
  for (const snapshot of snapshots.slice(keepCount)) {
    try {
      await fs.promises.rm(snapshot.dir, { recursive: true, force: true })
      removed.push(snapshot.dir)
    } catch {
      /* 删不掉就留着，下次再删 */
    }
  }
  return removed
}

export async function readSnapshotManifest(dir: string): Promise<SnapshotManifest | null> {
  try {
    const resolvedDir = path.resolve(dir)
    const dirStat = await fs.promises.lstat(resolvedDir)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null
    const manifestPath = path.join(resolvedDir, SNAPSHOT_MANIFEST_NAME)
    const manifestStat = await fs.promises.lstat(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null
    const raw = await fs.promises.readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(raw) as SnapshotManifest
    if (!manifest?.id || !Array.isArray(manifest.files)) return null
    return manifest
  } catch {
    return null
  }
}

export interface RestoreResult {
  ok: boolean
  restored: string[]
  /** WAL/SHM sidecars removed because they were absent from the snapshot. */
  removed?: string[]
  /** Invalid manifest/content entries or the file that failed during replacement. */
  failed: Array<{ source: string; reason: string }>
  /** Pre-restore copies; retained for recovery after both success and failure. */
  backupDir?: string
  /** On a failed commit, reports which prior files were restored and any rollback failures. */
  rollback?: { complete: boolean; restoredOriginals: string[]; failed: Array<{ source: string; reason: string }> }
  error?: string
}

export interface RestoreSnapshotOptions {
  /** The currently selected WeChat account directory; restore is restricted to its db_storage DB/WAL/SHM files. */
  allowedAccountDir: string
}

interface RestorePlanEntry {
  source: string
  action: 'replace' | 'delete'
  snapshotFile?: string
  bytes?: number
  sha256?: string
  role: Exclude<SnapshotFileEntry['role'], 'other'>
}

export interface SnapshotVerificationResult {
  ok: boolean
  id?: string
  verifiedFiles: number
  totalBytes: number
  failed: Array<{ source: string; reason: string }>
  error?: string
}

interface SnapshotInspection extends SnapshotVerificationResult {
  manifest?: SnapshotManifest
  plan: RestorePlanEntry[]
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate)
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function inspectSnapshotContents(dir: string): Promise<SnapshotInspection> {
  const snapshotDir = path.resolve(dir)
  const manifest = await readSnapshotManifest(snapshotDir)
  if (!manifest) {
    return {
      ok: false,
      verifiedFiles: 0,
      totalBytes: 0,
      failed: [{ source: path.join(snapshotDir, SNAPSHOT_MANIFEST_NAME), reason: 'manifest.json 缺失或损坏' }],
      plan: [],
      error: 'manifest.json 缺失或损坏',
    }
  }
  if (manifest.v !== SNAPSHOT_VERSION || manifest.id !== path.basename(snapshotDir) || !Array.isArray(manifest.databases)) {
    const error = '快照清单版本或目录标识无效'
    return { ok: false, id: manifest.id, verifiedFiles: 0, totalBytes: 0, failed: [{ source: '', reason: error }], plan: [], error }
  }

  const failed: Array<{ source: string; reason: string }> = []
  const databasePaths = new Set<string>()
  if (manifest.databases.length === 0) {
    failed.push({ source: SNAPSHOT_MANIFEST_NAME, reason: '快照清单必须至少包含一个数据库' })
  }
  for (const rawDatabase of manifest.databases) {
    if (typeof rawDatabase !== 'string' || !path.isAbsolute(rawDatabase)) {
      failed.push({ source: String(rawDatabase || ''), reason: '清单里的数据库路径无效' })
      continue
    }
    const databasePath = path.resolve(rawDatabase)
    if (!/\.db$/i.test(databasePath) || databasePaths.has(databasePath)) {
      failed.push({ source: databasePath, reason: '清单里的数据库路径无效或重复' })
      continue
    }
    databasePaths.add(databasePath)
  }

  const snapshotFiles = new Set<string>()
  const sourceFiles = new Set<string>()
  const plan: RestorePlanEntry[] = []
  for (const rawEntry of manifest.files as unknown[]) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      failed.push({ source: '', reason: '清单包含无效文件条目' })
      continue
    }
    const entry = rawEntry as Partial<SnapshotFileEntry>
    const file = typeof entry.file === 'string' ? entry.file : ''
    const source = typeof entry.source === 'string' && path.isAbsolute(entry.source) ? path.resolve(entry.source) : ''
    if (!file || path.basename(file) !== file || /[\\/:\0]/.test(file)) {
      failed.push({ source, reason: '快照文件名必须是快照目录内的单一文件名' })
      continue
    }
    if (!source) {
      failed.push({ source: String(entry.source || ''), reason: '清单里的恢复目标路径无效' })
      continue
    }
    if (snapshotFiles.has(file) || sourceFiles.has(source)) {
      failed.push({ source, reason: '清单里重复列出了快照文件或恢复目标' })
      continue
    }
    snapshotFiles.add(file)
    sourceFiles.add(source)

    const expectedRole = [...databasePaths].map((databasePath) => roleOf(source, databasePath)).find((role) => role !== 'other')
    if (!expectedRole || entry.role !== expectedRole) {
      failed.push({ source, reason: '恢复目标必须是清单数据库的 .db、-wal 或 -shm 文件' })
      continue
    }
    if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      failed.push({ source, reason: '快照文件的大小或 sha256 字段无效' })
      continue
    }

    const snapshotFile = path.resolve(snapshotDir, file)
    if (!isPathWithin(snapshotDir, snapshotFile)) {
      failed.push({ source, reason: '快照文件路径越出快照目录' })
      continue
    }
    try {
      const stat = await fs.promises.lstat(snapshotFile)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        failed.push({ source, reason: '快照内容必须是普通文件' })
        continue
      }
      const actual = await sha256File(snapshotFile)
      if (actual.bytes !== entry.bytes) {
        failed.push({ source, reason: `快照文件大小不符（期望 ${entry.bytes}，实得 ${actual.bytes}）` })
        continue
      }
      if (actual.sha256 !== entry.sha256.toLowerCase()) {
        failed.push({ source, reason: '快照文件 sha256 不符' })
        continue
      }
      plan.push({
        source,
        action: 'replace',
        snapshotFile,
        bytes: entry.bytes,
        sha256: entry.sha256.toLowerCase(),
        role: expectedRole,
      })
    } catch (error) {
      failed.push({ source, reason: `快照文件不可读：${String((error as Error)?.message || error)}` })
    }
  }

  for (const databasePath of databasePaths) {
    const mainFiles = plan.filter((entry) => entry.source === databasePath && entry.role === 'main')
    if (mainFiles.length !== 1) {
      failed.push({ source: databasePath, reason: '快照必须为每个清单数据库包含且仅包含一个主库文件' })
    }
  }

  const totalBytes = plan.reduce((sum, entry) => sum + (entry.bytes || 0), 0)
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes !== totalBytes) {
    failed.push({ source: SNAPSHOT_MANIFEST_NAME, reason: '清单总字节数与文件记录不符' })
  }
  return {
    ok: failed.length === 0,
    id: manifest.id,
    verifiedFiles: plan.length,
    totalBytes,
    failed,
    manifest,
    plan,
    error: failed.length ? '快照清单或内容校验未通过' : undefined,
  }
}

/** Validate the local snapshot only; this does not inspect or require the currently selected account. */
export async function verifySnapshot(dir: string): Promise<SnapshotVerificationResult> {
  const inspection = await inspectSnapshotContents(dir)
  return {
    ok: inspection.ok,
    id: inspection.id,
    verifiedFiles: inspection.verifiedFiles,
    totalBytes: inspection.totalBytes,
    failed: inspection.failed,
    error: inspection.error,
  }
}

async function stageVerifiedFile(source: string, destination: string, expected: { bytes: number; sha256: string }): Promise<string> {
  const staged = path.join(
    path.dirname(destination),
    `.weport-restore-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  try {
    await fs.promises.copyFile(source, staged, fs.constants.COPYFILE_EXCL)
    const actual = await sha256File(staged)
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error('暂存文件校验失败')
    return staged
  } catch (error) {
    await fs.promises.rm(staged, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Restore only manifest-listed files inside the selected account's db_storage.
 * Validate all snapshot files, stage replacements beside their destinations,
 * and keep verified copies of the current files before committing any rename.
 * If a rename fails, roll attempted paths back and report any rollback failure.
 */
export async function restoreSnapshot(dir: string, options: RestoreSnapshotOptions): Promise<RestoreResult> {
  const snapshotDir = path.resolve(dir)
  if (!options?.allowedAccountDir) {
    return { ok: false, restored: [], failed: [], error: '恢复前必须指定当前账号目录' }
  }

  const inspection = await inspectSnapshotContents(snapshotDir)
  if (!inspection.ok || !inspection.manifest) {
    return { ok: false, restored: [], failed: inspection.failed, error: inspection.error || '快照清单或内容校验未通过' }
  }
  const manifest = inspection.manifest

  let accountDir: string
  let storageDir: string
  let storageReal: string
  try {
    accountDir = path.resolve(options.allowedAccountDir)
    const accountReal = await fs.promises.realpath(accountDir)
    storageDir = path.join(accountDir, 'db_storage')
    const storageStat = await fs.promises.lstat(storageDir)
    if (!storageStat.isDirectory() || storageStat.isSymbolicLink()) throw new Error('db_storage 不是普通目录')
    storageReal = await fs.promises.realpath(storageDir)
    if (!isPathWithin(accountReal, storageReal)) throw new Error('db_storage 指向账号目录之外')
  } catch (error) {
    return {
      ok: false,
      restored: [],
      failed: [],
      error: `无法验证当前账号数据库目录：${String((error as Error)?.message || error)}`,
    }
  }

  const failed: Array<{ source: string; reason: string }> = []
  const databasePaths = new Set<string>()
  for (const rawDatabase of manifest.databases) {
    if (typeof rawDatabase !== 'string' || !path.isAbsolute(rawDatabase)) {
      failed.push({ source: String(rawDatabase || ''), reason: '清单里的数据库路径无效' })
      continue
    }
    const databasePath = path.resolve(rawDatabase)
    if (!/\.db$/i.test(databasePath) || !isPathWithin(storageDir, databasePath)) {
      failed.push({ source: databasePath, reason: '数据库不在当前账号的 db_storage 目录内' })
      continue
    }
    try {
      const parentReal = await fs.promises.realpath(path.dirname(databasePath))
      if (!isPathWithin(storageReal, parentReal)) {
        failed.push({ source: databasePath, reason: '数据库目录通过链接指向 db_storage 之外' })
        continue
      }
      const stat = await fs.promises.lstat(databasePath)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        failed.push({ source: databasePath, reason: '数据库路径不是普通文件' })
        continue
      }
    } catch (error) {
      if (!isNotFound(error)) {
        failed.push({ source: databasePath, reason: `数据库路径不可访问：${String((error as Error)?.message || error)}` })
        continue
      }
      // A database may have been deleted since its snapshot was created.
    }
    if (databasePaths.has(databasePath)) {
      failed.push({ source: databasePath, reason: '清单里重复列出了数据库' })
      continue
    }
    databasePaths.add(databasePath)
  }

  const plan = inspection.plan.map((entry) => ({ ...entry }))
  const sourceFiles = new Set(plan.map((entry) => entry.source))
  for (const entry of plan) {
    if (!isPathWithin(storageDir, entry.source)) {
      failed.push({ source: entry.source, reason: '恢复目标不在当前账号的 db_storage 目录内' })
      continue
    }
    try {
      const sourceParent = await fs.promises.realpath(path.dirname(entry.source))
      if (!isPathWithin(storageReal, sourceParent)) {
        failed.push({ source: entry.source, reason: '恢复目标目录通过链接指向 db_storage 之外' })
        continue
      }
      try {
        const destinationStat = await fs.promises.lstat(entry.source)
        if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
          failed.push({ source: entry.source, reason: '恢复目标不是普通文件' })
        }
      } catch (error) {
        if (!isNotFound(error)) {
          failed.push({ source: entry.source, reason: `恢复目标不可访问：${String((error as Error)?.message || error)}` })
        }
      }
    } catch (error) {
      failed.push({ source: entry.source, reason: `恢复目标目录不可访问：${String((error as Error)?.message || error)}` })
    }
  }

  // The file list is also an existence record for sidecars. An omitted WAL/SHM
  // must be removed if it appeared afterward, otherwise it could be paired with
  // the restored main database. A main database is never deleted by omission.
  for (const databasePath of databasePaths) {
    for (const candidate of snapshotFileCandidates(databasePath)) {
      const source = path.resolve(candidate)
      if (sourceFiles.has(source)) continue
      const role = roleOf(source, databasePath)
      if (role !== 'wal' && role !== 'shm') continue
      try {
        const parentReal = await fs.promises.realpath(path.dirname(source))
        if (!isPathWithin(storageReal, parentReal)) {
          failed.push({ source, reason: '恢复目标目录通过链接指向 db_storage 之外' })
          continue
        }
        try {
          const destinationStat = await fs.promises.lstat(source)
          if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
            failed.push({ source, reason: '待删除的数据库文件不是普通文件' })
            continue
          }
        } catch (error) {
          if (!isNotFound(error)) {
            failed.push({ source, reason: `待删除的数据库文件不可访问：${String((error as Error)?.message || error)}` })
            continue
          }
        }
        sourceFiles.add(source)
        plan.push({ source, action: 'delete', role })
      } catch (error) {
        failed.push({ source, reason: `无法验证待删除文件：${String((error as Error)?.message || error)}` })
      }
    }
  }

  // Remove stale sidecars first and replace/remove each main DB last. No reader
  // can observe the intermediate state while the WCDB maintenance lease is held.
  const operationOrder = (entry: RestorePlanEntry) =>
    (entry.role === 'main' ? 2 : 0) + (entry.action === 'replace' ? 1 : 0)
  plan.sort((a, b) => operationOrder(a) - operationOrder(b))

  if (failed.length > 0) {
    return { ok: false, restored: [], failed, error: '快照清单或内容校验未通过，已中止恢复（未改动任何库文件）' }
  }

  const backupParent = path.dirname(snapshotDir)
  const prepared: Array<RestorePlanEntry & {
    existed: boolean
    backupFile?: string
    backupFingerprint?: { bytes: number; sha256: string }
    stagedFile?: string
  }> = []
  let backupDir: string | undefined
  try {
    backupDir = await fs.promises.mkdtemp(path.join(backupParent, `_restore-backup-${timestampId()}-`))
    for (let index = 0; index < plan.length; index += 1) {
      const entry = plan[index]
      let existed = false
      let backupFile: string | undefined
      let backupFingerprint: { bytes: number; sha256: string } | undefined
      let beforeStat: fs.Stats | undefined
      try {
        beforeStat = await fs.promises.lstat(entry.source)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      if (beforeStat) {
        if (beforeStat.isSymbolicLink() || !beforeStat.isFile()) throw new Error('恢复目标已变为非普通文件')
        existed = true
        const beforeHash = await sha256File(entry.source)
        backupFile = path.join(backupDir, `${String(index).padStart(3, '0')}-${path.basename(entry.source)}`)
        await fs.promises.copyFile(entry.source, backupFile, fs.constants.COPYFILE_EXCL)
        backupFingerprint = await sha256File(backupFile)
        const afterStat = await fs.promises.lstat(entry.source)
        const afterHash = await sha256File(entry.source)
        if (
          afterStat.isSymbolicLink() || !afterStat.isFile() ||
          beforeStat.size !== afterStat.size || beforeStat.mtimeMs !== afterStat.mtimeMs ||
          beforeHash.bytes !== backupFingerprint.bytes || beforeHash.sha256 !== backupFingerprint.sha256 ||
          afterHash.bytes !== backupFingerprint.bytes || afterHash.sha256 !== backupFingerprint.sha256
        ) throw new Error('恢复目标在备份期间发生变化')
      }
      const stagedFile = entry.action === 'replace'
        ? await stageVerifiedFile(entry.snapshotFile!, entry.source, { bytes: entry.bytes!, sha256: entry.sha256! })
        : undefined
      prepared.push({ ...entry, existed, backupFile, backupFingerprint, stagedFile })
    }
  } catch (error) {
    await Promise.all(prepared.filter((entry) => entry.stagedFile).map((entry) => fs.promises.rm(entry.stagedFile!, { force: true }).catch(() => undefined)))
    if (backupDir) await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
    const source = plan[prepared.length]?.source || plan[0]?.source || ''
    return {
      ok: false,
      restored: [],
      failed: [{ source, reason: `写回前准备失败：${String((error as Error)?.message || error)}` }],
      error: '写回前准备失败，未改动任何库文件',
    }
  }

  const attempted: typeof prepared = []
  const restored: string[] = []
  const removed: string[] = []
  for (const entry of prepared) {
    try {
      if (entry.existed) {
        const currentStat = await fs.promises.lstat(entry.source)
        if (currentStat.isSymbolicLink() || !currentStat.isFile()) throw new Error('恢复目标在准备期间变为非普通文件')
        const current = await sha256File(entry.source)
        if (current.bytes !== entry.backupFingerprint!.bytes || current.sha256 !== entry.backupFingerprint!.sha256) {
          throw new Error('恢复目标在备份后发生变化')
        }
      } else {
        try {
          await fs.promises.lstat(entry.source)
          throw new Error('原本不存在的恢复目标在准备期间出现')
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
      }
      if (entry.action === 'delete' && !entry.existed) continue
      attempted.push(entry)
      if (entry.action === 'delete') {
        await fs.promises.unlink(entry.source)
        removed.push(entry.source)
      } else {
        await fs.promises.rename(entry.stagedFile!, entry.source)
        entry.stagedFile = undefined
        restored.push(entry.source)
      }
    } catch (error) {
      const rollbackFailed: Array<{ source: string; reason: string }> = []
      const rolledBack: string[] = []
      for (const prior of attempted.reverse()) {
        try {
          if (prior.existed) {
            const rollbackStage = await stageVerifiedFile(prior.backupFile!, prior.source, prior.backupFingerprint!)
            await fs.promises.rename(rollbackStage, prior.source)
          } else {
            await fs.promises.rm(prior.source, { force: true })
          }
          rolledBack.push(prior.source)
        } catch (rollbackError) {
          rollbackFailed.push({ source: prior.source, reason: String((rollbackError as Error)?.message || rollbackError) })
        }
      }
      await Promise.all(prepared.filter((item) => item.stagedFile).map((item) => fs.promises.rm(item.stagedFile!, { force: true }).catch(() => undefined)))
      const complete = rollbackFailed.length === 0
      return {
        ok: false,
        restored: [],
        failed: [{ source: entry.source, reason: `${entry.action === 'delete' ? '删除' : '替换'}失败：${String((error as Error)?.message || error)}` }],
        backupDir,
        rollback: { complete, restoredOriginals: rolledBack, failed: rollbackFailed },
        error: complete
          ? `恢复失败，已将 ${rolledBack.length} 个已尝试文件回滚到恢复前状态；备份保留在 ${backupDir}`
          : `恢复失败且回滚未完成；请使用 ${backupDir} 中的恢复前备份检查并手动修复`,
      }
    }
  }
  return { ok: true, restored, removed, failed: [], backupDir }
}

/**
 * 写操作的统一收口：**先快照，再执行**。
 * 快照失败 = 写操作不执行（§10.3"自动快照 → 写入"的顺序不能颠倒）。
 */
export async function withAutoSnapshot<T>(
  options: SnapshotOptions,
  run: () => Promise<T>,
): Promise<{ snapshot: SnapshotResult; result?: T }> {
  const snapshot = await createSnapshot(options)
  if (!snapshot.ok) return { snapshot }
  await applyRetention(options.rootDir, SNAPSHOT_RETENTION)
  const result = await run()
  return { snapshot, result }
}
