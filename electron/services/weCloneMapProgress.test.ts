import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('./config', () => ({ ConfigService: class { static getInstance() { return { get: () => '' } } } }))
vi.mock('./chatService', () => ({ chatService: {} }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
vi.mock('./ai/providerProfiles', () => ({ ProviderProfileService: class { list() { return [] } } }))
import { WeCloneService } from './weCloneService'

describe('concurrent WeClone progress (#57)', () => {
  it('counts settled shards, exposes fallback failures, and preserves digest order', async () => {
    const service = Object.create(WeCloneService.prototype) as any
    const pending: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = []
    service.callLlmWithFallback = () => new Promise<string>((resolve, reject) => pending.push({ resolve, reject }))
    const progress: Array<{ done: number; message: string }> = []
    const shards = [1, 2, 3].map(n => [{ sid: 'fixture', talker: '我', text: `text ${n}`, ts: n }])
    const resultPromise = service.runMapPhase(shards, new Map(), [], undefined,
      (done: number, _total: number, message: string) => progress.push({ done, message }))
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    pending[2].resolve('third')
    await vi.waitFor(() => expect(progress).toHaveLength(1))
    expect(progress[0].done).toBe(1)
    pending[0].reject(new Error('synthetic network failure'))
    await vi.waitFor(() => expect(progress).toHaveLength(2))
    expect(progress[1].message).toContain('失败 1')
    pending[1].resolve('second')
    const result = await resultPromise
    expect(progress.map(p => p.done)).toEqual([1, 2, 3])
    expect(result.failures).toBe(1)
    expect(result.digests[1]).toContain('second')
    expect(result.digests[2]).toContain('third')
  })
})
