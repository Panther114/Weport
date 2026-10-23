import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./config', () => ({ ConfigService: class {
  getCacheBasePath() { return tmpdir() }
  get() { return '' }
} }))
vi.mock('./wcdbService', () => ({ wcdbService: { isConnected: vi.fn(async () => true), close: vi.fn(async () => undefined) } }))

import { chatService } from './chatService'
import { sourceFingerprint } from './export/sourceFingerprint'
import { wcdbService } from './wcdbService'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; vi.clearAllMocks() })

it.each(['database', 'WAL'] as const)('refreshes a connected scanned snapshot after fixture %s changes', async kind => {
  root = mkdtempSync(join(tmpdir(), 'weport-scanned-refresh-'))
  const accountDir = join(root, 'wxid_demo'), storage = join(accountDir, 'db_storage', 'session')
  mkdirSync(storage, { recursive: true })
  const db = join(storage, 'session.db')
  writeFileSync(db, Buffer.alloc(4096, 1))
  const snapshot = { identity: 'fixture-account', accountDir }
  const target = Object.create(Object.getPrototypeOf(chatService)) as any
  Object.assign(target, {
    connectionGeneration: 1, connectionQueue: Promise.resolve(), connectInFlight: null,
    connected: true, connectionIdentity: snapshot.identity, connectionMode: 'scanned-snapshot',
    scannedSourceFingerprint: await sourceFingerprint(accountDir),
    resolveConnectSnapshot: () => snapshot, isConnectSnapshotCurrent: () => true,
    clearConnectionState: vi.fn(() => { target.connected = false }),
    connectInternal: vi.fn(async () => ({ success: true, readOnlySnapshot: true })),
  })
  expect(await target.connect()).toEqual({ success: true, readOnlySnapshot: true })
  expect(target.connectInternal).not.toHaveBeenCalled()
  expect(wcdbService.close).not.toHaveBeenCalled()

  writeFileSync(kind === 'database' ? db : `${db}-wal`, Buffer.alloc(8192, 2))
  expect(await target.connect()).toEqual({ success: true, readOnlySnapshot: true })
  expect(target.clearConnectionState).toHaveBeenCalledOnce()
  expect(wcdbService.close).toHaveBeenCalledOnce()
  expect(target.connectInternal).toHaveBeenCalledWith(snapshot, 1)
})
