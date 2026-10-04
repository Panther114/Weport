import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import crypto from 'node:crypto'
import {
  ExportLedger,
  LEDGER_FILE_NAME,
  LEDGER_VERSION,
  fingerprintFile,
  sha256OfBuffer,
  toLedgerRelativePath,
  unitKeyOf,
  verifyArtifact,
} from './ledger'

/**
 * 导出账本（v1.2 §10.1 ①）。
 *
 * 这里的每条断言都在守一个具体的续跑故障：
 * 崩溃时写了一半的最后一行不能被当成"已完成"、版本不同的旧记录不能被当成"已完成"、
 * 账本说完成但磁盘上文件被删/被改必须重导。
 */

let root = ''

const unit = (overrides: Partial<Parameters<ExportLedger['append']>[0]> = {}) => ({
  taskId: 'task-1',
  sessionId: 'wxid_a',
  chunkStart: 0,
  chunkEnd: 0,
  artifact: 'txt#1',
  bytes: 3,
  sha256: sha256OfBuffer(Buffer.from('abc')),
  ...overrides,
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-ledger-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('账本落盘与读取', () => {
  it('账本文件固定在导出根目录的 .weport-export-ledger.jsonl', () => {
    const ledger = new ExportLedger(root)
    expect(ledger.ledgerPath).toBe(path.join(root, LEDGER_FILE_NAME))
  })

  it('append 之后 read 能读回同一条，且带版本号', async () => {
    const ledger = new ExportLedger(root)
    await ledger.append(unit())
    const { entries, discarded } = await ledger.read()
    expect(entries).toHaveLength(1)
    expect(entries[0].v).toBe(LEDGER_VERSION)
    expect(entries[0].sessionId).toBe('wxid_a')
    expect(entries[0].artifact).toBe('txt#1')
    expect(entries[0].at).toBeGreaterThan(0)
    expect(discarded.truncatedTail).toBe(false)
    expect(discarded.versionMismatch).toBe(0)
  })

  it('一行一个单元：多条记录按追加顺序读回，索引按单元键去重', async () => {
    const ledger = new ExportLedger(root)
    await ledger.append(unit())
    await ledger.append(unit({ sessionId: 'wxid_b', artifact: 'txt#1' }))
    await ledger.append(unit({ bytes: 4, sha256: sha256OfBuffer(Buffer.from('abcd')) }))
    const index = await ledger.buildIndex()
    expect(index.size).toBe(2)
    // 同一单元的后来者覆盖先前者
    expect(index.get(unitKeyOf({ sessionId: 'wxid_a', chunkStart: 0, chunkEnd: 0, artifact: 'txt#1' }))?.bytes).toBe(4)
  })

  it('时间分片进单元键：不同分片是不同单元', async () => {
    const ledger = new ExportLedger(root)
    await ledger.append(unit({ chunkStart: 1, chunkEnd: 10 }))
    await ledger.append(unit({ chunkStart: 11, chunkEnd: 20 }))
    const index = await ledger.buildIndex()
    expect(index.size).toBe(2)
  })

  it('outputRoot 记的是账本自己的根目录（诊断可读）', async () => {
    const ledger = new ExportLedger(root)
    const entry = await ledger.append(unit())
    expect(entry.outputRoot).toBe(path.resolve(root))
  })
})

describe('崩溃安全：截断的最后一行要被忽略', () => {
  it('半行 JSON 不算一条已完成记录', async () => {
    const ledger = new ExportLedger(root)
    await ledger.append(unit())
    await ledger.append(unit({ sessionId: 'wxid_b' }))
    // 模拟崩在写到一半：把最后一行切掉一半
    const raw = fs.readFileSync(ledger.ledgerPath, 'utf-8')
    const lines = raw.split('\n')
    fs.writeFileSync(ledger.ledgerPath, `${lines[0]}\n${lines[1].slice(0, 20)}`, 'utf-8')

    const { entries, discarded } = await ledger.read()
    expect(entries).toHaveLength(1)
    expect(entries[0].sessionId).toBe('wxid_a')
    expect(discarded.truncatedTail).toBe(true)
  })

  it('没有以换行收尾但内容是完整的行仍然可读（写整行后崩在 fsync 前）', async () => {
    const ledger = new ExportLedger(root)
    await ledger.append(unit())
    const raw = fs.readFileSync(ledger.ledgerPath, 'utf-8')
    fs.writeFileSync(ledger.ledgerPath, raw.trimEnd(), 'utf-8')
    const { entries } = await ledger.read()
    expect(entries).toHaveLength(1)
  })

  it('完全损坏的账本退化成"空账本"，不抛异常（代价只是全量重导）', async () => {
    const ledger = new ExportLedger(root)
    fs.writeFileSync(ledger.ledgerPath, '{not json at all', 'utf-8')
    const { entries } = await ledger.read()
    expect(entries).toEqual([])
    const index = await ledger.buildIndex()
    expect(index.size).toBe(0)
  })

  it('账本不存在时读出来是空的，不抛', async () => {
    const ledger = new ExportLedger(root)
    const { entries } = await ledger.read()
    expect(entries).toEqual([])
  })
})

describe('版本不匹配', () => {
  it('版本号不是当前的记录一律丢弃（不猜旧格式语义）', async () => {
    const ledger = new ExportLedger(root)
    const legacy = { ...unit(), v: LEDGER_VERSION + 1, at: Date.now(), outputRoot: root }
    fs.writeFileSync(ledger.ledgerPath, `${JSON.stringify(legacy)}\n`, 'utf-8')
    const { entries, discarded } = await ledger.read()
    expect(entries).toHaveLength(0)
    expect(discarded.versionMismatch).toBe(1)
  })

  it('当前版本的记录与不兼容版本的记录混在一起时，只丢后者', async () => {
    const ledger = new ExportLedger(root)
    await ledger.append(unit())
    const legacy = { ...unit({ sessionId: 'wxid_old' }), v: 0, at: Date.now(), outputRoot: root }
    fs.appendFileSync(ledger.ledgerPath, `${JSON.stringify(legacy)}\n`, 'utf-8')
    const { entries, discarded } = await ledger.read()
    expect(entries.map((entry) => entry.sessionId)).toEqual(['wxid_a'])
    expect(discarded.versionMismatch).toBe(1)
  })
})

describe('完成判定：账本说完成 + 磁盘一致', () => {
  it('产物未被改动 → 校验通过', async () => {
    const artifact = path.join(root, 'a.txt')
    fs.writeFileSync(artifact, 'hello', 'utf-8')
    const fingerprint = await fingerprintFile(artifact)
    const verification = await verifyArtifact(artifact, fingerprint)
    expect(verification.ok).toBe(true)
  })

  it('产物被截断（大小不符）→ 不通过', async () => {
    const artifact = path.join(root, 'a.txt')
    fs.writeFileSync(artifact, 'hello', 'utf-8')
    const fingerprint = await fingerprintFile(artifact)
    fs.writeFileSync(artifact, 'hel', 'utf-8')
    const verification = await verifyArtifact(artifact, fingerprint)
    expect(verification.ok).toBe(false)
    expect(verification.reason).toBe('size-mismatch')
  })

  it('产物被改写（大小相同、内容不同）→ 只靠 sha256 才能发现', async () => {
    const artifact = path.join(root, 'a.txt')
    fs.writeFileSync(artifact, 'hello', 'utf-8')
    const fingerprint = await fingerprintFile(artifact)
    fs.writeFileSync(artifact, 'world', 'utf-8')
    const verification = await verifyArtifact(artifact, fingerprint)
    expect(verification.ok).toBe(false)
    expect(verification.reason).toBe('sha-mismatch')
  })

  it('产物被删除 → 不通过（missing），调用方必须重导', async () => {
    const artifact = path.join(root, 'a.txt')
    fs.writeFileSync(artifact, 'hello', 'utf-8')
    const fingerprint = await fingerprintFile(artifact)
    fs.rmSync(artifact)
    const verification = await verifyArtifact(artifact, fingerprint)
    expect(verification.ok).toBe(false)
    expect(verification.reason).toBe('missing')
  })
})

describe('压缩与重置', () => {
  it('compact 只保留每个单元的最后一条，且重写走原子写（不留半截文件）', async () => {
    const ledger = new ExportLedger(root)
    await ledger.append(unit())
    await ledger.append(unit({ bytes: 9, sha256: sha256OfBuffer(Buffer.from('123456789')) }))
    await ledger.append(unit({ sessionId: 'wxid_b' }))
    const kept = await ledger.compact()
    expect(kept).toBe(2)
    const { entries } = await ledger.read()
    expect(entries).toHaveLength(2)
    const leftovers = fs.readdirSync(root).filter((name) => name !== LEDGER_FILE_NAME)
    expect(leftovers).toEqual([])
  })

  it('reset 清空账本（"全量重导"用）', async () => {
    const ledger = new ExportLedger(root)
    await ledger.append(unit())
    await ledger.reset()
    const { entries } = await ledger.read()
    expect(entries).toEqual([])
  })
})

describe('辅助函数', () => {
  it('相对路径统一成 POSIX 分隔符，便于跨平台比对', () => {
    const nested = path.join(root, 'media', 'wxid_a', '2024-01')
    expect(toLedgerRelativePath(root, path.join(nested, 'x.jpg'))).toBe('media/wxid_a/2024-01/x.jpg')
  })

  it('sha256OfBuffer 与 crypto 结果一致', () => {
    const buffer = Buffer.from('weport')
    expect(sha256OfBuffer(buffer)).toBe(crypto.createHash('sha256').update(buffer).digest('hex'))
  })

  it('空 sessionId / artifact 不允许写入（账本不能有无法索引的行）', async () => {
    const ledger = new ExportLedger(root)
    await expect(ledger.append(unit({ sessionId: '' }))).rejects.toThrow(/sessionId/)
    await expect(ledger.append(unit({ artifact: '' }))).rejects.toThrow(/artifact/)
  })
})
