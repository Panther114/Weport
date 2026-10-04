import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config', () => ({ ConfigService: class {
  getCacheBasePath() { return process.env.TEMP || '.' }
  get() { return '' }
} }))
vi.mock('../../wcdbService', () => ({ wcdbService: {
  openMessageCursor: vi.fn(), fetchMessageBatch: vi.fn(), closeMessageCursor: vi.fn(),
  getMessageTableStats: vi.fn(), getSessionMessageCounts: vi.fn(),
  getDisplayNames: vi.fn(async () => ({ success: true, map: {} })),
  getAvatarUrls: vi.fn(async () => ({ success: true, map: {} })),
} }))
vi.mock('../../chatService', () => ({ chatService: {
  setRuntimeConfig: vi.fn(),
  getSessions: vi.fn(async () => ({ success: false, sessions: [] })),
} }))
vi.mock('../../imageDecryptService', () => ({ imageDecryptService: { setRuntimeConfig: vi.fn() } }))
vi.mock('../../exportRecordService', () => ({ exportRecordService: {} }))

import { ExportContext } from './ExportContext'
import { CONFIRMED_EMPTY_SESSION_SKIP } from './emptySession'
import { chatService } from '../../chatService'
import { wcdbService } from '../../wcdbService'

describe('empty-session cursor collection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the internal empty-skip marker only after both native sources explicitly report zero', async () => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: false, error: 'cursor init failed' })
    vi.mocked(wcdbService.getMessageTableStats).mockResolvedValue({ success: true, tables: [{ count: 0 }] })
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: { empty_room: 0 } })

    const collected = await new ExportContext().collectMessages('empty_room', 'wxid_me')

    expect(collected.error).toBe(CONFIRMED_EMPTY_SESSION_SKIP)
  })

  it('keeps cursor-open failures as failures when either native count is unknown or nonzero', async () => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: false, error: 'cursor init failed' })
    vi.mocked(wcdbService.getMessageTableStats).mockResolvedValue({ success: true, tables: [{ count: 0 }] })
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: {} })

    const unknown = await new ExportContext().collectMessages('empty_room', 'wxid_me')
    expect(unknown.error).toBe('cursor init failed')

    vi.mocked(wcdbService.getMessageTableStats).mockResolvedValue({ success: true, tables: [{ count: 1 }] })
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: { empty_room: 0 } })
    const nonzeroTable = await new ExportContext().collectMessages('empty_room', 'wxid_me')
    expect(nonzeroTable.error).toBe('cursor init failed')
  })

  it('also classifies an opened cursor with no rows as empty only when counts confirm zero', async () => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: true, cursor: 1 })
    vi.mocked(wcdbService.fetchMessageBatch).mockResolvedValue({ success: true, hasMore: false, rows: [] })
    vi.mocked(wcdbService.closeMessageCursor).mockResolvedValue({ success: true })
    vi.mocked(wcdbService.getMessageTableStats).mockResolvedValue({ success: true, tables: [] })
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: { empty_room: 0 } })

    const collected = await new ExportContext().collectMessages('empty_room', 'wxid_me')

    expect(collected.error).toBe(CONFIRMED_EMPTY_SESSION_SKIP)
    expect(wcdbService.closeMessageCursor).toHaveBeenCalledWith(1)
  })

  it('uses an explicit raw session-table zero only when native count-map coverage is missing', async () => {
    vi.mocked(wcdbService.openMessageCursor).mockResolvedValue({ success: false, error: 'cursor init failed' })
    vi.mocked(wcdbService.getMessageTableStats).mockResolvedValue({ success: true, tables: [] })
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: false, error: 'count key missing' })
    vi.mocked(chatService.getSessions).mockResolvedValue({
      success: true,
      sessions: [{ username: 'empty_room', messageCountHint: 0 }],
    } as any)

    const collected = await new ExportContext().collectMessages('empty_room', 'wxid_me')
    expect(collected.error).toBe(CONFIRMED_EMPTY_SESSION_SKIP)

    vi.mocked(chatService.getSessions).mockResolvedValue({
      success: true,
      sessions: [{ username: 'empty_room' }],
    } as any)
    const unknown = await new ExportContext().collectMessages('empty_room', 'wxid_me')
    expect(unknown.error).toBe('cursor init failed')
  })
})
