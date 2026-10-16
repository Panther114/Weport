import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ExportOrchestrator } from './ExportOrchestrator'
import { createFakeOrchestratorContext } from './fakeOrchestratorContext'
import { CONFIRMED_EMPTY_SESSION_SKIP } from './emptySession'
import type { ExportOptions, ExportProgress } from '../types'

let root = ''
afterEach(() => {
  vi.restoreAllMocks()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

const options: ExportOptions = {
  format: 'txt',
  contentType: 'text',
  exportMedia: false,
  exportWriteLayout: 'B',
  exportConflictStrategy: 'overwrite',
  sessionLayout: 'shared',
  sessionNameWithTypePrefix: false,
  exportConcurrency: 1,
}

describe('confirmed empty-session orchestration', () => {
  it('reports an explicit successful skip without creating an empty artifact', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-empty-session-'))
    const outputRoot = path.join(root, 'out')
    const harness = createFakeOrchestratorContext({ sessions: [{ sessionId: 'empty_room', displayName: 'Empty', messages: [] }] })
    vi.spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt').mockResolvedValue({
      success: false,
      error: CONFIRMED_EMPTY_SESSION_SKIP,
    })
    const progress: ExportProgress[] = []

    const result = await new ExportOrchestrator(harness.context).exportSessions(
      ['empty_room'], outputRoot, options, (event) => progress.push(event),
    )

    expect(result).toMatchObject({
      success: true,
      successCount: 1,
      failCount: 0,
      successSessionIds: [],
      emptySkippedSessionIds: ['empty_room'],
    })
    expect(result.sessionOutputPaths?.empty_room).toBeUndefined()
    expect(fs.existsSync(path.join(outputRoot, 'Empty.txt'))).toBe(false)
    expect(progress.some((event) => event.phaseLabel === '已确认无消息，成功跳过')).toBe(true)
  })

  it('does not claim an empty skip when a previous artifact exists', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-empty-session-existing-'))
    const outputRoot = path.join(root, 'out')
    fs.mkdirSync(outputRoot, { recursive: true })
    const previousArtifact = path.join(outputRoot, 'Empty.txt')
    fs.writeFileSync(previousArtifact, 'previously exported message')
    const harness = createFakeOrchestratorContext({ sessions: [{ sessionId: 'empty_room', displayName: 'Empty', messages: [] }] })
    vi.spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt').mockResolvedValue({
      success: false,
      error: CONFIRMED_EMPTY_SESSION_SKIP,
    })

    const result = await new ExportOrchestrator(harness.context).exportSessions(['empty_room'], outputRoot, {
      ...options,
      exportConflictStrategy: 'rename',
    })

    expect(result).toMatchObject({ success: false, successCount: 0, failCount: 1 })
    expect(result.emptySkippedSessionIds).toEqual([])
    expect(result.failedSessionErrors?.empty_room).toContain('旧产物')
    expect(fs.readFileSync(previousArtifact, 'utf8')).toBe('previously exported message')
  })
})
