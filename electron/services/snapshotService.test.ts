import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import crypto from 'node:crypto'
import {
  SNAPSHOT_MANIFEST_NAME,
  SNAPSHOT_RETENTION,
  applyRetention,
  createSnapshot,
  listSnapshots,
  readSnapshotManifest,
  resolveAccountDatabasePaths,
  restoreSnapshot,
  snapshotFileCandidates,
  verifySnapshot,
  withAutoSnapshot,
} from './snapshotService'

/**
 * 写前自动快照（v1.2 §10.3 ③）。
 *
 * 守四件事：manifest 字段正确（含 `-wal`/`-shm`、大小、sha256、原因、恢复说明）、
 * 恢复能 1:1 还原（round-trip）、只保留最近 10 份、快照失败时写操作**不执行**。
 */

let root = ''
let dbDir = ''
let snapshotRoot = ''

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex')

function makeDatabase(name = 'session.db', body = 'sqlcipher-main-body'): string {
  const dbPath = path.join(dbDir, name)
  fs.writeFileSync(dbPath, body)
  fs.writeFileSync(`${dbPath}-wal`, 'wal-unmerged-frames')
  fs.writeFileSync(`${dbPath}-shm`, 'shm-shared-memory')
  return dbPath
}

function accountDir(): string {
  return path.join(root, 'fake-wechat-account')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-snapshot-'))
  dbDir = path.join(root, 'fake-wechat-account', 'db_storage', 'session')
  fs.mkdirSync(dbDir, { recursive: true })
  snapshotRoot = path.join(root, 'snapshots')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('master manifest 正确性', () => {
  it('账号数据库发现只扫描 db_storage，不包含账号根目录下的缓存库', async () => {
    const accountRoot = accountDir()
    const storageDb = path.join(accountRoot, 'db_storage', 'session', 'session.db')
    const cacheDb = path.join(accountRoot, 'cache', 'other.db')
    fs.mkdirSync(path.dirname(storageDb), { recursive: true })
    fs.mkdirSync(path.dirname(cacheDb), { recursive: true })
    fs.writeFileSync(storageDb, 'storage fixture')
    fs.writeFileSync(cacheDb, 'cache fixture')

    const result = await resolveAccountDatabasePaths(accountRoot)
    expect(result.databasePaths).toEqual([storageDb])
    expect(result.accountDir).toBe(path.resolve(accountRoot))
    expect(result.truncated).toBe(false)
  })

  it('包含主库 + -wal + -shm，各带大小与 sha256', async () => {
    const dbPath = makeDatabase()
    const result = await createSnapshot({ rootDir: snapshotRoot, reason: 'anti-revoke-install', databasePaths: [dbPath] })
    expect(result.ok).toBe(true)
    const manifest = result.manifest!
    expect(manifest.v).toBe(1)
    expect(manifest.reason).toBe('anti-revoke-install')
    expect(manifest.databases).toEqual([path.resolve(dbPath)])
    expect(manifest.files.map((file) => file.role).sort()).toEqual(['main', 'shm', 'wal'])
    expect(manifest.files.map((file) => file.bytes).every((bytes) => bytes > 0)).toBe(true)
    expect(manifest.files.every((file) => file.sha256.length === 64)).toBe(true)
    const main = manifest.files.find((file) => file.role === 'main')!
    expect(main.sha256).toBe(sha256('sqlcipher-main-body'))
    expect(manifest.totalBytes).toBe(manifest.files.reduce((sum, file) => sum + file.bytes, 0))
    expect(manifest.createdAtMs).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(manifest.createdAt))).toBe(false)
    expect(manifest.restoreInstructions).toContain('wal')
  })

  it('manifest.json 落在快照目录里，且与返回的对象一致', async () => {
    const dbPath = makeDatabase()
    const result = await createSnapshot({ rootDir: snapshotRoot, reason: 'sns-delete', databasePaths: [dbPath] })
    const onDisk = await readSnapshotManifest(result.dir!)
    expect(onDisk).toEqual(result.manifest)
    expect(fs.existsSync(path.join(result.dir!, SNAPSHOT_MANIFEST_NAME))).toBe(true)
  })

  it('快照目录名带原因与时间戳（人工能看出是哪次写操作）', async () => {
    const dbPath = makeDatabase()
    const result = await createSnapshot({ rootDir: snapshotRoot, reason: 'anti-revoke-uninstall', databasePaths: [dbPath] })
    expect(path.basename(result.dir!)).toMatch(/^\d{8}-\d{6}-\d{3}-anti-revoke-uninstall$/)
  })

  it('没有 -wal / -shm 时只快照主库（不报错）', async () => {
    const dbPath = path.join(dbDir, 'sns.db')
    fs.writeFileSync(dbPath, 'sns-only')
    const result = await createSnapshot({ rootDir: snapshotRoot, reason: 'sns-delete', databasePaths: [dbPath] })
    expect(result.ok).toBe(true)
    expect(result.manifest!.files).toHaveLength(1)
  })

  it('主库不存在时创建快照失败', async () => {
    const result = await createSnapshot({
      rootDir: snapshotRoot,
      reason: 'sns-delete',
      databasePaths: [path.join(dbDir, 'never-used.db')],
    })
    expect(result.ok).toBe(false)
    expect(result.manifest).toBeUndefined()
    expect(result.error).toContain('主数据库不可用')
  })

  it('只有缺失的 WAL/SHM 可以省略，其他侧车访问错误会让快照失败', async () => {
    const dbPath = makeDatabase()
    const originalStat = fs.promises.stat.bind(fs.promises)
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (filePath, options) => {
      if (String(filePath) === `${dbPath}-wal`) {
        throw Object.assign(new Error('injected sidecar stat failure'), { code: 'EACCES' })
      }
      return originalStat(filePath, options)
    })
    try {
      const result = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('数据库附属文件不可用')
    } finally {
      statSpy.mockRestore()
    }
  })

  it('主库在复制期间发生变化时拒绝生成快照', async () => {
    const dbPath = makeDatabase()
    const originalCopyFile = fs.promises.copyFile.bind(fs.promises)
    const copySpy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (source, destination) => {
      await originalCopyFile(source, destination)
      if (String(source) === dbPath) fs.writeFileSync(dbPath, 'changed-during-snapshot-copy')
    })
    try {
      const result = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('复制期间发生变化')
    } finally {
      copySpy.mockRestore()
    }
  })

  it('snapshotFileCandidates 固定返回 主库 / -wal / -shm', () => {
    expect(snapshotFileCandidates('C:\\db\\session.db')).toEqual([
      'C:\\db\\session.db',
      'C:\\db\\session.db-wal',
      'C:\\db\\session.db-shm',
    ])
  })

  it('快照目录里留下的文件内容与源文件逐字节一致', async () => {
    const dbPath = makeDatabase()
    const result = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    for (const file of result.manifest!.files) {
      expect(fs.readFileSync(path.join(result.dir!, file.file), 'utf-8')).toBe(fs.readFileSync(file.source, 'utf-8'))
    }
  })
})

describe('恢复往返（round-trip）', () => {
  it('写入后恢复 → 库内容与快照前完全一致（含 -wal）', async () => {
    const dbPath = makeDatabase()
    const before = {
      main: fs.readFileSync(dbPath, 'utf-8'),
      wal: fs.readFileSync(`${dbPath}-wal`, 'utf-8'),
      shm: fs.readFileSync(`${dbPath}-shm`, 'utf-8'),
    }
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'anti-revoke-install', databasePaths: [dbPath] })

    // 模拟"触发器等写操作改了库"
    fs.writeFileSync(dbPath, 'sqlcipher-main-body-CHANGED-BY-WRITE')
    fs.writeFileSync(`${dbPath}-wal`, 'wal-after-write')
    fs.writeFileSync(`${dbPath}-shm`, 'shm-after-write')
    fs.rmSync(`${dbPath}-shm`)

    const restored = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
    expect(restored.ok).toBe(true)
    expect(restored.failed).toEqual([])
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe(before.main)
    expect(fs.readFileSync(`${dbPath}-wal`, 'utf-8')).toBe(before.wal)
    expect(fs.readFileSync(`${dbPath}-shm`, 'utf-8')).toBe(before.shm)
  })

  it('恢复前会把现场另存一份（回滚本身也可回滚）', async () => {
    const dbPath = makeDatabase()
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'sns-delete', databasePaths: [dbPath] })
    fs.writeFileSync(dbPath, 'current-on-disk')
    const restored = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
    expect(restored.backupDir).toBeTruthy()
    const backup = fs.readdirSync(restored.backupDir!)
    expect(backup.length).toBeGreaterThan(0)
    const backedUpMain = backup.map((name) => fs.readFileSync(path.join(restored.backupDir!, name), 'utf-8'))
    expect(backedUpMain).toContain('current-on-disk')
  })

  it('快照自校验失败时不动任何库文件（要么全恢复、要么不动）', async () => {
    const dbPath = makeDatabase()
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'sns-delete', databasePaths: [dbPath] })
    // 破坏快照里的一份拷贝
    const mainFile = snapshot.manifest!.files.find((file) => file.role === 'main')!
    fs.writeFileSync(path.join(snapshot.dir!, mainFile.file), 'tampered')
    fs.writeFileSync(dbPath, 'live-before-restore')

    const restored = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
    expect(restored.ok).toBe(false)
    expect(restored.failed.length).toBeGreaterThan(0)
    expect(restored.error).toContain('校验未通过')
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('live-before-restore')
  })

  it('清单遗漏主库时验证和恢复都拒绝，且不删除或覆盖现场主库', async () => {
    const dbPath = makeDatabase()
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    fs.writeFileSync(dbPath, 'live-before-invalid-restore')
    const manifestPath = path.join(snapshot.dir!, SNAPSHOT_MANIFEST_NAME)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    manifest.files = manifest.files.filter((entry: { role: string }) => entry.role !== 'main')
    manifest.totalBytes = manifest.files.reduce((sum: number, entry: { bytes: number }) => sum + entry.bytes, 0)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const verification = await verifySnapshot(snapshot.dir!)
    expect(verification.ok).toBe(false)
    expect(verification.failed.some((entry) => entry.reason.includes('每个清单数据库'))).toBe(true)

    const restored = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
    expect(restored.ok).toBe(false)
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('live-before-invalid-restore')
  })

  it('拒绝没有数据库或文件的空快照清单', async () => {
    const dbPath = makeDatabase()
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    const manifestPath = path.join(snapshot.dir!, SNAPSHOT_MANIFEST_NAME)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    manifest.databases = []
    manifest.files = []
    manifest.totalBytes = 0
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))

    const verification = await verifySnapshot(snapshot.dir!)
    expect(verification.ok).toBe(false)
    expect(verification.failed.some((entry) => entry.reason.includes('至少包含一个数据库'))).toBe(true)
  })

  it('独立验证快照文件，不需要当前账号也不读取或写回数据库', async () => {
    const dbPath = makeDatabase()
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    const before = {
      main: fs.readFileSync(dbPath, 'utf-8'),
      wal: fs.readFileSync(`${dbPath}-wal`, 'utf-8'),
      shm: fs.readFileSync(`${dbPath}-shm`, 'utf-8'),
    }
    fs.writeFileSync(dbPath, 'live-before-verify')
    const result = await verifySnapshot(snapshot.dir!)
    expect(result.ok).toBe(true)
    expect(result.id).toBe(path.basename(snapshot.dir!))
    expect(result.verifiedFiles).toBe(3)
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('live-before-verify')
    expect(fs.readFileSync(`${dbPath}-wal`, 'utf-8')).toBe(before.wal)
    expect(fs.readFileSync(`${dbPath}-shm`, 'utf-8')).toBe(before.shm)
  })

  it('独立验证即使快照源账号目录已不存在', async () => {
    const dbPath = makeDatabase()
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    fs.rmSync(accountDir(), { recursive: true, force: true })

    const result = await verifySnapshot(snapshot.dir!)
    expect(result.ok).toBe(true)
    expect(result.verifiedFiles).toBe(3)
    expect(fs.existsSync(dbPath)).toBe(false)
  })

  it('拒绝越出快照目录的文件名和当前账号 db_storage 之外的恢复目标', async () => {
    const dbPath = makeDatabase()
    const outsidePath = path.join(root, 'outside.db')
    fs.writeFileSync(outsidePath, 'must-stay-unchanged')
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    const manifestPath = path.join(snapshot.dir!, SNAPSHOT_MANIFEST_NAME)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

    manifest.files[0].file = '../outside.db'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    const escapedFile = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
    expect(escapedFile.ok).toBe(false)
    expect(fs.readFileSync(outsidePath, 'utf-8')).toBe('must-stay-unchanged')

    manifest.files[0].file = path.basename(manifest.files[0].source)
    manifest.files[0].source = outsidePath
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    const escapedTarget = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
    expect(escapedTarget.ok).toBe(false)
    expect(fs.readFileSync(outsidePath, 'utf-8')).toBe('must-stay-unchanged')
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('sqlcipher-main-body')
  })

  it('拒绝把快照恢复到另一个账号的 db_storage', async () => {
    const dbPath = makeDatabase()
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    const otherAccount = path.join(root, 'other-account')
    fs.mkdirSync(path.join(otherAccount, 'db_storage'), { recursive: true })
    const result = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: otherAccount })
    expect(result.ok).toBe(false)
    expect(result.failed.length).toBeGreaterThan(0)
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('sqlcipher-main-body')
  })

  it('删除快照时不存在、之后出现的 WAL/SHM，并把它们放入恢复前备份', async () => {
    const dbPath = path.join(dbDir, 'session.db')
    const walPath = `${dbPath}-wal`
    const shmPath = `${dbPath}-shm`
    fs.writeFileSync(dbPath, 'snapshot-main')
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    expect(snapshot.manifest!.files.map((entry) => entry.role)).toEqual(['main'])

    fs.writeFileSync(dbPath, 'live-main')
    fs.writeFileSync(walPath, 'wal-created-after-snapshot')
    fs.writeFileSync(shmPath, 'shm-created-after-snapshot')
    const restored = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })

    expect(restored.ok).toBe(true)
    expect(restored.restored).toEqual([dbPath])
    expect(restored.removed).toEqual([walPath, shmPath])
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('snapshot-main')
    expect(fs.existsSync(walPath)).toBe(false)
    expect(fs.existsSync(shmPath)).toBe(false)
    const backupContents = fs.readdirSync(restored.backupDir!).map((name) => fs.readFileSync(path.join(restored.backupDir!, name), 'utf-8'))
    expect(backupContents).toEqual(expect.arrayContaining(['live-main', 'wal-created-after-snapshot', 'shm-created-after-snapshot']))
  })

  it('rolls back sidecar deletions if replacing the main DB fails', async () => {
    const dbPath = path.join(dbDir, 'session.db')
    const walPath = `${dbPath}-wal`
    const shmPath = `${dbPath}-shm`
    fs.writeFileSync(dbPath, 'snapshot-main')
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    fs.writeFileSync(dbPath, 'live-main-before-restore')
    fs.writeFileSync(walPath, 'live-wal-before-restore')
    fs.writeFileSync(shmPath, 'live-shm-before-restore')
    const originalRename = fs.promises.rename.bind(fs.promises)
    let failMainCommit = true
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === dbPath && failMainCommit) {
        failMainCommit = false
        throw new Error('injected main DB replacement failure')
      }
      return originalRename(from, to)
    })
    try {
      const result = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
      expect(result.ok).toBe(false)
      expect(result.rollback?.complete).toBe(true)
      expect(result.rollback?.restoredOriginals).toEqual(expect.arrayContaining([walPath, shmPath]))
      expect(fs.readFileSync(dbPath, 'utf-8')).toBe('live-main-before-restore')
      expect(fs.readFileSync(walPath, 'utf-8')).toBe('live-wal-before-restore')
      expect(fs.readFileSync(shmPath, 'utf-8')).toBe('live-shm-before-restore')
    } finally {
      renameSpy.mockRestore()
    }
  })

  it('写回失败时把已替换文件恢复到原状态并保留备份', async () => {
    const dbPath = makeDatabase()
    const walPath = `${dbPath}-wal`
    const shmPath = `${dbPath}-shm`
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    fs.writeFileSync(dbPath, 'live-main-before-restore')
    fs.writeFileSync(walPath, 'live-wal-before-restore')
    const originalRename = fs.promises.rename.bind(fs.promises)
    let failCommit = true
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === dbPath && failCommit) {
        failCommit = false
        throw new Error('injected commit failure')
      }
      return originalRename(from, to)
    })
    try {
      const result = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
      expect(result.ok).toBe(false)
      expect(result.rollback?.complete).toBe(true)
      expect(result.rollback?.restoredOriginals).toContain(dbPath)
      expect(result.rollback?.restoredOriginals).toContain(walPath)
      expect(result.rollback?.restoredOriginals).toContain(shmPath)
      expect(fs.readFileSync(dbPath, 'utf-8')).toBe('live-main-before-restore')
      expect(fs.readFileSync(walPath, 'utf-8')).toBe('live-wal-before-restore')
      expect(fs.readFileSync(shmPath, 'utf-8')).toBe('shm-shared-memory')
      expect(fs.existsSync(result.backupDir!)).toBe(true)
    } finally {
      renameSpy.mockRestore()
    }
  })

  it('回滚也失败时明确报告未完成并保留恢复前副本', async () => {
    const dbPath = makeDatabase()
    const walPath = `${dbPath}-wal`
    const shmPath = `${dbPath}-shm`
    const snapshot = await createSnapshot({ rootDir: snapshotRoot, reason: 'manual', databasePaths: [dbPath] })
    fs.writeFileSync(dbPath, 'live-main-before-restore')
    fs.writeFileSync(walPath, 'live-wal-before-restore')
    const originalRename = fs.promises.rename.bind(fs.promises)
    let failMainCommit = true
    let walRenames = 0
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === dbPath && failMainCommit) {
        failMainCommit = false
        throw new Error('injected main DB replacement failure')
      }
      if (String(to) === walPath) {
        walRenames += 1
        if (walRenames === 2) throw new Error('injected WAL rollback failure')
      }
      return originalRename(from, to)
    })
    try {
      const result = await restoreSnapshot(snapshot.dir!, { allowedAccountDir: accountDir() })
      expect(result.ok).toBe(false)
      expect(result.rollback?.complete).toBe(false)
      expect(result.rollback?.failed.map((entry) => entry.source)).toContain(walPath)
      expect(result.error).toContain('回滚未完成')
      expect(fs.readFileSync(dbPath, 'utf-8')).toBe('live-main-before-restore')
      expect(fs.readFileSync(walPath, 'utf-8')).toBe('wal-unmerged-frames')
      expect(fs.readFileSync(shmPath, 'utf-8')).toBe('shm-shared-memory')
      const backupContents = fs.readdirSync(result.backupDir!).map((name) => fs.readFileSync(path.join(result.backupDir!, name), 'utf-8'))
      expect(backupContents).toContain('live-main-before-restore')
      expect(backupContents).toContain('live-wal-before-restore')
    } finally {
      renameSpy.mockRestore()
    }
  })

  it('manifest 缺失时恢复失败，不抛异常', async () => {
    const empty = path.join(root, 'empty-snapshot')
    fs.mkdirSync(empty, { recursive: true })
    const result = await restoreSnapshot(empty, { allowedAccountDir: accountDir() })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('manifest.json')
  })
})

describe('保留策略：只留最近 10 份', () => {
  it('第 11 份写入后，最老的一份被删除', async () => {
    const dbPath = makeDatabase()
    for (let i = 0; i < SNAPSHOT_RETENTION + 1; i += 1) {
      const result = await createSnapshot({ rootDir: snapshotRoot, reason: `write-${i}`, databasePaths: [dbPath] })
      expect(result.ok).toBe(true)
      // 目录名按毫秒时间戳，同毫秒会重名；这里显式错开，模拟真实调用间隔
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
    const removed = await applyRetention(snapshotRoot, SNAPSHOT_RETENTION)
    expect(removed).toHaveLength(1)
    const remaining = await listSnapshots(snapshotRoot)
    expect(remaining).toHaveLength(SNAPSHOT_RETENTION)
    // 删掉的是最老的那份（write-0），最新的还在
    expect(remaining[0].reason).toBe(`write-${SNAPSHOT_RETENTION}`)
    expect(remaining.some((snapshot) => snapshot.reason === 'write-0')).toBe(false)
  })

  it('不足 10 份时什么都不删', async () => {
    const dbPath = makeDatabase()
    for (let i = 0; i < 3; i += 1) {
      await createSnapshot({ rootDir: snapshotRoot, reason: `write-${i}`, databasePaths: [dbPath] })
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
    const removed = await applyRetention(snapshotRoot, SNAPSHOT_RETENTION)
    expect(removed).toEqual([])
    expect(await listSnapshots(snapshotRoot)).toHaveLength(3)
  })

  it('listSnapshots 按时间倒序（新→旧），坏 manifest 的目录被跳过但不删', async () => {
    const dbPath = makeDatabase()
    await createSnapshot({ rootDir: snapshotRoot, reason: 'a', databasePaths: [dbPath] })
    await new Promise((resolve) => setTimeout(resolve, 4))
    await createSnapshot({ rootDir: snapshotRoot, reason: 'b', databasePaths: [dbPath] })
    const broken = path.join(snapshotRoot, '20200101-000000-000-broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, SNAPSHOT_MANIFEST_NAME), '{not json')

    const list = await listSnapshots(snapshotRoot)
    expect(list.map((snapshot) => snapshot.reason)).toEqual(['b', 'a'])
    expect(fs.existsSync(broken)).toBe(true)
  })

  it('快照根目录不存在时 listSnapshots 返回空数组', async () => {
    expect(await listSnapshots(path.join(root, 'missing'))).toEqual([])
  })
})

describe('withAutoSnapshot：先快照，再写入', () => {
  it('快照失败时写操作不执行（顺序不能颠倒）', async () => {
    const dbPath = makeDatabase()
    // 用一个文件当 snapshots 根目录，制造 mkdir 必失败
    const blockedRoot = path.join(root, 'blocked-root')
    fs.writeFileSync(blockedRoot, 'not a directory')
    let wrote = false
    const { snapshot, result } = await withAutoSnapshot(
      { rootDir: blockedRoot, reason: 'anti-revoke-install', databasePaths: [dbPath] },
      async () => { wrote = true; return 'written' },
    )
    expect(snapshot.ok).toBe(false)
    expect(result).toBeUndefined()
    expect(wrote).toBe(false)
  })

  it('成功时先落快照再执行，并在执行前完成保留策略', async () => {
    const dbPath = makeDatabase()
    const order: string[] = []
    const { snapshot, result } = await withAutoSnapshot(
      { rootDir: snapshotRoot, reason: 'sns-delete', databasePaths: [dbPath] },
      async () => { order.push('write'); return 'ok' },
    )
    expect(snapshot.ok).toBe(true)
    expect(result).toBe('ok')
    expect(order).toEqual(['write'])
    const list = await listSnapshots(snapshotRoot)
    expect(list).toHaveLength(1)
    expect(fs.existsSync(path.join(list[0].dir, SNAPSHOT_MANIFEST_NAME))).toBe(true)
  })
})
