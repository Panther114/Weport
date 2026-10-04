'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { assertArchitecture, elfArchitecture, machOArchitectures, smokeSource } = require('./verify-packaged-native.cjs')

function elf64(machine = 62, elfClass = 2, dataEncoding = 1) {
  const buffer = Buffer.alloc(64)
  buffer.set([0x7f, 0x45, 0x4c, 0x46, elfClass, dataEncoding], 0)
  buffer.writeUInt16LE(machine, 18)
  return buffer
}

function thinMachO(cpuType) {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(cpuType, 4)
  return buffer
}

function universalMachO(cpuTypes) {
  const buffer = Buffer.alloc(8 + cpuTypes.length * 20)
  buffer.writeUInt32BE(0xcafebabe, 0)
  buffer.writeUInt32BE(cpuTypes.length, 4)
  cpuTypes.forEach((cpuType, index) => buffer.writeUInt32BE(cpuType, 8 + index * 20))
  return buffer
}

function pe64(machine = 0x8664) {
  const buffer = Buffer.alloc(0x86)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(0x80, 0x3c)
  buffer.write('PE\0\0', 0x80, 'ascii')
  buffer.writeUInt16LE(machine, 0x84)
  return buffer
}

test('accepts packaged Linux x86_64 ELF64 assets', () => {
  assert.equal(elfArchitecture(elf64()), 'x64')
})

test('rejects non-ELF, non-64-bit, big-endian, and non-x86_64 assets', () => {
  assert.throws(() => elfArchitecture(Buffer.alloc(64)), /invalid ELF header/)
  assert.throws(() => elfArchitecture(elf64(62, 1, 1)), /ELF64 little-endian/)
  assert.throws(() => elfArchitecture(elf64(62, 2, 2)), /ELF64 little-endian/)
  assert.throws(() => elfArchitecture(elf64(183)), /machine=0xb7/)
})

test('reads thin and universal Mach-O architecture tables', () => {
  assert.deepEqual(machOArchitectures(thinMachO(0x0100000c)), ['arm64'])
  assert.deepEqual(machOArchitectures(universalMachO([0x01000007, 0x0100000c])), ['x64', 'arm64'])
})

test('rejects malformed Mach-O headers', () => {
  assert.throws(() => machOArchitectures(Buffer.alloc(4)), /truncated Mach-O/)
  assert.throws(() => machOArchitectures(Buffer.alloc(32)), /invalid Mach-O/)
  const truncatedFat = Buffer.alloc(12)
  truncatedFat.writeUInt32BE(0xcafebabe, 0)
  truncatedFat.writeUInt32BE(1, 4)
  assert.throws(() => machOArchitectures(truncatedFat), /malformed universal Mach-O/)
})

test('accepts only packaged Windows AMD64 PE assets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-pe-header-'))
  const filePath = path.join(directory, 'native.bin')
  try {
    fs.writeFileSync(filePath, pe64())
    assertArchitecture(filePath, 'win32', 'x64')

    fs.writeFileSync(filePath, pe64(0xaa64))
    assert.throws(() => assertArchitecture(filePath, 'win32', 'x64'), /expected AMD64 PE/)

    fs.writeFileSync(filePath, Buffer.alloc(64))
    assert.throws(() => assertArchitecture(filePath, 'win32', 'x64'), /invalid PE header/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('generated Electron-as-Node init smoke script parses', () => {
  assert.doesNotThrow(() => new vm.Script(smokeSource()))
})
