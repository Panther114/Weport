import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KeyHealthService,
  clearDbKeys,
  emptyDbKeyStore,
  hasDbStorageFiles,
  mergeAccountPassphrase,
  mergeDbKeyUpdates,
  toKeyHealthReport,
  validateAccountKeyAgainstDbs,
  type DbKeyStoreFile,
  type SecretCodec,
} from './keyHealthService'
import { DbFileEnumerationLimitError, SQLCIPHER_HMAC_OFFSET, SQLCIPHER_PAGE_SIZE, deriveMacKey, keyFingerprint } from './wcdbPageKey'
import crypto from 'crypto'

/**
 * 密钥健康面板的引擎侧单测（§10.4 的验收项）。
 *
 * 覆盖四条硬规则：
 * 1. 合并写入绝不碰其它库/其它账号；
 * 2. 无效密钥不覆盖有效密钥（粘贴先验证后落盘）；
 * 3. per-DB 状态区分 ok / stale / invalid / missing / unknown；
 * 4. 日志与返回值里只有指纹。
 *
 * 库文件是**合成的**：按 SQLCipher 的格式自己写一页，因此不依赖真实微信数据。
 */

const dirs: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weport-keyhealth-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

/** 造一个 raw 模式的库：page 1 的 MAC 用给定 salt/key 算出来。 */
function makeDb(path: string, saltHex: string, keyHex: string): void {
  const page = Buffer.alloc(SQLCIPHER_PAGE_SIZE)
  const salt = Buffer.from(saltHex, 'hex')
  const key = Buffer.from(keyHex, 'hex')
  salt.copy(page, 0)
  for (let i = 16; i < SQLCIPHER_HMAC_OFFSET; i++) page[i] = (i * 13 + 7) & 0xff
  const macKey = deriveMacKey(key, salt)
  const mac = crypto.createHmac('sha512', macKey)
  mac.update(page.subarray(16, SQLCIPHER_HMAC_OFFSET))
  const pageNo = Buffer.alloc(4)
  pageNo.writeUInt32LE(1, 0)
  mac.update(pageNo)
  mac.digest().copy(page, SQLCIPHER_HMAC_OFFSET)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, page)
}

/** 内存 codec：测试里不需要真 safeStorage，但要保留 `safe:` 前缀语义。 */
const testCodec: SecretCodec = {
  available: () => true,
  encrypt: (plain) => `safe:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (stored) => (stored.startsWith('safe:') ? Buffer.from(stored.slice(5), 'base64').toString('utf8') : stored),
}

function memoryPersistence(initial: DbKeyStoreFile = emptyDbKeyStore()) {
  let store = initial
  return {
    read: () => store,
    write: (next: DbKeyStoreFile) => { store = next },
    current: () => store,
  }
}

const KEY_A = 'a1'.repeat(32)
const KEY_B = 'b2'.repeat(32)
const SALT_A = '11'.repeat(16)
const SALT_B = '22'.repeat(16)

function seedAccount(): { dbStorage: string; accountDir: string; root: string } {
  const root = tempRoot()
  const accountDir = join(root, 'wxid_demo_0000')
  const dbStorage = join(accountDir, 'db_storage')
  makeDb(join(dbStorage, 'session', 'session.db'), SALT_A, KEY_A)
  makeDb(join(dbStorage, 'contact', 'contact.db'), SALT_B, KEY_B)
  return { root, accountDir, dbStorage }
}

function seedHistoryAccount(): { accountDir: string; dbs: Array<{ id: string; path: string; key: string }> } {
  const root = tempRoot()
  const accountDir = join(root, 'wxid_demo_0000')
  const dbStorage = join(accountDir, 'db_storage')
  const defs = [
    { id: 'session/session.db', salt: '31'.repeat(16) },
    { id: 'message/message_0.db', salt: '32'.repeat(16) },
    { id: 'message/message_1.db', salt: '33'.repeat(16) },
    { id: 'media/media_0.db', salt: '34'.repeat(16) },
  ]
  const dbs = defs.map((item) => {
    const dbPath = join(dbStorage, ...item.id.split('/'))
    makeDb(dbPath, item.salt, KEY_A)
    return { id: item.id, path: dbPath, key: KEY_A }
  })
  return { accountDir, dbs }
}

describe('合并写入（绝不互相覆盖）', () => {
  it('account-passphrase readiness returns all authenticated page keys for mirror fallback', async () => {
    const fixture = seedHistoryAccount()
    const expected = fixture.dbs.map(db => {
      const salt = readFileSync(db.path).subarray(0, 16)
      const derived = crypto.pbkdf2Sync(Buffer.from(KEY_A, 'hex'), salt, 256000, 32, 'sha512')
      makeDb(db.path, salt.toString('hex'), derived.toString('hex'))
      return { id: db.id, keyHex: derived.toString('hex') }
    })
    const store: DbKeyStoreFile = { version: 1, accounts: {
      wxid_demo_0000: { dbKeys: {}, passphrase: testCodec.encrypt(KEY_A), passphraseSource: 'hook', updatedAt: 5 },
    } }
    const service = new KeyHealthService({ deps: {
      codec: testCodec, store: memoryPersistence(store), resolveAccountDir: () => fixture.accountDir,
    } })
    expect((await service.getHealth()).connectionReady).toBe(true)
    const material = service.getVerifiedDbKeyMaterial()
    expect(material.success).toBe(true)
    expect(material.keys).toEqual(expected)
    expect(material.missing).toEqual([])
    expect(material.invalid).toEqual([])
    // Coverage stays strict when an additional required shard cannot authenticate.
    makeDb(join(fixture.accountDir, 'db_storage', 'message', 'message_2.db'), SALT_B, KEY_B)
    expect((await service.getHealth()).connectionReady).toBe(false)
    expect(service.getVerifiedDbKeyMaterial().invalid).toContain('message/message_2.db')
  }, 30_000)

  it('validates native hex-decoded account passphrases and returns derived per-database keys', async () => {
    const { accountDir, dbStorage } = seedAccount()
    const salt = Buffer.from(SALT_A, 'hex')
    const derived = crypto.pbkdf2Sync(Buffer.from(KEY_A, 'hex'), salt, 256000, 32, 'sha512')
    makeDb(join(dbStorage, 'session', 'session.db'), SALT_A, derived.toString('hex'))
    const persistence = memoryPersistence(emptyDbKeyStore())
    const service = new KeyHealthService({ deps: { codec: testCodec, store: persistence, resolveAccountDir: () => accountDir } })
    const pasted = await service.paste({ dbKeyId: 'session/session.db', text: KEY_A })
    expect(pasted.success).toBe(true)
    const material = service.getVerifiedDbKeyMaterial(accountDir)
    expect(material.keys).toEqual([{ id: 'session/session.db', keyHex: derived.toString('hex') }])
    expect(material.missing).toEqual(['contact/contact.db'])
    const report = await service.getHealth(accountDir)
    expect(report.entries.find(entry => entry.id === 'session/session.db')?.mode).toBe('passphrase')
  })
  it('写入一个库不动其它库、也不动其它账号', () => {
    const store: DbKeyStoreFile = {
      version: 1,
      accounts: {
        other: { dbKeys: { 'session/session.db': { key: testCodec.encrypt(KEY_B), source: 'scan', verified: true, at: 1, fingerprint: 'b2b2…b2b2' } } },
        wxid_demo_0000: { dbKeys: { 'session/session.db': { key: testCodec.encrypt(KEY_A), source: 'scan', verified: true, at: 1, fingerprint: 'a1a1…a1a1' } } },
      },
    }
    const merged = mergeDbKeyUpdates(store, 'wxid_demo_0000', [
      { dbKeyId: 'contact/contact.db', keyHex: KEY_B, saltHex: SALT_B, source: 'scan', verified: true },
    ], (plain) => testCodec.encrypt(plain), 999)

    expect(merged.applied).toEqual(['contact/contact.db'])
    // 同账号的另一个库原样保留
    expect(testCodec.decrypt(merged.next.accounts.wxid_demo_0000.dbKeys['session/session.db'].key)).toBe(KEY_A)
    // 其它账号原样保留（连对象引用都不该被改写）
    expect(testCodec.decrypt(merged.next.accounts.other.dbKeys['session/session.db'].key)).toBe(KEY_B)
    expect(store.accounts.wxid_demo_0000.dbKeys['contact/contact.db']).toBeUndefined()
  })

  it('未验证的更新一律拒绝（无效密钥不得覆盖有效密钥）', () => {
    const store: DbKeyStoreFile = {
      version: 1,
      accounts: { wxid_demo_0000: { dbKeys: { 'session/session.db': { key: testCodec.encrypt(KEY_A), source: 'scan', verified: true, at: 1, fingerprint: 'a1a1…a1a1' } } } },
    }
    const merged = mergeDbKeyUpdates(store, 'wxid_demo_0000', [
      { dbKeyId: 'session/session.db', keyHex: KEY_B, source: 'manual', verified: false },
    ], (plain) => testCodec.encrypt(plain), 999)
    expect(merged.applied).toHaveLength(0)
    expect(merged.rejected[0]).toEqual({ dbKeyId: 'session/session.db', reason: 'unverified' })
    expect(testCodec.decrypt(merged.next.accounts.wxid_demo_0000.dbKeys['session/session.db'].key)).toBe(KEY_A)
  })

  it('同一把已验证密钥重复写入记 unchanged（不刷新时间戳）', () => {
    const store: DbKeyStoreFile = {
      version: 1,
      accounts: { wxid_demo_0000: { dbKeys: { 'session/session.db': { key: testCodec.encrypt(KEY_A), salt: SALT_A, source: 'scan', verified: true, at: 111, fingerprint: keyFingerprint(KEY_A) } } } },
    }
    const merged = mergeDbKeyUpdates(store, 'wxid_demo_0000', [
      { dbKeyId: 'session/session.db', keyHex: KEY_A, saltHex: SALT_A, source: 'scan', verified: true },
    ], (plain) => testCodec.encrypt(plain), 999)
    expect(merged.unchanged).toEqual(['session/session.db'])
    expect(merged.next.accounts.wxid_demo_0000.dbKeys['session/session.db'].at).toBe(111)
  })

  it('格式不对的密钥被拒绝，不会写进库里', () => {
    const store = emptyDbKeyStore()
    const merged = mergeDbKeyUpdates(store, 'wxid_demo_0000', [
      { dbKeyId: 'session/session.db', keyHex: 'not-hex', source: 'manual', verified: true },
    ], (plain) => testCodec.encrypt(plain), 1)
    expect(merged.applied).toHaveLength(0)
    expect(merged.rejected).toHaveLength(1)
    expect(merged.next.accounts.wxid_demo_0000?.dbKeys['session/session.db']).toBeUndefined()
  })

  it('账号口令与 per-DB 密钥互不干扰', () => {
    const store = emptyDbKeyStore()
    const withPass = mergeAccountPassphrase(store, 'wxid_demo_0000', KEY_A, 'hook', (p) => testCodec.encrypt(p), 5)
    const merged = mergeDbKeyUpdates(withPass, 'wxid_demo_0000', [
      { dbKeyId: 'contact/contact.db', keyHex: KEY_B, saltHex: SALT_B, source: 'scan', verified: true },
    ], (p) => testCodec.encrypt(p), 6)
    expect(testCodec.decrypt(merged.next.accounts.wxid_demo_0000.passphrase!)).toBe(KEY_A)
    expect(testCodec.decrypt(merged.next.accounts.wxid_demo_0000.dbKeys['contact/contact.db'].key)).toBe(KEY_B)
  })

  it('clear 只删点名的库，账号口令与其它库保留', () => {
    const store = mergeAccountPassphrase({
      version: 1,
      accounts: {
        wxid_demo_0000: {
          dbKeys: {
            'session/session.db': { key: testCodec.encrypt(KEY_A), source: 'scan', verified: true, at: 1, fingerprint: 'a1a1…a1a1' },
            'contact/contact.db': { key: testCodec.encrypt(KEY_B), source: 'scan', verified: true, at: 1, fingerprint: 'b2b2…b2b2' },
          },
        },
      },
    }, 'wxid_demo_0000', KEY_A, 'hook', (p) => testCodec.encrypt(p), 1)

    const next = clearDbKeys(store, 'wxid_demo_0000', ['contact/contact.db'], 9)
    expect(next.accounts.wxid_demo_0000.dbKeys['contact/contact.db']).toBeUndefined()
    expect(next.accounts.wxid_demo_0000.dbKeys['session/session.db']).toBeDefined()
    expect(testCodec.decrypt(next.accounts.wxid_demo_0000.passphrase!)).toBe(KEY_A)
  })
})

describe('账号级密钥校验（K6/K7 判据）', () => {
  it('对的密钥通过、错的密钥不通过，且报出检查/命中数量', () => {
    const { accountDir } = seedAccount()
    const good = validateAccountKeyAgainstDbs(accountDir, KEY_A)
    expect(good.valid).toBe(true)
    expect(good.checked).toBe(2)
    expect(good.matched).toBe(1)
    expect(good.dbs).toEqual(['session/session.db'])

    const bad = validateAccountKeyAgainstDbs(accountDir, 'ff'.repeat(32))
    expect(bad.valid).toBe(false)
    expect(bad.checked).toBe(2)
    expect(bad.matched).toBe(0)

    expect(hasDbStorageFiles(accountDir)).toBe(true)
    expect(hasDbStorageFiles(join(accountDir, 'nope'))).toBe(false)
  })
})

describe('逐库状态判定（含负例：错密钥不覆盖好密钥）', () => {
  function serviceWith(store: DbKeyStoreFile, accountDir: string) {
    const persistence = memoryPersistence(store)
    const service = new KeyHealthService({
      deps: {
        codec: testCodec,
        store: persistence,
        resolveAccountDir: () => accountDir,
        now: () => 1_700_000_000_000,
      },
    })
    return { service, persistence, accountDir }
  }

  it('没有密钥 → unknown；有正确密钥 → ok；状态与指纹如实', async () => {
    const { accountDir } = seedAccount()
    const empty = serviceWith(emptyDbKeyStore(), accountDir)
    const before = await empty.service.getHealth()
    expect(before.success).toBe(true)
    expect(before.entries).toHaveLength(2)
    expect(before.entries.every((e) => e.status === 'unknown')).toBe(true)

    const store: DbKeyStoreFile = {
      version: 1,
      accounts: {
        wxid_demo_0000: {
          dbKeys: {
            'session/session.db': { key: testCodec.encrypt(KEY_A), salt: SALT_A, source: 'scan', verified: true, at: 42, fingerprint: keyFingerprint(KEY_A) },
          },
        },
      },
    }
    const withKey = serviceWith(store, accountDir)
    const after = await withKey.service.getHealth()
    const session = after.entries.find((e) => e.id === 'session/session.db')
    const contact = after.entries.find((e) => e.id === 'contact/contact.db')
    expect(session?.status).toBe('ok')
    expect(session?.mode).toBe('raw')
    expect(session?.fingerprint).toBe(keyFingerprint(KEY_A))
    expect(session?.verifiedAt).toBe(42)
    expect(contact?.status).toBe('unknown')
    // 完整密钥绝不出现
    expect(JSON.stringify(after)).not.toContain(KEY_A)
  })

  it('连接就绪要求 session 和每个消息分片通过 HMAC；media coverage 单独报告', async () => {
    const fixture = seedHistoryAccount()
    const empty = serviceWith(emptyDbKeyStore(), fixture.accountDir).service
    const before = await empty.getHealth()
    expect(before.connectionReady).toBe(false)
    expect(before.connectionCoverage?.required).toBe(3)
    expect(before.connectionCoverage?.missing).toEqual([
      'session/session.db',
      'message/message_0.db',
      'message/message_1.db',
    ])

    const partialStore = mergeDbKeyUpdates(emptyDbKeyStore(), 'wxid_demo_0000', fixture.dbs
      .filter((db) => db.id !== 'message/message_1.db')
      .map((db) => ({ dbKeyId: db.id, keyHex: db.key, source: 'scan' as const, verified: true })),
    (plain) => testCodec.encrypt(plain), 1).next
    const partial = await serviceWith(partialStore, fixture.accountDir).service.getHealth()
    expect(partial.connectionReady).toBe(false)
    expect(partial.connectionCoverage?.missing).toEqual(['message/message_1.db'])
    expect(partial.connectionCoverage?.mediaRequired).toBe(1)
    expect(partial.connectionCoverage?.mediaReady).toBe(1)

    const fullStore = mergeDbKeyUpdates(emptyDbKeyStore(), 'wxid_demo_0000', fixture.dbs
      .map((db) => ({ dbKeyId: db.id, keyHex: db.key, source: 'scan' as const, verified: true })),
    (plain) => testCodec.encrypt(plain), 2).next
    const fullService = serviceWith(fullStore, fixture.accountDir).service
    const full = await fullService.getHealth()
    expect(full.connectionReady).toBe(true)
    expect(full.connectionCoverage?.ready).toBe(3)
    expect(full.connectionCoverage?.mediaReady).toBe(1)
    const material = fullService.getVerifiedDbKeyMaterial(fixture.accountDir)
    expect(material.success).toBe(true)
    expect(material.keys).toEqual(fixture.dbs.map(({ id, key }) => ({ id, keyHex: key })))
  })

  it('缺少 session.db 时，即使所有现存消息分片密钥都有效也不报告连接就绪', async () => {
    const fixture = seedHistoryAccount()
    const sessionDb = fixture.dbs.find((db) => db.id === 'session/session.db')!
    rmSync(sessionDb.path, { force: true })
    const store = mergeDbKeyUpdates(emptyDbKeyStore(), 'wxid_demo_0000', fixture.dbs
      .filter((db) => db.id !== 'session/session.db')
      .map((db) => ({ dbKeyId: db.id, keyHex: db.key, source: 'scan' as const, verified: true })),
    (plain) => testCodec.encrypt(plain), 3).next

    const report = await serviceWith(store, fixture.accountDir).service.getHealth()

    expect(report.connectionReady).toBe(false)
    expect(report.connectionCoverage?.required).toBe(3)
    expect(report.connectionCoverage?.ready).toBe(2)
    expect(report.connectionCoverage?.missing).toContain('session/session.db')
  })

  it('数据库枚举达到安全上限时返回不可就绪错误，而不是未捕获异常', async () => {
    const { accountDir } = seedAccount()
    const service = new KeyHealthService({
      deps: {
        codec: testCodec,
        store: memoryPersistence(emptyDbKeyStore()),
        resolveAccountDir: () => accountDir,
        listDbs: () => { throw new DbFileEnumerationLimitError(400) },
      },
    })

    const report = await service.getHealth()
    const material = service.getVerifiedDbKeyMaterial(accountDir)

    expect(report.success).toBe(false)
    expect(report.connectionReady).toBe(false)
    expect(report.error).toContain('安全上限 400')
    expect(material.success).toBe(false)
    expect(material.error).toContain('安全上限 400')
  })

  it('密钥错、salt 未变 → invalid；salt 变了 → stale（两种用户动作不同）', async () => {
    const { accountDir } = seedAccount()
    const wrongKeyStore: DbKeyStoreFile = {
      version: 1,
      accounts: {
        wxid_demo_0000: {
          dbKeys: {
            'session/session.db': { key: testCodec.encrypt(KEY_B), salt: SALT_A, source: 'manual', verified: true, at: 7, fingerprint: keyFingerprint(KEY_B) },
          },
        },
      },
    }
    const wrong = await serviceWith(wrongKeyStore, accountDir).service.getHealth()
    const session = wrong.entries.find((e) => e.id === 'session/session.db')
    expect(session?.status).toBe('invalid')
    expect(session?.reason).toContain('HMAC')
    expect(session?.action).toContain('登录捕获')

    const staleStore: DbKeyStoreFile = {
      version: 1,
      accounts: {
        wxid_demo_0000: {
          dbKeys: {
            'session/session.db': { key: testCodec.encrypt(KEY_B), salt: 'ee'.repeat(16), source: 'scan', verified: true, at: 7, fingerprint: keyFingerprint(KEY_B) },
          },
        },
      },
    }
    const stale = await serviceWith(staleStore, accountDir).service.getHealth()
    const staleSession = stale.entries.find((e) => e.id === 'session/session.db')
    expect(staleSession?.status).toBe('stale')
    expect(staleSession?.reason).toContain('salt')
  })

  it('库文件读不出首页 → missing；账号目录没有 db_storage → 结构化失败（不是空报告）', async () => {
    const { accountDir, dbStorage } = seedAccount()
    // 截断成不足一页：文件还在、但不是一个可判定的库（真实场景：复制到一半的备份）
    writeFileSync(join(dbStorage, 'contact', 'contact.db'), Buffer.alloc(64))
    const report = await serviceWith(emptyDbKeyStore(), accountDir).service.getHealth()
    expect(report.entries.find((e) => e.id === 'contact/contact.db')?.status).toBe('missing')

    const emptyDir = tempRoot()
    const noStorage = await serviceWith(emptyDbKeyStore(), emptyDir).service.getHealth()
    expect(noStorage.success).toBe(false)
    expect(noStorage.error).toContain('db_storage')
  })

  it('账号级口令覆盖到的库显示 ok 且来源标成 hook，其余库仍 unknown', async () => {
    const { accountDir } = seedAccount()
    // 账号口令 = KEY_B：它能解开 contact.db，但解不开 session.db
    const store: DbKeyStoreFile = {
      version: 1,
      accounts: { wxid_demo_0000: { dbKeys: {}, passphrase: testCodec.encrypt(KEY_B), passphraseSource: 'hook', updatedAt: 5 } },
    }
    const report = await serviceWith(store, accountDir).service.getHealth()
    const contact = report.entries.find((e) => e.id === 'contact/contact.db')
    const session = report.entries.find((e) => e.id === 'session/session.db')
    expect(contact?.status).toBe('ok')
    expect(contact?.source).toBe('hook')
    expect(contact?.mode).toBe('raw')
    expect(session?.status).toBe('unknown')
  })
})

describe('粘贴：四种语法都能识别，验不过就不写盘（负例验收）', () => {
  it('正确密钥写入目标库；错误密钥被拒且**不覆盖**另一个库的好密钥', async () => {
    const { accountDir } = seedAccount()
    const store: DbKeyStoreFile = {
      version: 1,
      accounts: {
        wxid_demo_0000: {
          dbKeys: {
            'session/session.db': { key: testCodec.encrypt(KEY_A), salt: SALT_A, source: 'scan', verified: true, at: 1, fingerprint: keyFingerprint(KEY_A) },
          },
        },
      },
    }
    const persistence = memoryPersistence(store)
    const service = new KeyHealthService({
      deps: { codec: testCodec, store: persistence, resolveAccountDir: () => accountDir },
    })

    // ① 写入 contact.db 的正确密钥（96 位 hex 形式，带 salt）
    const ok = await service.paste({ dbKeyId: 'contact/contact.db', text: `${KEY_B}${SALT_B}` })
    expect(ok.success).toBe(true)
    expect(ok.syntax).toBe('key+salt-96')
    expect(ok.fingerprint).toBe(keyFingerprint(KEY_B))
    expect(testCodec.decrypt(persistence.current().accounts.wxid_demo_0000.dbKeys['contact/contact.db'].key)).toBe(KEY_B)

    // ② 故意粘贴一把错密钥到 contact.db：必须被拒，且 session.db 的好密钥不受影响
    const before = JSON.stringify(persistence.current())
    const bad = await service.paste({ dbKeyId: 'contact/contact.db', text: `x'${'cd'.repeat(32)}'` })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('未写入')
    expect(bad.rejected?.[0]).toContain('page 1 HMAC')
    expect(JSON.stringify(persistence.current())).toBe(before)
    expect(testCodec.decrypt(persistence.current().accounts.wxid_demo_0000.dbKeys['session/session.db'].key)).toBe(KEY_A)
    // 状态：contact 仍是 ok（旧的正确密钥还在），session ok
    const report = await service.getHealth()
    expect(report.entries.find((e) => e.id === 'contact/contact.db')?.status).toBe('ok')
    expect(report.entries.find((e) => e.id === 'session/session.db')?.status).toBe('ok')
  })

  it('0x 前缀与裸 hex 两种语法也都能落到目标库', async () => {
    const { accountDir } = seedAccount()
    const persistence = memoryPersistence(emptyDbKeyStore())
    const service = new KeyHealthService({ deps: { codec: testCodec, store: persistence, resolveAccountDir: () => accountDir } })
    const withPrefix = await service.paste({ dbKeyId: 'session/session.db', text: `0x${KEY_A}` })
    expect(withPrefix.success).toBe(true)
    expect(withPrefix.syntax).toBe('hex-0x')
    const plain = await service.paste({ dbKeyId: 'contact/contact.db', text: KEY_B })
    expect(plain.success).toBe(true)
    expect(plain.syntax).toBe('raw64')
  })

  it('语法错误直接给出可分支的错误码文案（不写盘）', async () => {
    const { accountDir } = seedAccount()
    const persistence = memoryPersistence(emptyDbKeyStore())
    const service = new KeyHealthService({ deps: { codec: testCodec, store: persistence, resolveAccountDir: () => accountDir } })
    const result = await service.paste({ dbKeyId: 'session/session.db', text: 'hello' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('十六进制')
    expect(persistence.current().accounts).toEqual({})
  })
})

describe('rescan 门禁 + 契约映射', () => {
  it('V1.2 稳定版阻止 rescan 获取密钥，即使底层扫描器仍注入', async () => {
    const { accountDir } = seedAccount()
    const store: DbKeyStoreFile = {
      version: 1,
      accounts: {
        wxid_demo_0000: {
          dbKeys: {
            // 模拟"上一次扫描留下的、这次没被扫到的库"
            'message/message_9.db': { key: `safe:${'ab'.repeat(32)}`, salt: 'ab'.repeat(16), source: 'scan', verified: true, at: 1, fingerprint: 'abab…abab' },
          },
        },
      },
    }
    const persistence = memoryPersistence(store)
    let scanCalls = 0
    const service = new KeyHealthService({
      deps: {
        codec: testCodec,
        store: persistence,
        resolveAccountDir: () => accountDir,
        rescanKeys: async () => {
          scanCalls += 1
          return {
            success: true,
            keys: [
              { id: 'session/session.db', kind: 'session', path: 'x', keyHex: KEY_A, saltHex: SALT_A, mode: 'raw' as const, fingerprint: keyFingerprint(KEY_A) },
            ],
          }
        },
      },
    })
    const report = await service.rescan()
    expect(report.scan?.keys).toBe(0)
    expect(report.scan?.failed).toContain('免登录逐库扫描')
    expect(scanCalls).toBe(0)
    expect(persistence.current()).toEqual(store)
    expect(persistence.current().accounts.wxid_demo_0000.dbKeys['message/message_9.db']).toBeDefined()
  })

  it('没有扫描能力时（macOS/Linux）如实说明，不假装成功', async () => {
    const { accountDir } = seedAccount()
    const service = new KeyHealthService({
      deps: { codec: testCodec, store: memoryPersistence(emptyDbKeyStore()), resolveAccountDir: () => accountDir },
    })
    const report = await service.rescan()
    expect(report.scan?.failed).toContain('免登录')
  })

  it('toKeyHealthReport 映射成共享契约：databases/mode/error，且不含完整密钥', async () => {
    const { accountDir } = seedAccount()
    const service = new KeyHealthService({ deps: { codec: testCodec, store: memoryPersistence(emptyDbKeyStore()), resolveAccountDir: () => accountDir } })
    const contract = toKeyHealthReport(await service.getHealth())
    expect(contract.databases).toHaveLength(2)
    expect(contract.mode).toBe('none')
    expect(contract.databases[0].status).toBe('unknown')
    expect(contract.databases[0].error).toContain('还没有保存过密钥')
    expect(JSON.stringify(contract)).not.toMatch(/[0-9a-f]{64}/i)

    const filtered = toKeyHealthReport(await service.getHealth(), ['session'])
    expect(filtered.databases).toHaveLength(1)
    expect(filtered.databases[0].kind).toBe('session')
  })
})
