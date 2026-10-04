import { deflateRawSync, inflateRawSync } from 'zlib'

/**
 * 最小 ZIP 写入器（v1.2 §5 诊断包）。
 *
 * ## 为什么自己写而不是加依赖
 *
 * 诊断包只有 4 个文件（`diagnostics.json` / `checks.md` / 日志尾巴 / `config.redacted.json`），
 * 总量在几十 KB 量级。为此引入 `archiver` / `adm-zip` 会在**安装包**里多背一份
 * 依赖（electron-builder 会把它打进 app.asar），而本项目对包体与依赖面都有约束。
 * 仓库里唯一的归档工具是 `tar`（backupService 用），但 tar 不是用户双击能打开的
 * 格式 —— 诊断包是给用户发出去的，必须是 zip。
 *
 * 因此这里实现 **STORE + DEFLATE** 两种方法（方法 0/8）：
 *   - 纯函数、无 IO、无 Electron，可被单测逐字节覆盖；
 *   - 小文件（< 3 KB 或压缩后更大）直接 STORE —— 蹭压缩率不如让解压工具少一步；
 *   - 文件名为 UTF-8（通用标志位 bit 11），中文文件名在资源管理器里不会乱码；
 *   - 不写 Zip64（诊断包不会超过 4 GB / 65535 个条目，越界直接抛错而不是写坏包）。
 *
 * 校验和是自实现的 CRC-32（IEEE 802.3，与 `zlib.crc32` 同源）；用自实现而非
 * `zlib.crc32` 是因为后者在 Node 20.15 才出现，而 Electron 的 Node 版本随大版本浮动。
 */

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
/** UTF-8 文件名标志位（通用目的 bit 11）。 */
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** ZIP 2.0 = 支持 deflate。 */
const VERSION_NEEDED = 20
/** 单个条目最多 65535 字节的文件名。 */
const MAX_NAME_BYTES = 0xffff
/** deflate 后没有省下 8 字节就不值得压缩。 */
const COMPRESS_MARGIN = 8

let crcTable: Uint32Array | null = null

function crcTableOf(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  crcTable = table
  return table
}

/** CRC-32（IEEE）。与 `zlib.crc32` 同定义，自实现以便在旧 Node 上也能跑。 */
export function crc32(input: Buffer): number {
  const table = crcTableOf()
  let c = 0xffffffff
  for (let i = 0; i < input.length; i += 1) {
    c = table[(c ^ input[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS 日期/时间（ZIP 头用的本地时间，精度 2 秒）。 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff
  const day = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { time, date: day }
}

export interface ZipEntryInput {
  /** 包内路径。统一用 `/` 分隔；不以 `/` 开头。 */
  name: string
  data: Buffer | string
  /** 强制 STORE（已压缩过的内容再 deflate 只会变慢）。 */
  store?: boolean
}

/** zip 条目名归一化：统一 `/`、去掉空白与前导 `/`、去掉 `..` 段（防目录穿越）。 */
export function normalizeZipEntryName(name: string): string {
  const raw = String(name || '').replace(/\\/g, '/')
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
  return parts.join('/')
}

interface PreparedEntry {
  nameBytes: Buffer
  raw: Buffer
  data: Buffer
  method: number
  crc: number
  offset: number
}

/**
 * 生成一个完整的 ZIP 包（本地文件头 + 中央目录 + EOCD）。
 *
 * 抛错条件（宁可抛也不要写出一个打不开的包）：
 *   - 条目名为空；
 *   - 条目名超过 65535 字节；
 *   - 条目数超过 65535，或偏移量超过 4 GB（Zip64 未实现）。
 */
export function createZipBuffer(entries: ZipEntryInput[], options: { date?: Date } = {}): Buffer {
  if (entries.length > 0xffff) {
    throw new Error(`ZIP 条目过多（${entries.length}），未实现 Zip64`)
  }
  const date = options.date ?? new Date()
  const { time, date: dosDate } = dosDateTime(date)

  const prepared: PreparedEntry[] = []
  const chunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = normalizeZipEntryName(entry.name)
    if (!name) throw new Error('ZIP 条目名不能为空')
    const nameBytes = Buffer.from(name, 'utf8')
    if (nameBytes.length > MAX_NAME_BYTES) throw new Error(`ZIP 条目名过长：${name}`)
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const deflated = entry.store || raw.length < 64 ? null : deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated !== null && deflated.length + COMPRESS_MARGIN < raw.length
    const data = useDeflate ? (deflated as Buffer) : raw
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE

    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0)
    header.writeUInt16LE(VERSION_NEEDED, 4)
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(dosDate, 12)
    header.writeUInt32LE(crc32(raw), 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)

    chunks.push(header, nameBytes, data)
    prepared.push({ nameBytes, raw, data, method, crc: crc32(raw), offset })
    offset += header.length + nameBytes.length + data.length
  }

  const centralStart = offset
  for (const entry of prepared) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
    header.writeUInt16LE(VERSION_NEEDED, 4)
    header.writeUInt16LE(VERSION_NEEDED, 6)
    header.writeUInt16LE(FLAG_UTF8, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(dosDate, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.data.length, 20)
    header.writeUInt32LE(entry.raw.length, 24)
    header.writeUInt16LE(entry.nameBytes.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk start
    header.writeUInt16LE(0, 36) // internal attrs
    header.writeUInt32LE(0, 38) // external attrs
    header.writeUInt32LE(entry.offset, 42)
    chunks.push(header, entry.nameBytes)
    offset += header.length + entry.nameBytes.length
  }

  const centralSize = offset - centralStart
  if (offset > 0xffffffff) throw new Error('ZIP 超过 4 GB，未实现 Zip64')

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  chunks.push(eocd)

  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------------------
// 读取端：仅供单测与「包内自检」使用（应用不靠它读 zip，解压交给系统工具）
// ---------------------------------------------------------------------------

export interface ZipReadEntry {
  name: string
  data: Buffer
  method: number
}

/**
 * 解析一个由 {@link createZipBuffer} 生成的包。
 *
 * 这不是通用 zip 解析器：只认自家写出的、无 Zip64 / 无数据描述符 / 无加密的包。
 * 它存在的意义是让集成测试能**独立复算** CRC 与内容，而不是"写进去就算过了"。
 */
export function readZipBuffer(buffer: Buffer): ZipReadEntry[] {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocdOffset < 0) throw new Error('不是 ZIP：找不到 EOCD')
  const total = buffer.readUInt16LE(eocdOffset + 10)
  let cursor = buffer.readUInt32LE(eocdOffset + 16)
  const out: ZipReadEntry[] = []

  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIG) throw new Error('中央目录签名不对')
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const payload = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === METHOD_DEFLATE ? inflateRawSync(payload) : Buffer.from(payload)
    if (data.length !== uncompressedSize) throw new Error(`条目 ${name} 长度不符`)
    if (crc32(data) !== crc) throw new Error(`条目 ${name} CRC 不符`)
    out.push({ name, data, method })

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return out
}
