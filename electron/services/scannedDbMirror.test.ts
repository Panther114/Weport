import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as crypto from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveMacKey, verifyPageKey } from './wcdbPageKey'
import { createScannedDbMirror, type ScannedDbKeyMaterial } from './scannedDbMirror'

const PAGE_SIZE = 4096
const RESERVE = 80
const CONTENT_END = PAGE_SIZE - RESERVE
const HEADER = Buffer.from('SQLite format 3\0', 'ascii')
const KEY = Buffer.from('102132435465768798a9bacbdcedfe0f102132435465768798a9bacbdcedfe0f', 'hex')

let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

function pageMac(page: Buffer, macKey: Buffer, pageNo: number): Buffer {
  const pageNum = Buffer.alloc(4)
  pageNum.writeUInt32LE(pageNo)
  const bytes = pageNo === 1 ? page.subarray(16, CONTENT_END + 16) : page.subarray(0, CONTENT_END + 16)
  return crypto.createHmac('sha512', macKey).update(bytes).update(pageNum).digest()
}

function encryptPage(plain: Buffer, key: Buffer, salt: Buffer, pageNo: number, ivByte: number): Buffer {
  const encKey = key
  const macKey = deriveMacKey(encKey, salt)
  const out = Buffer.alloc(PAGE_SIZE)
  if (pageNo === 1) salt.copy(out)
  const start = pageNo === 1 ? 16 : 0
  const iv = Buffer.alloc(16, ivByte)
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv)
  cipher.setAutoPadding(false)
  Buffer.concat([cipher.update(plain.subarray(start, CONTENT_END)), cipher.final()]).copy(out, start)
  iv.copy(out, CONTENT_END)
  pageMac(out, macKey, pageNo).copy(out, PAGE_SIZE - 64)
  return out
}

function checksum(bytes: Buffer, bigEndianInput: boolean, initial: [number, number] = [0, 0]): [number, number] {
  let s0 = initial[0] >>> 0
  let s1 = initial[1] >>> 0
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const x0 = bigEndianInput ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset)
    const x1 = bigEndianInput ? bytes.readUInt32BE(offset + 4) : bytes.readUInt32LE(offset + 4)
    s0 = (s0 + x0 + s1) >>> 0
    s1 = (s1 + x1 + s0) >>> 0
  }
  return [s0, s1]
}

function appendChecksum(target: Buffer, offset: number, value: [number, number]): void {
  target.writeUInt32BE(value[0], offset)
  target.writeUInt32BE(value[1], offset + 4)
}

function makePlainPage(pageNo: number, marker: number): Buffer {
  const page = Buffer.alloc(PAGE_SIZE)
  page.fill(marker, pageNo === 1 ? 16 : 0, CONTENT_END)
  if (pageNo === 1) {
    HEADER.copy(page)
    page.writeUInt32BE(PAGE_SIZE, 16)
    page[18] = 1
    page[19] = 1
    page[20] = RESERVE
  }
  return page
}

function buildEncryptedDb(salt: Buffer, key: Buffer, page2Marker: number): Buffer {
  return Buffer.concat([
    encryptPage(makePlainPage(1, 0x21), key, salt, 1, 0x31),
    encryptPage(makePlainPage(2, page2Marker), key, salt, 2, 0x42),
  ])
}

function buildWal(salt: Buffer, key: Buffer, page2Marker: number): Buffer {
  const magic = 0x377f0682 // SQLite specifies little-endian checksum words for this magic.
  const header = Buffer.alloc(32)
  header.writeUInt32BE(magic, 0)
  header.writeUInt32BE(3007000, 4)
  header.writeUInt32BE(PAGE_SIZE, 8)
  header.writeUInt32BE(0, 12)
  header.writeUInt32BE(0x12345678, 16)
  header.writeUInt32BE(0x90abcdef, 20)
  const headerSum = checksum(header.subarray(0, 24), false)
  appendChecksum(header, 24, headerSum)

  const frame = Buffer.alloc(24 + PAGE_SIZE)
  frame.writeUInt32BE(2, 0)
  frame.writeUInt32BE(2, 4) // commit marker and database size
  header.copy(frame, 8, 16, 24)
  encryptPage(makePlainPage(2, page2Marker), key, salt, 2, 0x53).copy(frame, 24)
  const frameInput = Buffer.concat([frame.subarray(0, 8), frame.subarray(24)])
  appendChecksum(frame, 16, checksum(frameInput, false, headerSum))
  return Buffer.concat([header, frame])
}

function makeAccount(): { accountDir: string; keys: ScannedDbKeyMaterial[]; sessionPath: string; messagePath: string; walPath: string } {
  root = mkdtempSync(join(tmpdir(), 'weport-scanned-db-test-'))
  const accountDir = join(root, 'wxid_demo')
  const sessionPath = join(accountDir, 'db_storage', 'session', 'session.db')
  const messagePath = join(accountDir, 'db_storage', 'message', 'message_0.db')
  const walPath = `${messagePath}-wal`
  mkdirSync(join(accountDir, 'db_storage', 'session'), { recursive: true })
  mkdirSync(join(accountDir, 'db_storage', 'message'), { recursive: true })
  const sessionSalt = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')
  const messageSalt = Buffer.from('1112131415161718191a1b1c1d1e1f20', 'hex')
  writeFileSync(sessionPath, buildEncryptedDb(sessionSalt, KEY, 0x63))
  writeFileSync(messagePath, buildEncryptedDb(messageSalt, KEY, 0x74))
  writeFileSync(walPath, buildWal(messageSalt, KEY, 0x85))
  return {
    accountDir,
    keys: [
      { id: 'session/session.db', keyHex: KEY.toString('hex') },
      { id: 'message/message_0.db', keyHex: KEY.toString('hex') },
    ],
    sessionPath,
    messagePath,
    walPath,
  }
}

function expectPageHmac(page: Buffer, key: Buffer, salt: Buffer, pageNo: number): void {
  const macKey = deriveMacKey(key, salt)
  expect(pageMac(page, macKey, pageNo)).toEqual(page.subarray(PAGE_SIZE - 64))
}

describe('createScannedDbMirror', () => {
  it('rekeys every verified page and committed WAL frame without changing source files', async () => {
    const fixture = makeAccount()
    const sourceHashes = [fixture.sessionPath, fixture.messagePath, fixture.walPath]
      .map((file) => crypto.createHash('sha256').update(readFileSync(file)).digest('hex'))
    const randomBytes = (size: number): Buffer => Buffer.alloc(size, size === 32 ? 0x9a : size === 16 ? 0x6b : 0x5c)

    const result = await createScannedDbMirror({ accountDir: fixture.accountDir, keys: fixture.keys, randomBytes, destinationRoot: root })
    expect(result.ok).toBe(true)
    expect(result.convertedDbCount).toBe(2)
    expect(result.convertedPageCount).toBe(4)
    expect(result.walFrameCount).toBe(1)
    expect(result.mirrorDir).toBeTruthy()
    expect(result.mirrorKey).toMatch(/^[0-9a-f]{64}$/)

    const mirrorKey = Buffer.from(result.mirrorKey!, 'hex')
    const mirrorSession = join(result.mirrorDir!, 'db_storage', 'session', 'session.db')
    const mirrorMessage = join(result.mirrorDir!, 'db_storage', 'message', 'message_0.db')
    const sessionPage1 = readFileSync(mirrorSession).subarray(0, PAGE_SIZE)
    const messageBytes = readFileSync(mirrorMessage)
    const messagePage1 = messageBytes.subarray(0, PAGE_SIZE)
    const messagePage2 = messageBytes.subarray(PAGE_SIZE, PAGE_SIZE * 2)
    expect(verifyPageKey(sessionPage1, mirrorKey, ['passphrase']).mode).toBe('passphrase')
    expect(verifyPageKey(messagePage1, mirrorKey, ['passphrase']).mode).toBe('passphrase')
    expect(verifyPageKey(sessionPage1, mirrorKey, ['raw']).mode).toBeNull()
    const messageSalt = messagePage1.subarray(0, 16)
    const derivedMirrorKey = crypto.pbkdf2Sync(mirrorKey, messageSalt, 256000, 32, 'sha512')
    expectPageHmac(messagePage2, derivedMirrorKey, messageSalt, 2)

    const mirrorWal = readFileSync(`${mirrorMessage}-wal`)
    expect(mirrorWal.length).toBe(32 + 24 + PAGE_SIZE)
    const walHeader = mirrorWal.subarray(0, 32)
    const frame = mirrorWal.subarray(32)
    expect(walHeader.readUInt32BE(16)).toBe(0x5c5c5c5c)
    expect(frame.readUInt32BE(0)).toBe(2)
    expect(frame.readUInt32BE(4)).toBe(2)
    expect(frame.subarray(8, 16)).toEqual(walHeader.subarray(16, 24))
    const walHeaderSum = checksum(walHeader.subarray(0, 24), false)
    expect([walHeader.readUInt32BE(24), walHeader.readUInt32BE(28)]).toEqual(walHeaderSum)
    const frameSum = checksum(Buffer.concat([frame.subarray(0, 8), frame.subarray(24)]), false, walHeaderSum)
    expect([frame.readUInt32BE(16), frame.readUInt32BE(20)]).toEqual(frameSum)
    expectPageHmac(frame.subarray(24), derivedMirrorKey, messageSalt, 2)

    const afterHashes = [fixture.sessionPath, fixture.messagePath, fixture.walPath]
      .map((file) => crypto.createHash('sha256').update(readFileSync(file)).digest('hex'))
    expect(afterHashes).toEqual(sourceHashes)
  })

  it('refuses readiness when a required message shard key is missing', async () => {
    const fixture = makeAccount()
    const result = await createScannedDbMirror({
      accountDir: fixture.accountDir,
      keys: fixture.keys.filter((key) => key.id.startsWith('session/')),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('every message shard')
    expect(result.mirrorDir).toBeUndefined()
  })

  it('refuses a mirror when the session database is missing even if message keys exist', async () => {
    const fixture = makeAccount()
    rmSync(fixture.sessionPath, { force: true })

    const result = await createScannedDbMirror({
      accountDir: fixture.accountDir,
      keys: fixture.keys.filter((key) => key.id.startsWith('message/')),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('session/session.db was not found')
    expect(result.mirrorDir).toBeUndefined()
  })

  it('fails closed rather than preparing a mirror from a truncated DB list', async () => {
    root = mkdtempSync(join(tmpdir(), 'weport-scanned-db-limit-test-'))
    const accountDir = join(root, 'wxid_demo')
    const dbStorage = join(accountDir, 'db_storage')
    mkdirSync(dbStorage, { recursive: true })
    for (let index = 0; index < 401; index += 1) {
      writeFileSync(join(dbStorage, `shard_${index}.db`), Buffer.alloc(0))
    }

    const result = await createScannedDbMirror({ accountDir, keys: [] })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('安全上限 400')
    expect(result.mirrorDir).toBeUndefined()
  })

  it('rejects a tampered encrypted page instead of producing a mirror', async () => {
    const fixture = makeAccount()
    const bytes = readFileSync(fixture.messagePath)
    bytes[123] ^= 0xff
    writeFileSync(fixture.messagePath, bytes)
    const result = await createScannedDbMirror({ accountDir: fixture.accountDir, keys: fixture.keys })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('page 1 HMAC verification failed')
    expect(result.mirrorDir).toBeUndefined()
  })
})
