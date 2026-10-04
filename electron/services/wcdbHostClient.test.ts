import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyLinuxHostIcuData } from './wcdbHostClient'

describe('Linux WCDB host deployment', () => {
  let tempRoot = ''

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  it('copies Electron ICU data beside a host executable moved to userData', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'weport-wcdb-host-icu-'))
    const electronDir = join(tempRoot, 'electron')
    const hostDir = join(tempRoot, 'userData', 'wcdb-host')
    mkdirSync(electronDir, { recursive: true })
    mkdirSync(hostDir, { recursive: true })
    const icuData = Buffer.from('fixture ICU payload')
    writeFileSync(join(electronDir, 'icudtl.dat'), icuData)

    copyLinuxHostIcuData(join(electronDir, 'Weport'), join(hostDir, 'WeFlow'))

    expect(readFileSync(join(hostDir, 'icudtl.dat'))).toEqual(icuData)
  })

  it('fails clearly when the packaged Electron ICU data is missing', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'weport-wcdb-host-no-icu-'))
    const electronDir = join(tempRoot, 'electron')
    const hostDir = join(tempRoot, 'userData', 'wcdb-host')
    mkdirSync(electronDir, { recursive: true })
    mkdirSync(hostDir, { recursive: true })

    expect(() => copyLinuxHostIcuData(join(electronDir, 'Weport'), join(hostDir, 'WeFlow')))
      .toThrow(/Electron ICU data is missing/)
  })
})
