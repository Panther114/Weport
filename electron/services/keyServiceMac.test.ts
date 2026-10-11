import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, shell: {} }))

import { KeyServiceMac } from './keyServiceMac'

afterEach(() => vi.restoreAllMocks())

describe('macOS acquisition log privacy', () => {
  it('returns the acquired database key without writing it to console logs', async () => {
    const key = '0123456789abcdef'.repeat(4)
    const service = new KeyServiceMac()
    vi.spyOn(service as any, 'checkSipStatus').mockResolvedValue({ enabled: false })
    vi.spyOn(service as any, 'getDbKeyByHelperElevated').mockResolvedValue(key)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await service.autoGetDbKey()).toEqual({ success: true, key })
    expect(JSON.stringify([...log.mock.calls, ...warning.mock.calls, ...error.mock.calls])).not.toContain(key)
  })
})
