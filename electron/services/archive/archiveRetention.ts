import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { ArchiveEntry, ArchiveFile, ArchiveInventory, ArchiveManifest } from './types'

const fail = (reason: string): never => { throw Error(reason) }
const canonical = (value: any): string => JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, JSON.parse(canonical(value[k]))])))
const hash = (value: any) => createHash('sha256').update(canonical(value)).digest('hex')
const stoppedDefault = () => false
function check(stopped: () => boolean) { if (stopped()) fail('清理已取消；已清理部分将安全续跑') }
function validateName(name: string) {
  if (!name || name.includes('\\') || path.isAbsolute(name) || /^[a-z][a-z\d+.-]*:/i.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) fail('清理日志包含不安全的文件路径')
}
export interface RetentionFileFingerprint { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
async function verifyParents(root: string, name: string, allowMissing: boolean): Promise<boolean> {
  validateName(name)
  const parts = name.split('/')
  for (let index = 0; index < parts.length - 1; index++) {
    let stat
    try { stat = await fs.lstat(path.join(root, ...parts.slice(0, index + 1))) } catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('归档文件父目录含链接或已变化')
  }
  return true
}
function sameFingerprint(actual: RetentionFileFingerprint, expected: RetentionFileFingerprint) {
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size && actual.mtimeNs === expected.mtimeNs && actual.ctimeNs === expected.ctimeNs
}
/** A fixed baseline from a completed full hash; never refresh it during cleanup. */
export async function verifyFileFingerprint(root: string, name: string, expected: RetentionFileFingerprint): Promise<void> {
  await verifyParents(root, name, false)
  const actual = await fs.lstat(path.join(root, name), { bigint: true })
  if (!actual.isFile() || actual.isSymbolicLink() || !sameFingerprint(actual, expected)) fail('保留归档清单身份或时间戳已变化，清理已停止')
}

/** Validate every in-root parent and hash exactly the file to be unlinked/proved. */
export async function verifyInventoryFile(root: string, expected: ArchiveFile, stopped = stoppedDefault, allowMissing = false): Promise<RetentionFileFingerprint | undefined> {
  validateName(expected.path); check(stopped)
  const file = path.join(root, expected.path)
  if (!await verifyParents(root, expected.path, allowMissing)) return
  let before
  try { before = await fs.lstat(file, { bigint: true }) } catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!before.isFile() || before.isSymbolicLink()) fail('归档文件包含链接或特殊文件')
  const digest = createHash('sha256'); let bytes = 0
  for await (const block of createReadStream(file)) { check(stopped); digest.update(block); bytes += block.length }
  const after = await fs.lstat(file, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || !sameFingerprint(after, before) || after.size !== BigInt(bytes) || bytes !== expected.bytes || digest.digest('hex') !== expected.sha256) fail('归档文件或保留证明文件已变化，清理已停止')
  return { dev: after.dev, ino: after.ino, size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs }
}

/** Every component is inspected, including destination ancestors; never traverse links. */
export async function retentionBoundary(entry: ArchiveEntry, destination: string) {
  if (!entry.managed || !path.isAbsolute(destination) || path.dirname(path.resolve(entry.path)) !== path.resolve(destination) || path.basename(entry.path) !== 'weport-archive-' + entry.archiveId) fail('保留策略拒绝清理边界外目录')
  for (let current = path.resolve(entry.path); ; current = path.dirname(current)) {
    if (/^(?:xwechat_files|wechat files|wechat_files|weixin|db_storage)$/i.test(path.basename(current))) fail('保留策略禁止操作微信数据目录')
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('保留策略拒绝符号链接或非目录')
    if (path.dirname(current) === current) break
  }
}

export async function captureInventory(root: string, stopped = stoppedDefault): Promise<ArchiveInventory> {
  const inventory: ArchiveInventory = { files: [], directories: [] }
  async function visit(directory: string, depth: number) {
    check(stopped)
    if (depth > 64) fail('归档目录过深，保留以供检查')
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      check(stopped)
      const file = path.join(directory, item.name), stat = await fs.lstat(file), relative = path.relative(root, file).split(path.sep).join('/')
      if (stat.isSymbolicLink()) fail('归档含符号链接，保留以供检查')
      if (stat.isDirectory()) { inventory.directories.push(relative); await visit(file, depth + 1) }
      else if (stat.isFile()) {
        const digest = createHash('sha256'); let bytes = 0
        for await (const block of createReadStream(file)) { check(stopped); digest.update(block); bytes += block.length }
        const after = await fs.lstat(file)
        if (!after.isFile() || after.isSymbolicLink() || after.size !== bytes || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino) fail('归档文件在校验期间变化')
        inventory.files.push({ path: relative, bytes, sha256: digest.digest('hex') })
      } else fail('归档含特殊文件，保留以供检查')
      if (inventory.files.length + inventory.directories.length > 500_000) fail('归档文件数量超过清理安全上限')
    }
  }
  await visit(root, 0)
  inventory.files.sort((a, b) => a.path.localeCompare(b.path)); inventory.directories.sort()
  return inventory
}

export function assertInventory(actual: ArchiveInventory, expected: ArchiveInventory, partial = false) {
  for (const name of [...expected.directories, ...expected.files.map(file => file.path)]) validateName(name)
  const files = new Map(expected.files.map(file => [file.path, file])), dirs = new Set(expected.directories)
  if ((!partial && (actual.files.length !== files.size || actual.directories.length !== dirs.size)) || actual.directories.some(dir => !dirs.has(dir)) || actual.files.some(file => { const original = files.get(file.path); return !original || file.sha256 !== original.sha256 || file.bytes !== original.bytes })) fail('归档存在新增或变更文件，已保留')
}

/** Bind each unlink to the retained files which proved that old file redundant. */
export function retentionProofFiles(inventory: ArchiveInventory, old: ArchiveManifest, kept: ArchiveManifest): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null)
  const oldSessions = new Map(old.sessions.map(session => [session.path, session])), oldMedia = new Map(old.media.map(media => [media.path, media]))
  const keptSessions = new Map(kept.sessions.map(session => [session.id, session.path])), keptMedia = new Map(kept.media.map(media => [media.sha256 + ':' + media.bytes, media.path]))
  for (const file of inventory.files) {
    const session = oldSessions.get(file.path), media = oldMedia.get(file.path)
    const dependency = session ? keptSessions.get(session.id) : media ? keptMedia.get(media.sha256 + ':' + media.bytes) : file.path === 'bookmarks.json' ? 'bookmarks.json' : 'weport-archive.json'
    if (!dependency) fail('缺少旧归档文件对应的保留证明')
    result[file.path] = [...new Set(['weport-archive.json', dependency!])]
  }
  return result
}

async function read(root: string, name: string) {
  if (!name || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(part => !part || part === '..' || part === '.')) fail('归档文件路径无效')
  const file = path.join(root, name)
  if ((await fs.stat(file)).size > 512 * 1024 * 1024) fail('归档文件过大，无法安全比较')
  return JSON.parse(await fs.readFile(file, 'utf8'))
}
function metadata(doc: any) {
  const { messages: _messages, ...rest } = doc
  if (rest.weflow && typeof rest.weflow === 'object' && !Array.isArray(rest.weflow) && Number.isSafeInteger(rest.weflow.exportedAt) && rest.weflow.exportedAt >= 0) {
    rest.weflow = { ...rest.weflow }; delete rest.weflow.exportedAt
  }
  // JsonFormatter writes these two summaries from the selected message rows.
  // Ignore them ONLY when independently reproduced from this exact payload;
  // arbitrary metadata changes still prevent deletion.
  if (rest.session && typeof rest.session === 'object' && !Array.isArray(rest.session)) {
    rest.session = { ...rest.session }
    if (Number.isSafeInteger(rest.session.messageCount) && rest.session.messageCount === doc.messages.length) delete rest.session.messageCount
    if (doc.messages.length && doc.messages.every((message: any) => Number.isSafeInteger(message.createTime) && message.createTime >= 0)) {
      const lastAt = doc.messages.reduce((latest: number, message: any) => Math.max(latest, message.createTime), 0)
      if (Number.isSafeInteger(rest.session.lastTimestamp) && rest.session.lastTimestamp === lastAt) delete rest.session.lastTimestamp
    }
  }
  return rest
}

/** Exact physical IDs alone are insufficient: edits, old media and annotations must survive too. */
export async function proveCoverage(old: ArchiveEntry, oldManifest: ArchiveManifest, kept: ArchiveEntry, keptManifest: ArchiveManifest, stopped = stoppedDefault) {
  if (old.accountHash !== kept.accountHash || oldManifest.accountHash !== old.accountHash || keptManifest.accountHash !== kept.accountHash || oldManifest.archiveId !== old.archiveId || keptManifest.archiveId !== kept.archiveId || oldManifest.scheduleId !== old.scheduleId || keptManifest.scheduleId !== old.scheduleId) fail('归档身份与计划不符')
  const keptSessions = new Map(keptManifest.sessions.map(session => [session.id, session]))
  for (const session of oldManifest.sessions) {
    check(stopped)
    const newer = keptSessions.get(session.id)
    if (!newer) fail('新归档缺少旧会话，已保护旧归档')
    const oldDoc = await read(old.path, session.path), newDoc = await read(kept.path, newer!.path)
    if (canonical(metadata(oldDoc)) !== canonical(metadata(newDoc))) fail('会话元数据变化，已保护旧归档')
    const messages = new Map(newDoc.messages.map((message: any) => [message.sourceIdentityHash, hash(message)]))
    if (oldDoc.messages.some((message: any) => messages.get(message.sourceIdentityHash) !== hash(message))) fail('新归档缺少旧消息或消息内容已变化，已保护旧归档')
  }
  const media = new Set(keptManifest.media.map(file => file.sha256 + ':' + file.bytes))
  if (oldManifest.media.some(file => !media.has(file.sha256 + ':' + file.bytes))) fail('新归档缺少旧媒体字节，已保护旧归档')
  const oldMarks = await read(old.path, 'bookmarks.json'), newMarks = await read(kept.path, 'bookmarks.json')
  const bookmarks = new Set(newMarks.bookmarks.map(hash))
  if (oldMarks.bookmarks.some((bookmark: any) => !bookmarks.has(hash(bookmark))) || Object.entries(oldMarks.tags).some(([id, tags]) => !Array.isArray(tags) || (tags as any[]).some(tag => !newMarks.tags[id]?.includes(tag)))) fail('新归档缺少旧书签或标签，已保护旧归档')
  const extras = (annotations: any) => { const { archiveId: _archiveId, bookmarks: _bookmarks, tags: _tags, ...rest } = annotations; return rest }
  if (canonical(extras(oldMarks)) !== canonical(extras(newMarks))) fail('归档标注元数据变化，已保护旧归档')
}

/** No recursive removal: only previously inventoried files and subsequently empty directories. */
export async function unlinkInventoried(root: string, inventory: ArchiveInventory, beforeEach: (file?: ArchiveFile) => Promise<void>, stopped = stoppedDefault) {
  for (const file of inventory.files) {
    check(stopped); await beforeEach(file); check(stopped)
    // The journal durably authorizes this exact file; ENOENT can be a crash after unlink.
    await fs.unlink(path.join(root, file.path)).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  for (const dir of [...inventory.directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
    check(stopped); await beforeEach(); check(stopped)
    validateName(dir)
    const parts = dir.split('/')
    for (let index = 0; index < parts.length; index++) {
      let stat
      try { stat = await fs.lstat(path.join(root, ...parts.slice(0, index + 1))) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('归档待清理目录含链接或已变化')
    }
    await fs.rmdir(path.join(root, dir)).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  // Keep the empty root as a recovery anchor if the index commit is interrupted.
  check(stopped); await beforeEach(); check(stopped)
  if ((await fs.readdir(root)).length) fail('归档清理期间出现新增文件；已保留并停止清理')
}
