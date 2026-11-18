import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ account: 'A' }))
vi.mock('electron', () => ({ app: {}, net: {} }))
vi.mock('./config', () => ({ ConfigService: class {
  get(key: string) { return key === 'myWxid' ? state.account : key === 'dbPath' ? `/fixture/${state.account}` : key === 'decryptKey' ? 'fixture-key' : [] }
  getMyWxidCleaned() { return state.account }
  getAccountDir() { return `/fixture/${state.account}` }
} }))
vi.mock('./avatarCacheService', () => ({ avatarCacheService: {}, protocolUrlToPath: vi.fn() }))
vi.mock('./chatService', () => ({ chatService: {} }))
vi.mock('./wcdbService', () => ({ wcdbService: {
  open: vi.fn(async () => true), getGroupStats: vi.fn(), openMessageCursor: vi.fn(),
  fetchMessageBatch: vi.fn(), closeMessageCursor: vi.fn(async () => ({ success: true })),
  listMessageDbs: vi.fn(), getSessionMessageCounts: vi.fn(),
} }))
import { analyticsService } from './analyticsService'
import { groupAnalyticsService } from './groupAnalyticsService'
import { wcdbService } from './wcdbService'

describe('analytics account isolation, cursor errors and bounded scans', () => {
  beforeEach(() => {
    state.account = 'A'
    vi.clearAllMocks()
    vi.mocked(wcdbService.fetchMessageBatch).mockReset()
    vi.mocked(wcdbService.openMessageCursor).mockReset()
    vi.mocked(wcdbService.listMessageDbs).mockReset()
    vi.mocked(wcdbService.getSessionMessageCounts).mockReset()
    const analytics = analyticsService as any
    analytics.wordFrequencyCache = null
    analytics.selfSentDailyCache = null
    analytics.getPrivateSessions = vi.fn(async () => ({ usernames: ['shared@chatroom'], revision: 'fixture' }))
    ;(groupAnalyticsService as any).groupStatsCache.clear()
    ;(groupAnalyticsService as any).groupStatsInFlight.clear()
  })

  it('uses fresh account B statistics for a shared group', async () => {
    vi.mocked(wcdbService.getGroupStats).mockImplementation(async () => ({ success: true, data: { hourly: { 0: state.account === 'A' ? 7 : 99 } } }) as any)
    expect((await groupAnalyticsService.getGroupActiveHours('shared@chatroom')).data?.hourlyDistribution[0]).toBe(7)
    state.account = 'B'
    const second = await groupAnalyticsService.getGroupActiveHours('shared@chatroom')
    expect(second.data?.hourlyDistribution[0]).toBe(99)
    expect(wcdbService.getGroupStats).toHaveBeenCalledTimes(2)
    expect(wcdbService.open).toHaveBeenLastCalledWith('/fixture/B', 'fixture-key')
  })

  it('closes the cursor without fetching another page once the word-frequency cap is reached', async () => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: true, cursor: 1 } as any)
    vi.mocked(wcdbService.fetchMessageBatch)
      .mockResolvedValueOnce({ success: true, rows: Array(150000).fill({ is_send: 1, local_type: 1, content: '' }), hasMore: true } as any)
      .mockResolvedValueOnce({ success: true, rows: [{ is_send: 1, local_type: 1, content: '' }], hasMore: false } as any)
    const result = await analyticsService.getWordFrequency()
    expect(result.success).toBe(true)
    expect(result.data?.scannedMessages).toBe(150000)
    expect(wcdbService.fetchMessageBatch).toHaveBeenCalledTimes(1)
    expect(wcdbService.closeMessageCursor).toHaveBeenCalledOnce()
  })

  it('reports cursor-open failure without caching an empty successful word cloud', async () => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: false, error: 'synthetic cursor failure' } as any)
    const result = await analyticsService.getWordFrequency()
    expect(result.success).toBe(false)
    expect(result.error).toContain('synthetic cursor failure')
    expect((analyticsService as any).wordFrequencyCache).toBeNull()
  })

  it.each(['trends', 'words'])('continues %s past a verified empty synchronized session', async (feature) => {
    ;(analyticsService as any).getPrivateSessions.mockResolvedValue({ usernames: ['empty', 'history'], revision: 'fixture' })
    vi.mocked(wcdbService.openMessageCursor)
      .mockResolvedValueOnce({ success: false, errorCode: -3, error: 'no message database' })
      .mockResolvedValueOnce({ success: true, cursor: 2 })
    vi.mocked(wcdbService.listMessageDbs).mockResolvedValue({ success: true, data: ['message_0.db'] })
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: { empty: 0 } })
    vi.mocked(wcdbService.fetchMessageBatch).mockResolvedValue({ success: true, rows: [
      { is_send: 1, local_type: 1, content: 'hello world', create_time: 1700000000 },
      { is_send: 0, local_type: 1, content: 'received only', create_time: 1700000000 },
    ], hasMore: false })
    if (feature === 'trends') {
      const result = await analyticsService.getSelfSentDailyDistribution()
      expect(result.success).toBe(true)
      expect(result.data?.totalMessages).toBe(1)
    } else {
      const result = await analyticsService.getWordFrequency()
      expect(result.success).toBe(true)
      expect(result.data?.scannedMessages).toBe(1)
      expect(result.data?.items.length).toBeGreaterThan(0)
    }
    expect(wcdbService.getSessionMessageCounts).toHaveBeenCalledWith(['empty'])
    expect(wcdbService.closeMessageCursor).toHaveBeenCalledExactlyOnceWith(2)
  })

  it.each([
    { store: { success: true, data: [] }, count: { success: true, counts: { 'shared@chatroom': 0 } } },
    { store: { success: false }, count: { success: true, counts: { 'shared@chatroom': 0 } } },
    { store: { success: true, data: ['message_0.db'] }, count: { success: false } },
    { store: { success: true, data: ['message_0.db'] }, count: { success: true, counts: {} as Record<string, number> } },
    { store: { success: true, data: ['message_0.db'] }, count: { success: true, counts: { 'shared@chatroom': 5 } } },
  ])('preserves -3 when an empty history cannot be confirmed (%j)', async ({ store, count }) => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: false, errorCode: -3, error: 'no message database' })
    vi.mocked(wcdbService.listMessageDbs).mockResolvedValue(store)
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue(count)
    const result = await analyticsService.getWordFrequency()
    expect(result.success).toBe(false)
    expect(result.error).toContain('no message database')
    expect((analyticsService as any).wordFrequencyCache).toBeNull()
  })

  it('rejects an account switch during empty-history verification', async () => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: false, errorCode: -3 })
    vi.mocked(wcdbService.listMessageDbs).mockResolvedValue({ success: true, data: ['message_0.db'] })
    vi.mocked(wcdbService.getSessionMessageCounts).mockImplementation(async () => {
      state.account = 'B'
      return { success: true, counts: { 'shared@chatroom': 0 } }
    })
    const result = await analyticsService.getWordFrequency()
    expect(result.success).toBe(false)
    expect(result.error).toContain('账号已切换')
    expect((analyticsService as any).wordFrequencyCache).toBeNull()
  })

  it('reports a failed later cursor page without publishing partial results as complete', async () => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: true, cursor: 1 } as any)
    vi.mocked(wcdbService.fetchMessageBatch)
      .mockResolvedValueOnce({ success: true, rows: [{ is_send: 1, local_type: 1, content: 'hello world' }], hasMore: true } as any)
      .mockResolvedValueOnce({ success: false, error: 'synthetic page failure' } as any)
    const result = await analyticsService.getWordFrequency()
    expect(result.success).toBe(false)
    expect(result.data).toBeUndefined()
    expect(result.error).toContain('synthetic page failure')
    expect(wcdbService.closeMessageCursor).toHaveBeenCalledOnce()
  })
})
