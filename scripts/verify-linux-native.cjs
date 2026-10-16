'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const METADATA_PATH = path.join(PROJECT_ROOT, 'resources/wcdb/linux/x64/native-provenance.json')
const METADATA = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'))
const DEFAULT_SO_PATH = path.join(PROJECT_ROOT, 'resources/wcdb/linux/x64/libwcdb_api.so')

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}${String.fromCharCode(0)}`, 'utf8')
  return createHash('sha1').update(header).update(buffer).digest('hex')
}

function verifyElf64X64(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Linux WCDB asset must be a Buffer')
  if (buffer.length < 20 || buffer.subarray(0, 4).toString('hex') !== '7f454c46') {
    throw new Error('Expected an ELF shared library')
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error('Expected a little-endian ELF64 binary')
  }
  const fileType = buffer.readUInt16LE(16)
  const machine = buffer.readUInt16LE(18)
  if (fileType !== METADATA.elf.fileType) {
    throw new Error(`Expected ELF shared object type ${METADATA.elf.fileType}, found ${fileType}`)
  }
  if (machine !== Number.parseInt(METADATA.elf.machine, 16)) {
    throw new Error(`Expected x86-64 ELF machine 0x${METADATA.elf.machine}, found 0x${machine.toString(16)}`)
  }
  return { architecture: 'x86_64', fileType }
}

function verifyBytes(buffer, offset, expectedHex, description) {
  const expected = Buffer.from(expectedHex, 'hex')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + expected.length > buffer.length) {
    throw new Error(`Malformed Linux WCDB asset: ${description} is outside the file`)
  }
  const actual = buffer.subarray(offset, offset + expected.length)
  if (!actual.equals(expected)) {
    throw new Error(
      `Linux WCDB ${description} mismatch at file offset 0x${offset.toString(16)}: ` +
      `found ${actual.toString('hex')}, expected ${expectedHex}`,
    )
  }
}

function verifyHostGuard(buffer, policy = METADATA) {
  const guard = policy.adaptation.hostGuard
  const acceptedNames = Buffer.from(`${guard.acceptedProcessNames.join('\0')}\0`, 'ascii')
  verifyBytes(buffer, Number.parseInt(guard.acceptedNamesOffset, 16), acceptedNames.toString('hex'), 'host-name whitelist')
  verifyBytes(buffer, Number.parseInt(guard.poisonReturn.offset, 16), guard.poisonReturn.expectedHex, 'host-name failure return')
}

function verifyPatchBytes(buffer, mode, policy = METADATA) {
  for (const patch of policy.adaptation.patches) {
    const expectedHex = mode === 'source' ? patch.sourceHex : patch.expectedHex
    verifyBytes(buffer, patch.offset, expectedHex, `${mode === 'source' ? 'source ' : ''}expiry branch for ${patch.symbol}`)
  }
}

function validateSourceBinary(buffer, policy = METADATA) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Linux WCDB asset must be a Buffer')
  if (buffer.length !== policy.source.size) {
    throw new Error(`Unexpected source libwcdb_api.so size ${buffer.length}; expected ${policy.source.size}`)
  }
  const actualSha = sha256(buffer)
  if (actualSha !== policy.source.sha256) {
    throw new Error(`Unknown Linux WCDB source SHA-256 ${actualSha}; expected ${policy.source.sha256}`)
  }
  const actualBlob = gitBlobSha1(buffer)
  if (actualBlob !== policy.source.gitBlob) {
    throw new Error(`Linux WCDB source Git blob mismatch ${actualBlob}; expected ${policy.source.gitBlob}`)
  }
  const elf = verifyElf64X64(buffer)
  verifyPatchBytes(buffer, 'source', policy)
  verifyHostGuard(buffer, policy)
  return { sha256: actualSha, gitBlob: actualBlob, ...elf }
}

function validatePatchedBinary(buffer, policy = METADATA) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Linux WCDB asset must be a Buffer')
  if (buffer.length !== policy.source.size) {
    throw new Error(`Unexpected patched libwcdb_api.so size ${buffer.length}; expected ${policy.source.size}`)
  }
  const elf = verifyElf64X64(buffer)
  verifyPatchBytes(buffer, 'patched', policy)
  verifyHostGuard(buffer, policy)
  const actualSha = sha256(buffer)
  if (actualSha !== policy.adaptation.expectedSha256) {
    throw new Error(`Unexpected patched Linux WCDB SHA-256 ${actualSha}; expected ${policy.adaptation.expectedSha256}`)
  }
  return { sha256: actualSha, ...elf }
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

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  if (argv.length === 0) return { mode: 'patched', binaryPath: DEFAULT_SO_PATH }
  if (argv.length === 2 && argv[0] === '--source') return { mode: 'source', binaryPath: argv[1] }
  if (argv.length === 2 && argv[0] === '--patched') return { mode: 'patched', binaryPath: argv[1] }
  throw new Error('Usage: node scripts/verify-linux-native.cjs [--source|--patched <shared-library>]')
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      console.log('Usage: node scripts/verify-linux-native.cjs [--source|--patched <shared-library>]')
      console.log('--source verifies the exact upstream bytes and calculates the adaptation in memory; no file is written.')
      return 0
    }
    const buffer = fs.readFileSync(options.binaryPath)
    if (options.mode === 'source') {
      const verified = validateSourceBinary(buffer)
      const repaired = repairNativeBinary(buffer)
      console.log(`[linux-native] verified exact WeFlow source ${options.binaryPath} (sha256 ${verified.sha256}, git blob ${verified.gitBlob})`)
      console.log(`[linux-native] in-memory repair sha256=${sha256(repaired)}; no file written`)
      return 0
    }
    const verified = validatePatchedBinary(buffer)
    console.log(`[linux-native] verified patched Linux WCDB ${options.binaryPath} (sha256 ${verified.sha256}, x86_64)`)
    return 0
  } catch (error) {
    console.error(`[linux-native] ${error && error.message ? error.message : error}`)
    return 1
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  DEFAULT_SO_PATH,
  METADATA,
  gitBlobSha1,
  repairNativeBinary,
  sha256,
  validatePatchedBinary,
  validateSourceBinary,
  verifyElf64X64,
}
