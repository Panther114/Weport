import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('./config', () => ({ ConfigService: class { static getInstance() { return { get: () => '' } } } }))
vi.mock('./chatService', () => ({ chatService: { getSessionMessageCounts: vi.fn(), getMessages: vi.fn() } }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
vi.mock('./connectors/connectorsService', () => ({ connectorsService: { listConnectedIds: () => [], agentWriteAllowed: () => false } }))
vi.mock('./ai/providerProfiles', () => ({ ProviderProfileService: class {} }))

import { weportAiService } from './weportAiService'
import { chatService } from './chatService'

describe('AI history investigation', () => {
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
