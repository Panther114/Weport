import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('./config', () => ({ ConfigService: class { getCacheBasePath() { return tmpdir() } get() { return '' } } }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
import { chatService } from './chatService'
import { ImageDecryptService } from './imageDecryptService'
let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })
it('rebinds every eager chat cache to recovered storage before opening a connection', () => {
  root = mkdtempSync(join(tmpdir(), 'weport-cache-rebind-'))
  const target = Object.create(Object.getPrototypeOf(chatService)) as any
  Object.assign(target, { connected: false, cacheStorageBasePath: 'old-root', configService: { getCacheBasePath: () => root } })
  target.initializeStorageAfterRestart()
  for (const field of ['contactCacheService', 'messageCacheService', 'sessionStatsCacheService', 'groupMyMessageCountCacheService']) {
    expect(target[field].cacheFilePath.startsWith(root)).toBe(true)
  }
  expect(target.cacheStorageBasePath).toBe(root)
  const original = target.messageCacheService
  target.initializeStorageAfterRestart()
  expect(target.messageCacheService).toBe(original)
  target.connected = true; target.cacheStorageBasePath = 'old-root'
  expect(() => target.initializeStorageAfterRestart()).toThrow('before opening')
})

it('binds exact reader image resolution to the runtime account rather than the persisted account', async () => {
  const target = Object.create(Object.getPrototypeOf(chatService)) as any
  let imageAccount = 'persisted-account-A'
  const setImageConfig = vi.fn((config: { myWxid?: string }) => { imageAccount = config.myWxid || 'persisted-account-A' })
  Object.assign(target, {
    connected: false, resolveConnectSnapshot: () => ({ identity: 'fixture' }),
    imageDecryptService: { setRuntimeConfig: setImageConfig, decryptImage: vi.fn(async () => ({ success: true, localPath: 'data:image/png;base64,' + Buffer.from(imageAccount).toString('base64') })) },
    getMessageByIdentity: vi.fn(async () => ({ success: true, message: { imageMd5: 'a'.repeat(32), createTime: 1700000000 } })),
  })
  const runtime = { dbPath: '/private/B', myWxid: 'runtime-account-B', decryptKey: 'fixture-db-key', imageXorKey: 23, imageAesKey: 'fixture-image-key' }
  target.setRuntimeConfig(runtime)
  const result = await target.getImageDataByIdentity({ sessionId: 'room', localId: '1', ts: 1700000000, db: 'db_storage/message/message_0.db', table: 'Msg_room', idKind: 'local' })
  expect(result.success).toBe(true)
  expect(Buffer.from(result.data, 'base64').toString()).toBe('runtime-account-B')
  expect(setImageConfig).toHaveBeenLastCalledWith({ dbPath: runtime.dbPath, myWxid: runtime.myWxid, imageXorKey: 23, imageAesKey: 'fixture-image-key' })
  target.setRuntimeConfig({ dbPath: '/private/C', myWxid: 'runtime-account-C' })
  expect(setImageConfig).toHaveBeenLastCalledWith({ dbPath: '/private/C', myWxid: 'runtime-account-C', imageXorKey: undefined, imageAesKey: undefined })
})

it('uses the runtime account directory for image cache and sidecar metadata lookup', () => {
  const image = Object.create(ImageDecryptService.prototype) as any
  const getAccountDir = vi.fn((db?: string, wxid?: string) => db && wxid ? db + '/' + wxid : '/persisted/account-A')
  image.configService = { getAccountDir, get: () => '/persisted', getMyWxidCleaned: () => 'account-A' }
  image.setRuntimeConfig({ dbPath: '/private', myWxid: 'runtime-account-B' })
  expect(image.resolveCurrentAccountDir()).toBe('/private/runtime-account-B')
  expect(getAccountDir).toHaveBeenLastCalledWith('/private', 'runtime-account-B')
})
