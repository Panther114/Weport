import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SnsProtectionService } from './snsProtectionService'

const roots: string[] = [], services: SnsProtectionService[] = []
afterEach(() => { services.splice(0).forEach(service => service.stop()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weport-sns-auto-')); roots.push(root)
  const state = { account: 'A', running: true, installed: false, now: 1700000000000 }
  const options = {
    file: join(root, 'protection.json'), account: () => state.account, now: () => state.now,
    wechatRunning: vi.fn(async () => state.running),
    installed: vi.fn(async () => ({ success: true, installed: state.installed })),
    apply: vi.fn(async (enabled: boolean, valid: () => boolean) => { if (!valid()) return { success: false, error: 'cancelled' }; state.installed = enabled; return { success: true } }),
  }
  const create = () => { const service = new SnsProtectionService(options); services.push(service); return service }
  return { state, options, create }
}
async function idle(service: SnsProtectionService) { await vi.waitFor(() => expect((service as any).busy).toBe(false)) }

describe('deferred account-bound Moments protection', () => {
  it('persists a pending choice without writing while WeChat is running, then applies after exit and restart', async () => {
    const { state, options, create } = fixture(), original = create()
    original.request(true)
    await idle(original)
    expect(options.apply).not.toHaveBeenCalled()
    expect(original.state()).toMatchObject({ desired: true, pending: true })
    original.stop()
    const restarted = create()
    expect(restarted.state()).toMatchObject({ desired: true, pending: true })
    state.running = false
    await restarted.tick()
    expect(options.apply).toHaveBeenCalledOnce()
    expect(restarted.state()).toMatchObject({ desired: true, pending: false })
    expect(JSON.parse(readFileSync(options.file, 'utf8')).accounts.A.pending).toBe(false)
  })
  it('does not apply another account’s request', async () => {
    const { state, options, create } = fixture(), service = create()
    service.request(true); await idle(service)
    state.account = 'B'; state.running = false
    await service.tick()
    expect(service.state()).toBeNull()
    expect(options.apply).not.toHaveBeenCalled()
  })
  it('cancels a queued enable without a database write when protection is already off', async () => {
    const { options, create } = fixture(), service = create()
    service.request(true); await idle(service)
    service.request(false); await idle(service); await service.tick()
    expect(service.state()).toMatchObject({ desired: false, pending: false })
    expect(options.apply).not.toHaveBeenCalled()
  })
  it('rechecks the request lease immediately before applying and retains the replacement request', async () => {
    const { state, options, create } = fixture(), service = create()
    state.running = false
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    options.apply.mockImplementationOnce(async (enabled, valid) => { await gate; if (!valid()) return { success: false, error: 'cancelled' }; state.installed = enabled; return { success: true } })
    service.request(true)
    await vi.waitFor(() => expect(options.apply).toHaveBeenCalledOnce())
    const replacement = service.request(false)
    release(); await idle(service)
    expect(state.installed).toBe(false)
    expect(service.state()?.requestId).toBe(replacement.requestId)
    await service.tick()
    expect(service.state()).toMatchObject({ desired: false, pending: false })
  })
  it('keeps failed operations pending with a bounded retry delay and verifies native status', async () => {
    const { state, options, create } = fixture(), service = create()
    state.running = false
    options.apply.mockResolvedValueOnce({ success: false, error: 'snapshot failed' })
    service.request(true); await idle(service)
    expect(service.state()).toMatchObject({ pending: true, error: 'snapshot failed' })
    await service.tick(); expect(options.apply).toHaveBeenCalledOnce()
    state.now += 300001
    await service.tick()
    expect(service.state()).toMatchObject({ pending: false, desired: true })
    expect(service.state()?.error).toBeUndefined()
  })
  it('automatically queues missing protection again without writing to a running WeChat', async () => {
    const { state, options, create } = fixture(), service = create()
    state.running = false
    service.request(true); await idle(service)
    state.installed = false; state.running = true
    await service.tick()
    expect(service.state()).toMatchObject({ desired: true, pending: true })
    expect(options.apply).toHaveBeenCalledOnce()
  })
})
