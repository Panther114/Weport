'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const METADATA_PATH = path.join(PROJECT_ROOT, 'resources/wcdb/win32/x64/native-provenance.json')
const METADATA = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'))
const DEFAULT_DLL_PATH = path.join(PROJECT_ROOT, 'resources/wcdb/win32/x64/wcdb_api.dll')
const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00])

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function requireRange(buffer, offset, length, description) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Malformed PE: ${description} is outside the file`)
  }
}

function readU16(buffer, offset, description) {
  requireRange(buffer, offset, 2, description)
  return buffer.readUInt16LE(offset)
}

function readU32(buffer, offset, description) {
  requireRange(buffer, offset, 4, description)
  return buffer.readUInt32LE(offset)
}

function parsePeExports(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('PE input must be a Buffer')
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Malformed PE: missing DOS header')
  }

  const peOffset = readU32(buffer, 0x3c, 'PE header offset')
  requireRange(buffer, peOffset, 24, 'PE/COFF headers')
  if (!buffer.subarray(peOffset, peOffset + 4).equals(PE_SIGNATURE)) {
    throw new Error('Malformed PE: missing PE signature')
  }

  const machine = readU16(buffer, peOffset + 4, 'machine type')
  if (machine !== 0x8664) throw new Error(`Expected AMD64 WCDB DLL; PE machine is 0x${machine.toString(16)}`)

  const sectionCount = readU16(buffer, peOffset + 6, 'section count')
  const optionalHeaderSize = readU16(buffer, peOffset + 20, 'optional header size')
  const optionalOffset = peOffset + 24
  requireRange(buffer, optionalOffset, optionalHeaderSize, 'optional header')
  if (readU16(buffer, optionalOffset, 'optional header magic') !== 0x20b) {
    throw new Error('Expected PE32+ WCDB DLL')
  }

  const numberOfDirectories = readU32(buffer, optionalOffset + 108, 'data-directory count')
  if (numberOfDirectories < 1 || optionalHeaderSize < 120) {
    throw new Error('Malformed PE: export data directory is missing')
  }
  const exportRva = readU32(buffer, optionalOffset + 112, 'export directory RVA')
  const exportSize = readU32(buffer, optionalOffset + 116, 'export directory size')
  if (exportRva === 0 || exportSize < 40) throw new Error('Malformed PE: export directory is missing')

  const sectionTableOffset = optionalOffset + optionalHeaderSize
  requireRange(buffer, sectionTableOffset, sectionCount * 40, 'section table')
  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40
    sections.push({
      virtualSize: readU32(buffer, offset + 8, `section ${index} virtual size`),
      virtualAddress: readU32(buffer, offset + 12, `section ${index} virtual address`),
      rawSize: readU32(buffer, offset + 16, `section ${index} raw size`),
      rawOffset: readU32(buffer, offset + 20, `section ${index} raw offset`),
    })
  }

  function rvaToOffset(rva, length, description) {
    for (const section of sections) {
      const virtualSpan = Math.max(section.virtualSize, section.rawSize)
      const delta = rva - section.virtualAddress
      if (delta < 0 || delta >= virtualSpan) continue
      if (delta + length > section.rawSize) break
      const offset = section.rawOffset + delta
      requireRange(buffer, offset, length, description)
      return offset
    }
    throw new Error(`Malformed PE: ${description} RVA 0x${rva.toString(16)} is unmapped`)
  }

  const exportOffset = rvaToOffset(exportRva, 40, 'export directory')
  const nameCount = readU32(buffer, exportOffset + 24, 'export name count')
  const namesRva = readU32(buffer, exportOffset + 32, 'export names table RVA')
  if (nameCount > 65536) throw new Error(`Malformed PE: unreasonable export name count ${nameCount}`)

  const names = []
  for (let index = 0; index < nameCount; index += 1) {
    const namePointerOffset = rvaToOffset(namesRva + index * 4, 4, `export name pointer ${index}`)
    const nameRva = readU32(buffer, namePointerOffset, `export name pointer ${index}`)
    const nameOffset = rvaToOffset(nameRva, 1, `export name ${index}`)
    let end = nameOffset
    const maxEnd = Math.min(buffer.length, nameOffset + 4096)
    while (end < maxEnd && buffer[end] !== 0) end += 1
    if (end === maxEnd) throw new Error(`Malformed PE: export name ${index} is not terminated`)
    const name = buffer.toString('ascii', nameOffset, end)
    if (!name) throw new Error(`Malformed PE: export name ${index} is empty`)
    names.push(name)
  }

  const sortedNames = [...names].sort()
  if (new Set(sortedNames).size !== sortedNames.length) throw new Error('Malformed PE: duplicate export names')
  return {
    names: sortedNames,
    namesSha256: sha256(Buffer.from(sortedNames.join('\n'), 'utf8')),
  }
}

function parsePeImports(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('PE input must be a Buffer')
  const peOffset = readU32(buffer, 0x3c, 'PE header offset')
  requireRange(buffer, peOffset, 24, 'PE/COFF headers')
  if (!buffer.subarray(peOffset, peOffset + 4).equals(PE_SIGNATURE)) {
    throw new Error('Malformed PE: missing PE signature')
  }
  if (readU16(buffer, peOffset + 4, 'machine type') !== 0x8664) {
    throw new Error('Expected AMD64 WCDB DLL')
  }

  const sectionCount = readU16(buffer, peOffset + 6, 'section count')
  const optionalHeaderSize = readU16(buffer, peOffset + 20, 'optional header size')
  const optionalOffset = peOffset + 24
  requireRange(buffer, optionalOffset, optionalHeaderSize, 'optional header')
  if (readU16(buffer, optionalOffset, 'optional header magic') !== 0x20b || optionalHeaderSize < 128) {
    throw new Error('Expected PE32+ WCDB DLL with an import data directory')
  }

  const numberOfDirectories = readU32(buffer, optionalOffset + 108, 'data-directory count')
  if (numberOfDirectories < 2) throw new Error('Malformed PE: import data directory is missing')
  const importRva = readU32(buffer, optionalOffset + 120, 'import directory RVA')
  const importSize = readU32(buffer, optionalOffset + 124, 'import directory size')
  if (importRva === 0 && importSize === 0) {
    return { names: [], namesSha256: sha256(Buffer.alloc(0)) }
  }
  if (importRva === 0 || importSize < 20) throw new Error('Malformed PE: incomplete import directory')

  const sectionTableOffset = optionalOffset + optionalHeaderSize
  requireRange(buffer, sectionTableOffset, sectionCount * 40, 'section table')
  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40
    sections.push({
      virtualSize: readU32(buffer, offset + 8, `section ${index} virtual size`),
      virtualAddress: readU32(buffer, offset + 12, `section ${index} virtual address`),
      rawSize: readU32(buffer, offset + 16, `section ${index} raw size`),
      rawOffset: readU32(buffer, offset + 20, `section ${index} raw offset`),
    })
  }

  function rvaToOffset(rva, length, description) {
    for (const section of sections) {
      const virtualSpan = Math.max(section.virtualSize, section.rawSize)
      const delta = rva - section.virtualAddress
      if (delta < 0 || delta >= virtualSpan) continue
      if (delta + length > section.rawSize) break
      const offset = section.rawOffset + delta
      requireRange(buffer, offset, length, description)
      return offset
    }
    throw new Error(`Malformed PE: ${description} RVA 0x${rva.toString(16)} is unmapped`)
  }

  function readCStringAtRva(rva, description) {
    const offset = rvaToOffset(rva, 1, description)
    const endLimit = Math.min(buffer.length, offset + 4096)
    let end = offset
    while (end < endLimit && buffer[end] !== 0) end += 1
    if (end === endLimit) throw new Error(`Malformed PE: ${description} is not terminated`)
    const value = buffer.toString('ascii', offset, end)
    if (!value) throw new Error(`Malformed PE: ${description} is empty`)
    return value
  }

  const rows = []
  let foundTerminator = false
  for (let index = 0; index < Math.min(Math.floor(importSize / 20), 4096); index += 1) {
    const descriptorRva = importRva + index * 20
    const descriptorOffset = rvaToOffset(descriptorRva, 20, `import descriptor ${index}`)
    const originalThunkRva = readU32(buffer, descriptorOffset, `import descriptor ${index} lookup RVA`)
    const nameRva = readU32(buffer, descriptorOffset + 12, `import descriptor ${index} module RVA`)
    const firstThunkRva = readU32(buffer, descriptorOffset + 16, `import descriptor ${index} IAT RVA`)
    if (originalThunkRva === 0 && nameRva === 0 && firstThunkRva === 0) {
      foundTerminator = true
      break
    }
    if (nameRva === 0 || (originalThunkRva === 0 && firstThunkRva === 0)) {
      throw new Error(`Malformed PE: incomplete import descriptor ${index}`)
    }

    const moduleName = readCStringAtRva(nameRva, `import module ${index}`)
    const thunkRva = originalThunkRva || firstThunkRva
    let thunkTerminated = false
    for (let thunkIndex = 0; thunkIndex < 65536; thunkIndex += 1) {
      const thunkOffset = rvaToOffset(thunkRva + thunkIndex * 8, 8, `import thunk ${index}:${thunkIndex}`)
      const thunk = buffer.readBigUInt64LE(thunkOffset)
      if (thunk === 0n) {
        thunkTerminated = true
        break
      }
      let symbol
      if ((thunk & (1n << 63n)) !== 0n) {
        symbol = `#${String(thunk & 0xffffn)}`
      } else {
        if (thunk > 0xffffffffn) throw new Error(`Malformed PE: invalid import name RVA in ${moduleName}`)
        const hintOffset = rvaToOffset(Number(thunk), 2, `import hint ${index}:${thunkIndex}`)
        symbol = readCStringAtRva(Number(thunk) + 2, `import symbol ${index}:${thunkIndex}`)
        requireRange(buffer, hintOffset, 2, `import hint ${index}:${thunkIndex}`)
      }
      rows.push(`${moduleName}!${symbol}`)
    }
    if (!thunkTerminated) throw new Error(`Malformed PE: import thunk table ${index} is not terminated`)
  }
  if (!foundTerminator) throw new Error('Malformed PE: import descriptor table is not terminated')

  const names = rows.sort()
  if (new Set(names).size !== names.length) throw new Error('Malformed PE: duplicate imported symbols')
  return {
    names,
    namesSha256: sha256(Buffer.from(names.join('\n'), 'utf8')),
  }
}

function verifyExpectedSha256(actualSha256, policy = METADATA) {
  if (actualSha256 === policy.adaptation.expectedSha256) return

  const rejected = Object.entries(policy.knownRejectedSha256 || {})
    .find(([, digest]) => digest === actualSha256)
  if (rejected) {
    throw new Error(`Rejected known WCDB asset (${rejected[0]}): SHA-256 ${actualSha256}`)
  }

  throw new Error(`Unexpected WCDB asset SHA-256 ${actualSha256}; expected ${policy.adaptation.expectedSha256}`)
}

function validateNativeBinary(buffer, policy = METADATA) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Native WCDB asset must be a Buffer')
  if (buffer.length !== policy.size) {
    throw new Error(`Unexpected wcdb_api.dll size ${buffer.length}; expected ${policy.size}`)
  }

  for (const patch of policy.adaptation.patches) {
    const expected = Buffer.from(patch.expectedHex, 'hex')
    requireRange(buffer, patch.offset, expected.length, `guard at offset ${patch.offset}`)
    const actual = buffer.subarray(patch.offset, patch.offset + expected.length)
    if (!actual.equals(expected)) {
      throw new Error(
        `WCDB expiry guard mismatch at file offset ${patch.offset}: ` +
        `found ${actual.toString('hex')}, expected ${patch.expectedHex}`,
      )
    }
  }

  const exports = parsePeExports(buffer)
  if (exports.names.length !== policy.exportContract.count) {
    throw new Error(`WCDB export count changed: found ${exports.names.length}, expected ${policy.exportContract.count}`)
  }
  if (exports.namesSha256 !== policy.exportContract.namesSha256) {
    throw new Error(`WCDB export names changed: SHA-256 ${exports.namesSha256}`)
  }

  const imports = parsePeImports(buffer)
  if (imports.names.length !== policy.importContract.count) {
    throw new Error(`WCDB import count changed: found ${imports.names.length}, expected ${policy.importContract.count}`)
  }
  if (imports.namesSha256 !== policy.importContract.namesSha256) {
    throw new Error(`WCDB imported symbols changed: SHA-256 ${imports.namesSha256}`)
  }

  const actualSha256 = sha256(buffer)
  verifyExpectedSha256(actualSha256, policy)
  return {
    sha256: actualSha256,
    exportCount: exports.names.length,
    exportNamesSha256: exports.namesSha256,
    importCount: imports.names.length,
    importNamesSha256: imports.namesSha256,
  }
}

function findNativeDll(resourcePath) {
  const root = path.resolve(resourcePath)
  const candidates = []
  if (path.basename(root).toLowerCase() === 'wcdb_api.dll') candidates.push(root)
  else {
    candidates.push(
      root,
      path.join(root, 'resources/wcdb/win32/x64'),
      path.join(root, 'resources/resources/wcdb/win32/x64'),
      path.join(root, 'Contents/Resources/resources/wcdb/win32/x64'),
      path.join(root, 'Weport.app/Contents/Resources/resources/wcdb/win32/x64'),
    )
  }

  const seen = new Set()
  for (const candidate of candidates) {
    const file = path.basename(candidate).toLowerCase() === 'wcdb_api.dll'
      ? candidate
      : path.join(candidate, 'wcdb_api.dll')
    if (seen.has(file)) continue
    seen.add(file)
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  }
  throw new Error(`Could not find wcdb_api.dll in resource path: ${root}`)
}

function verifyNativeDllAtResourcePath(resourcePath) {
  const dllPath = findNativeDll(resourcePath)
  const result = validateNativeBinary(fs.readFileSync(dllPath))
  return { dllPath, ...result }
}

function parseArgs(argv) {
  if (argv.length === 0) return { resourcePath: DEFAULT_DLL_PATH }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  if (argv.length !== 2 || argv[0] !== '--resource-path') {
    throw new Error('Usage: node scripts/verify-native-assets.cjs [--resource-path <dll-or-resource-root>]')
  }
  return { resourcePath: argv[1] }
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      console.log('Usage: node scripts/verify-native-assets.cjs [--resource-path <dll-or-resource-root>]')
      return 0
    }
    const verified = verifyNativeDllAtResourcePath(options.resourcePath)
    console.log(
      `[native-assets] verified ${verified.dllPath} ` +
      `(sha256 ${verified.sha256}, ${verified.exportCount} exports, ${verified.importCount} imports)`,
    )
    return 0
  } catch (error) {
    console.error(`[native-assets] ${error && error.message ? error.message : error}`)
    return 1
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  DEFAULT_DLL_PATH,
  METADATA,
  findNativeDll,
  parsePeExports,
  parsePeImports,
  sha256,
  validateNativeBinary,
  verifyExpectedSha256,
  verifyNativeDllAtResourcePath,
}
