import { beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  created: vi.fn(),
  messageTypes: [] as string[],
}))

vi.mock('./wcdbHostClient', () => ({
  WcdbHostClient: class {
    private handlers = new Map<string, (...args: any[]) => void>()
    constructor() { host.created() }
    on(event: string, listener: (...args: any[]) => void) { this.handlers.set(event, listener); return this }
    postMessage(message: { id: number; type: string }) {
      host.messageTypes.push(message.type)
      queueMicrotask(() => this.handlers.get('message')?.({ id: message.id, result: { success: true } }))
      return true
    }
    async terminate() { host.messageTypes.push('shutdown') }
  },
}))

import { WcdbService } from './wcdbService'

describe('WCDB restore maintenance gate', () => {
  beforeEach(() => { host.created.mockClear(); host.messageTypes.length = 0 })

  it('reads idle connection status without spawning a host', async () => {
    const service = new WcdbService()

    await expect(service.isConnected()).resolves.toBe(false)
    await expect(service.getLastInitError()).resolves.toBeNull()
    expect(service.getHostGeneration()).toBe(0)
    expect(host.created).not.toHaveBeenCalled()
    expect(host.messageTypes).toEqual([])
  })

  it('holds one lease and rejects database calls without spawning a host', async () => {
    const service = new WcdbService()
    const release = service.acquireMaintenance()
    expect(release).toBeTypeOf('function')
    expect(service.isMaintenanceActive()).toBe(true)
    expect(service.acquireMaintenance()).toBeNull()

    await expect(service.getSessions()).rejects.toThrow('数据库正在恢复快照')
    expect(service.getHostGeneration()).toBe(0)
    expect(host.created).not.toHaveBeenCalled()

    release!()
    expect(service.isMaintenanceActive()).toBe(false)
  })

  it('allows cleanup calls as no-ops when there is no host', async () => {
    const service = new WcdbService()
    const release = service.acquireMaintenance()!

    await expect(service.close()).resolves.toBeUndefined()
    await expect(service.cancelScannedOpen()).resolves.toEqual({ success: true })
    await expect(service.closeMessageCursor(17)).resolves.toEqual({ success: true })
    expect(service.getHostGeneration()).toBe(0)
    expect(host.created).not.toHaveBeenCalled()

    release()
  })

  it('a stale release cannot clear a later maintenance lease', () => {
    const service = new WcdbService()
    const firstRelease = service.acquireMaintenance()!
    firstRelease()
    const secondRelease = service.acquireMaintenance()!

    firstRelease()
    expect(service.isMaintenanceActive()).toBe(true)
    secondRelease()
    expect(service.isMaintenanceActive()).toBe(false)
  })

  it('cancels an in-flight scan before close and host shutdown', async () => {
    const service = new WcdbService()
    await service.openScanned('private-account', [])

    await service.shutdown()

    const scanIndex = host.messageTypes.indexOf('openScanned')
    const cancelIndex = host.messageTypes.indexOf('cancelScannedOpen')
    const closeIndex = host.messageTypes.indexOf('close')
    const shutdownIndex = host.messageTypes.indexOf('shutdown')
    expect(scanIndex).toBeGreaterThanOrEqual(0)
    expect(cancelIndex).toBeGreaterThan(scanIndex)
    expect(closeIndex).toBeGreaterThan(cancelIndex)
    expect(shutdownIndex).toBeGreaterThan(closeIndex)
  })
})
