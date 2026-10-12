import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, net: {} }))
vi.mock('./config', () => ({ ConfigService: class { get() { return [] } } }))
vi.mock('./avatarCacheService', () => ({ avatarCacheService: { localUrlOrOriginal: (url: string) => url }, protocolUrlToPath: vi.fn() }))
vi.mock('./chatService', () => ({ chatService: { getSessions: vi.fn(), enrichSessionsContactInfo: vi.fn() } }))
vi.mock('./wcdbService', () => ({ wcdbService: {
  getSessions: vi.fn(), getGroupMemberCounts: vi.fn(), getSessionMessageCounts: vi.fn(),
} }))
import { analyticsService } from './analyticsService'
import { groupAnalyticsService } from './groupAnalyticsService'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'

describe('analytics uses recovered Reader history', () => {
  beforeEach(() => {
    vi.mocked(chatService.getSessions).mockResolvedValue({ success: true, sessions: [
      { username: 'old@chatroom', lastTimestamp: 123, messageCountHint: 18 },
      { username: 'old-private', lastTimestamp: 124, messageCountHint: 1 },
      { username: 'gh_official' }, { username: 'self' },
    ] as any })
  })
  it('includes removed conversations while respecting private-only and excluded scopes', async () => {
    const method = (analyticsService as any).getPrivateSessions.bind(analyticsService)
    expect((await method('self', new Set(), true)).usernames).toEqual(['old@chatroom', 'old-private'])
    expect((await method('self', new Set(), false)).usernames).toEqual(['old-private'])
    expect((await method('self', new Set(['old-private']), true)).usernames).toEqual(['old@chatroom'])
    expect(wcdbService.getSessions).not.toHaveBeenCalled()
    const before = await method('self', new Set(), true)
    vi.mocked(chatService.getSessions).mockResolvedValue({ success: true, sessions: [{ username: 'old@chatroom', lastTimestamp: 123, messageCountHint: 19 }] as any })
    expect((await method('self', new Set(), true)).revision).not.toBe(before.revision)
  })
  it('offers removed groups for group analysis with their independently counted history', async () => {
    vi.mocked(wcdbService.getGroupMemberCounts).mockResolvedValue({ success: true, map: {} })
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: { 'old@chatroom': 18 } })
    vi.mocked(chatService.enrichSessionsContactInfo).mockResolvedValue({ success: true, contacts: { 'old@chatroom': { displayName: 'Old group' } } })
    const target = Object.create(Object.getPrototypeOf(groupAnalyticsService))
    target.ensureConnected = vi.fn(async () => ({ success: true }))
    const result = await target.getGroupChats()
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject([{ username: 'old@chatroom', messageCount: 18 }])
    expect(wcdbService.getSessions).not.toHaveBeenCalled()
  })
})
