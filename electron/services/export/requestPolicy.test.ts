import { describe, expect, it, vi } from 'vitest'
import { resolveRequestedSessionLayout, selectUnmutedConversations } from './requestPolicy'

describe('export request policy (#56, #59)', () => {
  it.each(['shared', 'per-session'] as const)('preserves explicit %s layout with media', sessionLayout => {
    expect(resolveRequestedSessionLayout({ sessionLayout, exportMedia: true })).toBe(sessionLayout)
  })
  it('keeps legacy media and text defaults for callers without a layout', () => {
    expect(resolveRequestedSessionLayout({ exportMedia: true })).toBe('per-session')
    expect(resolveRequestedSessionLayout({ exportMedia: false })).toBe('shared')
  })
  it('excludes muted private/group chats and official accounts from the actual selection', async () => {
    const query = vi.fn(async () => ({ success: true, map: {
      friend: { isMuted: false }, 'work@chatroom': { isMuted: false },
      quiet: { isMuted: true }, 'quiet@chatroom': { isMuted: true },
    } }))
    expect(await selectUnmutedConversations(['friend', 'quiet', 'work@chatroom', 'quiet@chatroom', 'gh_news'], query))
      .toEqual(['friend', 'work@chatroom'])
    expect(query).toHaveBeenCalledExactlyOnceWith(['friend', 'quiet', 'work@chatroom', 'quiet@chatroom'])
  })
  it.each([
    { success: false, error: 'native unavailable' },
    { success: true, map: {} as Record<string, { isMuted?: boolean }> },
    { success: true, map: { friend: {} } },
  ])('rejects unknown/failed status without exporting restricted chats (%j)', async result => {
    await expect(selectUnmutedConversations(['friend'], async () => result)).rejects.toThrow()
  })
  it('batches large selections and keeps order', async () => {
    const ids = Array.from({ length: 451 }, (_, i) => `user${i}`)
    const query = vi.fn(async (batch: string[]) => ({ success: true,
      map: Object.fromEntries(batch.map(id => [id, { isMuted: false }])) }))
    expect(await selectUnmutedConversations(ids, query)).toEqual(ids)
    expect(query.mock.calls.map(([batch]) => batch.length)).toEqual([200, 200, 51])
  })
})
