import { describe, expect, it, vi } from 'vitest'
import { resolveDefaultGroupNames } from './groupDisplayName'
import { WcdbCore } from './wcdbCore'

describe('default group titles', () => {
  it('repairs a cached numeric group title through the native name lookup', async () => {
    const core = new WcdbCore() as any
    core.ensureReady = () => true
    core.displayNameCache.set('123@chatroom', { displayName: '123@chatroom', updatedAt: Date.now() })
    core.wcdbGetDisplayNames = (_handle: unknown, ids: string, out: unknown[]) => {
      out[0] = JSON.stringify(Object.fromEntries(JSON.parse(ids).map((id: string) => [id, id === 'alice' ? 'Alice' : id])))
      return 0
    }
    core.decodeJsonPtr = (value: string) => value
    core.execQuery = async (_kind: string, _path: unknown, sql: string) => ({
      success: true, rows: sql.includes("'alice'") ? [{ username: 'alice', nick_name: 'Alice' }] : [{ username: '123@chatroom' }],
    })
    core.getGroupMembers = vi.fn(async () => ({ success: true, members: ['alice'] }))
    await expect(core.getDisplayNames(['123@chatroom'])).resolves.toMatchObject({ success: true, map: { '123@chatroom': 'Alice' } })
    await expect(core.getDisplayNames(['123@chatroom'])).resolves.toMatchObject({ map: { '123@chatroom': 'Alice' } })
    expect(core.getGroupMembers).toHaveBeenCalledTimes(1)
  })
  it('uses member contact names and roster nicknames without replacing a named room', async () => {
    const names = { '123@chatroom': '123@chatroom', '456@chatroom': 'Actual name' }
    const members = vi.fn().mockResolvedValue({ success: true, members: [{ username: 'alice' }, { username: 'bob', nick_name: 'Bob' }] })
    await resolveDefaultGroupNames(Object.keys(names), names, members, async () => ({ success: true, map: { alice: 'Alice', bob: 'bob' } }))
    expect(names['123@chatroom']).toBe('Alice、Bob')
    expect(names['456@chatroom']).toBe('Actual name')
    expect(members).toHaveBeenCalledTimes(1)
  })
  it('keeps an explicit unknown ID when there is no roster evidence', async () => {
    const names = { '123@chatroom': '123@chatroom' }
    await resolveDefaultGroupNames(Object.keys(names), names, async () => ({ success: false }), vi.fn())
    expect(names['123@chatroom']).toBe('123@chatroom')
  })
})
