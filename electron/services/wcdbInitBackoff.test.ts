import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WcdbCore } from './wcdbCore'

const tempRoots: string[] = []

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weport-wcdb-init-backoff-'))
  tempRoots.push(root)
  return root
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('WCDB initialization retry cooldown', () => {
  it('keeps the native error and skips repeated DLL discovery until the cooldown expires', async () => {
    const root = await createTempRoot()
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const core = new WcdbCore() as any
    let discoveryCount = 0
    core.writeLog = () => undefined
    core.setPaths(join(root, 'resources'), join(root, 'user-data'))
    core.getDllPath = () => {
      discoveryCount += 1
      return join(root, 'missing', 'wcdb_api.dll')
    }

    expect(await core.open(join(root, 'account'), '0'.repeat(64))).toBe(false)
    const initialError = core.getLastInitError()
    expect(initialError).toContain('-2301')
    expect(discoveryCount).toBe(1)

    const scannedOpen = await core.openScanned(join(root, 'nonexistent-account'), [])
    expect(scannedOpen.success).toBe(false)
    expect(scannedOpen.error).toContain('-2301')
    expect(discoveryCount).toBe(1)

    expect(await core.open(join(root, 'account'), '0'.repeat(64))).toBe(false)
    now += 29_999
    expect(await core.open(join(root, 'account'), '0'.repeat(64))).toBe(false)
    expect(discoveryCount).toBe(1)
    expect(core.getLastInitError()).toBe(initialError)

    now += 1
    expect(await core.open(join(root, 'account'), '0'.repeat(64))).toBe(false)
    expect(discoveryCount).toBe(2)
  })

  it('retries immediately when the configured resource path changes', async () => {
    const root = await createTempRoot()
    const core = new WcdbCore() as any
    let discoveryCount = 0
    core.writeLog = () => undefined
    core.setPaths(join(root, 'resources-a'), join(root, 'user-data'))
    core.getDllPath = () => {
      discoveryCount += 1
      return join(root, 'missing', 'wcdb_api.dll')
    }

    expect(await core.open(join(root, 'account'), '0'.repeat(64))).toBe(false)
    expect(discoveryCount).toBe(1)

    core.setPaths(join(root, 'resources-b'), join(root, 'user-data'))
    expect(await core.open(join(root, 'account'), '0'.repeat(64))).toBe(false)
    expect(discoveryCount).toBe(2)
  })

  it('does not gate an account-key failure after engine initialization', async () => {
    const root = await createTempRoot()
    const dbStorage = join(root, 'account', 'db_storage')
    await mkdir(dbStorage, { recursive: true })
    await writeFile(join(dbStorage, 'session.db'), Buffer.alloc(0))

    const now = 50_000
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const core = new WcdbCore() as any
    let openCount = 0
    const retryAt = now + 30_000
    core.writeLog = () => undefined
    core.initialized = true
    core.nextInitializationRetryAt = retryAt
    core.wcdbOpenAccount = (_path: string, _key: string, outHandle: number[]) => {
      openCount += 1
      outHandle[0] = 0
      return -2001
    }
    core.printLogs = async () => undefined

    expect(await core.open(join(root, 'account'), '0'.repeat(64))).toBe(false)
    expect(openCount).toBe(1)
    expect(core.getLastInitError()).toContain('-2001')
    expect(core.nextInitializationRetryAt).toBe(retryAt)
  })
})
