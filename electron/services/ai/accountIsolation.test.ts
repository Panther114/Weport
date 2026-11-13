import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const state = vi.hoisted(() => ({ account: 'A', root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../config', () => ({ ConfigService: class { static getInstance() { return { getMyWxidCleaned: () => state.account, get: (key: string) => key === 'myWxid' ? state.account : key === 'weportAiDisabledTools' ? [] : '' } } } }))
vi.mock('../chatService', () => ({ chatService: { getSessions: vi.fn(async () => ({ success: true, sessions: [] })), getMessages: vi.fn(), getMessageByIdentity: vi.fn() } }))
vi.mock('../wcdbService', () => ({ wcdbService: {} }))
vi.mock('../searchRetrieval', () => ({ retrieveIndexedMessages: vi.fn(async () => ({ hits: [], total: 0, cursor: null, truncated: false })) }))
vi.mock('../connectors/connectorsService', () => ({ connectorsService: { listConnectedIds: () => [], agentWriteAllowed: () => false } }))
vi.mock('./providerProfiles', () => ({ ProviderProfileService: class { getForConsumer() { return { id: 'fixture', providerId: 'custom', model: 'fixture', apiKey: 'synthetic-test-value', baseUrl: 'https://fixture.invalid' } } } }))
import { WeportAiService } from '../weportAiService'
import { chatService } from '../chatService'
import { retrieveIndexedMessages } from '../searchRetrieval'

beforeEach(() => { state.account = 'A'; state.root = mkdtempSync(join(tmpdir(), 'weport-ai-isolation-')); vi.clearAllMocks() })
afterEach(() => rmSync(state.root, { recursive: true, force: true }))
const scope = () => ({ accountId: 'A', sessionIds: ['allowed'], from: 1700000000000, to: 1800000000000 })
function setup() {
  const service = new WeportAiService()
  const call = vi.spyOn(service as any, 'callModel').mockResolvedValue({ ok: true, content: 'Answer', usage: { totalTokens: 20 } })
  return { service, call }
}
describe('actual AI account and task boundaries', () => {
  it('preserves fractional millisecond task bounds for reads and shared search', async () => {
    const { service, call } = setup(), chat = service.createChat('Precise date boundary')
    const from = 1700000000001, to = 1700000001999
    vi.mocked(retrieveIndexedMessages).mockResolvedValueOnce({ hits: [{ sessionId: 'room', ts: from - 1, snippet: 'EXCLUDED SEARCH' }],
      total: 1, cursor: null, truncated: false, elapsedMs: 1 } as any)
    vi.mocked(chatService.getMessages).mockResolvedValue({ success: true, hasMore: false, messages: [
      { localId: 1, createTime: 1700000000, parsedContent: 'EXCLUDED BEFORE' },
      { localId: 2, createTime: 1700000001, parsedContent: 'INCLUDED EVIDENCE' },
      { localId: 3, createTime: 1700000002, parsedContent: 'EXCLUDED AFTER' },
    ].map(row => ({ ...row, localType: 1, _db_path: 'db', _table_name: 'Msg_room' })) as any })
    const step = (id: string, name: string, args: unknown) => ({ ok: true, content: '', toolCalls: [{ id, name, args }], usage: { totalTokens: 20 } })
    call.mockResolvedValueOnce(step('read', 'read_session_messages', { sessionId: 'room' }))
      .mockResolvedValueOnce(step('search', 'search_messages', { keyword: 'evidence' }))
      .mockResolvedValueOnce({ ok: true, content: 'Verified bounded evidence', usage: { totalTokens: 20 } })
    expect((await service.runChat(chat.id, 'Read only the authorized interval.', { scope: { accountId: 'A', sessionIds: ['room'], from, to } })).success).toBe(true)
    expect(chatService.getMessages).toHaveBeenLastCalledWith('room', 0, 400, 1700000001000, 1700000001000, false)
    const read = service.getChat(chat.id)!.messages.find(message => message.role === 'tool')!.content
    expect(read).toContain('INCLUDED EVIDENCE'); expect(read).not.toContain('EXCLUDED')
    expect(service.getChat(chat.id)!.messages.filter(message => message.role === 'tool').at(-1)!.content).not.toContain('EXCLUDED SEARCH')
    expect(retrieveIndexedMessages).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { sessionIds: ['room'], from, to } }))
  })
  it('carries contradictory bilingual evidence through the agent loop into a dated uncertain correction', async () => {
    const { service, call } = setup(), chat = service.createChat('Contradiction evaluation', undefined, { memoryEnabled: true })
    const messages = [
      { localId: 1, createTime: 1700000000, rawContent: 'Deadline is Friday.', parsedContent: 'Deadline is Friday.' },
      { localId: 2, createTime: 1700000100, rawContent: '更正：截止时间改为周一，仍待确认。', parsedContent: '更正：截止时间改为周一，仍待确认。' },
    ].map(row => ({ ...row, senderUsername: 'person', localType: 1, _db_path: 'message.db', _table_name: 'Msg_room' })) as any[]
    vi.mocked(chatService.getMessages).mockResolvedValue({ success: true, messages, hasMore: false })
    vi.mocked(chatService.getMessageByIdentity).mockImplementation(async (identity: any) => ({ success: true, message: messages.find(row => String(row.localId) === identity.localId) }))
    const toolCall = (id: string, name: string, args: unknown) => ({ ok: true, content: '', toolCalls: [{ id, name, args }], usage: { totalTokens: 20 } })
    let sourceIds: string[] = []
    call.mockResolvedValueOnce(toolCall('read', 'read_session_messages', { sessionId: 'room' }))
      .mockImplementationOnce(async () => {
        const transcript = service.getChat(chat.id)!.messages
        const evidence = transcript.find(message => message.role === 'tool')!.content
        sourceIds = [...evidence.matchAll(/weport-evidence:([a-f0-9]{64})/g)].map(match => match[1])
        expect(sourceIds).toHaveLength(2)
        expect(evidence).toContain('Deadline is Friday.'); expect(evidence).toContain('仍待确认')
        return toolCall('prior', 'save_memory_claim', { statement: 'Earlier message said Friday.', kind: 'observation', asOf: 1700000000000, evidenceIds: [sourceIds[0]] })
      }).mockImplementationOnce(async () => toolCall('correction', 'save_memory_claim', {
        statement: 'Monday is a later proposal pending confirmation.', kind: 'interpretation', asOf: 1700000100000,
        evidenceIds: [sourceIds[1]], counterEvidenceIds: [sourceIds[0]], supersedes: service.listMemoryClaims()[0].id,
        correction: 'The later message conflicts with the earlier date; confirmation is still missing.',
      })).mockResolvedValueOnce({ ok: true, content: 'The deadline changed in the messages and remains unconfirmed.', usage: { totalTokens: 20 } })
    expect((await service.runChat(chat.id, 'Compare the contradictory messages and preserve uncertainty.', { maxSteps: 5 })).success).toBe(true)
    const claims = new WeportAiService().listMemoryClaims()
    expect(claims).toHaveLength(2)
    expect(claims[0].status).toBe('superseded')
    expect(claims[1]).toMatchObject({ status: 'uncertain', kind: 'interpretation', evidenceIds: [sourceIds[1]], counterEvidenceIds: [sourceIds[0]], asOf: 1700000100000 })
  })
  it.each(['unavailable', 'changed'])('refuses a model-requested observation when its source is %s', async failure => {
    const { service, call } = setup(), chat = service.createChat('Unavailable evidence evaluation', undefined, { memoryEnabled: true })
    const message = { localId: 1, createTime: 1700000000, rawContent: 'Original', parsedContent: 'Original',
      senderUsername: 'person', localType: 1, _db_path: 'message.db', _table_name: 'Msg_room' } as any
    const [link] = service.registerEvidence('A', 'room', [message])
    vi.mocked(chatService.getMessageByIdentity).mockResolvedValue(failure === 'unavailable'
      ? { success: false, error: 'Source unavailable' } : { success: true, message: { ...message, rawContent: 'Changed' } })
    call.mockResolvedValueOnce({ ok: true, content: '', toolCalls: [{ id: 'save', name: 'save_memory_claim', args: {
      statement: 'Model requested unsupported observation', kind: 'observation', asOf: Date.now(), evidenceIds: [link.slice('weport-evidence:'.length)],
    } }], usage: { totalTokens: 20 } }).mockResolvedValueOnce({ ok: true, content: 'Cannot verify this observation.', usage: { totalTokens: 20 } })
    expect((await service.runChat(chat.id, 'Save only verified observations.', { maxSteps: 3 })).success).toBe(true)
    expect(service.listMemoryClaims()).toEqual([])
    expect(service.getChat(chat.id)!.messages.find(message => message.role === 'tool')!.content).toMatch(/unavailable|changed/i)
  })
  it('resolves exact registered citations, rejects changed sources and hides another account references', async () => {
    const { service } = setup()
    const message = { localId: 0, localIdRaw: '9007199254740993', createTime: 1700000000, rawContent: '你好 evidence', parsedContent: '你好 evidence',
      _db_path: 'db_storage/message/message_0.db', _table_name: 'Msg_room', senderUsername: 'person', localType: 1 } as any
    const [url] = service.registerEvidence('A', 'room', [message]), id = url.slice('weport-evidence:'.length)
    vi.mocked(chatService.getMessageByIdentity).mockResolvedValue({ success: true, message })
    expect(await service.resolveEvidence(id)).toMatchObject({ success: true, message: { content: '你好 evidence', sender: 'person', createTime: 1700000000 } })
    expect(chatService.getMessageByIdentity).toHaveBeenLastCalledWith(expect.objectContaining({ localId: '9007199254740993', db: message._db_path, table: message._table_name }))
    vi.mocked(chatService.getMessageByIdentity).mockResolvedValue({ success: true, message: { ...message, parsedContent: 'changed' } })
    expect((await service.resolveEvidence(id)).error).toContain('changed')
    state.account = 'B'
    expect((await service.resolveEvidence(id)).success).toBe(false)
  })
  it('retains dated corrections and counterevidence across service recreation', () => {
    const { service } = setup()
    const [url] = service.registerEvidence('A', 'room', [{ localId: 1, createTime: 1700000000, rawContent: 'source', parsedContent: 'source', _db_path: 'db_storage/message/message_0.db', _table_name: 'Msg_room', localType: 1 } as any])
    const id = url.slice('weport-evidence:'.length)
    const old = service.saveMemoryClaim({ statement: 'Prior observation', kind: 'observation', status: 'active', asOf: 1700000000000, evidenceIds: [id], counterEvidenceIds: [] })
    service.saveMemoryClaim({ statement: 'Corrected interpretation', kind: 'interpretation', status: 'uncertain', asOf: 1700000000001, evidenceIds: [], counterEvidenceIds: [id], supersedes: old.id, correction: 'Needs a newer source' })
    const rows = new WeportAiService().listMemoryClaims()
    expect(rows[0].status).toBe('superseded'); expect(rows[1].counterEvidenceIds).toEqual([id])
  })
  it('isolates chats and Markdown memory across account switches', () => {
    const { service } = setup(), chat = service.createChat('Account A', undefined, { memoryEnabled: true })
    const memory = (service as any).memoryDir()
    writeFileSync(join(memory, 'fact.md'), 'Only A')
    state.account = 'B'
    expect(service.listChats()).toEqual([])
    expect(service.getChat(chat.id)).toBeNull()
    expect(service.readNoteFile(chat.id, 'memory/fact.md')).toBeNull()
    state.account = 'A'
    expect(service.getChat(chat.id)?.chat.title).toBe('Account A')
    expect(service.readNoteFile(chat.id, 'memory/fact.md')).toBe('Only A')
  })
  it('refuses an old account task or remote provider in local-only mode before a model call', async () => {
    const { service, call } = setup(), chat = service.createChat('Test')
    expect((await service.runChat(chat.id, 'Hello', { accountId: 'B' })).success).toBe(false)
    expect((await service.runChat(chat.id, 'Hello', { processing: 'local-only' })).success).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })
  it('freezes an empty toolset for deterministic scoped WeBot evidence', async () => {
    const { service, call } = setup(), chat = service.createChat('Digest')
    expect((await service.runChat(chat.id, 'Only the supplied evidence', { accountId: 'A', tools: 'none', maxSteps: 1, maxTotalTokens: 100 })).success).toBe(true)
    expect((call.mock.calls[0][4] as any).tools).toEqual([])
    expect(chatService.getSessions).not.toHaveBeenCalled()
  })
  it('keeps supplied context labels in schema answers without registering them as local evidence', async () => {
    const { service, call } = setup(), chat = service.createChat('Supplied context boundary')
    const answer = { status: 'uncertain', verified: false, sourceIds: ['memo-a', 'memo-b'], reason: 'The supplied texts disagree.' }
    call.mockImplementationOnce(async (_id, messages, _signal, _compressed, shape) => {
      const options = shape as { tools: unknown[]; systemContent: string }
      const history = messages as Array<{ content: string }>
      expect(options.tools).toEqual([])
      expect(options.systemContent).not.toContain('Mandatory memory protocol')
      expect(history.at(-1)!.content).toContain('[memo-a]')
      return { ok: true, content: JSON.stringify(answer), usage: { totalTokens: 20 } }
    })
    expect((await service.runChat(chat.id, 'Return only JSON. [memo-a] Meeting on Tuesday. [memo-b] Suggest Thursday, pending agreement.', { tools: 'none', maxSteps: 1 })).success).toBe(true)
    expect(JSON.parse(service.getChat(chat.id)!.messages.filter(row => row.role === 'assistant').at(-1)!.content)).toEqual(answer)
    expect(chatService.getSessions).not.toHaveBeenCalled()
    expect(chatService.getMessages).not.toHaveBeenCalled()
    expect(chatService.getMessageByIdentity).not.toHaveBeenCalled()
    expect(service.listMemoryClaims()).toEqual([])
  })
  it('rejects supplied context labels when a model tries to save them as a verified observation', async () => {
    const { service, call } = setup(), chat = service.createChat('Supplied context cannot become provenance', undefined, { memoryEnabled: true })
    call.mockResolvedValueOnce({ ok: true, content: '', toolCalls: [{ id: 'save-context', name: 'save_memory_claim', args: {
      statement: 'User supplied text claimed a meeting.', kind: 'observation', asOf: Date.now(), evidenceIds: ['memo-a'],
    } }], usage: { totalTokens: 20 } }).mockResolvedValueOnce({ ok: true, content: 'The supplied text is not verified local history.', usage: { totalTokens: 20 } })
    expect((await service.runChat(chat.id, '[memo-a] Meeting happened. Save this as a verified local-history observation.', { maxSteps: 3 })).success).toBe(true)
    expect(service.listMemoryClaims()).toEqual([])
    expect(service.getChat(chat.id)!.messages.find(row => row.role === 'tool')!.content).toMatch(/unavailable|invalid/i)
    expect(chatService.getMessageByIdentity).not.toHaveBeenCalled()
  })
  it('restricts the tool table and denies an out-of-scope read before native dispatch', async () => {
    const { service, call } = setup(), chat = service.createChat('Scoped')
    call.mockResolvedValueOnce({ ok: true, content: '', toolCalls: [{ id: 'call-1', name: 'read_session_messages', args: { sessionId: 'private' } }], usage: { totalTokens: 20 } })
    expect((await service.runChat(chat.id, 'Check selected history', { scope: scope() })).success).toBe(true)
    expect((call.mock.calls[0][4] as any).tools.map((tool: any) => tool.function.name).sort()).toEqual(['read_session_messages', 'search_messages'])
    expect(chatService.getMessages).not.toHaveBeenCalled()
    expect(service.getChat(chat.id)?.messages.some(message => message.role === 'tool' && message.content.includes('outside'))).toBe(true)
    expect((await service.runChat(chat.id, 'Change scope', { scope: { ...scope(), sessionIds: ['private'] } })).success).toBe(false)
  })
  it('rejects a changed account after a model response before executing its tools', async () => {
    const { service, call } = setup(), chat = service.createChat('Account lease')
    call.mockImplementationOnce(async () => { state.account = 'B'; return { ok: true, content: '', toolCalls: [{ id: 'call-1', name: 'read_session_messages', args: { sessionId: 'allowed' } }] } })
    expect((await service.runChat(chat.id, 'Check', { scope: scope() })).success).toBe(false)
    expect(chatService.getMessages).not.toHaveBeenCalled()
    expect(service.listChats()).toEqual([])
  })
})


describe('per-chat memory and automation ownership', () => {
  it('defaults memory off and persists explicit choices and live changes across restart', () => {
    const { service } = setup()
    const enabled = service.createChat('Enabled', undefined, { memoryEnabled: true })
    const defaultChat = service.createChat('Default')
    expect(defaultChat.memoryEnabled).toBe(false)
    expect(service.setMemoryEnabled(defaultChat.id, true).chat.memoryEnabled).toBe(true)
    expect(service.isMemoryEnabled(defaultChat.id)).toBe(true)
    expect(service.setMemoryEnabled(defaultChat.id, false).memoryDir).toBe('')
    const disabled = service.createChat('Disabled', undefined, { memoryEnabled: false })
    expect(enabled.memoryEnabled).toBe(true)
    const restarted = new WeportAiService()
    expect(restarted.isMemoryEnabled(disabled.id)).toBe(false)
    expect(restarted.getChat(disabled.id)?.memoryDir).toBe('')
  })
  it('excludes memory and prior-analysis tools from disabled runs while preserving current-chat notes', async () => {
    const { service, call } = setup(), chat = service.createChat('Disabled', undefined, { memoryEnabled: false })
    expect((await service.runChat(chat.id, 'Use current notes only')).success).toBe(true)
    const tools = (call.mock.calls[0][4] as any).tools.map((tool: any) => tool.function.name)
    expect(tools).toContain('write_note')
    expect(tools).not.toEqual(expect.arrayContaining(['list_memory_claims', 'save_memory_claim', 'review_prior_analyses']))
    for (const name of ['list_memory_claims', 'save_memory_claim', 'review_prior_analyses']) expect(tools).not.toContain(name)
    const write = (service as any).buildTools().find((tool: any) => tool.name === 'write_note')
    expect(await write.handler({ path: 'memory/denied.md', content: 'secret' }, { chatId: chat.id })).toContain('错误')
    expect(await write.handler({ path: 'notes/local.md', content: 'allowed' }, { chatId: chat.id })).toContain('笔记已写入')
    expect(service.readNoteFile(chat.id, 'memory/denied.md')).toBeNull()
    expect(service.readNoteFile(chat.id, 'notes/local.md')).toBe('allowed\n')
    expect(service.listNotes(chat.id).map(note => note.scope)).toEqual(['notes'])
    const claim = (service as any).buildTools().find((tool: any) => tool.name === 'save_memory_claim')
    await expect(claim.handler({}, { chatId: chat.id })).rejects.toThrow('Memory is disabled')
  })
  it('preserves user literals on disk and in the provider projection', () => {
    const { service } = setup(), chat = service.createChat('Literal spelling')
    const original = 'Quote "WreportAI" and "Weport Ai" literally.'
    const message = { id: 'literal', role: 'user', content: original, createdAt: 1 }
    ;(service as any).persistMessages(chat.id, [message])
    expect(service.getChat(chat.id)?.messages[0].content).toBe(original)
    expect(new WeportAiService().getChat(chat.id)?.messages[0].content).toBe(original)
    expect((service as any).buildApiMessages([message], '', 'minimal')[1].content).toBe(original)
  })
  it('preserves interactive archived turns after compaction and restart', () => {
    const { service } = setup(), chat = service.createChat('History')
    const old = { id: 'old', role: 'user', content: 'Original request', createdAt: 1 }
    const recent = { id: 'new', role: 'assistant', content: 'Latest answer', createdAt: 2 }
    ;(service as any).archiveMessages(chat.id, [old])
    ;(service as any).persistMessages(chat.id, [old, recent])
    expect(new WeportAiService().getChat(chat.id)?.messages.map(row => row.id)).toEqual(['old', 'new'])
  })
  it('compacts only the provider projection while every original turn survives restart', () => {
    const { service } = setup(), chat = service.createChat('Compaction')
    const messages = Array.from({ length: 24 }, (_, i) => ({ id: `turn-${i}`, role: i % 2 ? 'assistant' : 'user', content: '历史证据'.repeat(500), createdAt: i }))
    ;(service as any).persistMessages(chat.id, messages)
    vi.spyOn(service as any, 'resolveContextWindow').mockReturnValue(16000)
    expect(service.compactChat(chat.id)).toMatchObject({ success: true, changed: true })
    expect((service as any).loadMessages(chat.id).messages.length).toBeLessThan(messages.length)
    expect(new WeportAiService().getChat(chat.id)?.messages).toEqual(messages)
  })
  it('does not replace original turns when archiving fails during compaction', () => {
    const { service } = setup(), chat = service.createChat('Archive failure')
    const messages = Array.from({ length: 24 }, (_, i) => ({ id: `turn-${i}`, role: i % 2 ? 'assistant' : 'user', content: 'evidence '.repeat(500), createdAt: i }))
    ;(service as any).persistMessages(chat.id, messages)
    vi.spyOn(service as any, 'resolveContextWindow').mockReturnValue(16000)
    vi.spyOn(service as any, 'archiveMessages').mockImplementation(() => { throw new Error('Archive unavailable') })
    expect(service.compactChat(chat.id)).toMatchObject({ success: false, changed: false })
    expect(new WeportAiService().getChat(chat.id)?.messages).toEqual(messages)
  })
  it('never registers a run after a damaged transcript read', async () => {
    const { service, call } = setup(), chat = service.createChat('Damaged')
    writeFileSync((service as any).chatFilePath(chat.id), '{truncated')
    await expect(service.runChat(chat.id, 'Continue')).rejects.toThrow()
    expect(service.hasActiveRuns()).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })
  it('always ends the run when saving the transcript fails', async () => {
    const { service, call } = setup(), chat = service.createChat('Disk failure')
    const events: any[] = []; service.setEventEmitter(event => events.push(event))
    vi.spyOn(service as any, 'persistMessages').mockImplementation(() => { throw new Error('Disk full') })
    expect(await service.runChat(chat.id, 'Continue')).toMatchObject({ success: false, error: 'Disk full' })
    expect(service.hasActiveRuns()).toBe(false)
    expect(events).toContainEqual({ type: 'status', chatId: chat.id, running: false })
    expect(call).not.toHaveBeenCalled()
  })
  it('retains cancellation ownership until a deleted run settles and never recreates its transcript', async () => {
    const { service, call } = setup(), chat = service.createChat('Deleted while running')
    let finish!: (value: any) => void
    call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const run = service.runChat(chat.id, 'Analyze', { tools: 'none' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const file = (service as any).chatFilePath(chat.id)
    service.deleteChat(chat.id)
    expect(service.hasActiveRuns()).toBe(true)
    finish({ ok: true, content: 'Late answer', usage: { totalTokens: 20 } })
    await run
    expect(service.hasActiveRuns()).toBe(false)
    expect(existsSync(file)).toBe(false)
    expect(service.listChats()).toEqual([])
  })
  it('rejects memory changes and manual compaction while a run is active', () => {
    const { service } = setup(), chat = service.createChat('Busy')
    ;(service as any).running.set(chat.id, new AbortController())
    expect(() => service.setMemoryEnabled(chat.id, true)).toThrow('任务结束')
    expect(service.compactChat(chat.id)).toMatchObject({ success: false, changed: false })
  })
  it('keeps full automation history out of interactive lists and reloads it after restart', () => {
    const { service } = setup()
    const interactive = service.createChat('Interactive')
    const automation = service.createChat('Automation', { kind: 'automation', taskId: 'task', runId: 'run' })
    const archived = { id: 'old', role: 'user', content: 'Old task', createdAt: 1 }
    const recent = { id: 'new', role: 'assistant', content: 'Result', createdAt: 2 }
    ;(service as any).archiveMessages(automation.id, [archived])
    ;(service as any).persistMessages(automation.id, [recent])
    const restarted = new WeportAiService()
    expect(restarted.listChats().map(chat => chat.id)).toEqual([interactive.id])
    expect(restarted.listAutomationChats('task')[0].id).toBe(automation.id)
    expect(restarted.getAutomationChat(automation.id)?.messages.map(message => message.id)).toEqual(['old', 'new'])
    expect(restarted.getAutomationChat(interactive.id)).toBeNull()
    expect(restarted.listChats({ includeAutomations: true })).toHaveLength(2)
  })
})
