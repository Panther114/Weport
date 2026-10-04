import { describe, expect, it, vi } from 'vitest'
import { WasmService } from './wasmService'

function fixture() {
  const service = Object.create(WasmService.prototype) as any
  Object.assign(service, { keystreamCache: new Map(), keystreamCacheBytes: 0,
    keystreamCacheMaxBytes: 32, keystreamCacheMaxEntries: 4,
    getRawKeystream: vi.fn(async (_key: string, size: number) => Buffer.from(Array.from({ length: size }, (_, i) => i))),
  })
  return service
}

describe('SNS keystream cache correctness and memory bounds', () => {
  it('keeps the entire aligned block when later requests need more bytes (#27)', async () => {
    const service = fixture()
    expect([...await service.getKeystream('123', 1)]).toEqual([7])
    expect([...await service.getKeystream('123', 8)]).toEqual([7, 6, 5, 4, 3, 2, 1, 0])
    expect(service.getRawKeystream).toHaveBeenCalledTimes(1)
    expect(service.getKeystreamCacheStats()).toEqual({ entries: 1, bytes: 8 })
  })
  it('never lets callers mutate the cached stream', async () => {
    const service = fixture()
    const first = await service.getKeystream('123', 3)
    first.fill(0)
    expect([...await service.getKeystream('123', 3)]).toEqual([7, 6, 5])
  })
  it('accounts correctly for concurrent same-key insertion and bounded LRU eviction', async () => {
    const service = fixture()
    await Promise.all(Array.from({ length: 20 }, () => service.getKeystream('123', 7)))
    expect(service.getKeystreamCacheStats()).toEqual({ entries: 1, bytes: 8 })
    for (let i = 0; i < 10; i++) await service.getKeystream(String(i), 16)
    expect(service.getKeystreamCacheStats()).toEqual({ entries: 2, bytes: 32 })
  })
  it('rejects invalid sizes before calling native code', async () => {
    const service = fixture()
    for (const size of [-1, NaN, Infinity, 1.5]) await expect(service.getKeystream('123', size)).rejects.toThrow(RangeError)
    expect(await service.getKeystream('123', 0)).toHaveLength(0)
    expect(service.getRawKeystream).not.toHaveBeenCalled()
  })
})
