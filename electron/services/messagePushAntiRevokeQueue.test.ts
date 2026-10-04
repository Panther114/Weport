import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  autoEnabled: true,
  context: { identity: 'account-a', generation: 0 },
  checkGate: null as null | (() => Promise<any>),
  installGate: null as null | (() => Promise<void>),
  installStarted: null as null | (() => void),
  nativeWrites: [] as Array<{ account: string; sessionId: string }>,
}))

vi.mock('./config', () => ({
  ConfigService: {
    getInstance: () => ({
      getCacheBasePath: () => '.',
      get: (key: string) => key === 'antiRevokeAutoApplyNewGroups' ? state.autoEnabled : false,
    }),
  },
}))

vi.mock('./chatService', () => ({
  chatService: {
    captureAntiRevokeContext: vi.fn(() => ({ ...state.context })),
    isAntiRevokeContextCurrent: vi.fn((context: { identity: string; generation: number }) =>
      context.identity === state.context.identity && context.generation === state.context.generation
    ),
    checkAntiRevokeTriggers: vi.fn(async () => state.checkGate
      ? state.checkGate()
      : { success: true, rows: [{ sessionId: 'new@chatroom', success: true, installed: false }] }),
    installAntiRevokeTriggers: vi.fn(async (
      sessionIds: string[],
      _context: { identity: string; generation: number },
      shouldContinue: () => boolean
    ) => {
      state.installStarted?.()
      if (state.installGate) await state.installGate()
      if (!shouldContinue()) return { success: false, error: 'stale auto-install lease' }
      state.nativeWrites.push(...sessionIds.map((sessionId) => ({ account: state.context.identity, sessionId })))
      return { success: true, rows: sessionIds.map((sessionId) => ({ sessionId, success: true })) }
    }),
    isReadOnlySnapshot: () => false,
    close: vi.fn(),
    connect: vi.fn(async () => ({ success: true })),
  },
}))

vi.mock('./wcdbService', () => ({ wcdbService: {} }))
vi.mock('./avatarCacheService', () => ({ avatarCacheService: {} }))

import { chatService } from './chatService'
import { MessagePushService } from './messagePushService'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function createService() {
  const service = new MessagePushService()
  ;(service as any).started = true
  ;(service as any).pendingAntiRevokeNewGroupsSessionIds.add('new@chatroom')
  return service
}

describe('automatic anti-revoke queue guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.autoEnabled = true
    state.context = { identity: 'account-a', generation: 0 }
    state.checkGate = null
    state.installGate = null
    state.installStarted = null
    state.nativeWrites = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not install when the opt-in is disabled while a status check is pending', async () => {
    const gate = deferred<any>()
    state.checkGate = () => gate.promise
    const service = createService()
    const flush = (service as any).flushAntiRevokeNewGroupsQueue() as Promise<void>

    expect(chatService.checkAntiRevokeTriggers).toHaveBeenCalledOnce()
    state.autoEnabled = false
    await service.handleConfigChanged('antiRevokeAutoApplyNewGroups')
    gate.resolve({ success: true, rows: [{ sessionId: 'new@chatroom', success: true, installed: false }] })
    await flush

    expect(chatService.installAntiRevokeTriggers).not.toHaveBeenCalled()
    expect(state.nativeWrites).toEqual([])
  })

  it('does not write captured IDs into a new account if the account changes during install preparation', async () => {
    const gate = deferred<void>()
    const started = deferred<void>()
    state.installGate = () => gate.promise
    state.installStarted = () => started.resolve()
    const service = createService()
    const flush = (service as any).flushAntiRevokeNewGroupsQueue() as Promise<void>
    await started.promise

    state.context = { identity: 'account-b', generation: 1 }
    gate.resolve()
    await flush

    expect(chatService.installAntiRevokeTriggers).toHaveBeenCalledWith(
      ['new@chatroom'],
      { identity: 'account-a', generation: 0 },
      expect.any(Function)
    )
    expect(state.nativeWrites).toEqual([])
  })
})
