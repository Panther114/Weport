import { createHash, randomUUID } from 'crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'fs'
import * as fs from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, parse } from 'path'

export const STORAGE_KINDS = ['cache', 'search-index', 'archive-library', 'ai-data', 'ai-workspace', 'model-cache', 'media', 'exports'] as const
export type StorageKind = typeof STORAGE_KINDS[number]
interface StoredFile { path: string; bytes: number; hash: string }
export interface StorageRelocation {
  version: 1; id: string; kind: StorageKind; source: string; target: string
  state: 'copying' | 'ready' | 'applied' | 'failed'; files: StoredFile[]; error?: string; startedAt: number; finishedAt?: number
}
interface Locations { version: 1; paths: Partial<Record<StorageKind, string>>; moves?: Array<{ source: string; target: string }> }
const locationFile = (profile: string) => join(profile, 'storage-locations.json')
const journalFile = (profile: string) => join(profile, 'storage-relocation.json')
function locations(profile: string): Locations {
  if (!existsSync(locationFile(profile))) return { version: 1, paths: {} }
  const data = JSON.parse(readFileSync(locationFile(profile), 'utf8')) as Locations
  if (data.version !== 1 || !data.paths || typeof data.paths !== 'object') throw Error('Unsupported storage-location configuration.')
  return data
}
export function resolveStorageLocation(profile: string, kind: StorageKind, fallback: string): string {
  const configured = locations(profile).paths[kind]
  if (configured && !isAbsolute(configured)) throw Error('A storage location must be absolute.')
  return configured || fallback
}
/** Pin the first default choice: fresh installs stay out of cloud Documents,
 * while an existing legacy cache remains reachable until a verified relocation.
 * Explicit user paths and relocation maps take precedence at the caller. */
export function defaultMediaStorageLocation(profile: string, documents: string): string {
  const file = join(profile, 'storage-defaults.json')
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number; media: string }
    if (saved.version !== 1 || !isAbsolute(saved.media)) throw Error('Unsupported storage default configuration.')
    return saved.media
  }
  const legacy = join(documents, 'WeFlow')
  const media = existsSync(legacy) ? legacy : join(profile, 'media')
  mkdirSync(profile, { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, media }), { mode: 0o600 })
  renameSync(temporary, file)
  return media
}
/** Existing folder pickers may choose a new default after a completed move. */
export function resetStorageLocation(profile: string, kind: StorageKind): void {
  const job = storageRelocationStatus(profile)
  if (preparing || (job?.kind === kind && ['copying', 'ready'].includes(job.state))) throw Error('Apply or discard the prepared storage relocation before choosing a different folder.')
  const config = locations(profile)
  if (!config.paths[kind]) return
  delete config.paths[kind]
  const temporary = `${locationFile(profile)}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 }); renameSync(temporary, locationFile(profile))
}
/** Persisted absolute references (archive library, schedules) follow verified moves. */
export function resolveRelocatedStoragePath(profile: string, path: string): string {
  let current = path
  for (const move of locations(profile).moves || []) {
    if (!isAbsolute(move.source) || !isAbsolute(move.target) || !isAbsolute(current)) continue
    if (inside(move.source, current)) current = join(move.target, relative(move.source, current))
    else {
      // Windows may persist an 8.3 TEMP path while preparation stores realpath's
      // long spelling. Use the same native normalization as fs/promises.realpath,
      // including existing ancestors of missing file tails.
      const source = canonicalReference(move.source), candidate = canonicalReference(current)
      if (inside(source, candidate)) current = join(move.target, relative(source, candidate))
    }
  }
  return current
}
function canonicalReference(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync.native(absolute) } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return absolute
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(canonicalReference(parent), relative(parent, absolute))
  }
}
async function atomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync() } finally { await handle.close() }
  await fs.rename(temporary, file)
}
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path)
  if (existsSync(absolute)) return fs.realpath(absolute)
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(await canonical(parent), relative(parent, absolute))
}
/** Refuse WeChat sources and overlapping roots before any copy or deletion. */
export async function assertStorageBoundary(root: string, protectedPaths: string[]): Promise<void> {
  const actual = await canonical(root)
  if (actual === parse(actual).root) throw Error('A filesystem root cannot be managed storage.')
  for (const protectedPath of protectedPaths.filter(Boolean)) {
    const protectedRoot = await canonical(protectedPath)
    if (inside(protectedRoot, actual) || inside(actual, protectedRoot)) throw Error('Storage must not overlap WeChat source data or another protected directory.')
  }
  for (let ancestor = actual; ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    if (existsSync(join(ancestor, 'db_storage')) || existsSync(join(ancestor, 'FileStorage'))) throw Error('WeChat source directories cannot be managed storage.')
  }
}
async function hash(file: string): Promise<{ bytes: number; hash: string }> {
  const digest = createHash('sha256'); let bytes = 0
  for await (const data of createReadStream(file)) { digest.update(data); bytes += data.length }
  return { bytes, hash: digest.digest('hex') }
}
async function inventory(root: string, verifyContent = true): Promise<StoredFile[]> {
  const files: StoredFile[] = []
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw Error('Storage relocation rejects symbolic links.')
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) files.push({ path: relative(root, full).split(sep).join('/'), ...(verifyContent ? await hash(full) : { bytes: (await fs.stat(full)).size, hash: '' }) })
      else throw Error('Storage contains an unsupported filesystem entry.')
    }
  }
  if (existsSync(root)) {
    if ((await fs.lstat(root)).isSymbolicLink()) throw Error('Storage rejects symbolic-link roots.')
    await walk(root)
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
export function storageRelocationStatus(profile: string): StorageRelocation | null {
  if (!existsSync(journalFile(profile))) return null
  const data = JSON.parse(readFileSync(journalFile(profile), 'utf8')) as StorageRelocation
  if (data.version !== 1 || !STORAGE_KINDS.includes(data.kind) || !isAbsolute(data.source) || !isAbsolute(data.target)
    || !Array.isArray(data.files) || data.files.some(file => !file.path || isAbsolute(file.path) || file.path.includes('\\') || file.path.split('/').some(part => part === '.' || part === '..' || !part) || !/^[a-f0-9]{64}$/.test(file.hash) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) throw Error('Unsupported storage relocation journal.')
  return data
}
let preparing = false
/** Copy and verify first. Runtime paths stay unchanged until a clean restart. */
export async function prepareStorageRelocation(profile: string, kind: StorageKind, source: string, destination: string, protectedPaths: string[] = []): Promise<StorageRelocation> {
  if (preparing) throw Error('Another storage relocation is running.')
  if (!STORAGE_KINDS.includes(kind) || !isAbsolute(source) || !isAbsolute(destination)) throw Error('Choose a valid storage category and absolute destination.')
  const prior = storageRelocationStatus(profile)
  if (prior && ['copying', 'ready'].includes(prior.state)) throw Error('A prepared relocation must be applied or discarded first.')
  if (storageCleanupStatus(profile)?.state === 'ready') throw Error('Apply or cancel the prepared cache cleanup first.')
  preparing = true
  let job: StorageRelocation | undefined
  try {
    await assertStorageBoundary(source, protectedPaths)
    await assertStorageBoundary(destination, protectedPaths)
    const plannedSource = await canonical(source), plannedParent = await canonical(destination)
    if (inside(plannedSource, plannedParent) || inside(plannedParent, plannedSource)) throw Error('The destination must be separate from the source directory.')
    await fs.mkdir(destination, { recursive: true })
    const parent = await fs.realpath(destination), original = existsSync(source) ? await fs.realpath(source) : resolve(source)
    await assertStorageBoundary(original, protectedPaths)
    await assertStorageBoundary(parent, protectedPaths)
    if (inside(original, parent) || inside(parent, original)) throw Error('The destination must be separate from the source directory.')
    const id = randomUUID(), target = join(parent, 'Weport-' + kind + '-' + id)
    job = { version: 1, id, kind, source: original, target, state: 'copying', files: [], startedAt: Date.now() }
    await atomic(journalFile(profile), job)
    job.files = await inventory(original)
    // Persist the verified source inventory before the first copied byte so a
    // crashed partial copy can later be recognized and cleaned conservatively.
    await atomic(journalFile(profile), job)
    const totalBytes = job.files.reduce((sum, file) => sum + file.bytes, 0), space = await fs.statfs(parent)
    if (Number(space.bavail) * Number(space.bsize) < totalBytes + 64 * 1024 * 1024) throw Error('Insufficient free space for verified storage relocation.')
    await fs.mkdir(target, { recursive: false })
    for (const file of job.files) {
      const output = join(target, file.path)
      if (!inside(target, output)) throw Error('Storage entry escapes its destination.')
      await fs.mkdir(dirname(output), { recursive: true }); await fs.copyFile(join(original, file.path), output, fs.constants.COPYFILE_EXCL)
    }
    if (JSON.stringify(await inventory(original)) !== JSON.stringify(job.files)) throw Error('The source changed during relocation. Original storage remains active.')
    if (JSON.stringify(await inventory(target)) !== JSON.stringify(job.files)) throw Error('The copied storage failed verification. Original storage remains active.')
    job.state = 'ready'; job.finishedAt = Date.now(); await atomic(journalFile(profile), job)
    return job
  } catch (error) {
    if (job) { job.state = 'failed'; job.error = error instanceof Error ? error.message : String(error); await atomic(journalFile(profile), job) }
    throw error
  } finally { preparing = false }
}
/** Run before managed services initialize. The single location-map rename commits. */
export async function applyPreparedStorageRelocation(profile: string, protectedPaths: string[] = []): Promise<StorageRelocation | null> {
  const job = storageRelocationStatus(profile)
  if (!job || !['ready', 'copying'].includes(job.state)) return job
  try {
    if (locations(profile).paths[job.kind] === job.target) {
      // Recover a crash after committing the location map but before the journal.
      job.state = 'applied'; job.finishedAt = Date.now(); await atomic(journalFile(profile), job)
      return job
    }
    if (job.state === 'copying') throw Error('The copy was interrupted. Original storage remains active; retry the relocation.')
    await assertStorageBoundary(job.source, protectedPaths)
    await assertStorageBoundary(job.target, protectedPaths)
    if (inside(job.source, job.target) || inside(job.target, job.source)) throw Error('Relocation paths must remain separate.')
    if (JSON.stringify(await inventory(job.source)) !== JSON.stringify(job.files)) throw Error('The original storage changed after preparation. Relocation was not applied.')
    if (JSON.stringify(await inventory(job.target)) !== JSON.stringify(job.files)) throw Error('The prepared copy changed. Relocation was not applied.')
    const config = locations(profile)
    config.paths[job.kind] = job.target
    config.moves = [...(config.moves || []), { source: job.source, target: job.target }]
    await atomic(locationFile(profile), config)
    job.state = 'applied'; job.finishedAt = Date.now(); await atomic(journalFile(profile), job)
  } catch (error) {
    job.state = 'failed'; job.error = error instanceof Error ? error.message : String(error); await atomic(journalFile(profile), job)
  }
  return job
}
export async function discardStorageRelocation(profile: string): Promise<void> {
  if (preparing) throw Error('Wait for the current copy to finish.')
  const job = storageRelocationStatus(profile)
  if (job?.state === 'applied') throw Error('This relocation is already applied.')
  // Copies and sources are kept; discarding never recursively removes user data.
  await fs.rm(journalFile(profile), { force: true })
}
/** Delete only unchanged duplicate files, never recursively remove a directory.
 * Unknown files, changed copies, symlinks and source/active-path overlaps fail closed.
 * Files are rechecked individually so an interrupted cleanup can safely be retried. */
export async function cleanupStorageRelocation(profile: string, side: 'original' | 'prepared', protectedPaths: string[] = []): Promise<{ files: number; bytes: number }> {
  if (preparing) throw Error('Wait for the storage operation to finish.')
  const job = storageRelocationStatus(profile)
  if (!job || (side === 'original' ? job.state !== 'applied' : !['ready', 'failed'].includes(job.state))) throw Error('No eligible relocation copy exists.')
  const root = side === 'original' ? job.source : job.target
  const retained = side === 'original' ? job.target : job.source
  if (side === 'original' && locations(profile).paths[job.kind] !== job.target) throw Error('The verified destination is no longer active.')
  if (side === 'prepared' && locations(profile).paths[job.kind] === job.target) throw Error('The prepared copy is already active.')
  const active = Object.values(locations(profile).paths).filter((path): path is string => Boolean(path) && path !== root)
  preparing = true
  let bytes = 0, files = 0
  try {
    await assertStorageBoundary(root, [...protectedPaths, ...active])
    const expected = new Map(job.files.map(file => [file.path, file]))
    const removing = await inventory(root), keeping = new Map((await inventory(retained)).map(file => [file.path, file]))
    for (const file of removing) {
      if (JSON.stringify(expected.get(file.path)) !== JSON.stringify(file) || JSON.stringify(keeping.get(file.path)) !== JSON.stringify(file)) throw Error('A copy changed or contains unique files; cleanup refused. All remaining files are preserved.')
    }
    for (const file of removing) {
      const deleting = join(root, file.path), preserving = join(retained, file.path)
      // Rewalk both parent chains: a replacement junction must not redirect unlink.
      for (const candidate of [deleting, preserving]) {
        for (let part = candidate; inside(candidate === deleting ? root : retained, part); part = dirname(part)) {
          if ((await fs.lstat(part)).isSymbolicLink()) throw Error('Storage cleanup rejects symbolic links.')
          if (part === (candidate === deleting ? root : retained)) break
        }
      }
      if (JSON.stringify(await hash(deleting)) !== JSON.stringify({ bytes: file.bytes, hash: file.hash }) || JSON.stringify(await hash(preserving)) !== JSON.stringify({ bytes: file.bytes, hash: file.hash })) throw Error('A file changed during cleanup; remaining files are preserved.')
      await fs.unlink(deleting); bytes += file.bytes; files++
    }
    if (side === 'prepared') await fs.rm(journalFile(profile), { force: true })
    return { bytes, files }
  } finally { preparing = false }
}
export async function storageUsage(root: string): Promise<{ files: number; bytes: number }> {
  const items = await inventory(root, false)
  return { files: items.length, bytes: items.reduce((total, file) => total + file.bytes, 0) }
}

interface DerivedCleanup { version: 1; kind: 'search-index' | 'model-cache'; root: string; files: StoredFile[]; state: 'ready' | 'done' | 'failed'; error?: string }
const cleanupFile = (profile: string) => join(profile, 'storage-cleanup.json')
export function storageCleanupStatus(profile: string): DerivedCleanup | null {
  if (!existsSync(cleanupFile(profile))) return null
  return JSON.parse(readFileSync(cleanupFile(profile), 'utf8')) as DerivedCleanup
}
export async function discardStorageCleanup(profile: string): Promise<void> {
  if (preparing) throw Error('Wait for the storage operation to finish.')
  await fs.rm(cleanupFile(profile), { force: true })
}
function rebuildable(kind: DerivedCleanup['kind'], name: string): boolean {
  if (kind === 'model-cache') return ['models-cache.json', 'models-cache.meta.json'].includes(name)
  return /^[^/]+\/(manifest\.json|lexical-v1-g\d+\.bin|shards\/[^/]+-b\d+-g\d+\.json\.gz)$/.test(name)
}
/** Queue only recognized derived artifacts; arbitrary files in these folders stay. */
export async function prepareDerivedStorageCleanup(profile: string, kind: DerivedCleanup['kind'], root: string, protectedPaths: string[] = []): Promise<DerivedCleanup> {
  if (!['search-index', 'model-cache'].includes(kind)) throw Error('This category may contain unique user content and cannot be cleared.')
  if (preparing || storageRelocationStatus(profile)?.state === 'ready') throw Error('Finish or discard the relocation before cleaning caches.')
  preparing = true
  try {
    await assertStorageBoundary(root, protectedPaths)
    const files = (await inventory(root)).filter(file => rebuildable(kind, file.path))
    const job: DerivedCleanup = { version: 1, kind, root, files, state: 'ready' }
    await atomic(cleanupFile(profile), job)
    return job
  } finally { preparing = false }
}
/** Run at startup before services acquire/cache their derived artifacts. */
export async function applyPreparedStorageCleanup(profile: string, protectedPaths: string[] = []): Promise<DerivedCleanup | null> {
  const job = storageCleanupStatus(profile)
  if (!job || job.state !== 'ready') return job
  try {
    if (job.version !== 1 || !['search-index', 'model-cache'].includes(job.kind) || !isAbsolute(job.root) || !Array.isArray(job.files) || job.files.some(file => !rebuildable(job.kind, file.path))) throw Error('Invalid derived cleanup journal.')
    const currentRoot = resolveStorageLocation(profile, job.kind, join(profile, job.kind))
    if (resolve(currentRoot) !== resolve(job.root)) throw Error('Storage location changed; cleanup cancelled.')
    await assertStorageBoundary(job.root, protectedPaths)
    const current = new Map((await inventory(job.root)).map(file => [file.path, file]))
    // Validate all before removing any. Already removed files allow crash recovery.
    for (const file of job.files) if (current.has(file.path) && JSON.stringify(current.get(file.path)) !== JSON.stringify(file)) throw Error('A cache file changed; cleanup cancelled and files preserved.')
    for (const file of job.files) {
      if (!current.has(file.path)) continue
      const path = join(job.root, file.path)
      if (JSON.stringify(await hash(path)) !== JSON.stringify({ bytes: file.bytes, hash: file.hash })) throw Error('A cache file changed during cleanup.')
      // inventory rejects links, and paths are restricted by rebuildable above.
      await fs.unlink(path)
    }
    job.state = 'done'
  } catch (error) { job.state = 'failed'; job.error = error instanceof Error ? error.message : String(error) }
  await atomic(cleanupFile(profile), job)
  return job
}
