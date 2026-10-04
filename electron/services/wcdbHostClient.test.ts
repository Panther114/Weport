import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyLinuxHostRuntimeFiles } from './wcdbHostClient'

describe('Linux WCDB host deployment', () => {
  let tempRoot = ''

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  it('copies Electron ICU and V8 runtime files beside a host executable moved to userData', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'weport-wcdb-host-runtime-'))
    const electronDir = join(tempRoot, 'electron')
    const hostDir = join(tempRoot, 'userData', 'wcdb-host')
    mkdirSync(electronDir, { recursive: true })
    mkdirSync(hostDir, { recursive: true })
    const runtimeFiles = {
      'icudtl.dat': Buffer.from('fixture ICU payload'),
      'snapshot_blob.bin': Buffer.from('fixture V8 snapshot blob'),
      'v8_context_snapshot.bin': Buffer.from('fixture V8 context snapshot'),
    }
    for (const [name, contents] of Object.entries(runtimeFiles)) writeFileSync(join(electronDir, name), contents)

    copyLinuxHostRuntimeFiles(join(electronDir, 'Weport'), join(hostDir, 'WeFlow'))

    for (const [name, contents] of Object.entries(runtimeFiles)) {
      expect(readFileSync(join(hostDir, name))).toEqual(contents)
    }
  })

  it('fails clearly when a required packaged Electron runtime file is missing', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'weport-wcdb-host-no-runtime-'))
    const electronDir = join(tempRoot, 'electron')
    const hostDir = join(tempRoot, 'userData', 'wcdb-host')
    mkdirSync(electronDir, { recursive: true })
    mkdirSync(hostDir, { recursive: true })

    writeFileSync(join(electronDir, 'icudtl.dat'), Buffer.from('fixture ICU payload'))
    writeFileSync(join(electronDir, 'snapshot_blob.bin'), Buffer.from('fixture V8 snapshot blob'))

    expect(() => copyLinuxHostRuntimeFiles(join(electronDir, 'Weport'), join(hostDir, 'WeFlow')))
      .toThrow(/Electron runtime file is missing.*v8_context_snapshot\.bin/)
  })
})
