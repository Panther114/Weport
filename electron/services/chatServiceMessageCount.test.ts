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

const connectTarget = (decryptKey: string, dbKeyStore: unknown = { accounts: {} }) => {
  const target = Object.create(Object.getPrototypeOf(chatService)) as any
  const accountDir = 'D:\\xwechat_files\\wxid_demo_0000'
  const values: Record<string, unknown> = {
    myWxid: 'wxid_demo_0000',
    dbPath: 'D:\\xwechat_files',
    decryptKey,
    dbKeyStore,
  }
  target.configService = {
    get: (key: string) => values[key],
    getAccountDir: () => accountDir,
  }
  target.runtimeConfig = { myWxid: 'wxid_demo_0000', dbPath: 'D:\\xwechat_files', decryptKey }
  target.connectionGeneration = 1
  target.describeInitFailure = vi.fn(() => 'account-key-invalid')
  target.maybeShowInitFailureDialog = vi.fn(async () => undefined)
  return { target, snapshot: target.resolveConnectSnapshot(), accountDir }
}

function installConnectMocks(openResult = false) {
  const service = wcdbService as unknown as Record<string, any>
  service.open = vi.fn(async () => openResult)
  service.openScanned = vi.fn(async () => ({ success: true, sourceFingerprint: 'mirror-fingerprint' }))
  service.getLastInitError = vi.fn(async () => 'native account-key failure')
  service.close = vi.fn(async () => undefined)
  return service
}

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

describe('V1.2 stable release does not connect through a scanned mirror', () => {
  it('does not open a scanned mirror when the account-level key is blank, even with stored page keys', async () => {
    const service = installConnectMocks()
    const staleStore = {
      accounts: {
        wxid_demo_0000: {
          passphrase: '',
          dbKeys: {
            'session/session.db': { key: `safe:${'a1'.repeat(32)}`, verified: true, source: 'scan' },
          },
        },
      },
    }
    const { target, snapshot } = connectTarget('', staleStore)

    const result = await target.connectInternal(snapshot, 1)

    expect(result.success).toBe(false)
    expect(result.error).toContain('账号级密钥')
    expect(result.error).toContain('登录捕获')
    expect(service.open).not.toHaveBeenCalled()
    expect(service.openScanned).not.toHaveBeenCalled()
  })

  it('does not fall back to stale per-DB keys after an account-level key fails', async () => {
    const service = installConnectMocks(false)
    const staleStore = {
      accounts: {
        wxid_demo_0000: {
          passphrase: `safe:${'b2'.repeat(32)}`,
          dbKeys: {
            'session/session.db': { key: `safe:${'a1'.repeat(32)}`, verified: true, source: 'scan' },
            'message/message_0.db': { key: `safe:${'c3'.repeat(32)}`, verified: true, source: 'scan' },
          },
        },
      },
    }
    const { target, snapshot } = connectTarget('d4'.repeat(32), staleStore)

    const result = await target.connectInternal(snapshot, 1)

    expect(result.success).toBe(false)
    expect(result.error).toContain('account-key-invalid')
    if (process.platform === 'win32') {
      expect(result.error).toContain('登录捕获')
      expect(result.error).not.toContain('V1.3')
    }
    expect(service.open).toHaveBeenCalledTimes(1)
    expect(service.openScanned).not.toHaveBeenCalled()
  })
})
