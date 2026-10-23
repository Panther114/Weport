import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import net from 'net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const state = vi.hoisted(() => ({ account: 'A', root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('./config', () => ({ ConfigService: { getInstance: () => ({ get: (key: string) => key === 'myWxid' ? state.account : 'admin-token', getMyWxidCleaned: () => state.account, set: vi.fn() }) } }))
vi.mock('./chatService', () => ({ chatService: { getSessions: vi.fn(async () => ({ success: true, sessions: [{ username: 'allowed' }, { username: 'private' }] })), getMessages: vi.fn(async () => ({ success: true, messages: [{ createTime: 15 }, { createTime: 30 }], hasMore: false })) } }))
vi.mock('./weBotRegistry', () => ({ getWeBotService: () => null }))
vi.mock('./snsService', () => ({ snsService: {} }))
vi.mock('./analyticsService', () => ({ analyticsService: {} }))
vi.mock('./groupAnalyticsService', () => ({ groupAnalyticsService: {} }))
vi.mock('./searchRetrieval', () => ({ retrieveIndexedMessages: vi.fn(async () => ({ hits: [], coverage: { complete: true } })) }))
import { mcpService } from './mcpService'
import { dataAccessService } from './dataAccessService'
import { chatService } from './chatService'
import { retrieveIndexedMessages } from './searchRetrieval'

describe('MCP client scope enforcement over real HTTP transport', () => {
  let url: string, token: string, grantId: string
  const clients: Client[] = []
  async function client(bearer = token) {
    const result = new Client({ name: 'scoped-test', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } })
    await result.connect(transport); clients.push(result)
    return { client: result, transport }
  }
  beforeAll(async () => {
    state.root = mkdtempSync(join(tmpdir(), 'weport-mcp-scope-'))
    const issued = dataAccessService.create({ name: 'Test', accountId: 'A', sessionIds: ['allowed'], from: 10000, to: 20000, expiresAt: Date.now() + 60000 })
    token = issued.token; grantId = issued.grant.id
    const reservation = net.createServer(); await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done))
    const port = (reservation.address() as net.AddressInfo).port
    await new Promise<void>(done => reservation.close(() => done()))
    await mcpService.start(port, '127.0.0.1'); url = `http://127.0.0.1:${port}/mcp`
  })
  afterAll(async () => { for (const client of clients) await client.close(); await mcpService.stop(); rmSync(state.root, { recursive: true, force: true }) })
  it('lists only scoped tools and chats; rejects another chat before reading', async () => {
    const x = await client()
    expect((await x.client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_messages', 'list_sessions', 'search_messages'])
    vi.mocked(chatService.getSessions).mockResolvedValueOnce({ success: true, sessions: [{ username: 'allowed',
      summary: 'SECRET OUTSIDE DATE RANGE', lastTimestamp: 99, lastMsgSender: 'private sender' } as any] })
    const result = await x.client.callTool({ name: 'list_sessions', arguments: {} })
    expect(JSON.parse((result.content as any)[0].text).sessions).toEqual([{ username: 'allowed' }])
    const rejected = await x.client.callTool({ name: 'get_messages', arguments: { sessionId: 'private' } })
    expect(rejected.isError).toBe(true)
    expect(chatService.getMessages).not.toHaveBeenCalled()
  })
  it('passes date restrictions into retrieval and defensively filters returned message times', async () => {
    const x = await client()
    const result = await x.client.callTool({ name: 'get_messages', arguments: { sessionId: 'allowed' } })
    expect(chatService.getMessages).toHaveBeenLastCalledWith('allowed', 0, 50, 10000, 20000)
    expect(JSON.parse((result.content as any)[0].text).messages).toEqual([{ createTime: 15 }])
    vi.mocked(retrieveIndexedMessages).mockResolvedValueOnce({ hits: [{ sessionId: 'allowed', ts: 15000 },
      { sessionId: 'allowed', ts: 20001, snippet: 'SECRET DATE' }, { sessionId: 'private', ts: 15000, snippet: 'SECRET CHAT' }],
      total: 3, cursor: null, elapsedMs: 1, truncated: false } as any)
    const searched = await x.client.callTool({ name: 'search_messages', arguments: { keyword: '你好 hello' } })
    expect(JSON.parse((searched.content as any)[0].text).hits).toEqual([{ sessionId: 'allowed', ts: 15000 }])
    expect(retrieveIndexedMessages).toHaveBeenLastCalledWith({ text: '你好 hello', limit: 50, scope: { sessionIds: ['allowed'], from: 10000, to: 20000 } })
  })
  it('rejects account switching and prevents another principal taking an existing session', async () => {
    const x = await client()
    state.account = 'B'
    const rejected = await x.client.callTool({ name: 'list_sessions', arguments: {} })
    expect(rejected.isError).toBe(true)
    state.account = 'A'
    const response = await fetch(url, { headers: { Authorization: 'Bearer admin-token', 'mcp-session-id': x.transport.sessionId!, Accept: 'text/event-stream' } })
    expect(response.status).toBe(403); await response.text()
  })
  it('rejects a revoked grant on its existing session', async () => {
    const x = await client(); dataAccessService.revoke(grantId)
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'mcp-session-id': x.transport.sessionId!, Accept: 'text/event-stream' } })
    expect(response.status).toBe(401); await response.text()
  })
  it('resolves one explicit principal and cannot promote an expired second lookup to administrator', async () => {
    const issued = dataAccessService.create({ name: 'Race fixture', accountId: 'A', sessionIds: ['allowed'], from: 10000, to: 20000, expiresAt: Date.now() + 60000 })
    const grant = dataAccessService.authenticate(issued.token)!
    const authenticate = vi.spyOn(dataAccessService, 'authenticate').mockReturnValueOnce(grant).mockReturnValue(undefined)
    const unrestricted = vi.spyOn(mcpService as any, 'registerTools')
    try {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${issued.token}`,
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Race fixture', version: '1' } },
      }) })
      expect(response.status).toBe(200); await response.text()
      expect(authenticate).toHaveBeenCalledTimes(1)
      expect(unrestricted).not.toHaveBeenCalled()
      expect((mcpService as any).sessions.get(response.headers.get('mcp-session-id')).principal).toBe(grant.id)
    } finally { authenticate.mockRestore(); unrestricted.mockRestore() }
  })
})
