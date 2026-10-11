import { describe, expect, it, vi } from 'vitest'
import { ImageKeyReadiness } from './imageKeyReadiness'

function fixture() {
  const state: any = { dbPath: 'data', myWxid: 'a', decryptKey: 'db-key', wxidConfigs: { a: { decryptKey: 'account-db-key' } } }
  const config: any = { get: (key: string) => state[key], set: vi.fn((key: string, value: any) => { state[key] = value }) }
  const acquire = vi.fn(async () => ({ success: true, verified: true, aesKey: 'image-key', xorKey: 0 }))
  return { state, config, acquire, service: new ImageKeyReadiness(config, acquire) }
}
describe('automatic account image key readiness', () => {
  it('saves verified image keys with XOR zero without changing database keys', async () => {
    const f = fixture()
    expect(await f.service.ensure()).toBe(true)
    expect(f.state.wxidConfigs.a).toMatchObject({ decryptKey: 'account-db-key', imageAesKey: 'image-key', imageXorKey: 0 })
    expect(f.state.decryptKey).toBe('db-key')
    await f.service.ensure()
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })
  it.each([{ success: false }, { success: true, verified: false, aesKey: 'wrong', xorKey: 2 }, { success: true, verified: true, aesKey: 'partial' }])('does not save incomplete or unverified keys: %j', async result => {
    const f = fixture(); f.acquire.mockResolvedValue(result as any)
    expect(await f.service.ensure()).toBe(false)
    expect(f.config.set).not.toHaveBeenCalled()
  })
  it('coalesces concurrent connection/export requests', async () => {
    const f = fixture()
    expect(await Promise.all([f.service.ensure(), f.service.ensure()])).toEqual([true, true])
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })
  it('coalesces concurrent failures without repeated scans or key writes', async () => {
    const f = fixture(); f.acquire.mockResolvedValue({ success: false } as any)
    expect(await Promise.all([f.service.ensure(), f.service.ensure()])).toEqual([false, false])
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.config.set).not.toHaveBeenCalled()
  })
  it('does not borrow another account global keys or scan without an account', async () => {
    const f = fixture(); f.state.imageAesKey = 'other-account'; f.state.imageXorKey = 5
    expect(await f.service.ensure()).toBe(true)
    expect(f.acquire).toHaveBeenCalledWith('data', 'a')
    f.state.myWxid = ''
    expect(await f.service.ensure()).toBe(false)
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })
  it('discards keys when the selected data directory changes during acquisition', async () => {
    const f = fixture()
    f.acquire.mockImplementation(async () => { f.state.dbPath = 'different-data'; return { success: true, verified: true, aesKey: 'image-key', xorKey: 0 } })
    expect(await f.service.ensure()).toBe(false)
    expect(f.config.set).not.toHaveBeenCalled()
  })
  it('discards acquisition across account changes, including switching away and back', async () => {
    const f = fixture()
    let finish!: (value: any) => void
    f.acquire.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = f.service.ensure()
    f.state.myWxid = 'b'; f.service.invalidate()
    f.state.myWxid = 'a'; f.service.invalidate()
    finish({ success: true, verified: true, aesKey: 'stale', xorKey: 3 })
    expect(await pending).toBe(false)
    expect(f.config.set).not.toHaveBeenCalled()
  })
  it('preserves newer manually saved keys and unrelated edits', async () => {
    const f = fixture()
    f.acquire.mockImplementation(async () => { f.state.wxidConfigs.a.imageAesKey = 'manual'; f.state.wxidConfigs.a.imageXorKey = 9; return { success: true, verified: true, aesKey: 'image-key', xorKey: 0 } })
    expect(await f.service.ensure()).toBe(true)
    expect(f.state.wxidConfigs.a.imageAesKey).toBe('manual')
  })
  it('leaves connection usable when cache acquisition throws', async () => {
    const f = fixture(); f.acquire.mockRejectedValue(new Error('cache unavailable'))
    expect(await f.service.ensure()).toBe(false)
    expect(f.config.set).not.toHaveBeenCalled()
  })
})
