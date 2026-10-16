import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ home: '', documents: '', appData: '' }))
vi.mock('electron', () => ({ app: { getPath: (key: 'documents' | 'appData') => paths[key] } }))
vi.mock('os', async importOriginal => ({ ...await importOriginal<typeof import('os')>(), homedir: () => paths.home }))
import { DbPathService } from './dbPathService'
import { windowsDbRoots } from './windowsDbRoots'

describe.skipIf(process.platform !== 'win32')('Windows database discovery (issue #36)', () => {
  let fixture = ''
  let configDir = ''
  const hintName = 'a'.repeat(32) + '.ini'
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'weport-db-discovery-'))
    paths.home = join(fixture, 'home')
    paths.documents = join(fixture, 'OneDrive', 'Documents')
    paths.appData = join(fixture, 'AppData')
    configDir = join(paths.appData, 'Tencent', 'xwechat', 'config')
    mkdirSync(configDir, { recursive: true })
  })
  afterEach(() => rmSync(fixture, { recursive: true, force: true }))
  const account = (root: string) => mkdirSync(join(root, 'wxid_fixture', 'db_storage'), { recursive: true })

  it('finds redirected Documents in both auto and default discovery', async () => {
    const root = join(paths.documents, 'xwechat_files')
    account(root)
    const service = new DbPathService()
    expect(await service.autoDetect()).toEqual({ success: true, path: root })
    expect(service.getDefaultPath()).toBe(root)
    expect(service.scanWxids(root).map(w => w.wxid)).toEqual(['wxid_fixture'])
  })
  it.each([false, true])('finds a custom save location, already-root=%s', async alreadyRoot => {
    const parent = join(fixture, 'custom', '微信数据')
    const root = join(parent, 'xwechat_files')
    account(root)
    writeFileSync(join(configDir, hintName), alreadyRoot ? root : parent)
    const service = new DbPathService()
    expect(await service.autoDetect()).toEqual({ success: true, path: root })
    expect(service.getDefaultPath()).toBe(root)
  })
  it('resolves MyDocument and UTF-16 BOM without treating the token as a path', async () => {
    const root = join(paths.documents, 'xwechat_files')
    account(root)
    writeFileSync(join(configDir, hintName), Buffer.from('\uFEFFMyDocument:\0', 'utf16le'))
    expect(windowsDbRoots(paths.home, paths.documents, paths.appData)[0]).toBe(root)
    expect((await new DbPathService().autoDetect()).path).toBe(root)
  })
  it('ignores malformed, oversized and stale hints, then finds the legacy default', async () => {
    writeFileSync(join(configDir, hintName), 'relative\\folder')
    writeFileSync(join(configDir, 'b'.repeat(32) + '.ini'), 'X'.repeat(4097))
    writeFileSync(join(configDir, 'c'.repeat(32) + '.ini'), join(fixture, 'gone'))
    const root = join(paths.home, 'Documents', 'xwechat_files')
    account(root)
    expect((await new DbPathService().autoDetect()).path).toBe(root)
  })
  it('rejects a 3.x layout and explains how to select a directory', async () => {
    mkdirSync(join(paths.documents, 'xwechat_files', 'wxid_fixture', 'FileStorage', 'Image'), { recursive: true })
    const result = await new DbPathService().autoDetect()
    expect(result.success).toBe(false)
    expect(result.error).toContain('微信 4.x')
    expect(result.error).toContain('手动选择')
  })
})

describe.skipIf(process.platform !== 'linux')('Linux database discovery', () => {
  let fixture = ''
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'weport-linux-discovery-'))
    paths.home = join(fixture, 'home')
    vi.stubEnv('XDG_DATA_HOME', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(fixture, { recursive: true, force: true })
  })
  const account = (root: string) => mkdirSync(join(root, 'wxid_fixture', 'db_storage'), { recursive: true })

  it('finds native WeChat Documents data while skipping empty older roots', async () => {
    mkdirSync(join(paths.home, 'xwechat_files'), { recursive: true })
    const root = join(paths.home, 'Documents', 'xwechat_files')
    account(root)
    const service = new DbPathService()
    expect(await service.autoDetect()).toEqual({ success: true, path: root })
    expect(service.getDefaultPath()).toBe(root)
    expect(service.scanWxids(root).map(w => w.wxid)).toEqual(['wxid_fixture'])
  })

  it.each(['com.tencent.WeChat', 'com.tencent.wechat'])('finds Flatpak data for %s', async appId => {
    const root = join(paths.home, '.var', 'app', appId, 'data', 'xwechat_files')
    account(root)
    expect(await new DbPathService().autoDetect()).toEqual({ success: true, path: root })
  })

  it('honors an absolute XDG data root', async () => {
    const data = join(fixture, 'custom-data')
    vi.stubEnv('XDG_DATA_HOME', data)
    const root = join(data, 'xwechat_files')
    account(root)
    expect(await new DbPathService().autoDetect()).toEqual({ success: true, path: root })
  })

  it('ignores relative XDG data roots and uses the standard fallback', async () => {
    vi.stubEnv('XDG_DATA_HOME', 'relative-data')
    const root = join(paths.home, '.local', 'share', 'xwechat_files')
    account(root)
    expect(await new DbPathService().autoDetect()).toEqual({ success: true, path: root })
  })
})
