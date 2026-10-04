import { describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CIPHER_RECORD_PREFIX,
  RECORD_SHAPE,
  CIPHER_XOR_MASK,
  CIPHER_XOR_PERIOD,
  CHUNK_OVERLAP,
  decodeBlobWithMask,
  decodeCipherBlob,
  extractKeyRecords,
  readHexRunAt,
  recoverCipherMaskCandidates,
  resolveDbStorageDir,
  scanWindowsWeChatDbKeys,
  STRUCT_OFFSET_ATTEMPTS,
  DEFAULT_YIELD_EVERY_MS,
} from './keyScanService'

/**
 * 扫描器的**纯计算部分**单测（K11 的另一半）。
 *
 * 这里不碰任何进程内存：blob 是合成的 —— 用真实的 32 字节掩码把
 * `x'<64 hex key><32 hex salt>'` 掩起来，然后要求解析器还原。
 * 掩码自恢复用一个**旋转过的**掩码来考，这样"能不能在掩码变了之后仍解出来"
 * 就变成可重复的断言，而不是等某天微信升级才发现。
 */

const KEY_HEX = '8443a0b1c2d3e4f5061728394a5b6c7d8e9fa1b2c3d4e5f60718293a4b5cd059'
const SALT_HEX = 'f277735c8e20e8655fa6e38b4189ad23'
const RECORD = `x'${KEY_HEX}${SALT_HEX}'`

/** 把明文按掩码掩起来（`start` 是这段明文在 blob 里的绝对下标 —— 相位必须一致）。 */
function maskText(text: string, mask: Buffer, start = 0): Buffer {
  const out = Buffer.alloc(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) ^ mask[(start + i) % mask.length]
  return out
}

/** 造一个"像真 blob 一样"的缓冲区：前后各带一些正常文本。 */
function makeBlob(mask: Buffer): Buffer {
  const prefix = Buffer.from('com.Tencent.WCDB.Config\0', 'latin1')
  return Buffer.concat([prefix, maskText(RECORD, mask, prefix.length), Buffer.from('\0\0', 'latin1')])
}

describe('常量与证据锚点', () => {
  it('掩码长度就是周期（32，不是报告里写的 27 —— 抄错会把整条路解成乱码）', () => {
    expect(CIPHER_XOR_MASK.length).toBe(32)
    expect(CIPHER_XOR_PERIOD).toBe(CIPHER_XOR_MASK.length)
    expect(CIPHER_XOR_MASK.toString('hex')).toBe(
      'd2c7442458020000004889442450488b450048844c2448488944254048584c24'
    )
  })

  it('结构偏移尝试表以参考实现的位置打头，并带上可回收的诊断标签', () => {
    expect(STRUCT_OFFSET_ATTEMPTS[0]).toEqual({ label: 'ref-4.1.13.65', nodeConfigPtr: 0x28, configBlob: 0x88 })
    expect(STRUCT_OFFSET_ATTEMPTS.length).toBeGreaterThan(1)
    expect(new Set(STRUCT_OFFSET_ATTEMPTS.map((a) => a.label)).size).toBe(STRUCT_OFFSET_ATTEMPTS.length)
  })

  it('分块参数与让出时间片在合理范围（2 MB + 0x80 重叠；≤ 50 ms 的卡顿预算）', () => {
    expect(CHUNK_OVERLAP).toBe(0x80)
    expect(DEFAULT_YIELD_EVERY_MS).toBeLessThanOrEqual(50)
    expect(CIPHER_RECORD_PREFIX.toString('latin1')).toBe("x'")
  })
})

describe('记录抽取', () => {
  it('96 hex 的整条记录解成 key + salt', () => {
    const records = extractKeyRecords(RECORD)
    expect(records).toEqual([{ keyHex: KEY_HEX, saltHex: SALT_HEX }])
  })

  it('只有 64 hex 时 salt 为 null（老版本形态）', () => {
    const records = extractKeyRecords(`x'${KEY_HEX}'`)
    expect(records).toEqual([{ keyHex: KEY_HEX, saltHex: null }])
  })

  it('一条 blob 里塞了两条记录时按起点滑窗抽出，且去重', () => {
    const a = '11'.repeat(32)
    const b = '22'.repeat(32)
    const run = `${a}${b}`
    const records = extractKeyRecords(`x'${run}'`)
    expect(records.length).toBeGreaterThan(0)
    expect(records.some((r) => r.keyHex === run.slice(0, 64))).toBe(true)
    const ids = new Set(records.map((r) => `${r.keyHex}|${r.saltHex}`))
    expect(ids.size).toBe(records.length)
  })

  it('大小写混写照样认，但归一化成小写', () => {
    const records = extractKeyRecords(`X'${KEY_HEX.toUpperCase()}${SALT_HEX.toUpperCase()}'`)
    expect(records[0].keyHex).toBe(KEY_HEX)
    expect(records[0].saltHex).toBe(SALT_HEX)
  })

  it('readHexRunAt 对形状苛刻：长度不足 64 或以非引号结尾都返回 null', () => {
    const decoded = Buffer.from(`${RECORD}X`, 'latin1')
    expect(readHexRunAt(decoded, 2)).toBe(`${KEY_HEX}${SALT_HEX}`)
    expect(readHexRunAt(Buffer.from("x'ab'", 'latin1'), 2)).toBeNull()
    expect(readHexRunAt(Buffer.from("x'abc'", 'latin1'), 2)).toBeNull()
    expect(readHexRunAt(decoded.subarray(0, 10), 2)).toBeNull()
  })
})

describe('掩码解码', () => {
  it('参考掩码能把 blob 还原成记录（正向量）', () => {
    const blob = makeBlob(CIPHER_XOR_MASK)
    expect(decodeBlobWithMask(blob, CIPHER_XOR_MASK)).toContain(RECORD)
    const decoded = decodeCipherBlob(blob, { masks: [CIPHER_XOR_MASK] })
    expect(decoded.usedMaskHex).toBe(CIPHER_XOR_MASK.toString('hex'))
    expect(decoded.records).toEqual([{ keyHex: KEY_HEX, saltHex: SALT_HEX }])
  })

  it('掩码不对时解不出记录（负向量）', () => {
    const blob = makeBlob(CIPHER_XOR_MASK)
    const wrongMask = Buffer.from(CIPHER_XOR_MASK.map((b) => b ^ 0x5a))
    const decoded = decodeCipherBlob(blob, { masks: [wrongMask] })
    expect(decoded.records).toHaveLength(0)
  })
})

describe('掩码自恢复（掩码随版本变了也能救回来）', () => {
  it('已知 salt ⇒ 掩码被唯一确定，直接解出真密钥（决定性路径）', () => {
    // 真掩码 = 参考掩码右移 7（模拟"新版微信换了掩码"）
    const rotated = Buffer.from(CIPHER_XOR_MASK.map((_, i) => CIPHER_XOR_MASK[(i + 7) % CIPHER_XOR_MASK.length]))
    const blob = makeBlob(rotated)

    // 先用参考掩码试：应当失败（证明这个测试真的在考自恢复）
    expect(decodeCipherBlob(blob, { masks: [CIPHER_XOR_MASK] }).records).toHaveLength(0)

    // salt 的 32 个字符覆盖 32 个残差类各一次 ⇒ 掩码可被唯一反解
    const recovery = recoverCipherMaskCandidates(blob, { knownSalts: [SALT_HEX] })
    expect(recovery.anchors).toBeGreaterThan(0)
    expect(recovery.masks).toHaveLength(1)
    expect(recovery.masks[0].equals(rotated)).toBe(true)

    const decoded = decodeCipherBlob(blob, { masks: recovery.masks, recovery })
    expect(decoded.records).toEqual([{ keyHex: KEY_HEX, saltHex: SALT_HEX }])
  })

  it('没有已知 salt 时退化成 crib-drag 候选（不保证唯一，靠 HMAC 裁决）', () => {
    const rotated = Buffer.from(CIPHER_XOR_MASK.map((_, i) => CIPHER_XOR_MASK[(i + 7) % CIPHER_XOR_MASK.length]))
    const blob = makeBlob(rotated)
    const recovery = recoverCipherMaskCandidates(blob)
    // 契约：候选生成器 —— 每个候选都必须是**结构合法**的记录形状；
    // 唯一性不保证（真值必在其中，其余由调用方的 HMAC 裁决掉）。
    expect(recovery.explored).toBeGreaterThan(0)
    expect(recovery.explored).toBeLessThan(200_000)
    for (const mask of recovery.masks) {
      expect(RECORD_SHAPE.test(decodeBlobWithMask(blob, mask))).toBe(true)
    }
  })

  it('没有 x\'…\' 结构的缓冲区不会吐出候选（不做无谓的枚举）', () => {
    const noise = Buffer.alloc(120)
    crypto.randomFillSync(noise)
    const recovery = recoverCipherMaskCandidates(noise, { knownSalts: [SALT_HEX] })
    expect(recovery.masks).toHaveLength(0)
    expect(recovery.anchors).toBe(0)
  })

  it('过短/过大输入直接拒绝（有界，不拖死扫描）', () => {
    expect(recoverCipherMaskCandidates(Buffer.alloc(10)).masks).toHaveLength(0)
    expect(recoverCipherMaskCandidates(Buffer.alloc(4096)).masks).toHaveLength(0)
  })

  it('候选数量有上限（不会因为病态输入无限枚举）', () => {
    const rotated = Buffer.from(CIPHER_XOR_MASK.map((_, i) => CIPHER_XOR_MASK[(i + 3) % CIPHER_XOR_MASK.length]))
    const blob = makeBlob(rotated)
    const recovery = recoverCipherMaskCandidates(blob, { maxCombos: 32, maxMasks: 2 })
    expect(recovery.masks.length).toBeLessThanOrEqual(2)
  })
})

it.skipIf(process.platform !== 'win32')('database enumeration overflow returns a structured scan error before process access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weport-key-scan-limit-test-'))
  const dbStorageDir = join(root, 'db_storage')
  mkdirSync(dbStorageDir, { recursive: true })
  try {
    for (let index = 0; index < 401; index += 1) {
      writeFileSync(join(dbStorageDir, `shard_${index}.db`), Buffer.alloc(0))
    }

    const result = await scanWindowsWeChatDbKeys({ dbStorageDir })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('db-enumeration-incomplete')
    expect(result.error).toContain('安全上限 400')
    expect(result.keys).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('数据目录定位', () => {
  it('接受账号目录或 db_storage 本身，找不到返回 null', () => {
    const account = 'D:\\xwechat_files\\wxid_demo_0000'
    // 只验证"不会因为传入 db_storage 而再拼一层"这个语义（真实目录不需要存在）
    expect(resolveDbStorageDir(`${account}\\db_storage`)).toBe(null)
    expect(resolveDbStorageDir('')).toBe(null)
  })
})
