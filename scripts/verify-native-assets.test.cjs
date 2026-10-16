'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const afterPack = require('./after-pack.cjs')
const { Arch } = require('electron-builder')

const {
  DEFAULT_DLL_PATH,
  METADATA,
  findNativeDll,
  parsePeExports,
  sha256,
  validateNativeBinary,
  verifyExpectedSha256,
} = require('./verify-native-assets.cjs')
const { repairNativeBinary } = require('./repair-native-assets.cjs')

const FIXTURE_PATCHES = [
  { offset: 0x800, sourceHex: '7e0a', expectedHex: 'eb0a' },
  { offset: 0x900, sourceHex: '0f8e30010000', expectedHex: 'e93101000090' },
]

function makePeFixture({ firstGuard = 'eb0a', secondGuard = 'e93101000090' } = {}) {
  const buffer = Buffer.alloc(0x1000)
  const peOffset = 0x80
  const optionalOffset = peOffset + 24
  const sectionOffset = optionalOffset + 240
  const exportOffset = 0x200
  const firstNameOffset = 0x280
  const secondNameOffset = 0x290

  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(peOffset, 0x3c)
  buffer.write('PE\0\0', peOffset, 'binary')
  buffer.writeUInt16LE(0x8664, peOffset + 4)
  buffer.writeUInt16LE(1, peOffset + 6)
  buffer.writeUInt16LE(240, peOffset + 20)
  buffer.writeUInt16LE(0x20b, optionalOffset)
  buffer.writeUInt32LE(16, optionalOffset + 108)
  buffer.writeUInt32LE(0x1000, optionalOffset + 112)
  buffer.writeUInt32LE(0x100, optionalOffset + 116)
  buffer.writeUInt32LE(0x1100, optionalOffset + 120)
  buffer.writeUInt32LE(0x28, optionalOffset + 124)

  buffer.writeUInt32LE(0x400, sectionOffset + 8)
  buffer.writeUInt32LE(0x1000, sectionOffset + 12)
  buffer.writeUInt32LE(0x400, sectionOffset + 16)
  buffer.writeUInt32LE(exportOffset, sectionOffset + 20)

  buffer.writeUInt32LE(2, exportOffset + 24)
  buffer.writeUInt32LE(0x1040, exportOffset + 32)
  buffer.writeUInt32LE(0x1080, exportOffset + 0x40)
  buffer.writeUInt32LE(0x1090, exportOffset + 0x44)
  buffer.write('wcdb_init\0', firstNameOffset, 'ascii')
  buffer.write('wcdb_shutdown\0', secondNameOffset, 'ascii')

  buffer.writeUInt32LE(0x1140, 0x300)
  buffer.writeUInt32LE(0x1160, 0x30c)
  buffer.writeUInt32LE(0x1140, 0x310)
  buffer.writeBigUInt64LE(0x1180n, 0x340)
  buffer.write('KERNEL32.dll\0', 0x360, 'ascii')
  buffer.writeUInt16LE(0, 0x380)
  buffer.write('CreateFileW\0', 0x382, 'ascii')

  Buffer.from(firstGuard, 'hex').copy(buffer, FIXTURE_PATCHES[0].offset)
  Buffer.from(secondGuard, 'hex').copy(buffer, FIXTURE_PATCHES[1].offset)
  return buffer
}

function exportContract(buffer) {
  const exports = parsePeExports(buffer)
  return { count: exports.names.length, namesSha256: exports.namesSha256 }
}

function importContract(buffer) {
  const imports = require('./verify-native-assets.cjs').parsePeImports(buffer)
  return { count: imports.names.length, namesSha256: imports.namesSha256 }
}

function fixturePolicy(buffer, expectedBuffer = buffer) {
  return {
    size: buffer.length,
    source: { sha256: sha256(buffer) },
    adaptation: {
      expectedSha256: sha256(expectedBuffer),
      patches: FIXTURE_PATCHES,
    },
    exportContract: exportContract(expectedBuffer),
    importContract: importContract(expectedBuffer),
    knownRejectedSha256: {},
  }
}

test('canonical Win32 x64 wcdb_api.dll matches the recorded guards, exports and hash', () => {
  const result = validateNativeBinary(fs.readFileSync(DEFAULT_DLL_PATH))
  assert.equal(result.sha256, METADATA.adaptation.expectedSha256)
  assert.equal(result.exportCount, 112)
  assert.equal(result.exportNamesSha256, METADATA.exportContract.namesSha256)
  assert.equal(result.importCount, 417)
  assert.equal(result.importNamesSha256, METADATA.importContract.namesSha256)
})

test('rejects the expired WeFlow binary and the community 2038-extension hash', () => {
  assert.throws(
    () => verifyExpectedSha256(METADATA.knownRejectedSha256.expiredWeFlowAsset),
    /Rejected known WCDB asset \(expiredWeFlowAsset\)/,
  )
  assert.throws(
    () => verifyExpectedSha256(METADATA.knownRejectedSha256.community2038Extension),
    /Rejected known WCDB asset \(community2038Extension\)/,
  )
})

test('rejects an expired branch and a 2038-style branch extension', () => {
  const accepted = makePeFixture()
  const policy = fixturePolicy(accepted)

  const expired = makePeFixture({ firstGuard: '7e0a' })
  assert.throws(() => validateNativeBinary(expired, policy), /expiry guard mismatch at file offset 2048/)

  const extended = makePeFixture({ secondGuard: '0f8e30010000' })
  assert.throws(() => validateNativeBinary(extended, policy), /expiry guard mismatch at file offset 2304/)
})

test('rejects unknown mutations and changed exports even when their hash is supplied', () => {
  const accepted = makePeFixture()
  const policy = fixturePolicy(accepted)

  const mutated = Buffer.from(accepted)
  mutated[0xf00] = 0x01
  assert.throws(() => validateNativeBinary(mutated, policy), /Unexpected WCDB asset SHA-256/)

  const changedExports = Buffer.from(accepted)
  changedExports[0x29b] = 'm'.charCodeAt(0)
  const exportChangedPolicy = {
    ...policy,
    adaptation: { ...policy.adaptation, expectedSha256: sha256(changedExports) },
  }
  assert.throws(() => validateNativeBinary(changedExports, exportChangedPolicy), /WCDB export names changed/)

  const changedImports = Buffer.from(accepted)
  changedImports[0x38c] = 'X'.charCodeAt(0)
  const importChangedPolicy = {
    ...policy,
    adaptation: { ...policy.adaptation, expectedSha256: sha256(changedImports) },
  }
  assert.throws(() => validateNativeBinary(changedImports, importChangedPolicy), /WCDB imported symbols changed/)
})

test('repairs only an exact source hash and produces the deterministic expected output', () => {
  const source = makePeFixture({ firstGuard: '7e0a', secondGuard: '0f8e30010000' })
  const expected = makePeFixture()
  const policy = fixturePolicy(source, expected)
  const repaired = repairNativeBinary(source, policy)

  assert.deepEqual(repaired, expected)
  assert.equal(sha256(repaired), policy.adaptation.expectedSha256)
  assert.throws(() => repairNativeBinary(Buffer.from('not the recorded source')), /unexpected wcdb_api\.dll size/)

  const unknown = Buffer.from(source)
  unknown[0xf00] = 1
  assert.throws(() => repairNativeBinary(unknown, policy), /unknown wcdb_api\.dll SHA-256/)
})

test('locates assets inside a packaged resource root', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-native-gate-'))
  try {
    const packagedDll = path.join(temporaryRoot, 'resources', 'resources', 'wcdb', 'win32', 'x64', 'wcdb_api.dll')
    fs.mkdirSync(path.dirname(packagedDll), { recursive: true })
    fs.copyFileSync(DEFAULT_DLL_PATH, packagedDll)
    assert.equal(findNativeDll(temporaryRoot), packagedDll)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('Windows x64 afterPack checks the copied DLL and packaged provenance', async () => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-native-after-pack-'))
  try {
    const packagedDir = path.join(appOutDir, 'resources', 'resources', 'wcdb', 'win32', 'x64')
    fs.mkdirSync(packagedDir, { recursive: true })
    fs.copyFileSync(DEFAULT_DLL_PATH, path.join(packagedDir, 'wcdb_api.dll'))
    fs.copyFileSync(
      path.join(path.dirname(DEFAULT_DLL_PATH), 'native-provenance.json'),
      path.join(packagedDir, 'native-provenance.json'),
    )

    const context = { electronPlatformName: 'win32', arch: Arch.x64, appOutDir }
    await afterPack(context)

    const packagedDllPath = path.join(packagedDir, 'wcdb_api.dll')
    const corrupted = fs.readFileSync(packagedDllPath)
    corrupted[0xf00] ^= 1
    fs.writeFileSync(packagedDllPath, corrupted)
    await assert.rejects(afterPack(context), /Unexpected WCDB asset SHA-256/)
  } finally {
    fs.rmSync(appOutDir, { recursive: true, force: true })
  }
})
