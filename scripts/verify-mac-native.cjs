'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const METADATA_PATH = path.join(PROJECT_ROOT, 'resources/wcdb/macos/universal/native-provenance.json')
const METADATA = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'))
const DEFAULT_DYLIB_PATH = path.join(PROJECT_ROOT, 'resources/wcdb/macos/universal/libwcdb_api.dylib')
const MH_MAGIC_64 = 0xfeedfacf
const CPU_TYPE_ARM64 = 0x0100000c
const MH_DYLIB = 6
const LC_SEGMENT_64 = 0x19
const LC_SYMTAB = 0x2
const LC_CODE_SIGNATURE = 0x1d
const LC_LOAD_DYLIB = 0xc
const N_STAB = 0xe0
const N_TYPE = 0x0e
const N_EXT = 0x01
const N_SECT = 0x0e

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function requireRange(buffer, offset, length, description) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Malformed Mach-O: ${description} is outside the file`)
  }
}

function readU64(buffer, offset, description) {
  requireRange(buffer, offset, 8, description)
  const value = buffer.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Malformed Mach-O: ${description} is too large`)
  return Number(value)
}

function fixedCString(buffer, offset, length, description) {
  requireRange(buffer, offset, length, description)
  const end = buffer.indexOf(0, offset)
  const boundedEnd = end < 0 || end > offset + length ? offset + length : end
  return buffer.toString('ascii', offset, boundedEnd)
}

function readCString(buffer, offset, limit, description) {
  requireRange(buffer, offset, 1, description)
  const end = buffer.indexOf(0, offset)
  if (end < 0 || end >= limit) throw new Error(`Malformed Mach-O: unterminated ${description}`)
  return buffer.toString('utf8', offset, end)
}

function parseMachO(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Mach-O input must be a Buffer')
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error('Expected a little-endian thin 64-bit Mach-O')
  }

  const cpuType = buffer.readUInt32LE(4)
  const fileType = buffer.readUInt32LE(12)
  const commandCount = buffer.readUInt32LE(16)
  const commandBytes = buffer.readUInt32LE(20)
  requireRange(buffer, 32, commandBytes, 'load command table')
  if (commandCount > 4096) throw new Error(`Malformed Mach-O: unreasonable load command count ${commandCount}`)

  let cursor = 32
  const segments = []
  const loadCommands = []
  let symbolTable = null
  let codeSignature = null

  for (let index = 0; index < commandCount; index += 1) {
    requireRange(buffer, cursor, 8, `load command ${index}`)
    const command = buffer.readUInt32LE(cursor)
    const commandSize = buffer.readUInt32LE(cursor + 4)
    if (commandSize < 8) throw new Error(`Malformed Mach-O: invalid load command ${index} size`)
    requireRange(buffer, cursor, commandSize, `load command ${index}`)
    const record = { command, offset: cursor, size: commandSize }
    loadCommands.push(record)

    if (command === LC_SEGMENT_64) {
      if (commandSize < 72) throw new Error(`Malformed Mach-O: short LC_SEGMENT_64 at 0x${cursor.toString(16)}`)
      const segmentName = fixedCString(buffer, cursor + 8, 16, 'segment name')
      const vmAddress = readU64(buffer, cursor + 24, 'segment vm address')
      const vmSize = readU64(buffer, cursor + 32, 'segment vm size')
      const fileOffset = readU64(buffer, cursor + 40, 'segment file offset')
      const fileSize = readU64(buffer, cursor + 48, 'segment file size')
      const sectionCount = buffer.readUInt32LE(cursor + 64)
      if (72 + sectionCount * 80 > commandSize) throw new Error(`Malformed Mach-O: short section table in ${segmentName}`)
      const sections = []
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
        const sectionOffset = cursor + 72 + sectionIndex * 80
        const sectionName = fixedCString(buffer, sectionOffset, 16, 'section name')
        const sectionSegment = fixedCString(buffer, sectionOffset + 16, 16, 'section segment name')
        const address = readU64(buffer, sectionOffset + 32, 'section address')
        const size = readU64(buffer, sectionOffset + 40, 'section size')
        const offset = buffer.readUInt32LE(sectionOffset + 48)
        const flags = buffer.readUInt32LE(sectionOffset + 64)
        const zeroFill = (flags & 0xff) === 1 || (flags & 0xff) === 0x0c || (flags & 0xff) === 0x12
        if (!zeroFill && size > 0) requireRange(buffer, offset, size, `${sectionSegment},${sectionName}`)
        sections.push({ name: sectionName, segment: sectionSegment, address, size, offset, flags, index: sectionIndex + 1 })
      }
      if (fileSize > 0) requireRange(buffer, fileOffset, fileSize, `${segmentName} file range`)
      segments.push({ name: segmentName, vmAddress, vmSize, fileOffset, fileSize, sections })
    } else if (command === LC_SYMTAB) {
      if (commandSize < 24) throw new Error('Malformed Mach-O: short LC_SYMTAB')
      symbolTable = {
        symbolOffset: buffer.readUInt32LE(cursor + 8),
        symbolCount: buffer.readUInt32LE(cursor + 12),
        stringOffset: buffer.readUInt32LE(cursor + 16),
        stringSize: buffer.readUInt32LE(cursor + 20),
      }
    } else if (command === LC_CODE_SIGNATURE) {
      if (commandSize < 16) throw new Error('Malformed Mach-O: short LC_CODE_SIGNATURE')
      codeSignature = {
        offset: buffer.readUInt32LE(cursor + 8),
        size: buffer.readUInt32LE(cursor + 12),
        commandOffset: cursor,
      }
      if (codeSignature.size > 0) requireRange(buffer, codeSignature.offset, codeSignature.size, 'code signature blob')
    } else if (command === LC_LOAD_DYLIB) {
      if (commandSize < 24) throw new Error('Malformed Mach-O: short LC_LOAD_DYLIB')
      record.nameOffset = buffer.readUInt32LE(cursor + 8)
      if (record.nameOffset < 24 || record.nameOffset >= commandSize) {
        throw new Error(`Malformed Mach-O: invalid dylib name offset at 0x${cursor.toString(16)}`)
      }
      record.name = readCString(buffer, cursor + record.nameOffset, cursor + commandSize, 'dylib name')
    }

    cursor += commandSize
  }
  if (cursor > 32 + commandBytes) throw new Error('Malformed Mach-O: load commands exceed sizeofcmds')

  const symbols = []
  if (symbolTable) {
    if (symbolTable.symbolCount > 1_000_000) throw new Error('Malformed Mach-O: unreasonable symbol count')
    requireRange(buffer, symbolTable.symbolOffset, symbolTable.symbolCount * 16, 'nlist_64 table')
    requireRange(buffer, symbolTable.stringOffset, symbolTable.stringSize, 'symbol string table')
    for (let index = 0; index < symbolTable.symbolCount; index += 1) {
      const offset = symbolTable.symbolOffset + index * 16
      const stringIndex = buffer.readUInt32LE(offset)
      const type = buffer.readUInt8(offset + 4)
      const sectionIndex = buffer.readUInt8(offset + 5)
      const value = readU64(buffer, offset + 8, `symbol ${index} value`)
      if (stringIndex === 0 || stringIndex >= symbolTable.stringSize) continue
      const name = readCString(buffer, symbolTable.stringOffset + stringIndex, symbolTable.stringOffset + symbolTable.stringSize, `symbol ${index} name`)
      symbols.push({ name, type, sectionIndex, value })
    }
  }

  return { cpuType, fileType, segments, loadCommands, codeSignature, symbols }
}

function findTextSection(macho) {
  const matches = macho.segments.flatMap((segment) =>
    segment.sections.filter((section) => section.segment === '__TEXT' && section.name === '__text'))
  if (matches.length !== 1) throw new Error(`Expected one __TEXT,__text section; found ${matches.length}`)
  return matches[0]
}

function validateLayout(buffer, policy = METADATA) {
  const macho = parseMachO(buffer)
  const expectedCpu = Number.parseInt(policy.macho.cpuType, 16)
  if (macho.cpuType !== expectedCpu) throw new Error(`Expected ARM64 Mach-O CPU type 0x${expectedCpu.toString(16)}, found 0x${macho.cpuType.toString(16)}`)
  if (macho.fileType !== policy.macho.fileType) throw new Error(`Expected Mach-O dylib file type ${policy.macho.fileType}, found ${macho.fileType}`)

  const section = findTextSection(macho)
  const expected = policy.macho.textSection
  if (section.address !== Number.parseInt(expected.address, 16)) {
    throw new Error(`Unexpected __TEXT,__text address 0x${section.address.toString(16)}`)
  }
  if (section.offset !== expected.fileOffset || section.size !== expected.size) {
    throw new Error(
      `Unexpected __TEXT,__text layout: file offset 0x${section.offset.toString(16)}, size 0x${section.size.toString(16)}`,
    )
  }

  for (const guard of policy.macho.symbolGuards) {
    const symbol = macho.symbols.find((item) =>
      item.name === guard.name && (item.type & N_STAB) === 0 &&
      (item.type & N_TYPE) === N_SECT && (item.type & N_EXT) !== 0)
    if (!symbol) throw new Error(`Mach-O symbol guard missing: ${guard.name}`)
    if (symbol.value !== Number.parseInt(guard.address, 16) || symbol.sectionIndex !== guard.sectionIndex) {
      throw new Error(`Mach-O symbol guard mismatch for ${guard.name}: address=0x${symbol.value.toString(16)} section=${symbol.sectionIndex}`)
    }
    if (symbol.value < section.address || symbol.value >= section.address + section.size) {
      throw new Error(`Mach-O symbol ${guard.name} is outside __TEXT,__text`)
    }
  }

  const host = policy.adaptation.hostGuard
  const hostBytes = Buffer.from(host.expectedHex, 'hex')
  requireRange(buffer, host.offset, hostBytes.length, 'host guard instruction')
  if (!buffer.subarray(host.offset, host.offset + hostBytes.length).equals(hostBytes)) {
    throw new Error(`WCDB host guard mismatch at file offset 0x${host.offset.toString(16)}`)
  }
  return { macho, section }
}

function verifyPatchBytes(buffer, mode, policy = METADATA) {
  for (const patch of policy.adaptation.patches) {
    const expectedHex = mode === 'source' ? patch.sourceHex : patch.expectedHex
    const expected = Buffer.from(expectedHex, 'hex')
    requireRange(buffer, patch.offset, expected.length, `${patch.symbol} expiry branch`)
    const actual = buffer.subarray(patch.offset, patch.offset + expected.length)
    if (!actual.equals(expected)) {
      const label = mode === 'source' ? 'source expiry branch' : 'expiry branch'
      throw new Error(`WCDB ${label} mismatch for ${patch.symbol} at file offset 0x${patch.offset.toString(16)}: found ${actual.toString('hex')}, expected ${expectedHex}`)
    }
  }
}

function validateSourceBinary(buffer, policy = METADATA) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Native WCDB asset must be a Buffer')
  if (buffer.length !== policy.source.size) throw new Error(`Unexpected source dylib size ${buffer.length}; expected ${policy.source.size}`)
  const actualSha = sha256(buffer)
  if (actualSha !== policy.source.sha256) throw new Error(`Unknown macOS WCDB source SHA-256 ${actualSha}; expected ${policy.source.sha256}`)
  const { section } = validateLayout(buffer, policy)
  const textSha = sha256(buffer.subarray(section.offset, section.offset + section.size))
  if (textSha !== policy.macho.textSection.sourceSha256) {
    throw new Error(`Source __TEXT,__text SHA-256 mismatch: ${textSha}`)
  }
  verifyPatchBytes(buffer, 'source', policy)
  return { sha256: actualSha, textSha256: textSha, architecture: 'arm64' }
}

/** Validate the locally patched dylib before install_name_tool / code signing. */
function validatePatchedBinary(buffer, policy = METADATA) {
  const result = validatePackagedNativeBinary(buffer, policy)
  const actualSha = sha256(buffer)
  if (actualSha !== policy.adaptation.expectedSha256) {
    throw new Error(`Unexpected patched dylib SHA-256 ${actualSha}; expected ${policy.adaptation.expectedSha256}`)
  }
  return { ...result, sha256: actualSha }
}

/** Validate the app-bundle copy. Linkage and code-signature bytes may differ. */
function validatePackagedNativeBinary(buffer, policy = METADATA) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Packaged WCDB asset must be a Buffer')
  const { section } = validateLayout(buffer, policy)
  verifyPatchBytes(buffer, 'packaged', policy)
  const textSha = sha256(buffer.subarray(section.offset, section.offset + section.size))
  if (textSha !== policy.adaptation.expectedTextSha256) {
    throw new Error(`Packaged __TEXT,__text SHA-256 mismatch: ${textSha}; expected ${policy.adaptation.expectedTextSha256}`)
  }
  return { architecture: 'arm64', textOffset: section.offset, textSize: section.size, textSha256: textSha }
}

/** Pure in-memory adaptation. It never writes the returned Buffer to disk. */
function repairNativeBinary(sourceBuffer, policy = METADATA) {
  validateSourceBinary(sourceBuffer, policy)
  const repaired = Buffer.from(sourceBuffer)
  const allowed = new Uint8Array(sourceBuffer.length)
  for (const patch of policy.adaptation.patches) {
    const expected = Buffer.from(patch.expectedHex, 'hex')
    expected.copy(repaired, patch.offset)
    allowed.fill(1, patch.offset, patch.offset + expected.length)
  }

  for (let offset = 0; offset < sourceBuffer.length; offset += 1) {
    if (sourceBuffer[offset] !== repaired[offset] && allowed[offset] !== 1) {
      throw new Error(`Repair changed an unapproved byte at file offset 0x${offset.toString(16)}`)
    }
  }

  const actualSha = sha256(repaired)
  if (actualSha !== policy.adaptation.expectedSha256) {
    throw new Error(`Repair output SHA-256 ${actualSha} does not match ${policy.adaptation.expectedSha256}`)
  }
  validatePatchedBinary(repaired, policy)
  return repaired
}

function findNativeDylib(resourcePath) {
  const root = path.resolve(resourcePath)
  const name = 'libwcdb_api.dylib'
  const candidates = [
    path.basename(root).toLowerCase() === name.toLowerCase() ? root : null,
    path.join(root, 'resources/wcdb/macos/universal', name),
    path.join(root, 'resources/resources/wcdb/macos/universal', name),
    path.join(root, 'Contents/Resources/resources/wcdb/macos/universal', name),
    path.join(root, 'Weport.app/Contents/Resources/resources/wcdb/macos/universal', name),
    path.join(root, 'mac-arm64/Weport.app/Contents/Resources/resources/wcdb/macos/universal', name),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`Could not find ${name} in resource path: ${root}`)
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  if (argv.length === 0) return { mode: 'patched', resourcePath: DEFAULT_DYLIB_PATH }
  if (argv.length === 2 && ['--source', '--patched', '--packaged'].includes(argv[0])) {
    return { mode: argv[0].slice(2), resourcePath: argv[1] }
  }
  throw new Error('Usage: node scripts/verify-mac-native.cjs [--source|--patched|--packaged <dylib-or-resource-root>]')
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      console.log('Usage: node scripts/verify-mac-native.cjs [--source|--patched|--packaged <dylib-or-resource-root>]')
      console.log('--source verifies only the exact upstream bytes and calculates the patch in memory; it never writes a file.')
      return 0
    }
    const dylibPath = findNativeDylib(options.resourcePath)
    const buffer = fs.readFileSync(dylibPath)
    if (options.mode === 'source') {
      const verified = validateSourceBinary(buffer)
      const repaired = repairNativeBinary(buffer)
      console.log(`[mac-native] verified exact WeFlow source ${dylibPath} (sha256 ${verified.sha256})`)
      console.log(`[mac-native] in-memory repair sha256=${sha256(repaired)} text_sha256=${METADATA.adaptation.expectedTextSha256}; no file written`)
      return 0
    }
    const verified = options.mode === 'packaged'
      ? validatePackagedNativeBinary(buffer)
      : validatePatchedBinary(buffer)
    console.log(`[mac-native] verified ${options.mode} ARM64 WCDB ${dylibPath} (__TEXT,__text sha256 ${verified.textSha256})`)
    return 0
  } catch (error) {
    console.error(`[mac-native] ${error && error.message ? error.message : error}`)
    return 1
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  DEFAULT_DYLIB_PATH,
  METADATA,
  findNativeDylib,
  parseMachO,
  repairNativeBinary,
  sha256,
  validatePackagedNativeBinary,
  validatePatchedBinary,
  validateSourceBinary,
}
