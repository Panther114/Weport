import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExportOrchestrator } from './ExportOrchestrator'
import { createFakeOrchestratorContext } from './fakeOrchestratorContext'
import type { ExportOptions, ExportProgress } from '../types'
import * as mediaHashes from '../mediaDedupeCache'
import { runBoundedPool } from '../utils/parallelLimit'
import { mkdirSync, writeFileSync } from 'node:fs'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const options: ExportOptions = { format: 'txt', exportMedia: false, exportConcurrency: 2, exportWriteLayout: 'B', sessionLayout: 'per-session' }
function fixture(count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'weport-export-lifecycle-')); roots.push(root)
  const sessions = Array.from({ length: count }, (_, index) => ({ sessionId: `room${index}`, displayName: `Room ${index}`, messages: [{ id: index + 1, ts: index + 1, sender: 'me', text: 'fixture' }] }))
  return { root, sessions, ...createFakeOrchestratorContext({ sessions }) }
}

describe('export orchestration lifecycle', () => {
  it('drains active writers before releasing runtime state after another session throws', async () => {
    const x = fixture(3), first = deferred(), second = deferred(), bothStarted = deferred()
    const clear = vi.spyOn(x.context, 'clearMediaRuntimeState')
    const started: string[] = []
    vi.spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt').mockImplementation(async (...args) => {
      started.push(args[0]); if (started.length === 2) bothStarted.resolve()
      if (args[0] === 'room0') { await first.promise; throw new Error('fixture first writer failure') }
      await second.promise
      return x.exportSessionImplementation(...args)
    })
    let settled = false
    const running = new ExportOrchestrator(x.context).exportSessions(x.sessions.map(row => row.sessionId), x.root, options).finally(() => { settled = true })
    await bothStarted.promise
    first.resolve()
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(clear).not.toHaveBeenCalled()
    expect([...started].sort()).toEqual(['room0', 'room1'])
    second.resolve()
    const result = await running
    expect(clear).toHaveBeenCalledOnce()
    expect(result.success).toBe(false)
    expect(result.successSessionIds).toEqual(['room1'])
    expect(result.pendingSessionIds).toEqual(['room0', 'room2'])
    expect([...started].sort()).toEqual(['room0', 'room1'])
  })

  it('keeps progress below completion while the root manifest is still being written', async () => {
    const x = fixture(), writing = deferred(), release = deferred()
    const write = x.context.writeArtifactFile.bind(x.context)
    vi.spyOn(x.context, 'writeArtifactFile').mockImplementation(async (file, content) => {
      if (file.endsWith('export-manifest.json')) { writing.resolve(); await release.promise }
      return write(file, content)
    })
    vi.spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt').mockImplementation(x.exportSessionImplementation)
    const progress: ExportProgress[] = []
    const running = new ExportOrchestrator(x.context).exportSessions(['room0'], x.root, options, row => progress.push(row))
    await writing.promise
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every(row => row.current < row.total && row.phase !== 'complete')).toBe(true)
    expect(progress.at(-1)?.phaseLabel).toContain('清单')
    release.resolve()
    expect((await running).success).toBe(true)
    expect(progress.at(-1)).toMatchObject({ current: 1, total: 1, phase: 'complete' })
  })

  it('reports pre-cancelled work as stopped without connecting or losing pending sessions', async () => {
    const x = fixture(2), connect = vi.spyOn(x.context, 'ensureConnected')
    const result = await new ExportOrchestrator(x.context).exportSessions(['room0', 'room1'], x.root, options, undefined, { shouldStop: () => true })
    expect(result).toMatchObject({ success: true, stopped: true, pendingSessionIds: ['room0', 'room1'] })
    expect(connect).not.toHaveBeenCalled()
  })

  it('honors a pause requested during finalization and emits no terminal completion', async () => {
    const x = fixture(), write = x.context.writeArtifactFile.bind(x.context)
    let paused = false
    vi.spyOn(x.context, 'writeArtifactFile').mockImplementation(async (file, content) => {
      const result = await write(file, content)
      if (file.endsWith('export-manifest.json')) paused = true
      return result
    })
    vi.spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt').mockImplementation(x.exportSessionImplementation)
    const progress: ExportProgress[] = []
    const result = await new ExportOrchestrator(x.context).exportSessions(['room0'], x.root, options, row => progress.push(row), { shouldPause: () => paused })
    expect(result).toMatchObject({ success: true, paused: true, pendingSessionIds: [], successSessionIds: ['room0'] })
    expect(progress.some(row => row.phase === 'complete')).toBe(false)
  })
})


it('does not commit an empty skip-authorizing inventory when attachment hashing fails', async () => {
  const x = fixture()
  vi.spyOn(x.context, 'isMediaExportEnabled').mockReturnValue(true)
  const hash = vi.spyOn(mediaHashes, 'hashFileContent').mockResolvedValueOnce(null)
  vi.spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt').mockImplementation(async (...args) => {
    const result = await x.exportSessionImplementation(...args)
    const layout = x.context.getMediaLayout(args[1], args[2])
    const directory = join(layout.mediaRootDir, layout.mediaRelativePrefix, 'images')
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'fixture.png'), 'fixture')
    return result
  })
  const orchestrator = new ExportOrchestrator(x.context)
  const mediaOptions = { ...options, exportMedia: true, exportImages: true, exportConflictStrategy: 'incremental' as const }
  expect((await orchestrator.exportSessions(['room0'], x.root, mediaOptions)).success).toBe(true)
  expect(hash).toHaveBeenCalledOnce()
  expect((await orchestrator.exportSessions(['room0'], x.root, mediaOptions)).success).toBe(true)
  expect(x.exportedSessions).toHaveLength(2)
})


it.each(['shouldStop', 'shouldPause'] as const)('drains an active callback when %s throws', async predicate => {
  const active = deferred(), error = new Error('fixture predicate failure')
  let checks = 0, settled = false
  const called: number[] = []
  const running = runBoundedPool([0, 1, 2], {
    concurrency: 2,
    [predicate]: () => { checks++; if (checks === 2) throw error; return false },
  }, async value => { called.push(value); await active.promise; return 'complete' }).finally(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  expect(called).toEqual([0])
  active.resolve()
  await expect(running).rejects.toBe(error)
  expect(called).toEqual([0])
})
