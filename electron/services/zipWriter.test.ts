import { describe, expect, it } from 'vitest'
import { createZipBuffer, crc32, normalizeZipEntryName, readZipBuffer } from './zipWriter'

/**
 * ZIP 写入器单测。
 *
 * 断言方式是"写出去、再独立读回来"：`readZipBuffer` 会**重算每个条目的 CRC-32 与
 * 长度**，因此内容对不上、偏移算错、压缩标志写错都会在这里失败 —— 而不是等到
 * 用户用资源管理器打不开包才发现。
 */

describe('crc32', () => {
  it('与标准向量一致', () => {
    // 经典向量：CRC-32("The quick brown fox jumps over the lazy dog") = 0x414FA339
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog', 'utf8'))).toBe(0x414fa339)
    expect(crc32(Buffer.alloc(0))).toBe(0)
    expect(crc32(Buffer.from('a', 'utf8'))).toBe(0xe8b7be43)
  })
})

describe('normalizeZipEntryName', () => {
  it('统一分隔符并去掉目录穿越段', () => {
    expect(normalizeZipEntryName('logs\\wcdb.log')).toBe('logs/wcdb.log')
    expect(normalizeZipEntryName('/a//b.log')).toBe('a/b.log')
    expect(normalizeZipEntryName('../../etc/passwd')).toBe('etc/passwd')
    expect(normalizeZipEntryName('./checks.md')).toBe('checks.md')
  })
})

describe('createZipBuffer / readZipBuffer 往返', () => {
  it('多条目（含中文名、可压缩大文件）能原样读回', () => {
    const big = Buffer.from('weport diagnostics '.repeat(2000), 'utf8') // 36 KB，可压缩
    const entries = [
      { name: 'checks.md', data: '# Weport 诊断摘要\n\n一切正常。' },
      { name: 'logs/wcdb.log', data: '[bootstrap] ok\n[bootstrap] ok\n' },
      { name: '配置/中文名.json', data: JSON.stringify({ theme: 'dark', n: 1 }) },
      { name: 'big.txt', data: big },
      { name: 'empty.txt', data: '' },
    ]
    const zip = createZipBuffer(entries, { date: new Date('2025-01-02T03:04:06Z') })

    // 魔数 + EOCD 都在（说明这是一个真正的 zip，而不是随便一串字节）
    expect(zip.subarray(0, 4).toString('binary')).toBe('PK\u0003\u0004')
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true)

    const read = readZipBuffer(zip)
    expect(read.map((entry) => entry.name)).toEqual([
      'checks.md',
      'logs/wcdb.log',
      '配置/中文名.json',
      'big.txt',
      'empty.txt',
    ])
    const byName = new Map(read.map((entry) => [entry.name, entry]))
    expect(byName.get('checks.md')!.data.toString('utf8')).toBe('# Weport 诊断摘要\n\n一切正常。')
    expect(byName.get('logs/wcdb.log')!.data.toString('utf8')).toBe('[bootstrap] ok\n[bootstrap] ok\n')
    expect(JSON.parse(byName.get('配置/中文名.json')!.data.toString('utf8'))).toEqual({ theme: 'dark', n: 1 })
    expect(byName.get('big.txt')!.data.equals(big)).toBe(true)
    expect(byName.get('empty.txt')!.data.length).toBe(0)

    // 大文本应当被压缩（方法 8），小文件走 STORE（方法 0）
    expect(byName.get('big.txt')!.method).toBe(8)
    expect(zip.length).toBeLessThan(big.length)
    expect(byName.get('checks.md')!.method).toBe(0)
  })

  it('拒绝空条目名', () => {
    expect(() => createZipBuffer([{ name: '  ', data: 'x' }])).toThrow(/条目名/)
  })
})
