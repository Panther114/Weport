import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ key: '', snapshot: false, enabled: true }))
vi.mock('./config', () => ({ ConfigService: { getInstance: () => ({
  getCacheBasePath: () => process.env.TEMP || '.',
  get: (key: string) => key === 'decryptKey' ? state.key : key === 'messagePushEnabled' ? state.enabled : false,
}) } }))
vi.mock('./chatService', () => ({ chatService: {
  connect: vi.fn(async () => ({ success: true })),
  isReadOnlySnapshot: () => state.snapshot,
  close: vi.fn(),
} }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
import { MessagePushService } from './messagePushService'
import { chatService } from './chatService'

describe('live notification connection requirements', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.key = ''; state.snapshot = false; state.enabled = true })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  const boot = async () => {
    const service = new MessagePushService()
    vi.spyOn(service as any, 'bootstrapBaseline').mockResolvedValue(undefined)
    service.start()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    return service
  }
  it('does not open a scanned history mirror in the background without an original key', async () => {
    const service = await boot()
    expect(chatService.connect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    service.stop()
  })
  it('does not poll or claim a live baseline for a read-only snapshot', async () => {
    state.key = 'a'.repeat(64); state.snapshot = true
    const service = await boot()
    expect(chatService.connect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect((service as any).bootstrapBaseline).not.toHaveBeenCalled()
    service.stop()
  })
  it('keeps fallback polling for a successful original-key connection', async () => {
    state.key = 'a'.repeat(64)
    const service = await boot()
    expect(chatService.connect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    expect((service as any).bootstrapBaseline).toHaveBeenCalledOnce()
    service.stop()
  })
})
