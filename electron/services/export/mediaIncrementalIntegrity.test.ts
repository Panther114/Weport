import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

vi.mock('../config', () => ({ ConfigService: class {
  getCacheBasePath() { return os.tmpdir() }
  getMyWxidCleaned() { return 'wxid_fixture' }
  get() { return '' }
} }))
vi.mock('../wcdbService', () => ({ wcdbService: {} }))
vi.mock('../chatService', () => ({ chatService: { setRuntimeConfig: vi.fn(), getVoiceData: vi.fn() } }))
vi.mock('../imageDecryptService', () => ({ imageDecryptService: { setRuntimeConfig: vi.fn() } }))
vi.mock('../exportRecordService', () => ({ exportRecordService: {} }))
import { ExportContext } from './core/ExportContext'
import { chatService } from '../chatService'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'weport-media-integrity-')) throw new Error('Fixture boundary rejected')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('incremental media without a previous ledger', () => {
  it.each([false, true])('validates derived cache bytes and isolates exports (corrupt cache: %s)', async corrupted => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-media-integrity-'))
    roots.push(root)
    const source = path.join(root, 'original.png'), cached = path.join(root, 'cached.png'), target = path.join(root, 'output.png')
    fs.writeFileSync(source, 'original image bytes')
    fs.writeFileSync(cached, corrupted ? 'corrupt cache bytes' : 'original image bytes')
    const context = new ExportContext()
    vi.spyOn(context as any, 'resolvePreferredMediaSource').mockResolvedValue({ sourcePath: cached, cacheHit: true })
    const result = await (context as any).copyMediaWithCacheAndDedup('image', source, target, undefined,
      { exportConflictStrategy: 'overwrite' }, 'media/output.png')
    expect(result.success).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('original image bytes')
    fs.writeFileSync(target, 'user edits exported image')
    expect(fs.readFileSync(source, 'utf8')).toBe('original image bytes')
    expect(fs.readFileSync(cached, 'utf8')).toBe(corrupted ? 'corrupt cache bytes' : 'original image bytes')
  })
  it('repairs corrupted voice bytes through the normal media export route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-media-integrity-'))
    roots.push(root)
    const payload = Buffer.from('RIFF fixture voice bytes')
    vi.mocked(chatService.getVoiceData).mockResolvedValue({ success: true, data: payload.toString('base64') })
    const context = new ExportContext()
    const message = { localType: 34, localId: 1, createTime: 1770000000, serverId: '123' }
    const options = { exportVoices: true, exportConflictStrategy: 'incremental' as const }
    const first = await context.exportMediaForMessage(message, 'fixture', root, 'media', options)
    expect(first?.kind).toBe('voice')
    const destination = path.join(root, first!.relativePath)
    fs.writeFileSync(destination, 'corrupted voice output')
    const second = await context.exportMediaForMessage(message, 'fixture', root, 'media', options)
    expect(second?.relativePath).toBe(first!.relativePath)
    expect(fs.readFileSync(destination)).toEqual(payload)
    const modified = fs.statSync(destination).mtimeMs
    await context.exportMediaForMessage(message, 'fixture', root, 'media', options)
    expect(fs.statSync(destination).mtimeMs).toBe(modified)
  })
  it.each(['image', 'video', 'emoji'] as const)('repairs corrupt %s output instead of trusting existence', async kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-media-integrity-'))
    roots.push(root)
    const source = path.join(root, 'source.bin'), target = path.join(root, 'target.bin')
    fs.writeFileSync(source, 'valid original fixture bytes')
    fs.writeFileSync(target, 'corrupt previously exported bytes')
    const context = new ExportContext()
    const result = await (context as any).copyMediaWithCacheAndDedup(kind, source, target, undefined,
      { exportConflictStrategy: 'incremental' }, 'media/target.bin')
    expect(result.success).toBe(true)
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(source))
    const modified = fs.statSync(target).mtimeMs
    const repeated = await (context as any).copyMediaWithCacheAndDedup(kind, source, target, undefined,
      { exportConflictStrategy: 'incremental' }, 'media/target.bin')
    expect(repeated.success).toBe(true)
    expect(fs.statSync(target).mtimeMs).toBe(modified)
    // An unavailable source cannot turn an arbitrary existing file into success.
    const unavailable = await (context as any).copyMediaWithCacheAndDedup(kind, path.join(root, 'missing.bin'), target, undefined,
      { exportConflictStrategy: 'incremental' }, 'media/target.bin')
    expect(unavailable.success).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('valid original fixture bytes')
  })
})
