'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  DEFAULT_DYLIB_PATH,
  METADATA,
  findNativeDylib,
  parseMachO,
  repairNativeBinary,
  sha256,
  validatePackagedNativeBinary,
  validatePatchedBinary,
  validateSourceBinary,
} = require('./verify-mac-native.cjs')

function sourceFixture() {
  const current = fs.readFileSync(DEFAULT_DYLIB_PATH)
  const currentSha = sha256(current)
  if (currentSha === METADATA.source.sha256) return Buffer.from(current)
  if (currentSha === METADATA.adaptation.expectedSha256) {
    const original = Buffer.from(current)
    for (const patch of METADATA.adaptation.patches) {
      const expected = Buffer.from(patch.expectedHex, 'hex')
      const source = Buffer.from(patch.sourceHex, 'hex')
      assert.deepEqual(original.subarray(patch.offset, patch.offset + expected.length), expected)
      source.copy(original, patch.offset)
    }
    assert.equal(sha256(original), METADATA.source.sha256)
    return original
  }
  throw new Error(`Canonical macOS WCDB fixture has unknown SHA-256 ${currentSha}`)
}

function patchedFixture() {
  return repairNativeBinary(sourceFixture())
}

function changedOffsets(before, after) {
  const offsets = []
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) offsets.push(index)
  }
  return offsets
}

function mutateDylibInstallName(buffer) {
  const command = parseMachO(buffer).loadCommands.find((item) => item.command === 0xc && item.name)
  assert.ok(command, 'fixture must include an LC_LOAD_DYLIB command')
  const stringOffset = command.offset + command.nameOffset
  assert.ok(command.name.length > 0)
  buffer[stringOffset] ^= 1
}

test('canonical WeFlow source matches the recorded ARM64 layout, code and symbols', () => {
  const source = sourceFixture()
  const result = validateSourceBinary(source)
  const parsed = parseMachO(source)
  assert.equal(result.sha256, METADATA.source.sha256)
  assert.equal(result.textSha256, METADATA.macho.textSection.sourceSha256)
  assert.equal(parsed.cpuType, Number.parseInt(METADATA.macho.cpuType, 16))
  assert.equal(parsed.fileType, METADATA.macho.fileType)
  assert.equal(parsed.symbols.find((symbol) => symbol.name === '_InitProtection')?.value, 0x6d0c)
  assert.equal(parsed.symbols.find((symbol) => symbol.name === '_wcdb_init')?.value, 0x6d7c)
})

test('offline repair changes exactly the two recorded instructions and matches expected hashes', () => {
  const source = sourceFixture()
  const before = Buffer.from(source)
  const repaired = repairNativeBinary(source)
  const allowedOffsets = METADATA.adaptation.patches.flatMap((patch) => {
    const sourceBytes = Buffer.from(patch.sourceHex, 'hex')
    const expectedBytes = Buffer.from(patch.expectedHex, 'hex')
    return Array.from(sourceBytes.keys()).filter((index) => sourceBytes[index] !== expectedBytes[index])
      .map((index) => patch.offset + index)
  })

  assert.deepEqual(changedOffsets(before, repaired), allowedOffsets.sort((a, b) => a - b))
  assert.deepEqual(source, before, 'repair must not mutate the source Buffer')
  assert.equal(sha256(repaired), METADATA.adaptation.expectedSha256)
  assert.equal(validatePatchedBinary(repaired).textSha256, METADATA.adaptation.expectedTextSha256)
})

test('repair rejects an unknown whole-file source hash before patching', () => {
  const unknown = sourceFixture()
  unknown[0x500] ^= 1
  assert.throws(() => repairNativeBinary(unknown), /Unknown macOS WCDB source SHA-256/)
})

test('packaged validation tolerates linkage and signature changes outside __TEXT', () => {
  const packaged = patchedFixture()
  const changed = Buffer.from(packaged)
  const parsed = parseMachO(changed)
  assert.ok(parsed.codeSignature && parsed.codeSignature.size > 0, 'fixture must carry a code-signature blob')

  mutateDylibInstallName(changed)
  changed[parsed.codeSignature.offset] ^= 0x5a
  assert.notEqual(sha256(changed), METADATA.adaptation.expectedSha256)
  assert.equal(validatePackagedNativeBinary(changed).textSha256, METADATA.adaptation.expectedTextSha256)
})

test('packaged validation rejects altered expiry branches, code and host guard', () => {
  const patched = patchedFixture()

  const alteredBranch = Buffer.from(patched)
  alteredBranch[METADATA.adaptation.patches[0].offset] ^= 1
  assert.throws(() => validatePackagedNativeBinary(alteredBranch), /expiry branch mismatch/)

  const alteredCode = Buffer.from(patched)
  alteredCode[0x6d10] ^= 1
  assert.throws(() => validatePackagedNativeBinary(alteredCode), /__TEXT,__text SHA-256 mismatch/)

  const alteredHostGuard = Buffer.from(patched)
  alteredHostGuard[METADATA.adaptation.hostGuard.offset] ^= 1
  assert.throws(() => validatePackagedNativeBinary(alteredHostGuard), /host guard mismatch/)
})

test('packaged validation rejects another CPU architecture and shifted text layout', () => {
  const patched = patchedFixture()

  const wrongCpu = Buffer.from(patched)
  wrongCpu.writeUInt32LE(0x01000007, 4)
  assert.throws(() => validatePackagedNativeBinary(wrongCpu), /Expected ARM64 Mach-O CPU type/)

  const wrongLayout = {
    ...METADATA,
    macho: { ...METADATA.macho, textSection: { ...METADATA.macho.textSection, fileOffset: METADATA.macho.textSection.fileOffset + 1 } },
  }
  assert.throws(() => validatePackagedNativeBinary(patched, wrongLayout), /Unexpected __TEXT,__text layout/)
})

test('locates a packaged macOS asset below Contents/Resources', () => {
  const appContents = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-mac-native-'))
  try {
    const packagedPath = path.join(appContents, 'Contents', 'Resources', 'resources', 'wcdb', 'macos', 'universal', 'libwcdb_api.dylib')
    fs.mkdirSync(path.dirname(packagedPath), { recursive: true })
    fs.copyFileSync(DEFAULT_DYLIB_PATH, packagedPath)
    assert.equal(findNativeDylib(path.join(appContents, 'Contents', 'Resources')), packagedPath)
  } finally {
    fs.rmSync(appContents, { recursive: true, force: true })
  }
})
