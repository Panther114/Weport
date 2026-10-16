import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'

const MAX_PACKED_INFO_BYTES = 64 * 1024
const MAX_PROTO_FIELDS = 256
const MAX_PROTO_FIELD_NUMBER = 0x1fffffff

/** Read WeChat's already-converted voice text. Never infer text from audio metadata. */
export function extractWechatVoiceTranscript(content: unknown): string {
  const xml = String(content || '')
  const block = /<voicetrans\b([^>]*)(?:\/>|>([\s\S]*?)<\/voicetrans\s*>)/i.exec(xml)
  const attribute = block && /\btranstext\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(block[1])
  const textNode = /<transtext\b[^>]*>([\s\S]*?)<\/transtext\s*>/i.exec(xml)
  const candidate = attribute?.[1] ?? attribute?.[2] ?? textNode?.[1] ??
    (block?.[2] && (/^\s*<!\[CDATA\[[\s\S]*?\]\]>\s*$/.test(block[2]) || !/<./.test(block[2])) ? block[2] : '')
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(String(candidate || ''))
  if (cdata) return cdata[1].trim()
  return String(candidate || '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|(quot|apos|lt|gt|amp));/gi,
    (entity, hex, decimal, named) => hex ? decodeCodePoint(entity, parseInt(hex, 16)) : decimal
      ? decodeCodePoint(entity, Number(decimal)) : ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' } as Record<string, string>)[named.toLowerCase()]).trim()
}

/**
 * Read the completed native transcript from packed_info_data.
 *
 * The known message shape is top-level field 5 containing a nested message:
 * nested field 1 is status (only 2 is complete), and nested field 2 is UTF-8
 * text. Unknown fields are skipped according to protobuf wire types. Any
 * malformed structure, ambiguous duplicate, unsupported source encoding,
 * invalid UTF-8, or non-final status fails closed to an empty string.
 */
export function extractWechatVoiceTranscriptFromPackedInfo(value: unknown): string {
  const bytes = packedInfoBytes(value)
  if (!bytes || bytes.length === 0 || bytes.length > MAX_PACKED_INFO_BYTES) return ''

  let transcriptPayload: Uint8Array | null = null
  let sawTranscriptField = false
  const validTopLevel = walkProtoFields(bytes, (fieldNumber, wireType, fieldValue) => {
    if (fieldNumber !== 5) return true
    if (wireType !== 2 || sawTranscriptField || !(fieldValue instanceof Uint8Array)) return false
    sawTranscriptField = true
    transcriptPayload = fieldValue
    return true
  })
  if (!validTopLevel || !sawTranscriptField || !transcriptPayload) return ''

  let status: bigint | null = null
  let textBytes: Uint8Array | null = null
  let sawStatus = false
  let sawText = false
  const validTranscript = walkProtoFields(transcriptPayload, (fieldNumber, wireType, fieldValue) => {
    if (fieldNumber === 1) {
      if (wireType !== 0 || sawStatus || typeof fieldValue !== 'bigint') return false
      sawStatus = true
      status = fieldValue
      return true
    }
    if (fieldNumber === 2) {
      if (wireType !== 2 || sawText || !(fieldValue instanceof Uint8Array)) return false
      sawText = true
      textBytes = fieldValue
    }
    return true
  })
  if (!validTranscript || !sawStatus || status !== 2n || !sawText || !textBytes) return ''

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(textBytes).trim()
    return text && !text.includes('\u0000') ? text : ''
  } catch {
    return ''
  }
}

type ProtoValue = bigint | Uint8Array | null

/** Bounded protobuf wire reader. It never allocates from an untrusted length. */
function walkProtoFields(
  bytes: Uint8Array,
  visit: (fieldNumber: number, wireType: number, value: ProtoValue) => boolean,
): boolean {
  let offset = 0
  let fields = 0
  while (offset < bytes.length) {
    if (++fields > MAX_PROTO_FIELDS) return false
    const key = readVarint(bytes, offset)
    if (!key) return false
    offset = key.nextOffset
    const fieldNumberBig = key.value >> 3n
    const wireType = Number(key.value & 7n)
    if (fieldNumberBig < 1n || fieldNumberBig > BigInt(MAX_PROTO_FIELD_NUMBER)) return false
    const fieldNumber = Number(fieldNumberBig)
    let value: ProtoValue = null

    if (wireType === 0) {
      const decoded = readVarint(bytes, offset)
      if (!decoded) return false
      offset = decoded.nextOffset
      value = decoded.value
    } else if (wireType === 1) {
      if (bytes.length - offset < 8) return false
      value = bytes.subarray(offset, offset + 8)
      offset += 8
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset)
      if (!length || length.value > BigInt(MAX_PACKED_INFO_BYTES)) return false
      offset = length.nextOffset
      const size = Number(length.value)
      if (!Number.isSafeInteger(size) || size > bytes.length - offset) return false
      value = bytes.subarray(offset, offset + size)
      offset += size
    } else if (wireType === 5) {
      if (bytes.length - offset < 4) return false
      value = bytes.subarray(offset, offset + 4)
      offset += 4
    } else {
      // Groups and reserved wire types are not part of the supported shape.
      return false
    }

    if (!visit(fieldNumber, wireType, value)) return false
  }
  return offset === bytes.length
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; nextOffset: number } | null {
  let value = 0n
  for (let index = 0; index < 10; index += 1) {
    const offset = start + index
    if (offset >= bytes.length) return null
    const byte = bytes[offset]
    if (index === 9 && byte > 1) return null // uint64 varints use at most one payload bit here
    value |= BigInt(byte & 0x7f) << BigInt(index * 7)
    if ((byte & 0x80) === 0) return { value, nextOffset: offset + 1 }
  }
  return null
}

function packedInfoBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.length <= MAX_PACKED_INFO_BYTES ? value : null
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_PACKED_INFO_BYTES) return null
    return new Uint8Array(value)
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_PACKED_INFO_BYTES) return null
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value) && value.length <= MAX_PACKED_INFO_BYTES && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value as number[])
  }
  if (value && typeof value === 'object') {
    const record = value as { type?: unknown; data?: unknown }
    if (record.type === 'Buffer' && Array.isArray(record.data)) return packedInfoBytes(record.data)
  }
  if (typeof value !== 'string') return null

  let encoded = value.trim()
  if (/^0x/i.test(encoded)) encoded = encoded.slice(2)
  if (!encoded || encoded.length > MAX_PACKED_INFO_BYTES * 2) return null
  if (/^(?:[0-9a-f]{2})+$/i.test(encoded)) return Buffer.from(encoded, 'hex')

  // Some WCDB bridges serialize blobs as canonical standard base64. Reject
  // permissive Buffer decodes and arbitrary printable strings.
  if (encoded.length > Math.ceil(MAX_PACKED_INFO_BYTES * 4 / 3) + 4 ||
      encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return null
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length === 0 || decoded.length > MAX_PACKED_INFO_BYTES || decoded.toString('base64') !== encoded) return null
  return decoded
}

function decodeCodePoint(entity: string, point: number): string {
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
    ? String.fromCodePoint(point) : entity
}
