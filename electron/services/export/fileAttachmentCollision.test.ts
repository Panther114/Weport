import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'

vi.mock('../config', () => ({ ConfigService: class {
  getCacheBasePath() { return os.tmpdir() }
  getMyWxidCleaned() { return 'wxid_fixture' }
  get() { return '' }
} }))
vi.mock('../wcdbService', () => ({ wcdbService: {} }))
vi.mock('../chatService', () => ({ chatService: { setRuntimeConfig: vi.fn() } }))
vi.mock('../imageDecryptService', () => ({ imageDecryptService: { setRuntimeConfig: vi.fn() } }))
vi.mock('../exportRecordService', () => ({ exportRecordService: {} }))
import { ExportContext } from './core/ExportContext'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'weport-file-collision-')) throw new Error('Fixture boundary rejected')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('same-name attachment payloads', () => {
  it.each(['overwrite', 'incremental'] as const)('preserves both payloads under %s', async strategy => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-file-collision-'))
    roots.push(root)
    const account = path.join(root, 'account'), output = path.join(root, 'output')
    const payloads = ['first distinct attachment', 'second distinct attachment']
    for (let index = 0; index < 2; index++) {
      const directory = path.join(account, 'msg', 'file', `2026-0${index + 5}`)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'report.txt'), payloads[index])
    }
    const context = new ExportContext()
    context.setRuntimeConfig({ dbPath: account, myWxid: 'wxid_fixture' })
    const results = []
    for (let index = 0; index < 2; index++) results.push(await context.exportMediaForMessage({
      localType: 49, xmlType: '6', fileName: 'report.txt', fileExt: 'txt',
      fileMd5: createHash('md5').update(payloads[index]).digest('hex'),
      createTime: Math.floor(new Date(`2026-0${index + 5}-02T00:00:00Z`).getTime() / 1000),
    }, 'fixture', output, 'media', { exportFiles: true, exportConflictStrategy: strategy }))
    expect(results.every(result => result?.kind === 'file')).toBe(true)
    expect(results[0]?.relativePath).not.toBe(results[1]?.relativePath)
    for (let index = 0; index < 2; index++) {
      const exported = path.join(output, results[index]!.relativePath)
      expect(path.basename(exported)).toBe('report.txt')
      expect(fs.readFileSync(exported, 'utf8')).toBe(payloads[index])
    }
    // Incremental reuse must validate the bytes, even when the path exists.
    fs.writeFileSync(path.join(output, results[0]!.relativePath), 'corrupt old output')
    const repaired = await context.exportMediaForMessage({
      localType: 49, xmlType: '6', fileName: 'report.txt', fileExt: 'txt',
      fileMd5: createHash('md5').update(payloads[0]).digest('hex'),
      createTime: Math.floor(new Date('2026-05-02T00:00:00Z').getTime() / 1000),
    }, 'fixture', output, 'media', { exportFiles: true, exportConflictStrategy: strategy })
    expect(repaired?.relativePath).toBe(results[0]!.relativePath)
    expect(fs.readFileSync(path.join(output, repaired!.relativePath), 'utf8')).toBe(payloads[0])
    await expect(context.exportMediaForMessage({
      localType: 49, xmlType: '6', fileName: 'report.txt', fileExt: 'txt',
      fileMd5: createHash('md5').update(payloads[0]).digest('hex'),
      createTime: Math.floor(new Date('2026-05-02T00:00:00Z').getTime() / 1000),
    }, 'fixture', output, 'media', { exportFiles: true, exportConflictStrategy: strategy,
      control: { shouldStop: () => true } })).rejects.toThrow()
  })
})
