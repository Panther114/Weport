import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'

vi.mock('electron', () => ({ app: { getVersion: () => 'test' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./config', () => ({ ConfigService: class {} }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
import { BackupService } from './backupService'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe('backup destination contract (#55)', () => {
  it.each([true, false])('packs a readable archive when given a directory=%s', async (directory) => {
    root = mkdtempSync(join(tmpdir(), 'weport-backup-test-'))
    const service = new BackupService() as any
    service.ensureConnected = async () => ({ success: true, wxid: 'fixture', dbPath: root, dbStorage: root })
    service.collectDatabases = async () => []
    const destination = directory ? root : join(root, 'explicit.zip')
    const result = await service.createBackup(destination)
    expect(result.success, result.error).toBe(true)
    expect(result.filePath).not.toBe(root)
    if (!directory) expect(result.filePath).toBe(destination)
    const entries: string[] = []
    await tar.t({ file: result.filePath, onReadEntry: entry => { entries.push(entry.path) } })
    expect(entries).toContain('manifest.json')
    expect(readdirSync(root)).toHaveLength(1)
  })
})
