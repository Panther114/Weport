import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MediaDedupeCounter,
  MediaDedupeCache,
  MediaHashIndex,
  fingerprintKey,
  hashFileContent,
  normalizeRelPath,
  verifyMediaAgainstLedger,
} from './mediaDedupeCache'
import type { LedgerMediaEntry } from './ledger'

/**
 * 媒体去重与解密缓存（v1.2 §10.1 ①）。
 *
 * 守四件事：账本媒体清单按内容哈希判定（缺文件/被截断/被改写都要重做）、
 * 解密缓存键含 `(路径, mtime, size, 密钥指纹)` 且**绝不出现密钥原文**、
 * 缓存读不出来只等于未命中（不是数据源）。
 */

let root = ''
let cacheDir = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-media-'))
  cacheDir = path.join(root, 'cache')
  fs.mkdirSync(cacheDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('密钥指纹', () => {
  it('单向、定长、可安全进缓存键与日志', () => {
    const key = 'a'.repeat(64)
    const fingerprint = fingerprintKey(key)
    expect(fingerprint).toMatch(/^k[0-9a-f]{16}$/)
    expect(fingerprint).not.toContain(key)
    expect(fingerprintKey(key)).toBe(fingerprint)
    expect(fingerprintKey('b'.repeat(64))).not.toBe(fingerprint)
  })

  it('空密钥有稳定占位（不产生 undefined 之类的怪键）', () => {
    expect(fingerprintKey('')).toBe('no-key')
    expect(fingerprintKey(null)).toBe('no-key')
    expect(fingerprintKey(undefined)).toBe('no-key')
  })
})

describe('内容哈希', () => {
  it('hashFileContent 与文件内容一致，缺失文件返回 null', async () => {
    const file = path.join(root, 'a.bin')
    fs.writeFileSync(file, 'media-bytes')
    const hash = await hashFileContent(file)
    expect(hash?.bytes).toBe(Buffer.byteLength('media-bytes'))
    expect(hash?.sha256).toHaveLength(64)
    expect(await hashFileContent(path.join(root, 'missing.bin'))).toBeNull()
  })
})

describe('账本媒体清单（mediaHashes）判定', () => {
  const mediaDir = () => path.join(root, 'media')

  it('路径命中且内容一致 → 可以跳过复制', async () => {
    fs.mkdirSync(mediaDir(), { recursive: true })
    const file = path.join(mediaDir(), 'a.jpg')
    fs.writeFileSync(file, 'image-bytes')
    const hash = await hashFileContent(file)
    const entry: LedgerMediaEntry = { path: 'media/a.jpg', sha256: hash!.sha256, bytes: hash!.bytes }
    const decision = await verifyMediaAgainstLedger(file, entry)
    expect(decision).toEqual({ skip: true, reason: 'verified' })
  })

  it('文件被删 → 不能跳过', async () => {
    const entry: LedgerMediaEntry = { path: 'media/gone.jpg', sha256: 'x'.repeat(64), bytes: 5 }
    const decision = await verifyMediaAgainstLedger(path.join(mediaDir(), 'gone.jpg'), entry)
    expect(decision.skip).toBe(false)
    expect(decision.reason).toBe('not-found')
  })

  it('文件被截断（大小不符）→ 不能跳过', async () => {
    fs.mkdirSync(mediaDir(), { recursive: true })
    const file = path.join(mediaDir(), 'b.jpg')
    fs.writeFileSync(file, 'full-image-bytes')
    const entry: LedgerMediaEntry = { path: 'media/b.jpg', sha256: 'x'.repeat(64), bytes: 999 }
    const decision = await verifyMediaAgainstLedger(file, entry)
    expect(decision.skip).toBe(false)
    expect(decision.reason).toBe('size-mismatch')
  })

  it('大小相同但内容不同（只靠哈希才能发现）→ 不能跳过', async () => {
    fs.mkdirSync(mediaDir(), { recursive: true })
    const file = path.join(mediaDir(), 'c.jpg')
    fs.writeFileSync(file, 'aaaa')
    const entry: LedgerMediaEntry = { path: 'media/c.jpg', sha256: 'x'.repeat(64), bytes: 4 }
    const decision = await verifyMediaAgainstLedger(file, entry)
    expect(decision.skip).toBe(false)
    expect(decision.reason).toBe('sha-mismatch')
  })

  it('账本里没有这条记录 → 不能跳过（no-record）', async () => {
    const decision = await verifyMediaAgainstLedger(path.join(mediaDir(), 'd.jpg'), undefined)
    expect(decision).toEqual({ skip: false, reason: 'no-record' })
  })
})

describe('MediaHashIndex', () => {
  it('按相对路径查，反斜杠与多余前缀被归一化', () => {
    const index = new MediaHashIndex(
      [{ path: 'media/wxid_a/2024-01/x.jpg', sha256: 'h1', bytes: 10 }],
      'D:/out',
    )
    expect(index.size).toBe(1)
    expect(index.has('media\\wxid_a\\2024-01\\x.jpg')).toBe(true)
    expect(index.has('/media/wxid_a/2024-01/x.jpg')).toBe(true)
    expect(index.get('media/wxid_a/2024-01/x.jpg')?.sha256).toBe('h1')
  })

  it('相对路径能还原成绝对路径（shared / per-session 两种布局都对）', () => {
    const index = new MediaHashIndex([], path.join(root, 'out'))
    expect(index.resolveAbsolute('media/a/b.jpg')).toBe(path.join(root, 'out', 'media', 'a', 'b.jpg'))
    expect(index.resolveAbsolute('会话1/media/a/b.jpg')).toBe(path.join(root, 'out', '会话1', 'media', 'a', 'b.jpg'))
    expect(index.resolveAbsolute('')).toBeNull()
  })

  it('没有根目录时不猜测绝对路径（返回 null，由调用方兜底）', () => {
    const index = new MediaHashIndex([{ path: 'media/a.jpg', sha256: 'h', bytes: 1 }])
    expect(index.getRootDir()).toBe('')
    expect(index.resolveAbsolute('media/a.jpg')).toBeNull()
  })

  it('同内容哈希可以跨会话查到（跨会话去重的依据）', () => {
    const index = new MediaHashIndex([
      { path: 'a/media/x.jpg', sha256: 'same', bytes: 3 },
      { path: 'b/media/y.jpg', sha256: 'same', bytes: 3 },
    ])
    expect(index.pathsWithHash('same').sort()).toEqual(['a/media/x.jpg', 'b/media/y.jpg'])
  })

  it('listAll 排序稳定、find 按谓词筛选', () => {
    const index = new MediaHashIndex([
      { path: 'b/x.jpg', sha256: 'h2', bytes: 2 },
      { path: 'a/x.jpg', sha256: 'h1', bytes: 1 },
    ])
    expect(index.listAll().map((entry) => entry.path)).toEqual(['a/x.jpg', 'b/x.jpg'])
    expect(index.find((entry) => entry.path.startsWith('b/'))).toHaveLength(1)
  })

  it('空路径条目被丢弃（不会变成\"永远命中\"）', () => {
    const index = new MediaHashIndex([{ path: '   ', sha256: 'h', bytes: 1 }])
    expect(index.size).toBe(0)
  })

  it('normalizeRelPath 统一成 POSIX 相对形式', () => {
    expect(normalizeRelPath('\\media\\a.jpg')).toBe('media/a.jpg')
    expect(normalizeRelPath('/media/a.jpg')).toBe('media/a.jpg')
    expect(normalizeRelPath('media/a.jpg')).toBe('media/a.jpg')
  })
})

describe('解密结果缓存（键含密钥指纹，不含密钥）', () => {
  it('同 (path, mtime, size, 指纹) 命中；换指纹不命中', async () => {
    const cache = new MediaDedupeCache(cacheDir)
    const source = path.join(root, 'src.jpg')
    fs.writeFileSync(source, 'encrypted-source')
    const cached = path.join(root, 'decoded.jpg')
    fs.writeFileSync(cached, 'decoded-image')
    const stat = fs.statSync(source)
    const payload = { sourcePath: source, mtimeMs: stat.mtimeMs, size: stat.size, keyFingerprint: fingerprintKey('key-a') }
    await cache.put({ ...payload, cachedPath: cached, sha256: 'h' })

    const hit = await cache.get(payload)
    expect(hit?.cachedPath).toBe(cached)
    expect(await cache.get({ ...payload, keyFingerprint: fingerprintKey('key-b') })).toBeNull()
  })

  it('mtime 或 size 变了就不命中（库/文件没变才复用）', async () => {
    const cache = new MediaDedupeCache(cacheDir)
    const source = path.join(root, 'src.jpg')
    fs.writeFileSync(source, 'encrypted-source')
    const cached = path.join(root, 'decoded.jpg')
    fs.writeFileSync(cached, 'decoded-image')
    const stat = fs.statSync(source)
    await cache.put({
      sourcePath: source,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      keyFingerprint: fingerprintKey('key-a'),
      cachedPath: cached,
      sha256: 'h',
    })
    expect(await cache.get({ sourcePath: source, mtimeMs: stat.mtimeMs + 1000, size: stat.size, keyFingerprint: fingerprintKey('key-a') })).toBeNull()
    expect(await cache.get({ sourcePath: source, mtimeMs: stat.mtimeMs, size: stat.size + 1, keyFingerprint: fingerprintKey('key-a') })).toBeNull()
  })

  it('产物文件没了 → 不命中，且该条被清掉（不留死缓存）', async () => {
    const cache = new MediaDedupeCache(cacheDir)
    const source = path.join(root, 'src.jpg')
    fs.writeFileSync(source, 'x')
    const cached = path.join(root, 'decoded.jpg')
    fs.writeFileSync(cached, 'y')
    const stat = fs.statSync(source)
    const payload = { sourcePath: source, mtimeMs: stat.mtimeMs, size: stat.size, keyFingerprint: 'k1' }
    await cache.put({ ...payload, cachedPath: cached, sha256: 'h' })
    fs.rmSync(cached)
    expect(await cache.get(payload)).toBeNull()
    expect(cache.size()).toBe(0)
  })

  it('落盘后重新加载仍然命中（跨进程续跑）', async () => {
    const source = path.join(root, 'src.jpg')
    fs.writeFileSync(source, 'encrypted-source')
    const cached = path.join(root, 'decoded.jpg')
    fs.writeFileSync(cached, 'decoded-image')
    const stat = fs.statSync(source)
    const payload = { sourcePath: source, mtimeMs: stat.mtimeMs, size: stat.size, keyFingerprint: fingerprintKey('key-a') }
    const first = new MediaDedupeCache(cacheDir)
    await first.put({ ...payload, cachedPath: cached, sha256: 'h' })
    await first.flush()

    const second = new MediaDedupeCache(cacheDir)
    const hit = await second.get(payload)
    expect(hit?.cachedPath).toBe(cached)
  })

  it('缓存文件损坏时退化为"没命中"，不影响导出', async () => {
    fs.writeFileSync(path.join(cacheDir, 'media-dedupe-cache.json'), '{broken')
    const cache = new MediaDedupeCache(cacheDir)
    const source = path.join(root, 'src.jpg')
    fs.writeFileSync(source, 'x')
    expect(await cache.get({ sourcePath: source, mtimeMs: 0, size: 1, keyFingerprint: 'k' })).toBeNull()
  })

  it('诊断快照里绝不出现密钥原文，只有指纹', async () => {
    const rawKey = 'deadbeef'.repeat(8)
    const cache = new MediaDedupeCache(cacheDir)
    const source = path.join(root, 'src.jpg')
    fs.writeFileSync(source, 'x')
    const cached = path.join(root, 'decoded.jpg')
    fs.writeFileSync(cached, 'y')
    await cache.put({
      sourcePath: source,
      mtimeMs: 1,
      size: 1,
      keyFingerprint: fingerprintKey(rawKey),
      cachedPath: cached,
      sha256: 'h',
    })
    const dumped = JSON.stringify(cache.snapshotForDiagnostics())
    expect(dumped).not.toContain(rawKey)
    expect(dumped).toContain(fingerprintKey(rawKey))
  })

  it('超出上限时按最近使用裁剪（不会无限增长）', async () => {
    const cache = new MediaDedupeCache(cacheDir, 128)
    for (let i = 0; i < 200; i += 1) {
      const source = path.join(root, `src-${i}.jpg`)
      fs.writeFileSync(source, `x${i}`)
      const cached = path.join(root, `decoded-${i}.jpg`)
      fs.writeFileSync(cached, 'y')
      await cache.put({
        sourcePath: source,
        mtimeMs: i,
        size: 1,
        keyFingerprint: 'k',
        cachedPath: cached,
        sha256: `h${i}`,
      })
    }
    expect(cache.size()).toBe(128)
    // 最新的那条还在
    expect(cache.snapshotForDiagnostics().some((entry) => entry.sha256 === 'h199')).toBe(true)
  })
})

describe('MediaDedupeCounter', () => {
  it('累加并快照，reset 清零', () => {
    const counter = new MediaDedupeCounter()
    counter.note({ ledgerSkips: 2, decryptCacheHits: 3 })
    counter.note({ ledgerSkips: 1, mismatches: 4 })
    expect(counter.snapshot()).toEqual({
      ledgerSkips: 3,
      contentReuses: 0,
      decryptCacheHits: 3,
      decryptCacheMisses: 0,
      mismatches: 4,
    })
    counter.reset()
    expect(counter.snapshot().ledgerSkips).toBe(0)
  })
})
