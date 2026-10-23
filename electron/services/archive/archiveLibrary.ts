import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { atomicWriteText } from '../export/atomicWrite'
import { sourceMessageIdentityHash } from '../export/sourceMessageIdentity'
import { assertInventory, captureInventory, proveCoverage, retentionBoundary, retentionProofFiles, unlinkInventoried, verifyFileFingerprint, verifyInventoryFile } from './archiveRetention'
import { assertStorageBoundary } from '../storageLocations'
import type { ArchiveAnnotations, ArchiveBookmark, ArchiveCleanupJournal, ArchiveEntry, ArchiveFile, ArchiveJob, ArchiveManifest, ArchiveMessage, ArchivePreflight, ArchiveRequest, ArchiveSchedule } from './types'

export const ARCHIVE_MANIFEST = 'weport-archive.json'
const MAX_JSON_BYTES = 512 * 1024 * 1024
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
export const archiveAccountHash = (account: string) => digest(account.trim().toLowerCase())
const AVAILABLE_MEDIA = new Set(['original', 'display', 'thumbnail', 'available'])
const MEDIA_STATUSES = new Set([...AVAILABLE_MEDIA, 'missing-locally', 'decryption-failed', 'unsupported', 'original-unavailable', 'not-requested'])
function validateMessageIdentity(message: ArchiveMessage) {
  const source = message.sourceIdentity
  if (!source || typeof source.localId !== 'string' || sourceMessageIdentityHash({ localId: source.localId, dbPath: source.db, tableName: source.table }) !== message.sourceIdentityHash) throw Error('归档消息精确来源与身份不符')
}
function mediaRelativePath(sessionPath: string, value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[a-z][a-z\d+.-]*:/i.test(value) || value.split('/').some(segment => !segment || segment === '..' || segment === '.')) throw Error('归档媒体包含不安全的相对路径')
  return path.posix.join(path.posix.dirname(sessionPath), value)
}
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
async function json(file: string): Promise<any> {
  if ((await fs.promises.stat(file)).size > MAX_JSON_BYTES) throw Error('归档 JSON 超过 512 MB，无法安全打开')
  return JSON.parse(await fs.promises.readFile(file, 'utf8'))
}
async function writeJson(file: string, value: unknown) { await atomicWriteText(file, JSON.stringify(value, null, 2)) }
async function hashFile(file: string): Promise<ArchiveFile> {
  const hash = createHash('sha256'); let bytes = 0
  for await (const data of fs.createReadStream(file)) { hash.update(data); bytes += data.length }
  return { path: file, bytes, sha256: hash.digest('hex') }
}
/** Reject traversal, absolute names and symlinks escaping the portable root. */
export async function archivePath(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(x => x === '..' || x === '.')) throw Error('归档包含不安全的相对路径')
  const base = await fs.promises.realpath(root), target = await fs.promises.realpath(path.join(base, relative))
  const rel = path.relative(base, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('归档文件越出目录边界')
  if (!(await fs.promises.stat(target)).isFile()) throw Error('归档条目不是文件')
  return target
}
async function walk(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw Error('归档不接受符号链接')
    if (entry.isDirectory()) result.push(...await walk(file)); else if (entry.isFile()) result.push(file)
  }
  return result
}
function relative(root: string, file: string) { const value = path.relative(root, file).split(path.sep).join('/'); if (!value || value.startsWith('..')) throw Error('导出产物越出归档目录'); return value }

export interface ArchiveDependencies {
  root: string
  currentAccount: () => string
  source: () => Promise<{ fingerprint: string | null; capability: 'live' | 'history-snapshot' | 'unavailable'; estimatedBytes?: number }>
  exportJson: (request: ArchiveRequest, output: string, progress: (value: { stage: string; cursor?: string; current?: number; total?: number }) => void, stopped: () => boolean) => Promise<{ success: boolean; failCount?: number; stopped?: boolean; sessionOutputPaths?: Record<string, string>; error?: string }>
  annotations: () => { favorites: Array<any>; marks: Array<any>; tags: Record<string, string[]> }
  task: { begin: (message: string) => void; progress: (stage: string, message: string, detail: Record<string, unknown>, percent?: number) => void; end: (state: 'done' | 'failed' | 'aborted', message: string) => void }
  resolvePath?: (value: string) => string
  sourceBusy?: () => boolean
  now?: () => number
  protectedPaths?: () => string[]
}

/** The library owns portable copies only. It never restores or writes WeChat databases. */
export class ArchiveLibrary {
  private entries: ArchiveEntry[] = []
  private jobs: ArchiveJob[] = []
  private schedules: ArchiveSchedule[] = []
  private cleanups: ArchiveCleanupJournal[] = []
  private saving: Promise<unknown> = Promise.resolve()
  private active: { id: string; cancelled: boolean } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private ready: Promise<void>
  private readerCache = new Map<string, { sha256: string; signature: string; messages: ArchiveMessage[] }>()
  constructor(private deps: ArchiveDependencies) { this.ready = this.load() }
  private now() { return this.deps.now?.() ?? Date.now() }
  private async load() {
    await fs.promises.mkdir(this.deps.root, { recursive: true })
    const file = path.join(this.deps.root, 'library.json')
    if (fs.existsSync(file)) {
      const data = await json(file)
      if (data.version !== 1 || !Array.isArray(data.entries) || !Array.isArray(data.jobs) || !Array.isArray(data.schedules)) throw Error('归档库索引格式不受支持；原文件已保留')
      const relocated = (value: string) => this.deps.resolvePath?.(value) || value
      const request = (value: ArchiveRequest) => ({ ...value, destination: relocated(value.destination) })
      this.entries = data.entries.map((entry: ArchiveEntry) => ({ ...entry, path: relocated(entry.path) }))
      this.jobs = data.jobs.map((job: ArchiveJob) => ({ ...job, staging: relocated(job.staging), finalPath: relocated(job.finalPath), request: request(job.request) }))
      this.schedules = data.schedules.map((schedule: ArchiveSchedule) => ({ ...schedule, request: request(schedule.request) }))
      this.cleanups = (data.cleanups || []).map((cleanup: ArchiveCleanupJournal) => ({ ...cleanup, destination: relocated(cleanup.destination) }))
      for (const cleanup of this.cleanups) {
        const entry = this.entries.find(item => item.archiveId === cleanup.archiveId)
        if (entry) { entry.retentionState = 'cleaning'; entry.retentionReason = '空间清理已开始；旧归档可能不完整，等待安全续跑' }
      }
      for (const job of this.jobs) if (job.state === 'running' || job.state === 'waiting') { job.state = 'interrupted'; job.error = '应用中断，校验来源后可续跑' }
      await this.save()
    }
  }
  private save() {
    // Schedule edits may arrive during hashing. Serialize index commits so an
    // earlier write cannot replace the durable cleanup intent after deletion.
    const saved = this.saving.then(() => writeJson(path.join(this.deps.root, 'library.json'), { version: 1, entries: this.entries, jobs: this.jobs.slice(-100), schedules: this.schedules, cleanups: this.cleanups }))
    this.saving = saved.catch(() => {})
    return saved
  }
  async status() { await this.ready; return { entries: this.entries.map(e => ({ ...e })), jobs: this.jobs.map(e => ({ ...e, request: { ...e.request } })), schedules: this.schedules.map(e => ({ ...e })), activeJobId: this.active?.id } }
  private validateRequest(request: ArchiveRequest) {
    if (!request || !request.accountId?.trim() || archiveAccountHash(request.accountId) !== archiveAccountHash(this.deps.currentAccount())) throw Error('账号已切换，请重新选择归档账号')
    if (!Array.isArray(request.sessionIds) || !request.sessionIds.length || request.sessionIds.some(id => typeof id !== 'string' || !id.trim())) throw Error('请至少选择一个会话')
    if (!path.isAbsolute(request.destination || '')) throw Error('请选择归档保存目录')
    if (request.dateRange && (!Number.isSafeInteger(request.dateRange.start) || !Number.isSafeInteger(request.dateRange.end) || request.dateRange.start < 0 || request.dateRange.end < 0 || (request.dateRange.end !== 0 && request.dateRange.end < request.dateRange.start))) throw Error('归档日期范围无效')
    if (!['best-available', 'original-only'].includes(request.mediaPolicy)) throw Error('媒体策略无效')
  }
  async preflight(request: ArchiveRequest): Promise<ArchivePreflight> {
    await this.ready
    const result: ArchivePreflight = { ok: false, errors: [], warnings: [], sourceCapability: 'unavailable' }
    try {
      this.validateRequest(request)
      if (this.active || this.deps.sourceBusy?.()) throw Error('已有导出或数据库任务，请等待结束')
      const source = await this.deps.source(); result.sourceCapability = source.capability
      if (!source.fingerprint || source.capability === 'unavailable') throw Error('当前连接不能读取历史记录')
      result.sourceFingerprint = source.fingerprint; result.estimatedBytes = source.estimatedBytes
      await fs.promises.mkdir(request.destination, { recursive: true })
      const probe = path.join(request.destination, '.weport-write-' + randomUUID())
      try { const handle = await fs.promises.open(probe, 'wx'); await handle.sync(); await handle.close() } finally { await fs.promises.rm(probe, { force: true }) }
      const space = await fs.promises.statfs(request.destination)
      result.freeBytes = Number(space.bavail) * Number(space.bsize)
      if (result.freeBytes < 64 * 1024 * 1024) throw Error('目标磁盘可用空间不足 64 MB')
      if (source.estimatedBytes && result.freeBytes < source.estimatedBytes * 2) result.warnings.push('磁盘空间可能不足；数据库大小仅是估算，媒体大小尚未知')
      if (source.capability === 'history-snapshot') result.warnings.push('此连接是历史快照，归档不包含快照之后的新消息')
      if (request.includeMedia) result.warnings.push(request.mediaPolicy === 'original-only' ? '仅保存可证明为原图的图片；显示版和缩略图会标为原图不可用' : '按本地最佳画质保存；本地未下载的文件无法恢复')
      result.ok = true
    } catch (e) { result.errors.push(errorText(e)) }
    return result
  }
  cancel() { if (!this.active) return false; this.active.cancelled = true; return true }
  async create(request: ArchiveRequest, retryId?: string, scheduleId?: string): Promise<ArchiveEntry> {
    await this.ready
    const check = await this.preflight(request)
    if (!check.ok || !check.sourceFingerprint) throw Error(check.errors.join('；'))
    // Preflight yields to filesystem/native work. Reserve again after it returns
    // so two callers cannot both publish jobs against a single active lease.
    if (this.active || this.deps.sourceBusy?.()) throw Error('已有归档或导出任务，请等待结束')
    let job = retryId ? this.jobs.find(j => j.id === retryId) : undefined
    if (retryId && (!job || !['interrupted', 'failed', 'aborted'].includes(job.state))) throw Error('归档任务不可续跑')
    if (job && (job.accountHash !== archiveAccountHash(request.accountId) || job.sourceFingerprint !== check.sourceFingerprint || JSON.stringify(job.request) !== JSON.stringify(request))) throw Error('来源或选项已变化，请新建归档；中断产物仍已保留')
    if (!job) {
      const id = randomUUID(), finalPath = path.join(request.destination, 'weport-archive-' + id)
      job = { id, request: { ...request, sessionIds: [...new Set(request.sessionIds)] }, accountHash: archiveAccountHash(request.accountId), sourceFingerprint: check.sourceFingerprint, staging: finalPath + '.partial', finalPath, state: 'running', stage: 'preflight', lastProgressAt: this.now(), scheduleId }
      this.jobs.push(job)
    }
    const current = job; current.state = 'running'; current.error = undefined
    this.active = { id: current.id, cancelled: false }; await this.save()
    this.deps.task.begin('正在创建可离线阅读的归档')
    const stopped = () => !this.active || this.active.cancelled || archiveAccountHash(this.deps.currentAccount()) !== current.accountHash
    let pendingSave: Promise<void> = Promise.resolve()
    const progress = (stage: string, cursor?: string, percent?: number) => {
      current.stage = stage; current.cursor = cursor; current.lastProgressAt = this.now(); current.state = 'running'
      this.deps.task.progress(stage, '正在归档：' + stage, { jobId: current.id, lastProgressAt: current.lastProgressAt, cursor }, percent)
      pendingSave = pendingSave.then(() => this.save()).catch(() => {})
    }
    const watchdog = setInterval(() => {
      if (this.now() - current.lastProgressAt > 90_000) {
        current.state = 'waiting'
        this.deps.task.progress(current.stage, '暂未收到新进度；可取消后安全续跑', { jobId: current.id, waitingReason: 'no-progress-90s', lastProgressAt: current.lastProgressAt, cursor: current.cursor })
      }
    }, 15_000)
    watchdog.unref?.()
    try {
      await fs.promises.mkdir(current.staging, { recursive: true })
      const exported = await this.deps.exportJson(current.request, path.join(current.staging, 'data'), p => progress(p.stage, p.cursor, p.total ? (Number(p.current) / p.total) * 75 : undefined), stopped)
      if (stopped() || exported.stopped) { current.state = 'aborted'; throw Error('归档已取消，中断产物已保留，可在来源不变时续跑') }
      if (!exported.success || exported.failCount) throw Error(exported.error || '部分会话导出失败；未发布不完整归档')
      const sourceAfter = await this.deps.source()
      if (sourceAfter.fingerprint !== current.sourceFingerprint) throw Error('归档期间来源变化，产物已保留；请新建归档')
      progress('生成清单', undefined, 80)
      const manifest = await this.buildManifest(current, exported.sessionOutputPaths || {})
      if (stopped()) { current.state = 'aborted'; throw Error('归档已取消') }
      await writeJson(path.join(current.staging, ARCHIVE_MANIFEST), manifest)
      progress('验证离线打开', undefined, 90)
      await this.verifyRoot(current.staging)
      if (stopped()) { current.state = 'aborted'; throw Error('归档已取消') }
      await fs.promises.rename(current.staging, current.finalPath)
      const entry = this.entry(current.finalPath, manifest, true)
      if (current.scheduleId) entry.inventory = await captureInventory(current.finalPath, stopped)
      this.entries.push(entry); current.state = 'done'; progress('完成', undefined, 100); current.state = 'done'
      await pendingSave; await this.save(); this.deps.task.end('done', `归档完成：${entry.messages} 条消息`)
      return entry
    } catch (e) {
      current.state = current.state === 'aborted' ? 'aborted' : 'failed'; current.error = errorText(e)
      await pendingSave; await this.save(); this.deps.task.end(current.state === 'aborted' ? 'aborted' : 'failed', current.error)
      throw e
    } finally { clearInterval(watchdog); this.active = null }
  }
  private async buildManifest(job: ArchiveJob, outputs: Record<string, string>): Promise<ArchiveManifest> {
    const sessions: ArchiveManifest['sessions'] = [], outcomes: Record<string, number> = {}, seen = new Set<string>()
    if (!Object.keys(outputs).length || Object.keys(outputs).some(id => !job.request.sessionIds.includes(id))) throw Error('归档导出未返回所选会话的有效产物')
    for (const [id, file] of Object.entries(outputs)) {
      const doc = await json(file)
      if (!Array.isArray(doc.messages)) throw Error('导出文件缺少消息数组')
      let firstAt = 0, lastAt = 0
      for (const message of doc.messages) {
        validateMessageIdentity(message)
        const identity = String(message.sourceIdentityHash || '')
        if (!/^[a-f\d]{64}$/.test(identity) || seen.has(id + '\0' + identity)) throw Error('归档消息缺少精确来源或出现重复物理身份')
        seen.add(id + '\0' + identity)
        const at = Number(message.createTime) || 0; firstAt = firstAt ? Math.min(firstAt, at) : at; lastAt = Math.max(lastAt, at)
        if (message.mediaOutcome?.status) outcomes[message.mediaOutcome.status] = (outcomes[message.mediaOutcome.status] || 0) + 1
      }
      sessions.push({ ...await hashFile(file), path: relative(job.staging, file), id, name: String(doc.session?.displayName || doc.session?.nickname || id), count: doc.messages.length, firstAt, lastAt })
    }
    const artifacts = new Set(sessions.map(s => s.path)), media: ArchiveFile[] = []
    for (const file of await walk(path.join(job.staging, 'data'))) {
      const name = relative(job.staging, file)
      if (artifacts.has(name) || /(?:^|\/)(?:\.[^/]*|export-manifest\.json|integrity-report\.json|missing-media\.csv|export_log\.txt)$/.test(name)) continue
      media.push({ ...await hashFile(file), path: name })
    }
    const raw = this.deps.annotations(), bookmarks: ArchiveBookmark[] = []
    for (const [kind, values] of [['favorite', raw.favorites], ['mark', raw.marks]] as const) for (const mark of values) {
      if (!job.request.sessionIds.includes(mark.sessionId)) continue
      const identity = mark.idKind === 'server' ? undefined : sourceMessageIdentityHash({ localId: mark.messageId || mark.localId, dbPath: mark.db, tableName: mark.table })
      bookmarks.push({ sessionId: mark.sessionId, kind, note: mark.note, at: Number(mark.at) || this.now(), sourceIdentityHash: identity, resolved: Boolean(identity && seen.has(mark.sessionId + '\0' + identity)), original: { ...mark } })
    }
    await writeJson(path.join(job.staging, 'bookmarks.json'), { version: 1, archiveId: job.id, accountHash: job.accountHash, bookmarks, tags: Object.fromEntries(Object.entries(raw.tags).filter(([id]) => job.request.sessionIds.includes(id))) } satisfies ArchiveAnnotations)
    return { schema: 'weport-archive', version: 1, archiveId: job.id, accountHash: job.accountHash, createdAt: this.now(), sourceFingerprint: job.sourceFingerprint, ...(job.request.dateRange ? { dateRange: { ...job.request.dateRange } } : {}), mediaPolicy: job.request.mediaPolicy, includesMedia: job.request.includeMedia, sessions, media, mediaOutcomes: outcomes, annotations: 'bookmarks.json', ...(job.scheduleId ? { scheduleId: job.scheduleId } : {}) }
  }
  private entry(root: string, manifest: ArchiveManifest, managed: boolean): ArchiveEntry { return { archiveId: manifest.archiveId, accountHash: manifest.accountHash, path: path.resolve(root), createdAt: manifest.createdAt, sessions: manifest.sessions.length, messages: manifest.sessions.reduce((n, s) => n + s.count, 0), scheduleId: manifest.scheduleId, managed } }
  async verifyRoot(root: string): Promise<ArchiveManifest> {
    const manifest = await json(await archivePath(root, ARCHIVE_MANIFEST)) as ArchiveManifest
    if (manifest.schema !== 'weport-archive' || manifest.version !== 1 || !/^[a-f\d-]{36}$/.test(manifest.archiveId) || !/^[a-f\d]{64}$/.test(manifest.accountHash) || !Array.isArray(manifest.sessions) || !Array.isArray(manifest.media)) throw Error('不支持或损坏的归档清单')
    if (manifest.sessions.length + manifest.media.length > 500_000) throw Error('归档条目超过安全上限')
    if (!['best-available', 'original-only'].includes(manifest.mediaPolicy) || typeof manifest.includesMedia !== 'boolean' || manifest.annotations !== 'bookmarks.json') throw Error('归档媒体策略无效')
    const paths = new Set<string>(), sessionIds = new Set<string>(), outcomes: Record<string, number> = {}
    const mediaPaths = new Set(manifest.media.map(item => item.path))
    for (const item of [...manifest.sessions, ...manifest.media]) {
      if (paths.has(item.path)) throw Error('归档含重复文件路径'); paths.add(item.path)
      const actual = await hashFile(await archivePath(root, item.path))
      if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw Error('归档文件校验失败：' + item.path)
    }
    for (const session of manifest.sessions) {
      if (sessionIds.has(session.id)) throw Error('归档含重复会话'); sessionIds.add(session.id)
      const doc = await json(await archivePath(root, session.path)), seen = new Set<string>()
      if (!Array.isArray(doc.messages) || doc.messages.length !== session.count) throw Error('归档消息数量与清单不符')
      for (const message of doc.messages) {
        validateMessageIdentity(message)
        if (!/^[a-f\d]{64}$/.test(message.sourceIdentityHash) || seen.has(message.sourceIdentityHash)) throw Error('归档消息身份无效或重复')
        seen.add(message.sourceIdentityHash)
        const outcome = message.mediaOutcome
        if (!outcome) continue
        if (!MEDIA_STATUSES.has(outcome.status) || typeof outcome.kind !== 'string') throw Error('归档媒体状态无效')
        outcomes[outcome.status] = (outcomes[outcome.status] || 0) + 1
        if (AVAILABLE_MEDIA.has(outcome.status)) {
          if (!manifest.includesMedia || !mediaPaths.has(mediaRelativePath(session.path, outcome.relativePath))) throw Error('媒体未列入归档清单')
          if (manifest.mediaPolicy === 'original-only' && outcome.kind === 'image' && outcome.status !== 'original') throw Error('归档图片不符合仅原图策略')
        } else if (outcome.relativePath !== undefined) throw Error('不可用媒体不应包含文件链接')
      }
    }
    const keys = new Set([...Object.keys(outcomes), ...Object.keys(manifest.mediaOutcomes || {})])
    if ([...keys].some(key => outcomes[key] !== manifest.mediaOutcomes?.[key])) throw Error('归档媒体统计与消息不符')
    await this.readAnnotations(root, manifest)
    return manifest
  }
  private async readAnnotations(root: string, manifest: ArchiveManifest): Promise<ArchiveAnnotations> {
    const data = await json(await archivePath(root, 'bookmarks.json')) as ArchiveAnnotations
    if (data.version !== 1 || data.archiveId !== manifest.archiveId || data.accountHash !== manifest.accountHash || !Array.isArray(data.bookmarks) || !data.tags || typeof data.tags !== 'object') throw Error('归档标注与账号不匹配')
    return data
  }
  async import(root: string) {
    if (this.active?.id.startsWith('retention:')) throw Error('正在清理归档，请等待结束')
    await this.ready; const manifest = await this.verifyRoot(root), entry = this.entry(root, manifest, false)
    const prior = this.entries.find(e => e.archiveId === entry.archiveId)
    if (prior && prior.accountHash !== entry.accountHash) throw Error('相同归档 ID 的账号不匹配')
    this.entries = this.entries.filter(e => e.archiveId !== entry.archiveId); this.entries.push(entry); await this.save()
    return { entry, manifest }
  }
  private async opened(id: string) {
    await this.ready; const entry = this.entries.find(e => e.archiveId === id); if (!entry) throw Error('归档未添加到本机库')
    if (entry.retentionState === 'cleaning') throw Error(entry.retentionReason || '归档空间清理中；请打开保留的新归档')
    const manifest = await json(await archivePath(entry.path, ARCHIVE_MANIFEST)) as ArchiveManifest
    if (manifest.archiveId !== entry.archiveId || manifest.accountHash !== entry.accountHash || manifest.version !== 1) throw Error('归档身份已变化，请重新导入')
    return { entry, manifest }
  }
  async open(id: string) { const { entry } = await this.opened(id); const manifest = await this.verifyRoot(entry.path); return { entry, manifest, annotations: await this.readAnnotations(entry.path, manifest) } }
  async page(id: string, sessionId: string, offset = 0, limit = 80, query = '') {
    const { entry, manifest } = await this.opened(id), session = manifest.sessions.find(s => s.id === sessionId)
    if (!session) throw Error('归档中没有此会话')
    const key = id + '\0' + sessionId
    let cached = this.readerCache.get(key)
    const file = await archivePath(entry.path, session.path), stat = await fs.promises.stat(file)
    const signature = `${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}`
    if (!cached || cached.sha256 !== session.sha256 || cached.signature !== signature) {
      const actual = await hashFile(file)
      if (actual.sha256 !== session.sha256) throw Error('归档会话文件已改变')
      cached = { sha256: session.sha256, signature, messages: (await json(file)).messages }; this.readerCache.set(key, cached)
      if (this.readerCache.size > 2) this.readerCache.delete(this.readerCache.keys().next().value!)
    }
    const text = query.trim().toLocaleLowerCase(), messages = text ? cached.messages.filter(m => String(m.content).toLocaleLowerCase().includes(text)) : cached.messages
    const start = Math.max(0, Math.floor(Number(offset) || 0)), take = Math.min(200, Math.max(1, Number(limit) || 80))
    return { messages: messages.slice(start, start + take), nextOffset: start + take, hasMore: start + take < messages.length, total: messages.length }
  }
  async evidence(id: string, sessionId: string, sourceIdentityHash: string) {
    if (!/^[a-f\d]{64}$/.test(sourceIdentityHash)) throw Error('证据身份无效')
    let offset = 0
    for (;;) { const page = await this.page(id, sessionId, offset, 200); const match = page.messages.filter(m => m.sourceIdentityHash === sourceIdentityHash); if (match.length === 1) return { archiveId: id, sessionId, sourceIdentityHash, message: match[0], uri: `weport-archive:${id}/${encodeURIComponent(sessionId)}/${sourceIdentityHash}` }; if (!page.hasMore) break; offset = page.nextOffset }
    throw Error('归档中未找到精确证据')
  }
  async bookmark(id: string, sessionId: string, identity: string, note: string, remove = false) {
    if (this.active?.id.startsWith('retention:')) throw Error('正在校验归档保留范围，请等待清理结束后保存书签')
    await this.evidence(id, sessionId, identity)
    const { entry, manifest } = await this.opened(id), data = await this.readAnnotations(entry.path, manifest)
    data.bookmarks = data.bookmarks.filter(b => !(b.sessionId === sessionId && b.sourceIdentityHash === identity))
    if (!remove) data.bookmarks.push({ sessionId, sourceIdentityHash: identity, kind: 'mark', note: String(note).slice(0, 4000), at: this.now(), resolved: true })
    await writeJson(path.join(entry.path, 'bookmarks.json'), data); return data
  }
  async media(id: string, sessionId: string, identity: string) {
    const evidence = await this.evidence(id, sessionId, identity), { entry, manifest } = await this.opened(id)
    const outcome = evidence.message.mediaOutcome
    if (!outcome?.relativePath || !['original', 'display', 'thumbnail', 'available'].includes(outcome.status)) return { available: false, status: outcome?.status || 'not-requested' }
    const session = manifest.sessions.find(s => s.id === sessionId)!
    const rel = mediaRelativePath(session.path, outcome.relativePath)
    const artifact = manifest.media.find(m => m.path === rel)
    if (!artifact) throw Error('媒体未列入归档清单')
    const file = await archivePath(entry.path, rel), actual = await hashFile(file)
    if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) throw Error('归档媒体完整性校验失败')
    return { available: true, status: outcome.status, url: `weport-media://local/${encodeURIComponent(file)}`, fileUrl: pathToFileURL(file).toString() }
  }
  async restore(id: string, destination: string) {
    const { entry } = await this.opened(id), manifest = await this.verifyRoot(entry.path)
    if (!path.isAbsolute(destination || '')) throw Error('请选择复制目标目录')
    const target = path.join(destination, 'weport-restored-' + randomUUID()); await fs.promises.mkdir(target, { recursive: false })
    try {
      for (const file of [ARCHIVE_MANIFEST, 'bookmarks.json', ...manifest.sessions.map(s => s.path), ...manifest.media.map(m => m.path)]) {
        const source = await archivePath(entry.path, file), dest = path.join(target, file)
        await fs.promises.mkdir(path.dirname(dest), { recursive: true }); await fs.promises.copyFile(source, dest, fs.constants.COPYFILE_EXCL)
      }
      await this.verifyRoot(target); return { path: target, verified: true }
    } catch (e) { throw Error('归档副本校验失败，已保留副本供检查：' + errorText(e)) }
  }
  async saveSchedule(value: { id?: string; request: ArchiveRequest; enabled: boolean; everyMinutes: number; keep: number }) {
    await this.ready; this.validateRequest(value.request)
    const minutes = Number(value.everyMinutes), keep = Number(value.keep)
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 43200 || !Number.isInteger(keep) || keep < 1 || keep > 100) throw Error('计划间隔须为 15–43200 分钟，保留 1–100 份')
    const prior = this.schedules.find(s => s.id === value.id)
    if (prior && prior.accountHash !== archiveAccountHash(value.request.accountId)) throw Error('无法修改其他账号的计划')
    const schedule: ArchiveSchedule = { id: prior?.id || randomUUID(), accountHash: archiveAccountHash(value.request.accountId), request: value.request, enabled: value.enabled === true, everyMinutes: minutes, keep, nextRunAt: this.now() + minutes * 60_000 }
    this.schedules = this.schedules.filter(s => s.id !== schedule.id); this.schedules.push(schedule); await this.save(); this.start(); return schedule
  }
  async removeSchedule(id: string) { await this.ready; this.schedules = this.schedules.filter(s => s.id !== id); await this.save(); this.start() }
  start() { void this.ready.then(() => { if (this.timer) clearInterval(this.timer); this.timer = null; if (this.cleanups.length || this.schedules.some(s => s.enabled)) { this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 60_000); this.timer.unref?.() } }).catch(() => {}) }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.cancel() }
  async tick() {
    await this.ready; if (this.active || this.deps.sourceBusy?.()) return
    if (this.cleanups.length) { await this.runCleanup(this.cleanups[0]); return }
    const due = this.schedules.find(s => s.enabled && s.nextRunAt <= this.now()); if (!due) return
    due.nextRunAt = this.now() + due.everyMinutes * 60_000; await this.save()
    try {
      if (due.accountHash !== archiveAccountHash(this.deps.currentAccount())) throw Error('等待计划所属账号连接')
      await this.create(due.request, undefined, due.id); due.lastRunAt = this.now(); due.lastError = undefined
      await this.applyRetention(due)
    } catch (e) { due.lastError = errorText(e) }
    await this.save()
  }
  private async applyRetention(schedule: ArchiveSchedule) {
    const candidates = this.entries.filter(e => e.managed && e.scheduleId === schedule.id && e.accountHash === schedule.accountHash).sort((a, b) => b.createdAt - a.createdAt)
    const kept = candidates.slice(0, schedule.keep)
    for (const entry of candidates.slice(schedule.keep)) {
      if (this.active) return
      this.active = { id: 'retention:' + entry.archiveId, cancelled: false }
      this.deps.task.begin('正在校验归档覆盖范围与空间保留策略')
      const stopped = () => !this.active || this.active.cancelled || archiveAccountHash(this.deps.currentAccount()) !== schedule.accountHash
      try {
        if (!entry.inventory) throw Error('旧归档缺少发布时文件清单，已保护')
        await this.cleanupBoundary(entry, schedule.request.destination)
        assertInventory(await captureInventory(entry.path, stopped), entry.inventory)
        const manifest = await this.verifyRoot(entry.path)
        let cleanup: ArchiveCleanupJournal | undefined, reason = '没有可证明覆盖旧内容的新归档，已保护'
        for (const survivor of kept) {
          try {
            await this.cleanupBoundary(survivor, schedule.request.destination)
            const inventory = await captureInventory(survivor.path, stopped)
            const newer = await this.verifyRoot(survivor.path)
            await proveCoverage(entry, manifest, survivor, newer, stopped)
            // Bind the proof to the exact files read and later rechecked.
            assertInventory(await captureInventory(survivor.path, stopped), inventory)
            assertInventory(await captureInventory(entry.path, stopped), entry.inventory)
            cleanup = { archiveId: entry.archiveId, survivorId: survivor.archiveId, destination: schedule.request.destination, inventory: entry.inventory, survivorInventory: inventory, proofFiles: retentionProofFiles(entry.inventory, manifest, newer) }; break
          } catch (error) { reason = errorText(error) }
        }
        if (!cleanup) throw Error(reason)
        if (stopped()) throw Error('清理已取消')
        this.cleanups.push(cleanup); entry.retentionState = 'cleaning'; entry.retentionReason = '空间清理已开始；旧归档可能不完整，等待安全续跑'
        await this.save() // Durable intent and visible partial state BEFORE the first unlink.
        this.active = null
        await this.runCleanup(cleanup)
        if (this.cleanups.some(item => item.archiveId === entry.archiveId)) return
      } catch (error) {
        if (!this.cleanups.some(item => item.archiveId === entry.archiveId)) { entry.retentionState = 'protected'; entry.retentionReason = errorText(error) }
        const cancelled = stopped()
        await this.save(); this.deps.task.end(cancelled ? 'aborted' : 'failed', errorText(error))
        if (cancelled) return
      } finally { this.active = null }
    }
  }
  private async cleanupBoundary(entry: ArchiveEntry, destination: string) {
    await assertStorageBoundary(entry.path, this.deps.protectedPaths?.() || [])
    await retentionBoundary(entry, destination)
  }
  private async runCleanup(cleanup: ArchiveCleanupJournal) {
    if (this.active) return
    const entry = this.entries.find(item => item.archiveId === cleanup.archiveId), survivor = this.entries.find(item => item.archiveId === cleanup.survivorId)
    if (!entry || !survivor) throw Error('清理日志缺少旧归档或保留归档，拒绝继续')
    this.active = { id: 'retention:' + entry.archiveId, cancelled: false }
    this.deps.task.begin('正在安全回收已被新归档完整覆盖的空间')
    const stopped = () => !this.active || this.active.cancelled || archiveAccountHash(this.deps.currentAccount()) !== entry.accountHash
    try {
      const boundary = async () => {
        if (stopped()) throw Error('清理已暂停；旧归档可能不完整，等待原账号连接后安全续跑')
        if (survivor.archiveId === entry.archiveId || !survivor.managed || survivor.accountHash !== entry.accountHash || survivor.scheduleId !== entry.scheduleId) throw Error('保留归档身份不符，清理已停止')
        await this.cleanupBoundary(survivor, cleanup.destination)
        await this.cleanupBoundary(entry, cleanup.destination)
      }
      // A restart always rehashes both inventories before trusting the journal.
      await boundary()
      assertInventory(await captureInventory(survivor.path, stopped), cleanup.survivorInventory)
      assertInventory(await captureInventory(entry.path, stopped), cleanup.inventory, true)
      const proofFiles = new Map(cleanup.survivorInventory.files.map(file => [file.path, file]))
      if (!cleanup.proofFiles || cleanup.inventory.files.some(file => !Array.isArray(cleanup.proofFiles[file.path]) || !cleanup.proofFiles[file.path].includes(ARCHIVE_MANIFEST) || cleanup.proofFiles[file.path].some(name => !proofFiles.has(name)))) throw Error('清理日志缺少逐文件保留证明，拒绝继续')
      const manifestFingerprint = await verifyInventoryFile(survivor.path, proofFiles.get(ARCHIVE_MANIFEST)!, stopped)
      if (!manifestFingerprint) throw Error('保留归档清单不存在，拒绝继续')
      let checked = 0
      const recheck = async (file?: ArchiveFile) => {
        await boundary()
        const dependencies = file ? cleanup.proofFiles[file.path] : [ARCHIVE_MANIFEST]
        await verifyFileFingerprint(survivor.path, ARCHIVE_MANIFEST, manifestFingerprint)
        for (const name of dependencies) if (name !== ARCHIVE_MANIFEST) await verifyInventoryFile(survivor.path, proofFiles.get(name)!, stopped)
        if (file) await verifyInventoryFile(entry.path, file, stopped, true)
        await verifyFileFingerprint(survivor.path, ARCHIVE_MANIFEST, manifestFingerprint)
        this.deps.task.progress('retention', '正在逐文件校验并回收旧归档；可取消后安全续跑', { archiveId: entry.archiveId, survivorId: survivor.archiveId, lastProgressAt: this.now(), checked: ++checked, total: cleanup.inventory.files.length })
      }
      await recheck()
      await unlinkInventoried(entry.path, cleanup.inventory, recheck, stopped)
      // Detect later external edits too; already verified unlinks cannot be undone.
      await boundary()
      assertInventory(await captureInventory(survivor.path, stopped), cleanup.survivorInventory)
      assertInventory(await captureInventory(entry.path, stopped), cleanup.inventory, true)
      this.entries = this.entries.filter(item => item.archiveId !== entry.archiveId)
      this.cleanups = this.cleanups.filter(item => item !== cleanup)
      await this.save(); this.deps.task.end('done', '旧归档空间已回收；全部内容已由保留归档覆盖')
    } catch (error) {
      entry.retentionState = 'cleaning'; entry.retentionReason = '清理未完成，旧归档可能不完整：' + errorText(error)
      await this.save(); this.deps.task.end(stopped() ? 'aborted' : 'failed', entry.retentionReason)
    } finally { this.active = null }
  }
}
