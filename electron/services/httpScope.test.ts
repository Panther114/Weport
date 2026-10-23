import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
const state = vi.hoisted(() => ({ account: 'A', root: '', admin: 'administrator-test' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('./config', () => ({ ConfigService: { getInstance: () => ({
  get: (key: string) => key === 'myWxid' ? state.account : state.admin, getMyWxidCleaned: () => state.account,
}) } }))
vi.mock('./chatService', () => ({ chatService: {
  getSessions: vi.fn(async () => ({ success: true, sessions: [{ username: 'allowed' }, { username: 'private' }] })),
  getMessages: vi.fn(async () => ({ success: true, messages: [{ createTime: 15 }, { createTime: 30 }], hasMore: false })),
} }))
vi.mock('./snsService', () => ({ snsService: {} }))
vi.mock('./groupAnalyticsService', () => ({ groupAnalyticsService: {} }))
vi.mock('./weBotRegistry', () => ({ getWeBotService: () => null }))
vi.mock('./searchRetrieval', () => ({ retrieveIndexedMessages: vi.fn(async () => ({ hits: [], coverage: { complete: false, stale: true } })) }))
import { httpService } from './httpService'
import { dataAccessService } from './dataAccessService'
import { chatService } from './chatService'
import { retrieveIndexedMessages } from './searchRetrieval'

describe('HTTP client scope enforcement over real transport', () => {
  let base: string, token: string, grantId: string
  beforeAll(async () => {
    state.root = mkdtempSync(join(tmpdir(), 'weport-http-scope-'))
    expect((await httpService.start(0, '127.0.0.1')).success).toBe(true)
    const address = (httpService as any).server.address()
    base = `http://127.0.0.1:${address.port}/api`
  })
  beforeEach(() => {
    state.account = 'A'; state.admin = 'administrator-test'; vi.clearAllMocks()
    const issued = dataAccessService.create({ accountId: 'A', sessionIds: ['allowed'], from: 10000, to: 20000,
      name: 'Synthetic client', expiresAt: Date.now() + 60000 })
    token = issued.token; grantId = issued.grant.id
  })
  afterAll(async () => { await httpService.stop(); rmSync(state.root, { recursive: true, force: true }) })
  const request = (route: string, method = 'GET', auth = token) => fetch(base + route, { method, headers: { Authorization: `Bearer ${auth}` } })
  const read = async (response: Response): Promise<Record<string, unknown>> => await response.json() as Record<string, unknown>
  it('filters sessions, enforces dates at retrieval and defensively removes out-of-range rows', async () => {
    vi.mocked(chatService.getSessions).mockResolvedValueOnce({ success: true, sessions: [{ username: 'allowed',
      summary: 'SECRET OUTSIDE DATE RANGE', lastTimestamp: 99, lastMsgSender: 'private sender' } as any] })
    expect((await read(await request('/sessions'))).sessions).toEqual([{ username: 'allowed' }])
    const messages = await read(await request('/messages?session=allowed'))
    expect(chatService.getMessages).toHaveBeenLastCalledWith('allowed', 0, 50, 10000, 20000)
    expect(messages.messages).toEqual([{ createTime: 15 }])
    expect(messages.scope).toEqual({ accountId: 'A', from: 10000, to: 20000 })
  })
  it('rejects forbidden chats, other surfaces and methods before native dispatch', async () => {
    for (const [route, method] of [['/messages?session=private', 'GET'], ['/search?session=private&keyword=test', 'GET'], ['/bot/notes', 'GET'], ['/contacts?usernames=private', 'GET'], ['/sessions', 'POST']]) {
      expect((await request(route, method)).status).toBe(403)
    }
    expect(chatService.getMessages).not.toHaveBeenCalled(); expect(retrieveIndexedMessages).not.toHaveBeenCalled()
  })
  it('shares indexed bilingual retrieval without allowing query parameters to broaden a grant', async () => {
    const result = await read(await request('/search?keyword=%E4%BD%A0%E5%A5%BD%20hello&from=0&to=9999999999999'))
    expect(retrieveIndexedMessages).toHaveBeenLastCalledWith({ text: '你好 hello', limit: 50,
      scope: { sessionIds: ['allowed'], from: 10000, to: 20000 } })
    expect(result.coverage).toMatchObject({ complete: false, stale: true })
    vi.mocked(retrieveIndexedMessages).mockResolvedValueOnce({ hits: [
      { sessionId: 'allowed', ts: 15000, snippet: 'authorized' }, { sessionId: 'private', ts: 15000, snippet: 'secret chat' },
      { sessionId: 'allowed', ts: 30000, snippet: 'secret date' },
    ], total: 3, cursor: null, truncated: false, elapsedMs: 1 } as any)
    const guarded = await read(await request('/search?keyword=test'))
    expect(guarded.hits).toEqual([{ sessionId: 'allowed', ts: 15000, snippet: 'authorized' }])
    expect(guarded.truncated).toBe(true)
  })
  it('rejects account changes before and during asynchronous reads and a grant revoked in flight', async () => {
    state.account = 'B'; expect((await request('/sessions')).status).toBe(403)
    expect(chatService.getSessions).not.toHaveBeenCalled()
    state.account = 'A'
    vi.mocked(chatService.getSessions).mockImplementationOnce(async () => { state.account = 'B'; return { success: true, sessions: [] } })
    expect((await request('/sessions')).status).toBe(403)
    state.account = 'A'
    vi.mocked(chatService.getSessions).mockImplementationOnce(async () => { dataAccessService.revoke(grantId); return { success: true, sessions: [] } })
    expect((await request('/sessions')).status).toBe(403)
    expect((await request('/sessions')).status).toBe(401)
  })
  it('keeps administrator access explicit and never turns an invalid token into unauthenticated full access', async () => {
    expect((await read(await request('/sessions', 'GET', state.admin))).sessions).toHaveLength(2)
    state.admin = ''
    expect((await request('/sessions', 'GET', 'invalid-token')).status).toBe(401)
    expect((await request('/sessions')).status).toBe(200)
  })
})
