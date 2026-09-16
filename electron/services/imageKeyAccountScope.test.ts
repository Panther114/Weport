import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KeyService,
  canonicalWxidVariants,
  deriveImageKeysForWxid,
  looksLikeWeChatAccountDir,
  resolveAccountImageDirs,
  selectVerifiedImageKey,
  verifyDerivedAesKey,
} from './keyService'

/**
 * issue #20 —— 「获取图片密钥失败」（两个微信账号在同一台 PC 上，一个正常一个失败）
 *
 * ## 现场结论（本机真实数据，非推断）
 *
 * - `wx_key.dll!GetImageKey` 已经把每个账号的 `aesKey`/`xorKey` 算好了，但
 *   Weport 丢掉它们，改用「候选 wxid」自算 `md5(String(code) + wxid)` 前 16 位。
 * - 这个推导**本身是对的**：本机 400/400 个真实 `*_t.dat` 模板都能被
 *   `md5(code + canonicalWxid)` 在偏移 `0x0F` 处解出图片魔数
 *   （`scripts/probe-image-key-derivation.cjs`）。
 * - 出问题的是**归属**：UI 传下来的是 `xwechat_files` 根目录，旧实现从根目录里
 *   挑"最新的 `*_t.dat`"，两个账号同机时很容易挑到**另一个账号**的模板 ——
 *   用 A 的密文校验 B 的密钥，永远不可能通过；随后内存扫描拿同一份密文去内存里
 *   找密钥，同样永远不可能命中，用户看到的正是 60 秒超时。
 *
 * 这个文件用合成的两账号目录把这条链路钉住：账号 B 的提取必须只碰 B 的模板，
 * 既不能失败，也绝不能返回 A 的密钥。
 */

const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

/** 账号目录名（带微信改号后缀）与 canonical wxid —— 与真实机器同形。 */
const ACCOUNT_A = { dir: 'wxid_aaa11111a1a_64b5', canonical: 'wxid_aaa11111a1a', code: 11111111 }
const ACCOUNT_B = { dir: 'wxid_bbb22222b2b_64b5', canonical: 'wxid_bbb22222b2b', code: 22222222 }

const tempDirs: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weport-imagekey-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

/**
 * 造一个与微信 4.x 同构的 `*_t.dat`（缩略图）：
 * `[6B V2 magic][int32 aesSize][int32 xorSize][1B pad][AES-ECB(PKCS7) 数据][XOR 尾部]`
 * 尾部最后两字节按微信的约定编码 XOR 密钥（`b[-2]^0xFF === b[-1]^0xD9 === xorKey`）。
 */
function buildTemplateFile(code: number, canonicalWxid: string, seed: number): Buffer {
  const { aesKey, xorKey } = deriveImageKeysForWxid(code, canonicalWxid)
  const plain = Buffer.alloc(1024, seed)
  plain[0] = 0xff; plain[1] = 0xd8; plain[2] = 0xff; plain[3] = 0xe0
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii'), null)
  const aesData = Buffer.concat([cipher.update(plain), cipher.final()])

  const tailPlain = Buffer.alloc(64, (seed ^ 0x5a) & 0xff)
  tailPlain[tailPlain.length - 2] = 0xff
  tailPlain[tailPlain.length - 1] = 0xd9
  const tail = Buffer.from(tailPlain.map((byte) => byte ^ xorKey))

  const header = Buffer.alloc(15)
  V2_MAGIC.copy(header, 0)
  header.writeInt32LE(plain.length, 6)
  header.writeInt32LE(tail.length, 10)
  header[14] = 0x01
  return Buffer.concat([header, aesData, tail])
}

/** 把模板写进 `<root>/<account>/msg/attach/<hash>/2026-09/Img/`。 */
function writeTemplate(root: string, account: { dir: string; canonical: string; code: number }, name: string, seed: number): string {
  const dir = join(root, account.dir, 'msg', 'attach', '0123456789abcdef0123456789abcdef', '2026-09', 'Img')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}_t.dat`)
  writeFileSync(file, buildTemplateFile(account.code, account.canonical, seed))
  return file
}

type PrivateKeyService = {
  _findTemplateData: (dir: string, limit: number) => Promise<{
    ciphertext: Buffer | null
    ciphertexts: Buffer[]
    entries: Array<{ file: string; ciphertext: Buffer }>
    xorKey: number | null
    files: string[]
  }>
  collectTemplateCiphertexts: (dirs: string[], limitPerDir: number) => Promise<{
    ciphertexts: Buffer[]
    origins: Array<{ file: string; dir: string }>
    files: string[]
    dirs: string[]
    xorKey: number | null
  }>
}

/**
 * 私有方法在这里通过类型断言调用：断言必须打在**真实实现**上（目录收敛、模板扫描、
 * 密钥筛选三段都是产物），而不是测试里再抄一份扫描逻辑。
 */
function internals(): PrivateKeyService {
  return new KeyService() as unknown as PrivateKeyService
}

async function scanAccount(root: string, account: { dir: string; canonical: string; code: number }) {
  const scope = resolveAccountImageDirs(root, account.dir)
  const templates = await internals().collectTemplateCiphertexts(scope.dirs, 8)
  return { scope, templates }
}

describe('resolveAccountImageDirs — 模板必须来自被选中的账号 (issue #20)', () => {
  it('从根目录按账号目录名收敛到唯一目录', () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)

    const a = resolveAccountImageDirs(root, ACCOUNT_A.dir)
    expect(a.scoped).toBe(true)
    expect(a.dirs.map((dir) => dir.endsWith(ACCOUNT_A.dir))).toEqual([true])

    const b = resolveAccountImageDirs(root, ACCOUNT_B.dir)
    expect(b.scoped).toBe(true)
    expect(b.dirs.map((dir) => dir.endsWith(ACCOUNT_B.dir))).toEqual([true])
  })

  it('canonical wxid（不带改号后缀）也能收敛到同一个目录', () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    const byCanonical = resolveAccountImageDirs(root, ACCOUNT_A.canonical)
    const byDirName = resolveAccountImageDirs(root, ACCOUNT_A.dir)
    expect(byCanonical.dirs).toEqual(byDirName.dirs)
  })

  it('wxid 对不上任何目录时明确报告"没收敛"，而不是默默用别人的目录', () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)

    const unknown = resolveAccountImageDirs(root, 'wxid_zzz99999z9z_0000')
    expect(unknown.scoped).toBe(false)
    expect(unknown.dirs).toEqual([])
    expect(unknown.allAccountDirs.length).toBe(2)
  })

  it('直接选账号目录（而不是根目录）时按账号目录处理', () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)
    const accountDir = join(root, ACCOUNT_B.dir)
    expect(looksLikeWeChatAccountDir(accountDir)).toBe(true)
    const scope = resolveAccountImageDirs(accountDir, ACCOUNT_B.dir)
    expect(scope.scoped).toBe(true)
    expect(scope.dirs).toEqual([accountDir])
  })

  it('canonicalWxidVariants 同时给出目录名与 canonical wxid', () => {
    const variants = canonicalWxidVariants(ACCOUNT_A.dir)
    expect(variants).toContain(ACCOUNT_A.dir)
    expect(variants).toContain(ACCOUNT_A.canonical)
  })
})

describe('派生密钥与真实模板对得上（本机实测规则的回归位）', () => {
  it('md5(code + canonicalWxid) 前 16 位能解开该账号的模板，且解不开别人的', () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)

    const aKey = deriveImageKeysForWxid(ACCOUNT_A.code, ACCOUNT_A.canonical).aesKey
    const bKey = deriveImageKeysForWxid(ACCOUNT_B.code, ACCOUNT_B.canonical).aesKey
    expect(aKey).not.toBe(bKey)

    const aTemplate = buildTemplateFile(ACCOUNT_A.code, ACCOUNT_A.canonical, 0x11).subarray(0x0f, 0x1f)
    const bTemplate = buildTemplateFile(ACCOUNT_B.code, ACCOUNT_B.canonical, 0x22).subarray(0x0f, 0x1f)
    expect(verifyDerivedAesKey(aKey, aTemplate)).toBe(true)
    expect(verifyDerivedAesKey(bKey, aTemplate)).toBe(false)
    expect(verifyDerivedAesKey(bKey, bTemplate)).toBe(true)
    expect(verifyDerivedAesKey(aKey, bTemplate)).toBe(false)
    expect(root).toBeTruthy()
  })
})

describe('selectVerifiedImageKey — 两个账号互不串号 (issue #20)', () => {
  const payloadForBoth = {
    accounts: [
      { wxid: ACCOUNT_A.canonical, keys: [{ code: ACCOUNT_A.code }] },
      { wxid: ACCOUNT_B.canonical, keys: [{ code: ACCOUNT_B.code }] },
    ],
  }

  it('账号 B 拿到的是 B 的密钥，且归属信息指向 B 的目录', async () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)
    const { scope, templates } = await scanAccount(root, ACCOUNT_B)

    const result = selectVerifiedImageKey({
      payload: payloadForBoth,
      scope,
      rootDir: root,
      wxidParam: ACCOUNT_B.dir,
      templates,
    })

    expect(result.success).toBe(true)
    expect(result.aesKey).toBe(deriveImageKeysForWxid(ACCOUNT_B.code, ACCOUNT_B.canonical).aesKey)
    expect(result.xorKey).toBe(ACCOUNT_B.code & 0xff)
    expect(result.accountDir?.endsWith(ACCOUNT_B.dir)).toBe(true)
    expect(templates.files.every((file) => file.includes(ACCOUNT_B.dir))).toBe(true)
  })

  it('账号 A 同样只拿自己的密钥（两边都可用，才是修好了）', async () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)
    const { scope, templates } = await scanAccount(root, ACCOUNT_A)

    const result = selectVerifiedImageKey({
      payload: payloadForBoth,
      scope,
      rootDir: root,
      wxidParam: ACCOUNT_A.dir,
      templates,
    })

    expect(result.success).toBe(true)
    expect(result.aesKey).toBe(deriveImageKeysForWxid(ACCOUNT_A.code, ACCOUNT_A.canonical).aesKey)
    expect(result.accountDir?.endsWith(ACCOUNT_A.dir)).toBe(true)
  })

  it('模板属于别的账号时宁可失败，也不返回一把不属于本账号的密钥', async () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)
    const scopeB = resolveAccountImageDirs(root, ACCOUNT_B.dir)
    // 故意喂 A 的模板（旧实现在两账号同机时就会这样）：
    const contaminated = await internals().collectTemplateCiphertexts(
      resolveAccountImageDirs(root, ACCOUNT_A.dir).dirs,
      8
    )

    const result = selectVerifiedImageKey({
      payload: payloadForBoth,
      scope: scopeB,
      rootDir: root,
      wxidParam: ACCOUNT_B.dir,
      templates: contaminated,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('对不上')
    expect(result.error).toContain('下一步')
    // 关键：绝不能把 A 的密钥当成 B 的结果交出去
    expect(result.aesKey).toBeUndefined()
  })

  it('kvcomm 只给出一个"名字对不上"的账号条目时（本机 wx_key.dll 的真实形态），仍按模板校验出正确的密钥', async () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)
    const { scope, templates } = await scanAccount(root, ACCOUNT_B)

    const result = selectVerifiedImageKey({
      payload: { accounts: [{ wxid: 'abcdefg', keys: [{ code: ACCOUNT_B.code }] }] },
      scope,
      rootDir: root,
      wxidParam: ACCOUNT_B.dir,
      templates,
    })

    expect(result.success).toBe(true)
    expect(result.aesKey).toBe(deriveImageKeysForWxid(ACCOUNT_B.code, ACCOUNT_B.canonical).aesKey)
  })

  it('账号目录里没有模板时给出"试了什么 + 下一步"，而不是一句"失败"', () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    const scope = resolveAccountImageDirs(root, ACCOUNT_B.dir)

    const result = selectVerifiedImageKey({
      payload: { accounts: [{ wxid: ACCOUNT_B.canonical, keys: [{ code: ACCOUNT_B.code }] }] },
      scope,
      rootDir: root,
      wxidParam: ACCOUNT_B.dir,
      templates: { ciphertexts: [], files: [], dirs: [] },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('*_t.dat')
    expect(result.error).toContain('下一步')
    expect(result.tried?.join(' ')).toContain(ACCOUNT_B.dir)
  })

  it('kvcomm 里一个密钥码都没有时也带下一步', () => {
    const result = selectVerifiedImageKey({
      payload: { accounts: [] },
      scope: { dirs: [], allAccountDirs: [], scoped: false },
      templates: { ciphertexts: [Buffer.alloc(16)], files: [], dirs: [] },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('下一步')
  })
})

describe('模板扫描本身：同机多账号时的"取最新"陷阱 (issue #20)', () => {
  it('在根目录上扫描会取到最新的那个账号的模板（旧行为的复现）', async () => {
    const root = tempRoot()
    const older = writeTemplate(root, ACCOUNT_B, 'b1', 0x22)
    const newer = writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    // 明确把 A 的模板设成更新（旧实现按 mtime 取"最新"）
    const now = Date.now() / 1000
    const { utimesSync } = await import('node:fs')
    utimesSync(older, now - 600, now - 600)
    utimesSync(newer, now, now)

    const rootScan = await internals()._findTemplateData(root, 32)
    expect(rootScan.files.length).toBeGreaterThan(0)
    // 根目录扫描拿到的模板来自 A —— 如果用户选的是 B，这份密文根本解不开 B 的密钥
    expect(rootScan.files[0]).toBe(newer)
    const bKey = deriveImageKeysForWxid(ACCOUNT_B.code, ACCOUNT_B.canonical).aesKey
    expect(verifyDerivedAesKey(bKey, rootScan.ciphertexts[0])).toBe(false)
  })

  it('收敛到账号目录后只喂本账号的模板，并给出该账号的 XOR 密钥', async () => {
    const root = tempRoot()
    writeTemplate(root, ACCOUNT_A, 'a1', 0x11)
    writeTemplate(root, ACCOUNT_B, 'b1', 0x22)

    const bScan = await internals().collectTemplateCiphertexts(resolveAccountImageDirs(root, ACCOUNT_B.dir).dirs, 8)
    expect(bScan.files.length).toBeGreaterThan(0)
    expect(bScan.files.every((file) => file.includes(ACCOUNT_B.dir))).toBe(true)
    expect(bScan.origins.every((origin) => origin.dir.endsWith(ACCOUNT_B.dir))).toBe(true)
    expect(bScan.xorKey).toBe(ACCOUNT_B.code & 0xff)
    expect(bScan.ciphertexts.length).toBe(bScan.origins.length)
  })

  it('多个模板里有一个损坏/截断时，其余模板仍能完成校验', async () => {
    const root = tempRoot()
    const good = writeTemplate(root, ACCOUNT_B, 'b1', 0x22)
    // 放一个"看起来像 V2 但密文区被截断"的坏文件，并让它成为最新的那个
    const badDir = join(root, ACCOUNT_B.dir, 'msg', 'attach', 'deadbeef', '2026-10', 'Img')
    mkdirSync(badDir, { recursive: true })
    const truncated = buildTemplateFile(ACCOUNT_B.code, ACCOUNT_B.canonical, 0x33).subarray(0, 0x12)
    writeFileSync(join(badDir, 'zz_t.dat'), truncated)
    writeFileSync(good, buildTemplateFile(ACCOUNT_B.code, ACCOUNT_B.canonical, 0x22))

    const { scope, templates } = await scanAccount(root, ACCOUNT_B)
    const result = selectVerifiedImageKey({
      payload: { accounts: [{ wxid: ACCOUNT_B.canonical, keys: [{ code: ACCOUNT_B.code }] }] },
      scope,
      rootDir: root,
      wxidParam: ACCOUNT_B.dir,
      templates,
    })

    expect(templates.ciphertexts.length).toBeGreaterThanOrEqual(1)
    expect(result.success).toBe(true)
    expect(result.aesKey).toBe(deriveImageKeysForWxid(ACCOUNT_B.code, ACCOUNT_B.canonical).aesKey)
  })
})
