import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
    const { service, call } = setup(), chat = service.createChat('Contradiction evaluation')
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
    const { service, call } = setup(), chat = service.createChat('Unavailable evidence evaluation')
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
    expect((await service.resolveEvidence(id)).success).toBe(true)
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
    const { service } = setup(), chat = service.createChat('Account A')
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
      expect(options.systemContent).toContain('These context labels do not need a tool lookup or a registered hex ID.')
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
    const { service, call } = setup(), chat = service.createChat('Supplied context cannot become provenance')
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
