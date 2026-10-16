import { describe, expect, it, vi } from 'vitest'
import { acquireKeyForSelectedAccount } from './accountKeyAcquisition'

describe('selected account key acquisition', () => {
  it.each(['', 'wxid_previous'])('uses the visible account when the saved account is %j', async (savedAccount) => {
    const stored: Record<string, string> = { dbPath: '/old-root', myWxid: savedAccount }
    const config = { set: async (key: string, value: string) => { stored[key] = value; return { success: true } } }
    const acquire = vi.fn(async () => ({ accountDir: `${stored.dbPath}/${stored.myWxid}` }))
    await expect(acquireKeyForSelectedAccount(config,
      { dbPath: ' /fixture/xwechat_files ', wxid: ' wxid_fixture_abcd ' }, acquire))
      .resolves.toEqual({ accountDir: '/fixture/xwechat_files/wxid_fixture_abcd' })
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('does not start extraction until the account write has completed', async () => {
    let completeAccountWrite!: (value: unknown) => void
    const accountWrite = new Promise((resolve) => { completeAccountWrite = resolve })
    const config = { set: vi.fn(async (key: string) => key === 'myWxid' ? accountWrite : { success: true }) }
    const acquire = vi.fn(async () => ({ success: true }))
    const pending = acquireKeyForSelectedAccount(config, { dbPath: '/fixture', wxid: 'wxid_fixture' }, acquire)
    await vi.waitFor(() => expect(config.set).toHaveBeenCalledWith('myWxid', 'wxid_fixture'))
    expect(acquire).not.toHaveBeenCalled()
    completeAccountWrite({ success: true })
    await pending
    expect(acquire).toHaveBeenCalledOnce()
  })

  it.each(['dbPath', 'myWxid'])('does not extract after a failed %s write', async (failedKey) => {
    const acquire = vi.fn(async () => ({ success: true }))
    const config = { set: async (key: string) => ({ success: key !== failedKey }) }
    await expect(acquireKeyForSelectedAccount(config, { dbPath: '/fixture', wxid: 'wxid_fixture' }, acquire))
      .rejects.toThrow('保存')
    expect(acquire).not.toHaveBeenCalled()
  })

  it('propagates IPC failures without starting extraction', async () => {
    const acquire = vi.fn(async () => ({ success: true }))
    const config = { set: async () => { throw new Error('IPC unavailable') } }
    await expect(acquireKeyForSelectedAccount(config, { dbPath: '/fixture', wxid: 'wxid_fixture' }, acquire))
      .rejects.toThrow('IPC unavailable')
    expect(acquire).not.toHaveBeenCalled()
  })

  it.each([{ dbPath: '', wxid: 'wxid_fixture' }, { dbPath: '/fixture', wxid: ' ' }])(
    'rejects an incomplete selection before writing configuration', async (selection) => {
      const config = { set: vi.fn(async () => ({ success: true })) }
      const acquire = vi.fn(async () => ({ success: true }))
      await expect(acquireKeyForSelectedAccount(config, selection, acquire)).rejects.toThrow('请先选择')
      expect(config.set).not.toHaveBeenCalled()
      expect(acquire).not.toHaveBeenCalled()
    })
})
