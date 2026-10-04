'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')

const {
  DEFAULT_SO_PATH,
  METADATA,
  gitBlobSha1,
  repairNativeBinary,
  sha256,
  validatePatchedBinary,
  validateSourceBinary,
} = require('./verify-linux-native.cjs')

function sourceFixture() {
  const current = fs.readFileSync(DEFAULT_SO_PATH)
  const currentSha = sha256(current)
  if (currentSha === METADATA.source.sha256) return Buffer.from(current)
  if (currentSha === METADATA.adaptation.expectedSha256) {
    const original = Buffer.from(current)
    for (const patch of METADATA.adaptation.patches) {
      const patched = Buffer.from(patch.expectedHex, 'hex')
      const source = Buffer.from(patch.sourceHex, 'hex')
      assert.deepEqual(original.subarray(patch.offset, patch.offset + patched.length), patched)
      source.copy(original, patch.offset)
    }
    assert.equal(sha256(original), METADATA.source.sha256)
    return original
  }
  throw new Error(`Canonical Linux WCDB fixture has unknown SHA-256 ${currentSha}`)
}

function changedOffsets(before, after) {
  const offsets = []
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) offsets.push(index)
  }
  return offsets
}

test('canonical WeFlow Linux source matches the recorded Git blob, ELF header, expiry bytes and host guard', () => {
  const source = sourceFixture()
  const result = validateSourceBinary(source)
  assert.equal(result.sha256, METADATA.source.sha256)
  assert.equal(result.gitBlob, METADATA.source.gitBlob)
  assert.equal(gitBlobSha1(source), '0c0629715e20967fa8de9334509971abfad5b4f3')
  assert.equal(result.architecture, 'x86_64')
  assert.equal(result.fileType, METADATA.elf.fileType)
  assert.deepEqual(METADATA.adaptation.hostGuard.acceptedProcessNames, [
    'electron', 'weflow.exe', 'weflow', 'ciphertalk.exe', 'ciphertalk',
    'wechatdataanalysis.exe', 'wechatdataanalysis',
  ])
})

test('offline repair changes exactly the two recorded expiry branches and matches the pinned hash', () => {
  const source = sourceFixture()
  const before = Buffer.from(source)
  const repaired = repairNativeBinary(source)
  const expectedOffsets = METADATA.adaptation.patches.flatMap((patch) => {
    const oldBytes = Buffer.from(patch.sourceHex, 'hex')
    const newBytes = Buffer.from(patch.expectedHex, 'hex')
    return Array.from(oldBytes.keys())
      .filter((index) => oldBytes[index] !== newBytes[index])
      .map((index) => patch.offset + index)
  }).sort((left, right) => left - right)

  assert.deepEqual(changedOffsets(before, repaired), expectedOffsets)
  assert.deepEqual(source, before, 'repair must not mutate the source Buffer')
  assert.equal(sha256(repaired), METADATA.adaptation.expectedSha256)
  assert.equal(validatePatchedBinary(repaired).sha256, METADATA.adaptation.expectedSha256)
})

test('repair rejects unknown source mutations and the patched verifier rejects modified guards', () => {
  const unknown = sourceFixture()
  unknown[0x500] ^= 1
  assert.throws(() => repairNativeBinary(unknown), /Unknown Linux WCDB source SHA-256/)

  const patched = repairNativeBinary(sourceFixture())
  const alteredExpiry = Buffer.from(patched)
  alteredExpiry[METADATA.adaptation.patches[0].offset] ^= 1
  assert.throws(() => validatePatchedBinary(alteredExpiry), /expiry branch for InitProtection mismatch/)

  const alteredHostGuard = Buffer.from(patched)
  alteredHostGuard[Number.parseInt(METADATA.adaptation.hostGuard.poisonReturn.offset, 16)] ^= 1
  assert.throws(() => validatePatchedBinary(alteredHostGuard), /host-name failure return mismatch/)

  const alteredAcceptedName = Buffer.from(patched)
  alteredAcceptedName[Number.parseInt(METADATA.adaptation.hostGuard.acceptedNamesOffset, 16)] ^= 1
  assert.throws(() => validatePatchedBinary(alteredAcceptedName), /host-name whitelist mismatch/)
})

test('patched verification rejects non-ELF and non-x86-64 assets', () => {
  const patched = repairNativeBinary(sourceFixture())

  const wrongMagic = Buffer.from(patched)
  wrongMagic[0] = 0
  assert.throws(() => validatePatchedBinary(wrongMagic), /Expected an ELF shared library/)

  const wrongMachine = Buffer.from(patched)
  wrongMachine.writeUInt16LE(183, 18)
  assert.throws(() => validatePatchedBinary(wrongMachine), /Expected x86-64 ELF machine/)
})
