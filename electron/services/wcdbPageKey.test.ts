import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DbFileEnumerationLimitError,
  KEY_BYTES,
  SQLCIPHER_HMAC_OFFSET,
  SQLCIPHER_KDF_ITERATIONS,
  SQLCIPHER_PAGE_SIZE,
  dbKindOf,
  deriveMacKey,
  deriveEncKeyFromPassphrase,
  keyFingerprint,
  listDbFiles,
  pageKeyMatches,
  parsePastedKeyInput,
  readPage1,
  saltHexOf,
  verifyPageKey,
} from './wcdbPageKey'
import crypto from 'crypto'

/**
 * page-1 校验器的**已知答案**测试（K11）。
 *
 * 向量由**独立实现**生成：`.wxkey-research/probe/kata-gen.cjs` 里的 `hmacOkReference`
 * 是从 `cipher2.cjs:27-36` 逐字复制的参考实现。如果只有一份实现，测试只是自证；
 * 有第二份实现做对照，才说明"这份实现和当初在本机取到真实密钥的那份一致"。
 *
 * 输入全是合成值（salt/密钥/页内容都是我编的），因此可以安全入库。
 */
const KAT = {
  saltHex: '000102030405060708090a0b0c0d0e0f',
  keyHex: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf',
  // 4032..4096 由参考实现算出的 HMAC（raw 模式与 passphrase 模式各一份）
  macRawHex:
    '3f19eb8854d0136d511d5d1260e49788d2702480023d93dc17ddd51d32e0683d1522a4026fcfb476d2124df5c8cb9caca04d1a60513d6d63d7c59467a481b9ea',
  macPassHex:
    '8867a08f37e2ed9aa84106cd6eb422fd39be5fb0cfb2aeefe81e26d4555b9419a9e7865f4648853a82741c8c6995b5920be7113dd3be9fbfa60f03090277aec1',
}

function buildPage(macHex: string): Buffer {
  const page = Buffer.alloc(SQLCIPHER_PAGE_SIZE)
  Buffer.from(KAT.saltHex, 'hex').copy(page, 0)
  for (let i = 16; i < SQLCIPHER_HMAC_OFFSET; i++) page[i] = (i * 7 + 3) & 0xff
  Buffer.from(macHex, 'hex').copy(page, SQLCIPHER_HMAC_OFFSET)
  return page
}

function buildPageForPassphraseText(passphrase: Buffer): Buffer {
  const page = Buffer.alloc(SQLCIPHER_PAGE_SIZE)
  const salt = Buffer.from(KAT.saltHex, 'hex')
  salt.copy(page, 0)
  for (let i = 16; i < SQLCIPHER_HMAC_OFFSET; i++) page[i] = (i * 5 + 11) & 0xff
  const encKey = deriveEncKeyFromPassphrase(passphrase, salt)
  const macKey = deriveMacKey(encKey, salt)
  const mac = crypto.createHmac('sha512', macKey)
  mac.update(page.subarray(16, SQLCIPHER_HMAC_OFFSET))
  const pageNo = Buffer.alloc(4)
  pageNo.writeUInt32LE(1, 0)
  mac.update(pageNo)
  mac.digest().copy(page, SQLCIPHER_HMAC_OFFSET)
  return page
}

const dirs: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weport-wcdbkey-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

describe('SQLCipher page 1 校验器 — 阳性向量（与参考实现逐字节一致）', () => {
  const key = Buffer.from(KAT.keyHex, 'hex')

  it('raw 模式命中 KAT', () => {
    expect(pageKeyMatches(buildPage(KAT.macRawHex), key, 'raw')).toBe(true)
    expect(verifyPageKey(buildPage(KAT.macRawHex), key, ['raw', 'passphrase']).mode).toBe('raw')
  })

  it('passphrase 模式命中 KAT（256000 轮 PBKDF2）', () => {
    expect(pageKeyMatches(buildPage(KAT.macPassHex), key, 'passphrase')).toBe(true)
    expect(verifyPageKey(buildPage(KAT.macPassHex), key, ['raw', 'passphrase']).mode).toBe('passphrase')
  })

  it('64 位 hex 口令按 UTF-8 文本进入 SQLCipher KDF', () => {
    const text = 'ab'.repeat(32)
    const page = buildPageForPassphraseText(Buffer.from(text, 'utf8'))
    expect(verifyPageKey(page, Buffer.from(text, 'utf8'), ['passphrase']).mode).toBe('passphrase')
    expect(verifyPageKey(page, Buffer.from(text, 'hex'), ['passphrase']).mode).toBe(null)
  })

  it('KDF 参数就是 4.1.10+ 的 256000', () => {
    expect(SQLCIPHER_KDF_ITERATIONS).toBe(256000)
  })
})

describe('SQLCipher page 1 校验器 — 阴性向量（不许把坏密钥判成好）', () => {
  const key = Buffer.from(KAT.keyHex, 'hex')
  const good = buildPage(KAT.macRawHex)

  it('翻一位密文就不成立', () => {
    const tampered = Buffer.from(good)
    tampered[100] ^= 0x01
    expect(pageKeyMatches(tampered, key, 'raw')).toBe(false)
  })

  it('翻一位 MAC 就不成立', () => {
    const tampered = Buffer.from(good)
    tampered[SQLCIPHER_HMAC_OFFSET + 10] ^= 0x80
    expect(pageKeyMatches(tampered, key, 'raw')).toBe(false)
  })

  it('错的密钥不成立（另一把 32 字节密钥）', () => {
    const other = Buffer.alloc(KEY_BYTES, 0x5a)
    expect(pageKeyMatches(good, other, 'raw')).toBe(false)
    expect(pageKeyMatches(good, other, 'passphrase')).toBe(false)
  })

  it('形态用错不成立（把 raw 页当口令判）', () => {
    expect(pageKeyMatches(good, key, 'passphrase')).toBe(false)
  })

  it('长度不对的输入直接拒绝（不抛异常）', () => {
    expect(pageKeyMatches(good.subarray(0, 4032), key, 'raw')).toBe(false)
    expect(pageKeyMatches(good, key.subarray(0, 31), 'raw')).toBe(false)
  })

  it('deriveMacKey 用 salt^0x3a（不是 salt 本身）', () => {
    const salt = Buffer.from(KAT.saltHex, 'hex')
    const macKey = deriveMacKey(key, salt)
    expect(macKey.length).toBe(32)
    expect(macKey.equals(deriveMacKey(key, Buffer.from(salt.map((b) => b ^ 0x3a))))).toBe(false)
  })
})

describe('readPage1 — 只读、无副作用', () => {
  it('读真实文件的第一页；文件不存在/过小时给出结构化错误', () => {
    const dir = tempRoot()
    const good = join(dir, 'good.db')
    const page = buildPage(KAT.macRawHex)
    writeFileSync(good, page)
    const loaded = readPage1(good)
    expect(loaded.ok).toBe(true)
    expect(loaded.page1?.length).toBe(SQLCIPHER_PAGE_SIZE)
    expect(saltHexOf(loaded.page1!)).toBe(KAT.saltHex)

    const missing = readPage1(join(dir, 'nope.db'))
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe('missing')

    const small = join(dir, 'small.db')
    writeFileSync(small, Buffer.alloc(100))
    const tooSmall = readPage1(small)
    expect(tooSmall.ok).toBe(false)
    expect(tooSmall.error).toBe('too-small')
  })
})

describe('粘贴语法（§10.4 的 4 种 + 2 种宽容变体）', () => {
  const keyHex = KAT.keyHex
  const saltHex = 'f277735c8e20e8655fa6e38b4189ad23'

  it('① 裸 64 位 hex', () => {
    const parsed = parsePastedKeyInput(keyHex)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.syntax).toBe('raw64')
    expect(parsed.keyHex).toBe(keyHex)
    expect(parsed.saltHex).toBeUndefined()
  })

  it('② 0x 前缀', () => {
    const parsed = parsePastedKeyInput(`0x${keyHex.toUpperCase()}`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.syntax).toBe('hex-0x')
    expect(parsed.keyHex).toBe(keyHex)
  })

  it("③ WCDB 的 x'…' 形式（带 salt）", () => {
    const parsed = parsePastedKeyInput(`x'${keyHex}${saltHex}'`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.syntax).toBe('wcdb-x')
    expect(parsed.keyHex).toBe(keyHex)
    expect(parsed.saltHex).toBe(saltHex)
  })

  it("③b WCDB 形式（不带 salt）", () => {
    const parsed = parsePastedKeyInput(`X'${keyHex}'`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.syntax).toBe('wcdb-x')
    expect(parsed.saltHex).toBeUndefined()
  })

  it('④ <key><salt> 96 位 hex', () => {
    const parsed = parsePastedKeyInput(`${keyHex}${saltHex}`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.syntax).toBe('key+salt-96')
    expect(parsed.keyHex).toBe(keyHex)
    expect(parsed.saltHex).toBe(saltHex)
  })

  it('⑤ 宽容：整段 PRAGMA 语句里抽 x\'…\'', () => {
    const parsed = parsePastedKeyInput(`PRAGMA key = "x'${keyHex}${saltHex}'";`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.keyHex).toBe(keyHex)
    expect(parsed.saltHex).toBe(saltHex)
  })

  it('⑥ 宽容：128 位 hex 当 key+salt(32B)', () => {
    const parsed = parsePastedKeyInput(`${keyHex}${'11'.repeat(32)}`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.syntax).toBe('key+salt-128')
    expect(parsed.saltHex).toBe('11'.repeat(32))
  })

  it('错误码可分支：空 / 非 hex / 长度不对（文案里没有"请重试"）', () => {
    const empty = parsePastedKeyInput('   ')
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.code).toBe('empty')
      expect(empty.message).not.toContain('重试')
    }
    const notHex = parsePastedKeyInput('zz'.repeat(32))
    expect(notHex.ok).toBe(false)
    if (!notHex.ok) expect(notHex.code).toBe('not-hex')
    const short = parsePastedKeyInput('ab'.repeat(31))
    expect(short.ok).toBe(false)
    if (!short.ok) {
      expect(short.code).toBe('bad-length')
      // 报的是**十六进制位数**（62），用户照着数就能发现自己少粘了一段
      expect(short.message).toContain('62')
    }
  })

  it('四种主语法互不串味：归一化形态统一为 x\'…\'', () => {
    const variants = [keyHex, `0x${keyHex}`, `x'${keyHex}'`, `${keyHex}${saltHex}`]
    for (const variant of variants) {
      const parsed = parsePastedKeyInput(variant)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.normalized.startsWith("x'")).toBe(true)
    }
  })
})

describe('指纹与库枚举', () => {
  it('指纹只暴露首 4 末 4', () => {
    expect(keyFingerprint(KAT.keyHex)).toBe('a0a1…bebf')
    expect(keyFingerprint(KAT.keyHex)).not.toContain(KAT.keyHex.slice(4, 60))
  })

  it('dbKindOf：message_0 / session / contact_fts 分类稳定', () => {
    expect(dbKindOf('message/message_0.db')).toBe('message_0')
    expect(dbKindOf('session/session.db')).toBe('session')
    expect(dbKindOf('contact/contact_fts.db')).toBe('contact_contact_fts')
    expect(dbKindOf('session.db')).toBe('session')
  })

  it('listDbFiles 只读枚举并按核心库优先排序', () => {
    const root = tempRoot()
    const dbStorage = join(root, 'db_storage')
    mkdirSync(join(dbStorage, 'message'), { recursive: true })
    mkdirSync(join(dbStorage, 'session'), { recursive: true })
    writeFileSync(join(dbStorage, 'message', 'message_0.db'), Buffer.alloc(10))
    writeFileSync(join(dbStorage, 'session', 'session.db'), Buffer.alloc(10))
    writeFileSync(join(dbStorage, 'message', 'not-a-db.txt'), Buffer.alloc(10))
    const files = listDbFiles(dbStorage)
    expect(files.map((f) => f.id)).toEqual(['session/session.db', 'message/message_0.db'])
    expect(files[0].group).toBe('core')
    expect(files[1].group).toBe('message')
  })

  it('超过枚举上限时默认失败，不把前缀报告成完整库列表', () => {
    const root = tempRoot()
    const dbStorage = join(root, 'db_storage')
    mkdirSync(dbStorage, { recursive: true })
    writeFileSync(join(dbStorage, 'a.db'), Buffer.alloc(10))
    writeFileSync(join(dbStorage, 'b.db'), Buffer.alloc(10))

    expect(listDbFiles(dbStorage, { maxFiles: 2 })).toHaveLength(2)
    writeFileSync(join(dbStorage, 'c.db'), Buffer.alloc(10))
    expect(() => listDbFiles(dbStorage, { maxFiles: 2 })).toThrow(DbFileEnumerationLimitError)
    expect(listDbFiles(dbStorage, { maxFiles: 2, allowTruncated: true })).toHaveLength(2)
  })
})
