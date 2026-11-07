import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, BrowserWindow: {} }))
vi.mock('./config', () => ({ ConfigService: class {} }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
import { ImageDecryptService } from './imageDecryptService'

describe('full-quality image requests', () => {
  it('does not share a pending thumbnail request with an original request', () => {
    const service = Object.create(ImageDecryptService.prototype) as any
    for (const method of ['getResolvePendingKey', 'getDecryptPendingKey']) {
      expect(service[method]({ sessionId: 'room' }, 'image')).not.toBe(service[method]({ sessionId: 'room', excludeThumbnail: true }, 'image'))
    }
  })
  it('invalidates a cached display image when a higher-tier original becomes available, even if its encoded file is smaller', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weport-image-quality-'))
    try {
      const md5 = 'a'.repeat(32), cached = join(dir, `${md5}.jpg`), original = join(dir, `${md5}_h.dat`)
      writeFileSync(cached, Buffer.alloc(500)); writeFileSync(original, Buffer.alloc(100))
      const service = Object.create(ImageDecryptService.prototype) as any
      Object.assign(service, { resolveCurrentAccountDir: () => dir, selectBestDatPathByBase: () => original,
        findCachedOutputByDatPath: () => null, deleteResolvedMediaCache: vi.fn(), cacheDatPath: vi.fn(), logInfo: vi.fn() })
      expect(await service.resolveThumbnailUpgrade({ imageMd5: md5, excludeThumbnail: true }, md5, cached)).toEqual({ kind: 'stale' })
      expect(service.deleteResolvedMediaCache).toHaveBeenCalledOnce()
      expect(service.cacheDatPath).toHaveBeenCalledWith(dir, md5, original)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
