import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, cp, symlink, rename } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'node:crypto'
import nodeFs, { readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { ArchiveLibrary, ARCHIVE_MANIFEST } from './archiveLibrary'
import { sourceMessageIdentityHash } from '../export/sourceMessageIdentity'
import type { ArchiveDependencies } from './archiveLibrary'
import type { ArchiveRequest } from './types'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weport-archive-library-')); roots.push(root)
  let account = 'A', fingerprint = 'source-1', now = 1700000000000
  const rows: any[] = [0, 1].map(shard => ({ localType: 1, createTime: 1700000000 + shard, content: shard ? 'hello history' : '你好 历史', rawContent: shard ? 'hello history' : '你好 历史',
    sourceIdentity: { db: `db_storage/message/message_${shard}.db`, table: 'Msg_chat', localId: '9007199254740993' },
    sourceIdentityHash: sourceMessageIdentityHash({ dbPath: `db_storage/message/message_${shard}.db`, tableName: 'Msg_chat', localId: '9007199254740993' })! }))
  const deps: ArchiveDependencies = {
    root: join(root, 'library'), currentAccount: () => account, now: () => now,
    source: vi.fn(async () => ({ fingerprint, capability: 'live' as const })),
    annotations: () => ({ favorites: [], marks: [], tags: { chat: ['work'] } }),
    task: { begin: vi.fn(), progress: vi.fn(), end: vi.fn() },
    exportJson: vi.fn(async (_request, output, progress) => {
      await mkdir(output, { recursive: true }); const file = join(output, 'chat.json')
      await writeFile(file, JSON.stringify({ session: { displayName: 'Fixture', messageCount: rows.length, lastTimestamp: Math.max(...rows.map(row => row.createTime)) }, messages: rows }))
      progress({ stage: 'writing', current: 1, total: 1 })
      return { success: true, sessionOutputPaths: { chat: file } }
    }),
  }
  const request: ArchiveRequest = { accountId: 'A', destination: root, sessionIds: ['chat'], mediaPolicy: 'best-available', includeMedia: false }
  const library = new ArchiveLibrary(deps)
  return { root, library, deps, request, rows, setAccount: (value: string) => { account = value }, setFingerprint: (value: string) => { fingerprint = value }, advance: () => { now += 1000000 } }
}
describe('portable archive implementation', () => {
  it('opens exact bilingual physical identities after restart without connecting to WeChat', async () => {
    const x = await fixture(), entry = await x.library.create(x.request)
    const offline = new ArchiveLibrary({ ...x.deps, source: async () => { throw Error('WeChat is stopped') } })
    const opened = await offline.open(entry.archiveId), page = await offline.page(entry.archiveId, 'chat')
    expect(opened.manifest.sessions[0].count).toBe(2)
    expect(page.messages.map(message => message.sourceIdentity?.localId)).toEqual(['9007199254740993', '9007199254740993'])
    expect(new Set(page.messages.map(message => message.sourceIdentityHash)).size).toBe(2)
    expect((await offline.page(entry.archiveId, 'chat', 0, 80, '你好')).total).toBe(1)
    expect((await offline.evidence(entry.archiveId, 'chat', x.rows[1].sourceIdentityHash)).message.rawContent).toBe('hello history')
    expect(x.deps.task.end).toHaveBeenLastCalledWith('done', expect.any(String))
  })
  it('keeps bookmarks portable and verifies a copied archive before reporting success', async () => {
    const x = await fixture(), entry = await x.library.create(x.request)
    await x.library.bookmark(entry.archiveId, 'chat', x.rows[0].sourceIdentityHash, 'Important')
    const copy = await x.library.restore(entry.archiveId, x.root)
    expect(copy.verified).toBe(true)
    const other = new ArchiveLibrary({ ...x.deps, root: join(x.root, 'other-library') })
    const imported = await other.import(copy.path), opened = await other.open(imported.entry.archiveId)
    expect(opened.annotations.bookmarks[0].note).toBe('Important')
    expect(opened.annotations.tags.chat).toEqual(['work'])
  })
  it('refuses corrupted payloads and traversal before importing an archive', async () => {
    const x = await fixture(), entry = await x.library.create(x.request)
    const manifest = JSON.parse(await readFile(join(entry.path, ARCHIVE_MANIFEST), 'utf8'))
    await writeFile(join(entry.path, manifest.sessions[0].path), '{}')
    await expect(x.library.verifyRoot(entry.path)).rejects.toThrow('校验失败')
    manifest.sessions[0].path = '../outside.json'
    await writeFile(join(entry.path, ARCHIVE_MANIFEST), JSON.stringify(manifest))
    await expect(x.library.verifyRoot(entry.path)).rejects.toThrow('不安全')
  })
  it('does not publish failed or changing sources; preserved jobs have recoverable states', async () => {
    const x = await fixture()
    const original = x.deps.exportJson
    x.deps.exportJson = async (...args) => { const result = await original(...args); x.setFingerprint('changed'); return result }
    await expect(x.library.create(x.request)).rejects.toThrow('来源变化')
    const status = await x.library.status()
    expect(status.entries).toEqual([]); expect(status.jobs[0].state).toBe('failed')
    await expect(x.library.create(x.request, status.jobs[0].id)).rejects.toThrow('来源或选项')
  })
  it('cancels, retains partial data and retries with unchanged source and options', async () => {
    const x = await fixture(), original = x.deps.exportJson
    x.deps.exportJson = async (...args) => { const result = await original(...args); x.library.cancel(); return result }
    await expect(x.library.create(x.request)).rejects.toThrow('取消')
    const status = await x.library.status(); expect(status.jobs[0].state).toBe('aborted')
    x.deps.exportJson = original
    const retried = await x.library.create(x.request, status.jobs[0].id)
    expect(retried.messages).toBe(2); expect((await x.library.status()).jobs).toHaveLength(1)
  })
  it('keeps protected old archives visible when their portable bookmarks change', async () => {
    const x = await fixture()
    try {
      const manual = await x.library.create(x.request)
      await x.library.saveSchedule({ request: x.request, enabled: true, everyMinutes: 15, keep: 1 })
      x.advance(); await x.library.tick()
      const firstScheduled = (await x.library.status()).entries.find(entry => entry.scheduleId)!
      await x.library.bookmark(firstScheduled.archiveId, 'chat', x.rows[0].sourceIdentityHash, 'Unique old annotation')
      x.advance(); await x.library.tick()
      const status = await x.library.status()
      expect(status.entries).toHaveLength(3)
      expect(status.entries.some(entry => entry.archiveId === manual.archiveId)).toBe(true)
      expect(status.entries.filter(entry => entry.scheduleId)).toHaveLength(2)
      expect(status.entries.find(entry => entry.archiveId === firstScheduled.archiveId)?.retentionState).toBe('protected')
      const old = await x.library.verifyRoot(firstScheduled.path)
      expect(old.sessions[0].count).toBe(2)
      expect(JSON.parse(await readFile(join(firstScheduled.path, 'bookmarks.json'), 'utf8')).bookmarks[0].note).toBe('Unique old annotation')
      expect((await readdir(x.root)).filter(name => name.startsWith('weport-archive-'))).toHaveLength(3)
    } finally { x.library.stop() }
  })
  it('rejects another account and missing selections in preflight', async () => {
    const x = await fixture(); x.setAccount('B')
    expect((await x.library.preflight(x.request)).ok).toBe(false)
    x.setAccount('A')
    expect((await x.library.preflight({ ...x.request, sessionIds: [] })).ok).toBe(false)
  })
})


async function rewriteSession(root: string, mutate: (doc: any, manifest: any) => void) {
  const manifest = JSON.parse(await readFile(join(root, ARCHIVE_MANIFEST), 'utf8'))
  const file = join(root, manifest.sessions[0].path), doc = JSON.parse(await readFile(file, 'utf8'))
  mutate(doc, manifest)
  const bytes = Buffer.from(JSON.stringify(doc))
  await writeFile(file, bytes)
  manifest.sessions[0].bytes = bytes.length
  manifest.sessions[0].sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(root, ARCHIVE_MANIFEST), JSON.stringify(manifest))
}

describe('portable archive source and media integrity', () => {
  it.each(['localId', 'db', 'table'])('rejects changed source %s even when the session file hash was updated', async field => {
    const x = await fixture(), entry = await x.library.create(x.request)
    await rewriteSession(entry.path, doc => { doc.messages[0].sourceIdentity[field] = field === 'localId' ? '9007199254740994' : 'different' })
    await expect(x.library.verifyRoot(entry.path)).rejects.toThrow('精确来源')
  })
  it.each(['original', 'display', 'thumbnail', 'available'])('resolves and copies manifest-linked %s media offline', async status => {
    const x = await fixture(), original = x.deps.exportJson
    x.rows[0].mediaOutcome = { kind: status === 'available' ? 'file' : 'image', status, relativePath: 'media/image.png' }
    x.deps.exportJson = async (...args) => {
      const result = await original(...args)
      await mkdir(join(args[1], 'media'), { recursive: true }); await writeFile(join(args[1], 'media/image.png'), 'portable fixture bytes')
      return result
    }
    const entry = await x.library.create({ ...x.request, includeMedia: true })
    const offline = new ArchiveLibrary({ ...x.deps, source: async () => { throw Error('offline') } })
    expect((await offline.media(entry.archiveId, 'chat', x.rows[0].sourceIdentityHash)).status).toBe(status)
    const copied = await offline.restore(entry.archiveId, x.root)
    expect(copied.verified).toBe(true)
    await writeFile(join(entry.path, 'data/media/image.png'), 'damaged fixture bytes')
    await expect(offline.media(entry.archiveId, 'chat', x.rows[0].sourceIdentityHash)).rejects.toThrow('完整性')
  })
  it.each(['missing-locally', 'decryption-failed', 'unsupported', 'original-unavailable', 'not-requested'])('preserves explicit %s without an attachment link', async status => {
    const x = await fixture()
    x.rows[0].mediaOutcome = { kind: 'image', status }
    const entry = await x.library.create({ ...x.request, includeMedia: true })
    expect((await x.library.open(entry.archiveId)).manifest.mediaOutcomes).toEqual({ [status]: 1 })
    expect(await x.library.media(entry.archiveId, 'chat', x.rows[0].sourceIdentityHash)).toEqual({ available: false, status })
  })
  it.each(['media/absent.png', '../escape.png', 'C:/outside.png', 'media\\outside.png'])('rejects unlisted or unsafe media links (%s)', async relativePath => {
    const x = await fixture(), entry = await x.library.create(x.request)
    await rewriteSession(entry.path, (doc, manifest) => {
      doc.messages[0].mediaOutcome = { kind: 'image', status: 'display', relativePath }
      manifest.includesMedia = true; manifest.mediaOutcomes = { display: 1 }
    })
    await expect(x.library.verifyRoot(entry.path)).rejects.toThrow(/媒体/)
  })
  it('invalidates cached evidence after the session file is modified', async () => {
    const x = await fixture(), entry = await x.library.create(x.request)
    await x.library.page(entry.archiveId, 'chat')
    await writeFile(join(entry.path, 'data/chat.json'), '{}')
    await expect(x.library.evidence(entry.archiveId, 'chat', x.rows[0].sourceIdentityHash)).rejects.toThrow('已改变')
  })
  it('follows verified storage aliases for archives, jobs and schedule destinations', async () => {
    const x = await fixture(), entry = await x.library.create(x.request)
    try {
      await x.library.saveSchedule({ request: x.request, enabled: true, everyMinutes: 15, keep: 1 })
      const moved = join(x.root, 'moved'); await mkdir(moved)
      await cp(entry.path, join(moved, entry.path.split(/[\\/]/).at(-1)!), { recursive: true })
      const relocated = new ArchiveLibrary({ ...x.deps, resolvePath: value => value === x.root ? moved : value.startsWith(entry.path) ? join(moved, value.slice(x.root.length + 1)) : value })
      const status = await relocated.status()
      expect(status.entries[0].path).toContain(moved)
      expect(status.jobs[0].request.destination).toBe(moved)
      expect(status.schedules[0].request.destination).toBe(moved)
      expect((await relocated.open(entry.archiveId)).manifest.sessions[0].count).toBe(2)
      relocated.stop()
    } finally { x.library.stop() }
  })
  it('rejects malformed date ranges before starting export', async () => {
    const x = await fixture()
    expect((await x.library.preflight({ ...x.request, dateRange: { start: 20, end: 10 } })).ok).toBe(false)
    expect(x.deps.exportJson).not.toHaveBeenCalled()
  })
  it('accepts exact sub-day and open-ended bounds without replacing the requested times', async () => {
    const x = await fixture()
    for (const dateRange of [{ start: 1700000001, end: 1700000002 }, { start: 1700000001, end: 0 }, { start: 0, end: 1700000002 }]) {
      expect((await x.library.preflight({ ...x.request, dateRange })).ok).toBe(true)
      const entry = await x.library.create({ ...x.request, dateRange })
      expect((await x.library.open(entry.archiveId)).manifest.dateRange).toEqual(dateRange)
    }
    expect((await x.library.preflight({ ...x.request, dateRange: { start: 0, end: -1 } })).ok).toBe(false)
  })
  it('rejects altered media outcome statistics', async () => {
    const x = await fixture(), entry = await x.library.create(x.request)
    await rewriteSession(entry.path, (_doc, manifest) => { manifest.mediaOutcomes = { thumbnail: 99 } })
    await expect(x.library.verifyRoot(entry.path)).rejects.toThrow('媒体统计')
  })
  it('does not publish a best-available image as original-only', async () => {
    const x = await fixture(), original = x.deps.exportJson
    x.rows[0].mediaOutcome = { kind: 'image', status: 'thumbnail', relativePath: 'image.png' }
    x.deps.exportJson = async (...args) => { const result = await original(...args); await writeFile(join(args[1], 'image.png'), 'fixture'); return result }
    await expect(x.library.create({ ...x.request, includeMedia: true, mediaPolicy: 'original-only' })).rejects.toThrow('仅原图')
    expect((await x.library.status()).entries).toHaveLength(0)
  })
})

describe('safe scheduled archive space retention', () => {
  async function scheduled() {
    const x = await fixture()
    await x.library.saveSchedule({ request: x.request, enabled: true, everyMinutes: 15, keep: 1 })
    x.advance(); await x.library.tick()
    const old = (await x.library.status()).entries[0]
    return { ...x, old }
  }
  it.each([false, true])('actually unlinks covered archive files, including when the newer snapshot grows (%s)', async grows => {
    const x = await scheduled()
    try {
      if (grows) x.rows.push({ ...x.rows[0], content: 'new message', createTime: x.rows[1].createTime + 10, sourceIdentity: { ...x.rows[0].sourceIdentity, localId: '4' }, sourceIdentityHash: sourceMessageIdentityHash({ dbPath: x.rows[0].sourceIdentity.db, tableName: x.rows[0].sourceIdentity.table, localId: '4' }) })
      x.advance(); await x.library.tick()
      const status = await x.library.status()
      expect(status.entries).toHaveLength(1)
      expect(status.entries[0].messages).toBe(grows ? 3 : 2)
      expect(await readdir(x.old.path)).toEqual([])
      expect((await x.library.open(status.entries[0].archiveId)).manifest.sessions[0].count).toBe(grows ? 3 : 2)
      const disk = JSON.parse(await readFile(join(x.deps.root, 'library.json'), 'utf8'))
      expect(disk.entries).toHaveLength(1); expect(disk.cleanups).toEqual([])
    } finally { x.library.stop() }
  })
  it('ignores only the recognized export timestamp and reclaims inventoried generated diagnostics too', async () => {
    const x = await fixture(), original = x.deps.exportJson
    let exportTime = 1
    x.deps.exportJson = async (...args) => {
      const result = await original(...args), file = result.sessionOutputPaths!.chat
      const doc = JSON.parse(await readFile(file, 'utf8')); doc.weflow = { version: '1', exportedAt: exportTime++, generator: 'Weport' }
      await writeFile(file, JSON.stringify(doc)); await writeFile(join(args[1], 'integrity-report.json'), JSON.stringify({ time: exportTime }))
      return result
    }
    try {
      await x.library.saveSchedule({ request: x.request, enabled: true, everyMinutes: 15, keep: 1 })
      x.advance(); await x.library.tick(); const old = (await x.library.status()).entries[0]
      expect(old.inventory?.files.map(file => file.path)).toContain('data/integrity-report.json')
      x.advance(); await x.library.tick()
      expect((await x.library.status()).entries).toHaveLength(1)
      expect(await readdir(old.path)).toEqual([])
    } finally { x.library.stop() }
  })
  it.each(['deleted-message', 'edited-message', 'user-file', 'changed-file', 'legacy-inventory', 'changed-tag', 'unknown-metadata', 'invalid-summary', 'invalid-timestamp'])('protects %s and keeps the archive visible with a reason', async variation => {
    const x = await scheduled()
    try {
      if (variation === 'deleted-message') x.rows.pop()
      if (variation === 'edited-message') x.rows[0].content = 'edited source content'
      if (variation === 'user-file') await writeFile(join(x.old.path, 'my-important-notes.txt'), 'unique user bytes')
      if (variation === 'changed-file') await writeFile(join(x.old.path, 'data/chat.json'), 'changed by user')
      if (variation === 'changed-tag') x.deps.annotations = () => ({ favorites: [], marks: [], tags: {} })
      if (variation === 'unknown-metadata' || variation === 'invalid-summary' || variation === 'invalid-timestamp') {
        const original = x.deps.exportJson
        x.deps.exportJson = async (...args) => {
          const result = await original(...args), file = result.sessionOutputPaths!.chat, doc = JSON.parse(await readFile(file, 'utf8'))
          if (variation === 'unknown-metadata') doc.session.displayName = 'different name'
          else if (variation === 'invalid-summary') doc.session.messageCount = 999
          else doc.session.lastTimestamp = 999
          await writeFile(file, JSON.stringify(doc)); return result
        }
      }
      if (variation === 'legacy-inventory') {
        const indexFile = join(x.deps.root, 'library.json'), index = JSON.parse(await readFile(indexFile, 'utf8'))
        delete index.entries[0].inventory; await writeFile(indexFile, JSON.stringify(index))
        x.library.stop(); x.library = new ArchiveLibrary(x.deps)
      }
      x.advance(); await x.library.tick()
      const protectedOld = (await x.library.status()).entries.find(entry => entry.archiveId === x.old.archiveId)
      expect(protectedOld?.retentionState).toBe('protected'); expect(protectedOld?.retentionReason).toBeTruthy()
      expect((await readdir(x.old.path)).length).toBeGreaterThan(0)
    } finally { x.library.stop() }
  })
  it('preserves unique available media bytes even when no message points at them', async () => {
    const x = await fixture(), original = x.deps.exportJson
    let includeMedia = true
    x.deps.exportJson = async (...args) => { const result = await original(...args); if (includeMedia) await writeFile(join(args[1], 'old-media.bin'), 'old unique bytes'); return result }
    try {
      await x.library.saveSchedule({ request: x.request, enabled: true, everyMinutes: 15, keep: 1 })
      x.advance(); await x.library.tick(); const old = (await x.library.status()).entries[0]
      includeMedia = false; x.advance(); await x.library.tick()
      expect((await x.library.status()).entries.find(entry => entry.archiveId === old.archiveId)?.retentionReason).toMatch('媒体')
      expect(await readFile(join(old.path, 'data/old-media.bin'), 'utf8')).toBe('old unique bytes')
    } finally { x.library.stop() }
  })
  it('rejects a linked directory without touching the link target', async () => {
    const x = await scheduled(), outside = join(x.root, 'outside')
    try {
      await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'unique')
      await symlink(outside, join(x.old.path, 'linked'), 'junction')
      x.advance(); await x.library.tick()
      expect((await x.library.status()).entries.find(entry => entry.archiveId === x.old.archiveId)?.retentionReason).toMatch('符号链接')
      expect(await readFile(join(outside, 'private.txt'), 'utf8')).toBe('unique')
    } finally { x.library.stop() }
  })
  it.each(['root-link', 'source-overlap', 'wrong-managed-basename'])('rejects %s at the cleanup boundary', async variation => {
    const x = await scheduled()
    try {
      if (variation === 'root-link') {
        const moved = join(x.root, 'preserved-external-archive')
        await rename(x.old.path, moved); await symlink(moved, x.old.path, 'junction')
      }
      if (variation === 'source-overlap') x.deps.protectedPaths = () => [x.old.path]
      if (variation === 'wrong-managed-basename') {
        const indexFile = join(x.deps.root, 'library.json'), index = JSON.parse(await readFile(indexFile, 'utf8'))
        const moved = join(x.root, 'user-renamed-archive'); await rename(x.old.path, moved)
        index.entries[0].path = moved; await writeFile(indexFile, JSON.stringify(index)); x.old.path = moved
        x.library.stop(); x.library = new ArchiveLibrary(x.deps)
      }
      x.advance(); await x.library.tick()
      expect((await x.library.status()).entries.find(entry => entry.archiveId === x.old.archiveId)?.retentionState).toBe('protected')
      expect((await readdir(x.old.path)).length).toBeGreaterThan(0)
    } finally { x.library.stop() }
  })
  it('journals partial cleanup before unlink and resumes after restart, refusing changed survivor files', async () => {
    const x = await scheduled(); let checks = 0
    x.deps.task.progress = vi.fn(stage => { if (stage === 'retention' && ++checks === 3) x.library.cancel() })
    try {
      x.advance(); await x.library.tick()
      let status = await x.library.status()
      expect(status.entries.find(entry => entry.archiveId === x.old.archiveId)?.retentionState).toBe('cleaning')
      expect(await readdir(x.old.path)).not.toContain('bookmarks.json')
      await expect(x.library.open(x.old.archiveId)).rejects.toThrow('不完整')
      const index = JSON.parse(await readFile(join(x.deps.root, 'library.json'), 'utf8'))
      expect(index.cleanups).toHaveLength(1)
      const kept = status.entries.find(entry => entry.archiveId !== x.old.archiveId)!, keptFile = join(kept.path, 'data/chat.json')
      const keptBytes = await readFile(keptFile), oldBytes = await readFile(join(x.old.path, 'data/chat.json'))
      await writeFile(keptFile, 'changed survivor')
      x.library.stop(); x.deps.task.progress = vi.fn(); x.library = new ArchiveLibrary(x.deps)
      x.setAccount('other-account'); await x.library.tick()
      expect(await readFile(join(x.old.path, 'data/chat.json'))).toEqual(oldBytes)
      x.setAccount('A')
      await x.library.tick()
      expect(await readFile(join(x.old.path, 'data/chat.json'))).toEqual(oldBytes)
      expect((await x.library.status()).entries.find(entry => entry.archiveId === x.old.archiveId)?.retentionState).toBe('cleaning')
      await writeFile(keptFile, keptBytes)
      x.library.stop(); x.library = new ArchiveLibrary(x.deps); await x.library.tick()
      status = await x.library.status(); expect(status.entries).toHaveLength(1)
      expect(await readdir(x.old.path)).toEqual([])
      expect((await x.library.open(kept.archiveId)).manifest.sessions[0].count).toBe(2)
    } finally { x.library.stop() }
  })
  it('checks the relevant retained proof file immediately before unlinking an old file', async () => {
    const x = await scheduled(); let first = true
    x.deps.task.progress = vi.fn(stage => {
      if (stage !== 'retention' || !first) return
      first = false
      const directories = readdirSync(x.root).filter(name => name.startsWith('weport-archive-'))
      const kept = directories.map((name: string) => join(x.root, name)).find((name: string) => name !== x.old.path)!
      writeFileSync(join(kept, 'bookmarks.json'), 'changed after resume inventory verification')
    })
    try {
      x.advance(); await x.library.tick()
      expect(await readFile(join(x.old.path, 'bookmarks.json'), 'utf8')).toContain('bookmarks')
      expect((await x.library.status()).entries.find(entry => entry.archiveId === x.old.archiveId)?.retentionState).toBe('cleaning')
    } finally { x.library.stop() }
  })
  it('never targets a user file added after cleanup starts and refuses a nonempty final directory', async () => {
    const x = await scheduled(); let first = true
    x.deps.task.progress = vi.fn(stage => { if (stage === 'retention' && first) { first = false; writeFileSync(join(x.old.path, 'user-file-added-during-cleanup.txt'), 'must survive') } })
    try {
      x.advance(); await x.library.tick()
      expect(await readFile(join(x.old.path, 'user-file-added-during-cleanup.txt'), 'utf8')).toBe('must survive')
      expect((await x.library.status()).entries.find(entry => entry.archiveId === x.old.archiveId)?.retentionState).toBe('cleaning')
    } finally { x.library.stop() }
  })
  it.each([4, 96])('reads a large retained manifest a constant number of times with %s media files', async mediaCount => {
    const x = await fixture(), original = x.deps.exportJson
    x.deps.exportJson = async (...args) => {
      const result = await original(...args)
      await Promise.all(Array.from({ length: mediaCount }, (_, index) => writeFile(join(args[1], `media-${index}.bin`), 'fixture media bytes')))
      return result
    }
    x.deps.task.progress = vi.fn(stage => {
      if (stage !== '验证离线打开') return
      const staging = readdirSync(x.root).find(name => name.startsWith('weport-archive-') && name.endsWith('.partial'))!
      const file = join(x.root, staging, ARCHIVE_MANIFEST), manifest = JSON.parse(readFileSync(file, 'utf8'))
      manifest.fixturePadding = 'x'.repeat(1024 * 1024)
      writeFileSync(file, JSON.stringify(manifest))
    })
    let streamSpy: ReturnType<typeof vi.spyOn> | undefined
    try {
      await x.library.saveSchedule({ request: x.request, enabled: true, everyMinutes: 15, keep: 1 })
      x.advance(); await x.library.tick(); const old = (await x.library.status()).entries[0]
      const reads: string[] = [], originalStream = nodeFs.createReadStream
      streamSpy = vi.spyOn(nodeFs, 'createReadStream').mockImplementation(((...args: Parameters<typeof nodeFs.createReadStream>) => {
        reads.push(String(args[0])); return originalStream(...args)
      }) as typeof nodeFs.createReadStream)
      syncBuiltinESMExports()
      x.advance(); await x.library.tick()
      const entries = (await x.library.status()).entries
      expect(entries).toHaveLength(1)
      expect(statSync(join(entries[0].path, ARCHIVE_MANIFEST)).size).toBeGreaterThan(1024 * 1024)
      const manifestReads = reads.filter(file => file === join(entries[0].path, ARCHIVE_MANIFEST))
      // Publication + prepare/bind + resume + fixed-baseline hash + final hash.
      expect(manifestReads).toHaveLength(6)
      expect(await readdir(old.path)).toEqual([])
    } finally { streamSpy?.mockRestore(); syncBuiltinESMExports(); x.library.stop() }
  }, 30000)
  it('rejects a manifest rewritten after baseline even when its bytes and mtime are restored', async () => {
    const x = await fixture()
    let first = true, unchangedMtime = false, changedCtime = false
    x.deps.task.progress = vi.fn(stage => {
      if (stage === '验证离线打开') {
        const staging = readdirSync(x.root).find(name => name.startsWith('weport-archive-') && name.endsWith('.partial'))!
        utimesSync(join(x.root, staging, ARCHIVE_MANIFEST), 1700000000, 1700000000)
      }
      if (stage !== 'retention' || !first) return
      first = false
      const roots = readdirSync(x.root).filter(name => name.startsWith('weport-archive-')).map(name => join(x.root, name))
      const newest = roots.map(root => ({ root, manifest: JSON.parse(readFileSync(join(root, ARCHIVE_MANIFEST), 'utf8')) })).sort((a, b) => b.manifest.createdAt - a.manifest.createdAt)[0].root
      const file = join(newest, ARCHIVE_MANIFEST), before = statSync(file, { bigint: true }), bytes = readFileSync(file)
      writeFileSync(file, Buffer.alloc(bytes.length, 32)); writeFileSync(file, bytes)
      utimesSync(file, 1700000000, 1700000000)
      const after = statSync(file, { bigint: true })
      unchangedMtime = after.mtimeNs === before.mtimeNs; changedCtime = after.ctimeNs !== before.ctimeNs
    })
    try {
      await x.library.saveSchedule({ request: x.request, enabled: true, everyMinutes: 15, keep: 1 })
      x.advance(); await x.library.tick(); const old = (await x.library.status()).entries[0]
      x.advance(); await x.library.tick()
      expect(unchangedMtime).toBe(true); expect(changedCtime).toBe(true)
      const entry = (await x.library.status()).entries.find(item => item.archiveId === old.archiveId)
      expect(entry?.retentionState).toBe('cleaning'); expect(entry?.retentionReason).toMatch('时间戳')
      expect(await readFile(join(old.path, 'bookmarks.json'), 'utf8')).toContain('bookmarks')
    } finally { x.library.stop() }
  })
})
