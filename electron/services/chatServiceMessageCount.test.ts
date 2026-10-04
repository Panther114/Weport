import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config', () => ({ ConfigService: class {
  getCacheBasePath() { return process.env.TEMP || '.' }
  get() { return '' }
} }))
vi.mock('./wcdbService', () => ({ wcdbService: { getSessionMessageCounts: vi.fn(), getMessageCounts: vi.fn() } }))

import { chatService, parseExplicitMessageCountHint } from './chatService'
import { wcdbService } from './wcdbService'

const countByTableScan = Object.getPrototypeOf(chatService).countSessionMessageCountsByTableScan
const getSessionMessageCounts = Object.getPrototypeOf(chatService).getSessionMessageCounts
const fake = () => ({
  getMessageDbCountSnapshot: vi.fn(async () => ({ success: true, dbPaths: [], dbSignature: 'fixture-signature' })),
  buildMessageDbSignature: vi.fn(() => 'fixture-signature'),
  logExportDiag: vi.fn(),
})
const fallbackTarget = () => ({
  normalizeExportDiagTraceId: vi.fn(() => undefined),
  startExportDiagStep: vi.fn(() => 0),
  endExportDiagStep: vi.fn(),
  ensureConnected: vi.fn(async () => ({ success: true })),
  refreshSessionMessageCountCacheScope: vi.fn(),
  sessionMessageCountCache: new Map(),
  sessionMessageCountHintCache: new Map(),
  sessionMessageCountBatchCache: null,
  sessionMessageCountCacheTtlMs: 0,
  sessionMessageCountBatchCacheTtlMs: 0,
  countSessionMessageCountsByTableScan: vi.fn(async () => ({ success: false, error: 'table scan unavailable' })),
  logExportDiag: vi.fn(),
})

describe('explicit message-count hints', () => {
  it('accepts only explicit whole nonnegative counts', () => {
    expect(parseExplicitMessageCountHint(0)).toBe(0)
    expect(parseExplicitMessageCountHint('0')).toBe(0)
    expect(parseExplicitMessageCountHint(' 12 ')).toBe(12)
    expect(parseExplicitMessageCountHint(null)).toBeUndefined()
    expect(parseExplicitMessageCountHint(undefined)).toBeUndefined()
    expect(parseExplicitMessageCountHint('')).toBeUndefined()
    expect(parseExplicitMessageCountHint('   ')).toBeUndefined()
    expect(parseExplicitMessageCountHint(0.5)).toBeUndefined()
    expect(parseExplicitMessageCountHint('0.5')).toBeUndefined()
    expect(parseExplicitMessageCountHint(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined()
  })
})

describe('ChatService message count adapter preserves unknown values', () => {
  beforeEach(() => {
    vi.mocked(wcdbService.getSessionMessageCounts).mockReset()
    vi.mocked(wcdbService.getMessageCounts).mockReset()
  })

  it('fails when the native adapter omits a requested session', async () => {
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: {} })
    const result = await countByTableScan.call(fake(), ['room'])
    expect(result).toMatchObject({ success: false })
  })

  it('preserves an explicit native zero count', async () => {
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: { room: 0 } })
    const result = await countByTableScan.call(fake(), ['room'])
    expect(result).toMatchObject({ success: true, counts: { room: 0 }, dbSignature: 'fixture-signature' })
  })

  it('propagates native count errors instead of manufacturing zero', async () => {
    vi.mocked(wcdbService.getSessionMessageCounts).mockResolvedValue({ success: false, error: 'native status 9' })
    const result = await countByTableScan.call(fake(), ['room'])
    expect(result).toMatchObject({ success: false, error: 'native status 9' })
  })

  it('does not turn a failed legacy batch count into successful zero counts', async () => {
    vi.mocked(wcdbService.getMessageCounts).mockResolvedValue({ success: false, error: 'native count status 9' })
    const result = await getSessionMessageCounts.call(fallbackTarget(), ['room'], {
      preferHintCache: false,
      bypassSessionCache: true,
    })
    expect(result).toMatchObject({ success: false, error: 'native count status 9' })
  })

  it('preserves an explicit legacy batch zero count', async () => {
    vi.mocked(wcdbService.getMessageCounts).mockResolvedValue({ success: true, counts: { room: 0 } })
    const result = await getSessionMessageCounts.call(fallbackTarget(), ['room'], {
      preferHintCache: false,
      bypassSessionCache: true,
    })
    expect(result).toMatchObject({ success: true, counts: { room: 0 } })
  })
})
