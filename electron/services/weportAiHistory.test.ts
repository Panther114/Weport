import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('./config', () => ({ ConfigService: class { static getInstance() { return { get: () => '' } } } }))
vi.mock('./chatService', () => ({ chatService: { getSessionMessageCounts: vi.fn(), getMessages: vi.fn(), getImageDataByIdentity: vi.fn(), getExportSessionStats: vi.fn(), getSessions: vi.fn() } }))
vi.mock('./wcdbService', () => ({ wcdbService: { getSessionMessageDateCountsBatch: vi.fn() } }))
vi.mock('./connectors/connectorsService', () => ({ connectorsService: { listConnectedIds: () => [], agentWriteAllowed: () => false } }))
vi.mock('./ai/providerProfiles', () => ({ ProviderProfileService: class {} }))

import { weportAiService } from './weportAiService'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'

describe('AI history investigation', () => {
  it('reads a substantial contiguous default page and preserves continuation evidence', async () => {
    const service = weportAiService as any
    const tool = service.buildTools().find((item: any) => item.name === 'read_session_messages')
    const cite = vi.spyOn(service, 'citeMessages').mockReturnValue('[source](weport-evidence:fixture)')
    const messages = Array.from({ length: 400 }, (_, index) => ({ localId: index + 1,
      createTime: 1700000000 + index, isSend: index % 2, senderUsername: 'person', localType: 1,
      parsedContent: `ordinary conversation ${index}` }))
    vi.mocked(chatService.getMessages).mockResolvedValue({ success: true, messages, hasMore: true, nextOffset: 800 } as any)
    try {
      const result = await tool.handler({ sessionId: 'room', offset: 400 }, { myWxid: 'me', getSessionName: () => 'Room' })
      expect(chatService.getMessages).toHaveBeenLastCalledWith('room', 400, 400, 0, 0, false)
      expect(result).toContain('ordinary conversation 399')
      expect(result).toContain('nextOffset=800')
      expect(JSON.parse(result.split('\nCoverage: ')[1])).toMatchObject({ offset: 400, returned: 400, hasMore: true, completeHistory: false })
      expect(tool.friendly({ sessionId: 'room', offset: 400 }, { getSessionName: () => 'Room' })).toContain('起点 400')
    } finally { cite.mockRestore() }
  })
  it('reads image sources by exact physical identity, picks newest within the scan and discloses omitted history', async () => {
    const service = weportAiService as any
    const message = (id: string, time: number, db: string) => ({ localId: 0, localIdRaw: id, createTime: time,
      _db_path: db, _table_name: 'Msg_room', localType: 3, parsedContent: '[图片]' })
    vi.mocked(chatService.getMessages).mockResolvedValue({ success: true, hasMore: true, messages: [
      message('9007199254740993', 1700000100, 'newer.db'), message('9007199254740993', 1700000000, 'older.db'),
    ] as any })
    vi.mocked(chatService.getImageDataByIdentity).mockResolvedValue({ success: false, error: 'Original image unavailable' })
    const cite = vi.spyOn(service, 'citeMessages').mockReturnValue('[source](weport-evidence:fixture)')
    try {
      const tool = service.buildTools().find((item: any) => item.name === 'read_chat_images')
      const result = await tool.handler({ sessionId: 'room', limit: 1 }, { myWxid: 'me', getSessionName: () => 'Room' })
      expect(chatService.getImageDataByIdentity).toHaveBeenLastCalledWith({ sessionId: 'room', localId: '9007199254740993',
        idKind: 'local', db: 'newer.db', table: 'Msg_room', ts: 1700000100000 })
      expect(result).toContain('Original image unavailable')
      expect(result).toContain('weport-evidence:fixture')
      expect(JSON.parse(result.split('\nCoverage: ')[1])).toMatchObject({ mode: 'images', complete: false, attached: 0, hasMore: true })
    } finally { cite.mockRestore() }
  })
  it('does not infer image absence from a partial or failed scan', async () => {
    const service = weportAiService as any
    const tool = service.buildTools().find((item: any) => item.name === 'read_chat_images')
    const context = { myWxid: 'me', getSessionName: () => 'Room' }
    vi.mocked(chatService.getMessages).mockResolvedValueOnce({ success: true, messages: [], hasMore: true })
    const partial = await tool.handler({ sessionId: 'room' }, context)
    expect(partial).toContain('不代表未扫描历史没有图片')
    expect(JSON.parse(partial.split('\nCoverage: ')[1]).complete).toBe(false)
    vi.mocked(chatService.getMessages).mockResolvedValueOnce({ success: false, error: 'fixture failure' })
    const failed = await tool.handler({ sessionId: 'room' }, context)
    expect(JSON.parse(failed.split('\nCoverage: ')[1])).toMatchObject({ complete: false, error: 'read-failed' })
  })
  it('labels cached aggregate results and missing requested sessions without claiming source completeness', async () => {
    const service = weportAiService as any
    vi.mocked(chatService.getExportSessionStats).mockResolvedValue({ success: true, data: { known: { totalMessages: 3 } } } as any)
    const tool = service.buildTools().find((item: any) => item.name === 'get_session_stats')
    const result = await tool.handler({ sessionIds: ['known', 'missing'] }, { getSessionName: (id: string) => id })
    expect(JSON.parse(result.split('\nCoverage: ')[1])).toMatchObject({ mode: 'aggregate', complete: false,
      mayUseStaleCache: true, missingSessions: ['missing'] })
  })
  it('fails a session inventory read rather than presenting a native failure as no history', async () => {
    vi.mocked(chatService.getSessions).mockResolvedValue({ success: false, error: 'unavailable fixture' })
    await expect((weportAiService as any).loadSessionsFresh()).rejects.toThrow('unavailable fixture')
  })
  it('never presents failed date statistics as an empty historical window', async () => {
    const service = weportAiService as any
    const sessions = vi.spyOn(service, 'getSessionMap').mockResolvedValue(new Map([['room', { username: 'room' }]]))
    vi.mocked(wcdbService.getSessionMessageDateCountsBatch).mockResolvedValue({ success: false, error: 'counts failed' })
    try {
      const result = await service.readPeriodEvents('fixture', 1700000000, 1700000100, 100, ['room'], 'all', { chatId: 'fixture', myWxid: 'me', getSessionName: () => 'Room' })
      expect(result).toContain('不能据此判断没有消息')
      expect(result).not.toContain('内没有任何消息')
    } finally { sessions.mockRestore() }
  })
  it('reports failed sample windows and does not discard chats with unknown date counts', async () => {
    const service = weportAiService as any
    const sessions = vi.spyOn(service, 'getSessionMap').mockResolvedValue(new Map([['room', { username: 'room' }]]))
    vi.mocked(wcdbService.getSessionMessageDateCountsBatch).mockResolvedValue({ success: true, data: {} })
    vi.mocked(chatService.getMessages).mockResolvedValue({ success: false, error: 'cursor failed' })
    try {
      const result = await service.readPeriodEvents('fixture', 1700000000, 1700000100, 100, ['room'], 'all', { chatId: 'fixture', myWxid: 'me', getSessionName: () => 'Room' })
      expect(chatService.getMessages).toHaveBeenCalledTimes(3)
      expect(result).toContain('覆盖不完整')
      const coverage = JSON.parse(result.split('\nCoverage: ')[1])
      expect(coverage.failedWindows).toHaveLength(3)
      expect(coverage.unknownCountSessions).toEqual(['room'])
      expect(coverage.complete).toBe(false)
    } finally { sessions.mockRestore() }
  })
  it('does not report an unknown message count as an empty history', async () => {
    vi.mocked(chatService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: {} })
    const service = weportAiService as any
    const log = vi.spyOn(service, 'appendDebugLog').mockImplementation(() => undefined)
    const tool = service.buildTools().find((item: any) => item.name === 'sample_session_history')
    const result = await tool.handler({ sessionId: 'room' }, { chatId: 'fixture', getSessionName: () => 'Room' })
    expect(result).toContain('没有返回有效数量')
    expect(result).not.toContain('该会话没有可抽样的消息')
    log.mockRestore()
  })
  it('exposes failed historical windows instead of claiming empty coverage', async () => {
    vi.mocked(chatService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: { room: 1000 } })
    vi.mocked(chatService.getMessages).mockResolvedValue({ success: false, error: 'native cursor timeout' })
    const service = weportAiService as any
    const log = vi.spyOn(service, 'appendDebugLog').mockImplementation(() => undefined)
    const tool = service.buildTools().find((item: any) => item.name === 'sample_session_history')
    const result = await tool.handler({ sessionId: 'room' }, { chatId: 'fixture', getSessionName: () => 'Room' })
    expect(result).toContain('native cursor timeout')
    expect(result).toContain('覆盖不完整')
    expect(result).not.toContain('读取=0')
    log.mockRestore()
  })
  it('reads five substantial historical windows and preserves the oldest stratum under a shared result budget', async () => {
    vi.mocked(chatService.getSessionMessageCounts).mockResolvedValue({ success: true, counts: { room: 10000 } })
    vi.mocked(chatService.getMessages).mockImplementation(async (_id, offset = 0, limit = 50) => ({
      success: true,
      messages: Array.from({ length: limit }, (_, i) => ({
        localId: offset + i, createTime: 1700000000 + offset + i, isSend: i % 2,
        senderUsername: 'person', localType: 1, parsedContent: 'Long historical evidence '.repeat(12),
      })) as any,
    }))
    const service = weportAiService as any
    const debugLog = vi.spyOn(service, 'appendDebugLog').mockImplementation(() => undefined)
    const tool = service.buildTools().find((item: any) => item.name === 'sample_session_history')
    const result = await tool.handler({ sessionId: 'room' }, {
      chatId: 'fixture', myWxid: 'me', getSessionName: () => 'Room', resultCharBudget: 15000,
    })
    expect(chatService.getMessages).toHaveBeenCalledTimes(5)
    expect(vi.mocked(chatService.getMessages).mock.calls.every((call) => call[2] === 200)).toBe(true)
    expect(vi.mocked(chatService.getMessages).mock.calls.at(-1)?.[1]).toBe(9800)
    expect(result).toContain('[近期')
    expect(result).toContain('[早期')
    expect(result.length).toBeLessThan(15000)
    debugLog.mockRestore()
  })

  it('freezes distinct automation instructions without changing the tool definitions', () => {
    const service = weportAiService as any
    const tools = service.buildTools()
    const interactive = service.createModelRequestShape(tools)
    const automatic = service.createModelRequestShape(tools, true)
    expect(automatic.tools).toEqual(interactive.tools)
    expect(automatic.systemContent).toContain('omit the interactive plan')
    expect(interactive.systemContent).toContain('Match the language of the latest user message')
    expect(automatic.hash).not.toBe(interactive.hash)
  })
})
