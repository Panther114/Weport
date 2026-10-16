import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sourceFingerprint } from './export/sourceFingerprint'
import {
  deriveMacKey,
  deriveEncKeyFromPassphrase,
  listDbFiles,
  saltHexOf,
  SQLCIPHER_HMAC_OFFSET,
  SQLCIPHER_PAGE_SIZE,
  SQLCIPHER_RESERVE,
  verifyPageKey,
} from './wcdbPageKey'

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii')
const WAL_HEADER_BYTES = 32
const WAL_FRAME_HEADER_BYTES = 24
const DB_PAGE_SIZE = SQLCIPHER_PAGE_SIZE
const DB_PAGE_BYTES = DB_PAGE_SIZE - SQLCIPHER_RESERVE
const DEFAULT_YIELD_BYTES = 8 * 1024 * 1024

export interface ScannedDbKeyMaterial {
  id: string
  keyHex: string
}

export interface ScannedDbMirrorOptions {
  accountDir: string
  keys: ScannedDbKeyMaterial[]
  destinationRoot?: string
  cancel?: { cancelled: boolean }
  onProgress?: (progress: { message: string; ratio: number | null; pagesDone: number; pagesTotal: number }) => void
  yieldBytes?: number
  /**
   * Internal native-wrapper verification seam. Production uses decoded hex
   * passphrase bytes with SQLCipher derivation, verified by native session and
   * message queries. The explicit alternatives remain for compatibility probes.
   */
  targetKeyMode?: 'raw' | 'utf8-passphrase' | 'hex-bytes-passphrase'
  randomBytes?: (size: number) => Buffer
  now?: () => number
}

export interface ScannedDbMirrorResult {
  ok: boolean
  mirrorDir?: string
  mirrorKey?: string
  dbStorageDir?: string
  sourceFingerprint?: string
  convertedDbCount: number
  convertedPageCount: number
  walFrameCount: number
  skippedDbIds: string[]
  error?: string
}

interface KeySet {
  encKey: Buffer
  macKey: Buffer
  salt: Buffer
}

interface FileFingerprint {
  exists: boolean
  size: number
  mtimeMs: number
  ctimeMs: number
}

function fingerprint(filePath: string): FileFingerprint {
  try {
    const stat = fs.statSync(filePath)
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
  } catch {
    return { exists: false, size: 0, mtimeMs: 0, ctimeMs: 0 }
  }
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.exists === b.exists && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function keySetForRawKey(keyHex: string, salt: Buffer): KeySet {
  const normalized = String(keyHex || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error('per-DB key has an invalid shape')
  const key = Buffer.from(normalized, 'hex')
  return { encKey: key, macKey: deriveMacKey(key, salt), salt }
}

function keySetForMirrorKey(
  mirrorKeyHex: string,
  salt: Buffer,
  mode: NonNullable<ScannedDbMirrorOptions['targetKeyMode']>
): KeySet {
  if (mode === 'raw') return keySetForRawKey(mirrorKeyHex, salt)
  const normalized = String(mirrorKeyHex || '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error('mirror key has an invalid shape')
  const keyMaterial = mode === 'utf8-passphrase'
    ? Buffer.from(normalized, 'utf8')
    : Buffer.from(normalized, 'hex')
  const encKey = deriveEncKeyFromPassphrase(keyMaterial, salt)
  return { encKey, macKey: deriveMacKey(encKey, salt), salt }
}

function pageMacMatches(page: Buffer, keys: KeySet, pageNo: number): boolean {
  if (page.length !== DB_PAGE_SIZE || pageNo <= 0) return false
  const ivOffset = DB_PAGE_SIZE - SQLCIPHER_RESERVE
  const authenticated = pageNo === 1
    ? page.subarray(16, ivOffset + 16)
    : page.subarray(0, ivOffset + 16)
  const pageNumber = Buffer.alloc(4)
  pageNumber.writeUInt32LE(pageNo, 0)
  const actual = crypto.createHmac('sha512', keys.macKey).update(authenticated).update(pageNumber).digest()
  return crypto.timingSafeEqual(actual, page.subarray(SQLCIPHER_HMAC_OFFSET, DB_PAGE_SIZE))
}

function decryptSqlCipherPage(page: Buffer, keys: KeySet, pageNo: number): Buffer {
  if (!pageMacMatches(page, keys, pageNo)) throw new Error(`page authentication failed at page ${pageNo}`)
  const dataOffset = pageNo === 1 ? 16 : 0
  const encryptedBytes = page.subarray(dataOffset, DB_PAGE_BYTES)
  const iv = page.subarray(DB_PAGE_BYTES, DB_PAGE_BYTES + 16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', keys.encKey, iv)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(encryptedBytes), decipher.final()])
  if (decrypted.length !== encryptedBytes.length) throw new Error(`unexpected plaintext size at page ${pageNo}`)
  const out = Buffer.alloc(DB_PAGE_SIZE)
  if (pageNo === 1) {
    SQLITE_HEADER.copy(out, 0)
    decrypted.copy(out, 16)
  } else {
    decrypted.copy(out, 0)
  }
  return out
}

function encryptSqlCipherPage(plain: Buffer, keys: KeySet, pageNo: number, randomBytes: (size: number) => Buffer): Buffer {
  if (plain.length !== DB_PAGE_SIZE) throw new Error(`unexpected plaintext page size ${plain.length}`)
  if (pageNo === 1 && !plain.subarray(0, 16).equals(SQLITE_HEADER)) throw new Error('page 1 has no SQLite header')
  const out = Buffer.alloc(DB_PAGE_SIZE)
  if (pageNo === 1) keys.salt.copy(out, 0)
  const dataOffset = pageNo === 1 ? 16 : 0
  const encryptedBytes = plain.subarray(dataOffset, DB_PAGE_BYTES)
  if (encryptedBytes.length % 16 !== 0) throw new Error('SQLCipher page payload is not AES block aligned')
  const iv = randomBytes(16)
  if (iv.length !== 16) throw new Error('random source returned an invalid IV length')
  const cipher = crypto.createCipheriv('aes-256-cbc', keys.encKey, iv)
  cipher.setAutoPadding(false)
  Buffer.concat([cipher.update(encryptedBytes), cipher.final()]).copy(out, dataOffset)
  iv.copy(out, DB_PAGE_BYTES)
  const pageNumber = Buffer.alloc(4)
  pageNumber.writeUInt32LE(pageNo, 0)
  const mac = crypto.createHmac('sha512', keys.macKey)
    .update(pageNo === 1 ? out.subarray(16, DB_PAGE_BYTES + 16) : out.subarray(0, DB_PAGE_BYTES + 16))
    .update(pageNumber)
    .digest()
  mac.copy(out, SQLCIPHER_HMAC_OFFSET)
  return out
}

function readExactSync(fd: number, length: number, position: number): Buffer {
  const out = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = fs.readSync(fd, out, offset, length - offset, position + offset)
    if (count <= 0) throw new Error('source file changed while reading')
    offset += count
  }
  return out
}

function checksumBytes(bytes: Buffer, bigEndianInput: boolean, initial: [number, number]): [number, number] {
  if (bytes.length % 8 !== 0) throw new Error('WAL checksum input must be a multiple of 8 bytes')
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

function walChecksumMatches(headerOrFrame: Buffer, checksumOffset: number, bigEndianInput: boolean, prior: [number, number]): [number, number] | null {
  const next = checksumBytes(headerOrFrame.subarray(0, checksumOffset), bigEndianInput, prior)
  return next[0] === headerOrFrame.readUInt32BE(checksumOffset) && next[1] === headerOrFrame.readUInt32BE(checksumOffset + 4)
    ? next
    : null
}

function writeChecksum(target: Buffer, offset: number, checksum: [number, number]): void {
  target.writeUInt32BE(checksum[0], offset)
  target.writeUInt32BE(checksum[1], offset + 4)
}

async function writeAll(handle: fs.promises.FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, position + offset)
    if (result.bytesWritten <= 0) throw new Error('failed to write mirror data')
    offset += result.bytesWritten
  }
}

async function yieldToHost(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function readFilePage(handle: number, pageNo: number): Promise<Buffer> {
  const page = Buffer.alloc(DB_PAGE_SIZE)
  let offset = 0
  const position = (pageNo - 1) * DB_PAGE_SIZE
  while (offset < page.length) {
    const bytesRead = fs.readSync(handle, page, offset, page.length - offset, position + offset)
    if (bytesRead <= 0) throw new Error(`database ended before page ${pageNo}`)
    offset += bytesRead
  }
  return page
}

async function transformWal(args: {
  sourcePath: string
  outputPath: string
  sourceKeys: KeySet
  targetKeys: KeySet
  randomBytes: (size: number) => Buffer
  cancel?: { cancelled: boolean }
  onFrame?: () => Promise<void>
}): Promise<{ frames: number; committedFrames: number }> {
  const stat = fingerprint(args.sourcePath)
  if (!stat.exists || stat.size === 0) return { frames: 0, committedFrames: 0 }
  const inputFd = fs.openSync(args.sourcePath, 'r')
  let output: fs.promises.FileHandle | null = null
  try {
    if (stat.size < WAL_HEADER_BYTES) throw new Error('WAL header is truncated')
    const header = readExactSync(inputFd, WAL_HEADER_BYTES, 0)
    const magic = header.readUInt32BE(0)
    if (magic !== 0x377f0682 && magic !== 0x377f0683) throw new Error('WAL magic is invalid')
    const pageSize = header.readUInt32BE(8)
    if (pageSize !== DB_PAGE_SIZE) throw new Error(`WAL page size ${pageSize} is unsupported`)
    const bigEndianInput = magic === 0x377f0683
    let sourceChecksum = walChecksumMatches(header, 24, bigEndianInput, [0, 0])
    if (!sourceChecksum) throw new Error('WAL header checksum is invalid')

    const targetHeader = Buffer.from(header.subarray(0, WAL_HEADER_BYTES))
    const targetSalt = args.randomBytes(8)
    if (targetSalt.length !== 8) throw new Error('random source returned an invalid WAL salt')
    targetSalt.copy(targetHeader, 16)
    const targetBigEndianInput = bigEndianInput
    let targetChecksum = checksumBytes(targetHeader.subarray(0, 24), targetBigEndianInput, [0, 0])
    writeChecksum(targetHeader, 24, targetChecksum)

    output = await fs.promises.open(args.outputPath, 'w')
    await writeAll(output, targetHeader, 0)
    const frameSize = WAL_FRAME_HEADER_BYTES + DB_PAGE_SIZE
    const completeFrameCount = Math.floor((stat.size - WAL_HEADER_BYTES) / frameSize)
    let committedFrames = 0
    let validFrames = 0
    let sourceOffset = WAL_HEADER_BYTES
    let targetOffset = WAL_HEADER_BYTES

    for (let frameIndex = 0; frameIndex < completeFrameCount; frameIndex++) {
      if (args.cancel?.cancelled) throw new Error('mirror preparation cancelled')
      const frame = readExactSync(inputFd, frameSize, sourceOffset)
      const pageNo = frame.readUInt32BE(0)
      const dbSize = frame.readUInt32BE(4)
      if (pageNo === 0 || !frame.subarray(8, 16).equals(header.subarray(16, 24))) break
      const frameForChecksum = Buffer.concat([frame.subarray(0, 8), frame.subarray(WAL_FRAME_HEADER_BYTES)])
      const nextSourceChecksum = checksumBytes(frameForChecksum, bigEndianInput, sourceChecksum)
      if (nextSourceChecksum[0] !== frame.readUInt32BE(16) || nextSourceChecksum[1] !== frame.readUInt32BE(20)) break

      const encryptedPage = frame.subarray(WAL_FRAME_HEADER_BYTES)
      if (!pageMacMatches(encryptedPage, args.sourceKeys, pageNo)) {
        throw new Error(`committed WAL page authentication failed at frame ${frameIndex + 1}`)
      }
      const plainPage = decryptSqlCipherPage(encryptedPage, args.sourceKeys, pageNo)
      const rekeyedPage = encryptSqlCipherPage(plainPage, args.targetKeys, pageNo, args.randomBytes)
      const outputFrame = Buffer.alloc(frameSize)
      frame.copy(outputFrame, 0, 0, 8)
      targetSalt.copy(outputFrame, 8)
      rekeyedPage.copy(outputFrame, WAL_FRAME_HEADER_BYTES)
      const checksumInput = Buffer.concat([outputFrame.subarray(0, 8), outputFrame.subarray(WAL_FRAME_HEADER_BYTES)])
      targetChecksum = checksumBytes(checksumInput, targetBigEndianInput, targetChecksum)
      writeChecksum(outputFrame, 16, targetChecksum)
      await writeAll(output, outputFrame, targetOffset)
      sourceChecksum = nextSourceChecksum
      validFrames++
      if (dbSize > 0) committedFrames = validFrames
      sourceOffset += frameSize
      targetOffset += frameSize
      if (args.onFrame) await args.onFrame()
    }

    if (committedFrames === 0) {
      await output.close()
      output = null
      await fs.promises.rm(args.outputPath, { force: true })
      return { frames: validFrames, committedFrames: 0 }
    }
    await output.truncate(WAL_HEADER_BYTES + committedFrames * frameSize)
    await output.sync()
    return { frames: validFrames, committedFrames }
  } finally {
    if (output) await output.close().catch(() => undefined)
    fs.closeSync(inputFd)
  }
}

async function rekeyOneDatabase(args: {
  sourcePath: string
  outputPath: string
  keyHex: string
  mirrorKey: string
  mirrorKeyMode: NonNullable<ScannedDbMirrorOptions['targetKeyMode']>
  randomBytes: (size: number) => Buffer
  cancel?: { cancelled: boolean }
  yieldBytes: number
  onPage: () => Promise<void>
}): Promise<{ pages: number; walFrames: number }> {
  const sourceWalPath = `${args.sourcePath}-wal`
  const sourceBefore = { db: fingerprint(args.sourcePath), wal: fingerprint(sourceWalPath) }
  const sourceFd = fs.openSync(args.sourcePath, 'r')
  let output: fs.promises.FileHandle | null = null
  let outputWalPath = `${args.outputPath}-wal`
  try {
    if (!sourceBefore.db.exists || sourceBefore.db.size < DB_PAGE_SIZE || sourceBefore.db.size % DB_PAGE_SIZE !== 0) {
      throw new Error('database size is not a complete SQLCipher page sequence')
    }
    const page1 = readExactSync(sourceFd, DB_PAGE_SIZE, 0)
    const salt = Buffer.from(page1.subarray(0, 16))
    const sourceRawKey = String(args.keyHex || '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(sourceRawKey)) throw new Error('per-DB key has an invalid shape')
    const keyBytes = Buffer.from(sourceRawKey, 'hex')
    if (!verifyPageKey(page1, keyBytes, ['raw']).mode) throw new Error('page 1 HMAC verification failed')
    const sourceKeys = keySetForRawKey(sourceRawKey, salt)
    const targetKeys = keySetForMirrorKey(args.mirrorKey, salt, args.mirrorKeyMode)
    const pageCount = sourceBefore.db.size / DB_PAGE_SIZE
    output = await fs.promises.open(args.outputPath, 'w')
    let processedBytes = 0
    for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
      if (args.cancel?.cancelled) throw new Error('mirror preparation cancelled')
      const sourcePage = pageNo === 1 ? page1 : await readFilePage(sourceFd, pageNo)
      const plainPage = decryptSqlCipherPage(sourcePage, sourceKeys, pageNo)
      const targetPage = encryptSqlCipherPage(plainPage, targetKeys, pageNo, args.randomBytes)
      await writeAll(output, targetPage, (pageNo - 1) * DB_PAGE_SIZE)
      processedBytes += DB_PAGE_SIZE
      if (processedBytes >= args.yieldBytes) {
        processedBytes = 0
        await args.onPage()
      }
    }
    await output.sync()
    await output.close()
    output = null
    const walResult = await transformWal({
      sourcePath: sourceWalPath,
      outputPath: outputWalPath,
      sourceKeys,
      targetKeys,
      randomBytes: args.randomBytes,
      cancel: args.cancel,
      onFrame: args.onPage,
    })
    const sourceAfter = { db: fingerprint(args.sourcePath), wal: fingerprint(sourceWalPath) }
    if (!sameFingerprint(sourceBefore.db, sourceAfter.db) || !sameFingerprint(sourceBefore.wal, sourceAfter.wal)) {
      throw new Error('database changed during snapshot; retry after WeChat finishes its write')
    }
    return { pages: pageCount, walFrames: walResult.committedFrames }
  } catch (error) {
    if (output) await output.close().catch(() => undefined)
    await fs.promises.rm(args.outputPath, { force: true }).catch(() => undefined)
    await fs.promises.rm(outputWalPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    fs.closeSync(sourceFd)
  }
}

/**
 * Builds a private, disposable account mirror that can be opened by the existing
 * account-level WCDB API. Source databases and their WAL files are opened read-only;
 * all pages and committed WAL frames are authenticated before rekeying.
 */
export async function createScannedDbMirror(options: ScannedDbMirrorOptions): Promise<ScannedDbMirrorResult> {
  const startedAt = (options.now ?? Date.now)()
  const randomBytes = options.randomBytes ?? crypto.randomBytes
  const yieldBytes = Math.max(DB_PAGE_SIZE, options.yieldBytes ?? DEFAULT_YIELD_BYTES)
  const accountDir = path.resolve(String(options.accountDir || ''))
  const dbStorageDir = path.join(accountDir, 'db_storage')
  const skippedDbIds: string[] = []
  let convertedDbCount = 0
  let convertedPageCount = 0
  let walFrameCount = 0
  let mirrorDir = ''
  let pagesTotal = 0
  let pagesDone = 0
  const report = (message: string): void => {
    try {
      options.onProgress?.({
        message,
        ratio: pagesTotal > 0 ? Math.min(1, pagesDone / pagesTotal) : null,
        pagesDone,
        pagesTotal,
      })
    } catch { /* progress must not affect key processing */ }
  }

  try {
    if (!accountDir || !fs.existsSync(dbStorageDir)) throw new Error('account database directory is missing')
    const keyMap = new Map(options.keys.map((key) => [key.id.replace(/\\/g, '/'), key.keyHex]))
    const dbs = listDbFiles(dbStorageDir)
    const required = dbs.filter((db) =>
      db.kind === 'session' || db.kind.startsWith('message') || db.kind.startsWith('biz_message')
    )
    const session = required.find((db) => db.kind === 'session' && /(^|\/)session\.db$/i.test(db.id))
    const messageDbs = required.filter((db) => db.kind.startsWith('message') || db.kind.startsWith('biz_message'))
    if (!session) throw new Error('session/session.db was not found')
    if (messageDbs.length === 0) throw new Error('no message database shards were found')
    const missingRequired = required.filter((db) => !keyMap.has(db.id)).map((db) => db.id)
    if (missingRequired.length > 0) {
      throw new Error(`scanned keys do not cover the session database and every message shard (${missingRequired.length} missing)`)
    }
    const selected = dbs.filter((db) => keyMap.has(db.id))
    const requiredIds = new Set(required.map((db) => db.id))
    if (selected.length === 0) throw new Error('no verified per-database keys are available')
    const sourceFingerprintBefore = await sourceFingerprint(accountDir)
    if (!sourceFingerprintBefore) throw new Error('could not fingerprint source databases before mirroring')
    pagesTotal = selected.reduce((sum, db) => sum + Math.max(1, Math.ceil(fingerprint(db.path).size / DB_PAGE_SIZE)), 0)

    const parent = options.destinationRoot ? path.resolve(options.destinationRoot) : os.tmpdir()
    await fs.promises.mkdir(parent, { recursive: true })
    mirrorDir = await fs.promises.mkdtemp(path.join(parent, 'weport-scanned-db-'))
    const mirrorDbStorage = path.join(mirrorDir, 'db_storage')
    const mirrorKey = randomBytes(32).toString('hex')
    report(`正在为 ${selected.length} 个已验证数据库建立临时只读副本…`)

    for (const db of selected) {
      if (options.cancel?.cancelled) throw new Error('mirror preparation cancelled')
      const sourceKey = keyMap.get(db.id)!
      const outputPath = path.join(mirrorDbStorage, ...db.id.split('/'))
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
      let result: { pages: number; walFrames: number } | null = null
      let lastError: unknown = null
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          result = await rekeyOneDatabase({
            sourcePath: db.path,
            outputPath,
            keyHex: sourceKey,
            mirrorKey,
            // wcdb_open_account decodes its hex argument to passphrase bytes,
            // then derives per-database keys from each salt. Native queries
            // verified this mode; raw-key mirrors fail with -3.
            mirrorKeyMode: options.targetKeyMode ?? 'hex-bytes-passphrase',
            randomBytes,
            cancel: options.cancel,
            yieldBytes,
            onPage: async () => {
              pagesDone += Math.max(1, Math.floor(yieldBytes / DB_PAGE_SIZE))
              report(`正在校验并重建数据库（${pagesDone}/${pagesTotal} 页）…`)
              await yieldToHost()
            },
          })
        } catch (error) {
          lastError = error
          if (!(error instanceof Error) || !error.message.includes('changed during snapshot') || attempt > 0) break
          await fs.promises.rm(outputPath, { force: true }).catch(() => undefined)
          await fs.promises.rm(`${outputPath}-wal`, { force: true }).catch(() => undefined)
          await yieldToHost()
        }
      }
      if (!result) {
        if (!requiredIds.has(db.id)) {
          skippedDbIds.push(db.id)
          continue
        }
        throw new Error(`database ${db.id} could not be mirrored: ${lastError instanceof Error ? lastError.message : String(lastError || 'unknown error')}`)
      }
      convertedDbCount++
      convertedPageCount += result.pages
      walFrameCount += result.walFrames
      pagesDone += result.pages % Math.max(1, Math.floor(yieldBytes / DB_PAGE_SIZE))
      report(`已处理 ${convertedDbCount}/${selected.length} 个数据库…`)
    }

    if (convertedDbCount === 0) throw new Error('no database could be mirrored')
    const sourceFingerprintAfter = await sourceFingerprint(accountDir)
    if (!sourceFingerprintAfter || sourceFingerprintAfter !== sourceFingerprintBefore) {
      throw new Error('WeChat databases changed during mirror preparation; retry after writes finish')
    }
    report(`临时只读副本已就绪（${convertedDbCount} 个数据库，${Date.now() - startedAt} ms）`)
    return {
      ok: true,
      mirrorDir,
      mirrorKey,
      dbStorageDir: mirrorDbStorage,
      sourceFingerprint: sourceFingerprintAfter,
      convertedDbCount,
      convertedPageCount,
      walFrameCount,
      skippedDbIds,
    }
  } catch (error) {
    if (mirrorDir) await fs.promises.rm(mirrorDir, { recursive: true, force: true }).catch(() => undefined)
    return {
      ok: false,
      convertedDbCount,
      convertedPageCount,
      walFrameCount,
      skippedDbIds,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Cleanup helper for the disposable mirror created by {@link createScannedDbMirror}. */
export async function removeScannedDbMirror(mirrorDir: string): Promise<void> {
  if (!mirrorDir) return
  const resolved = path.resolve(mirrorDir)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('weport-scanned-db-')) {
    throw new Error('refusing to remove a path outside the Weport temporary mirror directory')
  }
  await fs.promises.rm(resolved, { recursive: true, force: true })
}
