import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, (_event: unknown, ...args: any[]) => Promise<any>>(),
  config: { accountId: 'wxid_abc123_a1b2', cleanedAccountId: 'wxid_abc123' },
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.root, getAppPath: () => state.root, isPackaged: false },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (_event: unknown, ...args: any[]) => Promise<any>) => state.handlers.set(channel, handler) },
}))
vi.mock('../export', () => ({ exportService: { setRuntimeConfig: vi.fn(), exportSessions: vi.fn() } }))
vi.mock('../exportTaskControlService', () => ({ exportTaskControlService: { hasActiveTasks: () => false, createControl: () => ({}), releaseTask: vi.fn() } }))
vi.mock('../chatService', () => ({ chatService: { connect: async () => ({ success: true }), isReadOnlySnapshot: () => false } }))
vi.mock('../export/sourceFingerprint', () => ({ sourceFingerprint: async () => 'fixture-source' }))
vi.mock('../taskStatusService', () => ({ taskStatusService: { get: () => ({ status: 'idle' }), begin: vi.fn(), progress: vi.fn(), end: vi.fn() } }))

import { registerArchiveIpc } from './archiveIpc'
import type { ConfigService } from '../config'
import type { ArchiveRequest } from './types'

describe('archive IPC account identity', () => {
  let root = ''
  let library: ReturnType<typeof registerArchiveIpc> | undefined

  afterEach(async () => {
    library?.stop()
    library = undefined
    state.handlers.clear()
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
    state.root = ''
  })

  it('compares the request with the full configured wxid, not its lossy directory prefix', async () => {
    root = await mkdtemp(join(tmpdir(), 'weport-archive-ipc-'))
    state.root = root
    state.config.accountId = 'wxid_abc123_a1b2'
    state.config.cleanedAccountId = 'wxid_abc123'
    const config = {
      get: (key: string) => key === 'myWxid' ? state.config.accountId : '',
      getMyWxidCleaned: () => state.config.cleanedAccountId,
      getAccountDir: () => join(root, 'wxid_abc123_a1b2'),
    } as unknown as ConfigService
    library = registerArchiveIpc({
      config: () => config,
      annotations: () => ({ list: () => ({ favorites: [], marks: [], tags: {} }) }) as any,
      resources: () => root,
      guardExport: async () => {},
    })
    const request: ArchiveRequest = {
      accountId: 'wxid_abc123_a1b2', destination: join(root, 'archives'),
      sessionIds: ['chat'], includeMedia: false, mediaPolicy: 'best-available',
    }
    const invoke = state.handlers.get('archive:preflight')!

    const sameFullAccount = await invoke({}, request)
    expect(sameFullAccount.success).toBe(true)
    expect(sameFullAccount.data.ok).toBe(true)

    state.config.accountId = 'wxid_abc123'
    const prefixOnly = await invoke({}, request)
    expect(prefixOnly.success).toBe(true)
    expect(prefixOnly.data.ok).toBe(false)
    expect(prefixOnly.data.errors.join(' ')).toContain('账号已切换')
  })
})
