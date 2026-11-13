import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ contacts: {} as Record<string, { avatarUrl?: string }>, heads: {} as Record<string, string> }))
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
vi.mock('./config', () => ({ ConfigService: class { get() { return '' } getCacheBasePath() { return 'fixture-cache' } } }))
vi.mock('./contactCacheService', () => ({ ContactCacheService: class { get(id: string) { return state.contacts[id] } } }))
vi.mock('./wcdbService', () => ({ wcdbService: { getSnsTimeline: vi.fn() } }))
vi.mock('./chatService', () => ({ chatService: { enrichSessionsContactInfo: vi.fn(async () => ({ success: true, contacts: {} })) } }))
vi.mock('./avatarCacheService', () => ({ avatarCacheService: {
  getLocalizedHeadAvatars: vi.fn((authors: string[]) => ({ map: state.heads, missing: authors.filter(id => !state.heads[id]) })),
  isResolvable: vi.fn((url?: string) => !!url && !url.includes('deleted')),
  localUrlOrOriginal: vi.fn((url?: string) => url), ensure: vi.fn(),
} }))
import { snsService } from './snsService'
import { wcdbService } from './wcdbService'
import { chatService } from './chatService'

beforeEach(() => { state.contacts = {}; state.heads = {}; vi.clearAllMocks() })
describe('Moments author avatars', () => {
  const post = (username: string) => ({ id: username, username, avatarUrl: 'https://expired.qlogo.cn/avatar', media: [], comments: [] })
  it('uses an avatar already localized by another module even when the contact URL is stale', async () => {
    state.contacts.author = { avatarUrl: 'https://expired.qlogo.cn/avatar' }
    state.heads.author = 'weport-media://local/existing.jpg'
    vi.mocked(wcdbService.getSnsTimeline).mockResolvedValue({ success: true, timeline: [post('author')] } as any)
    const result = await snsService.getTimeline()
    expect(result.timeline?.[0].avatarUrl).toBe('weport-media://local/existing.jpg')
    expect(chatService.enrichSessionsContactInfo).not.toHaveBeenCalled()
  })
  it('batch-resolves authors outside contact warmup and repairs missing local paths', async () => {
    state.contacts.deleted = { avatarUrl: 'weport-media://local/deleted.jpg' }
    vi.mocked(chatService.enrichSessionsContactInfo).mockResolvedValueOnce({ success: true, contacts: {
      unknown: { avatarUrl: 'weport-media://local/unknown.jpg' }, deleted: { avatarUrl: 'weport-media://local/restored.jpg' },
    } })
    vi.mocked(wcdbService.getSnsTimeline).mockResolvedValue({ success: true, timeline: [post('unknown'), post('unknown'), post('deleted')] } as any)
    const result = await snsService.getTimeline()
    expect(chatService.enrichSessionsContactInfo).toHaveBeenCalledExactlyOnceWith(['unknown', 'deleted'])
    expect(result.timeline?.map(row => row.avatarUrl)).toEqual(['weport-media://local/unknown.jpg', 'weport-media://local/unknown.jpg', 'weport-media://local/restored.jpg'])
  })
  it('keeps the timeline usable when native contact enrichment returns a failure', async () => {
    vi.mocked(chatService.enrichSessionsContactInfo).mockResolvedValueOnce({ success: false, contacts: {} })
    vi.mocked(wcdbService.getSnsTimeline).mockResolvedValue({ success: true, timeline: [post('author')] } as any)
    expect((await snsService.getTimeline()).timeline?.[0].avatarUrl).toBe('https://expired.qlogo.cn/avatar')
  })
})
