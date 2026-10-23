import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeBotService } from './weBotService'
import { collectDigestBatch } from './weBotDigestCollector'
import { digestRelevantEvidence, normalizeDigestLimits, type DigestBatch, type DigestConfig } from './weBotDigest'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
const config = (): DigestConfig => ({ template: 'weekly-highlights', scope: { accountId: 'A', sessionIds: ['chat'], startTime: 0 }, limits: normalizeDigestLimits() })
const batch = (): DigestBatch => ({ evidence: [{ id: 'message-1', sessionId: 'chat', timestamp: 10, text: 'Decision confirmed', sourceUrl: `weport-evidence:${'a'.repeat(64)}` }], cursors: { chat: { timestamp: 10, identities: ['message-1'] } }, hasMore: false })
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'weport-digest-test-')); dirs.push(dir)
  let account = 'A'
  const dispatch = vi.fn(async () => ({ summary: 'A source-backed result' }))
  const collect = vi.fn(async () => batch())
  const notify = vi.fn()
  const options = { dataDir: dir, currentAccountId: () => account, dispatch, collectDigest: collect, notify }
  const service = new WeBotService(options)
  const task = service.createTask({ title: 'Delta', schedule: { kind: 'daily', hour: 8, minute: 0 }, references: [{ id: 'chat', label: 'Chat', kind: 'private' }], digest: config() })
  return { service, task, dispatch, collect, notify, options, setAccount: (value: string) => { account = value } }
}
describe('persisted scoped WeBot delta commits', () => {
  it('commits a note and watermark together and suppresses retries across restart', async () => {
    const x = setup()
    await x.service.runNow(x.task.id)
    expect(x.service.listTasks()[0].digestState?.cursors.chat.timestamp).toBe(10)
    expect(x.service.listNotes()).toHaveLength(1)
    const reopened = new WeBotService(x.options)
    await reopened.runNow(x.task.id)
    expect(x.dispatch).toHaveBeenCalledOnce()
    expect(x.notify).toHaveBeenCalledOnce()
    expect(reopened.listNotes()).toHaveLength(1)
    expect(reopened.listRuns()[0].outcome).toBe('duplicate')
  })
  it('does not advance a watermark or create a note on provider failure; retry commits once', async () => {
    const x = setup(); x.dispatch.mockRejectedValueOnce(new Error('Provider failed'))
    await x.service.runNow(x.task.id)
    expect(x.service.listTasks()[0].digestState).toBeUndefined()
    expect(x.service.listNotes()).toEqual([])
    await x.service.runNow(x.task.id)
    expect(x.service.listNotes()).toHaveLength(1)
    expect(x.service.listTasks()[0].digestState?.commits).toHaveLength(1)
  })
  it('rolls back note and cursor when durable commit fails', async () => {
    const x = setup(), original = x.service['persist'].bind(x.service)
    const persistence = vi.spyOn(x.service as any, 'persist').mockImplementation((strict: unknown) => { if (strict) throw new Error('Disk full'); original() })
    await x.service.runNow(x.task.id)
    expect(x.service.listNotes()).toEqual([])
    expect(x.service.listTasks()[0].digestState).toBeUndefined()
    expect(x.service.listRuns()[0].status).toBe('error')
    persistence.mockRestore()
    await x.service.runNow(x.task.id)
    expect(x.service.listNotes()).toHaveLength(1)
  })
  it('suppresses model requests, notes and notifications for unchanged or irrelevant text', async () => {
    const x = setup()
    const task = x.service.listTasks()[0]
    // New task uses a question template; statements have no question cues.
    const y = x.service.createTask({ ...task, title: 'Questions', digest: { ...config(), template: 'unanswered-questions' } })
    await x.service.runNow(y.id)
    expect(x.dispatch).not.toHaveBeenCalled()
    expect(x.notify).not.toHaveBeenCalled()
    expect(x.service.listNotes()).toEqual([])
    expect(x.service.listRuns()[0].outcome).toBe('no-change')
    expect(x.service.listTasks().find(t => t.id === y.id)?.digestState?.cursors.chat.timestamp).toBe(10)
  })
  it('rejects another account before collecting and rejects an account switch before committing', async () => {
    const x = setup(); x.setAccount('B')
    await x.service.runNow(x.task.id)
    expect(x.collect).not.toHaveBeenCalled(); expect(x.dispatch).not.toHaveBeenCalled()
    x.setAccount('A')
    x.dispatch.mockImplementationOnce(async () => { x.setAccount('B'); return { summary: 'Must not commit' } })
    await x.service.runNow(x.task.id)
    expect(x.service.listNotes()).toEqual([])
    expect(x.service.listTasks()[0].digestState).toBeUndefined()
  })
  it('prevents editing immutable source scope and externally setting the watermark', () => {
    const x = setup()
    expect(() => x.service.updateTask(x.task.id, { references: [{ id: 'other', label: 'Other', kind: 'private' }] })).toThrow('范围')
    expect(() => x.service.updateTask(x.task.id, { digestState: { cursors: {}, commits: [] } })).toThrow('水位')
    x.task.digest!.scope.sessionIds.push('other')
    expect(x.service.listTasks()[0].digest?.scope.sessionIds).toEqual(['chat'])
  })
  it('rejects evidence outside the selected sessions and oversized input before a model call', async () => {
    const x = setup(); x.collect.mockResolvedValueOnce({ ...batch(), evidence: [{ ...batch().evidence[0], sessionId: 'other' }] })
    await x.service.runNow(x.task.id)
    expect(x.dispatch).not.toHaveBeenCalled()
    x.collect.mockResolvedValueOnce({ ...batch(), evidence: [{ ...batch().evidence[0], text: 'x'.repeat(24001) }] })
    await x.service.runNow(x.task.id)
    expect(x.dispatch).not.toHaveBeenCalled()
    expect(x.service.listTasks()[0].digestState).toBeUndefined()
  })
  it('prevents concurrent manual retries for the same task', async () => {
    const x = setup(); let finish!: () => void
    x.dispatch.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ summary: 'Result' }) }))
    const running = x.service.runNow(x.task.id)
    await vi.waitFor(() => expect(x.dispatch).toHaveBeenCalledOnce())
    expect(await x.service.runNow(x.task.id)).toMatchObject({ success: false })
    finish(); await running
    expect(x.service.listNotes()).toHaveLength(1)
  })
})

it('collects same-timestamp deltas without omissions and preserves exact source identities', async () => {
  const x = setup(), task = x.task
  task.digest!.limits.maxMessages = 2
  const rows = [1, 2, 3, 4].map(id => ({ createTime: id < 4 ? 10 : 11, localIdRaw: String(id), parsedContent: `Message ${id}`, _db_path: 'account/db_storage/message/message_0.db', _table_name: 'Msg_chat' }))
  const deps = { currentAccountId: () => 'A', now: () => 20000,
    registerEvidence: () => `weport-evidence:${'a'.repeat(64)}`,
    getMessages: vi.fn(async (_sid: string, offset: number, limit: number, start: number) => {
      const filtered = rows.filter(row => row.createTime * 1000 >= start)
      return { success: true, messages: filtered.slice(offset, offset + limit), hasMore: offset + limit < filtered.length, nextOffset: offset + limit }
    }) }
  const first = await collectDigestBatch(task, new AbortController().signal, deps)
  expect(first.evidence).toHaveLength(2)
  task.digestState = { cursors: first.cursors, commits: [] }
  const second = await collectDigestBatch(task, new AbortController().signal, deps)
  expect(second.evidence).toHaveLength(2)
  expect(new Set([...first.evidence, ...second.evidence].map(row => row.id)).size).toBe(4)
})

it('checks the account again after a source read and respects deterministic template cues', async () => {
  const x = setup(); let account = 'A'
  await expect(collectDigestBatch(x.task, new AbortController().signal, {
    currentAccountId: () => account, registerEvidence: () => '',
    getMessages: async () => { account = 'B'; return { success: true, messages: [] } },
  })).rejects.toThrow('账号')
  expect(digestRelevantEvidence('decisions-deadlines', '提交截止明天')).toBe(true)
  expect(digestRelevantEvidence('unanswered-questions', '可以确认吗？')).toBe(true)
  expect(digestRelevantEvidence('weekly-highlights', '')).toBe(false)
  expect(normalizeDigestLimits({ maxMessages: Infinity }).maxMessages).toBe(200)
})

it('does not advance past a message that does not fit the remaining character budget', async () => {
  const x = setup(); x.task.digest!.limits.maxInputChars = 1000
  const rows = [1, 2].map(id => ({ createTime: 10, localIdRaw: String(id), parsedContent: 'x'.repeat(600), _db_path: 'db_storage/message/message_0.db', _table_name: 'Msg_chat' }))
  const deps = { currentAccountId: () => 'A', now: () => 20000, registerEvidence: () => `weport-evidence:${'a'.repeat(64)}`,
    getMessages: async () => ({ success: true, messages: rows, hasMore: false }) }
  const first = await collectDigestBatch(x.task, new AbortController().signal, deps)
  expect(first.evidence).toHaveLength(1); expect(first.hasMore).toBe(true)
  x.task.digestState = { cursors: first.cursors, commits: [] }
  const second = await collectDigestBatch(x.task, new AbortController().signal, deps)
  expect(second.evidence).toHaveLength(1)
  expect(second.evidence[0].id).not.toBe(first.evidence[0].id)
})

it('rejects rounded numeric source IDs and oversized individual messages before advancing a cursor', async () => {
  const x = setup(), deps = { currentAccountId: () => 'A', now: () => 20000, registerEvidence: () => `weport-evidence:${'a'.repeat(64)}`,
    getMessages: async () => ({ success: true, messages: [{ createTime: 10, localId: 9007199254740992, _db_path: 'db_storage/message/message_0.db', _table_name: 'Msg_chat' }], hasMore: false }) }
  await expect(collectDigestBatch(x.task, new AbortController().signal, deps)).rejects.toThrow('精确来源')
  await expect(collectDigestBatch(x.task, new AbortController().signal, { ...deps, getMessages: async () => ({ success: true, messages: [{ createTime: 10, localIdRaw: '1', parsedContent: 'x'.repeat(24001), _db_path: 'db_storage/message/message_0.db', _table_name: 'Msg_chat' }], hasMore: false }) })).rejects.toThrow('水位未前进')
  expect(x.task.digestState).toBeUndefined()
})
