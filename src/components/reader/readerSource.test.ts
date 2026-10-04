import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channelGapText,
  loadMessageImage,
  loadMessagePage,
  loadMessageByIdentity,
  loadMessageFile,
  loadMessageVideo,
  loadMessageVoice,
  loadReaderSessions,
  messageMatchesIdentity,
  readerChannels,
  searchSession,
} from './readerSource'
import { normalizeMessage } from './readerMessage'
import type { ReaderMessage } from './readerTypes'

/**
 * 引擎适配层（v1.2 §3）。
 *
 * 这组用例只关心一件事：**通道缺失时降级成真话**。写这段代码时 `electron/appMain.ts`
 * 里只有 `chat:getSessions` 与 `chat:getNewMessages`，所以"通道不存在"是**的正常
 * 状态**而不是异常状态 —— 页面必须显示缺口说明，不能伪造历史、不能空数组冒充。
 *
 * 用 stub 的 `window.electronAPI` 驱动：`readerSource` 每次调用都从 `window` 取桥，
 * 所以这里能按用例换掉整个引擎（node 环境没有 window，需自己挂）。
 */

function stubChat(chat: Record<string, unknown> | null): void {
  ;(globalThis as unknown as { window?: unknown }).window = chat === null ? undefined : { electronAPI: { chat } }
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  vi.restoreAllMocks()
})

describe('readerChannels', () => {
  it('没有 window（或在浏览器里没预加载）时全部为 false', () => {
    stubChat(null)
    const status = readerChannels()
    expect(status.sessions).toBe(false)
    expect(status.messages).toBe(false)
    expect(status.imageData).toBe(false)
    expect(status.voiceData).toBe(false)
    expect(status.videoData).toBe(false)
    expect(status.fileData).toBe(false)
    expect(status.search).toBe(false)
    expect(status.messageCounts).toBe(false)
  })

  it('按方法逐个探测（实测引擎只有 getSessions）', () => {
    stubChat({ getSessions: async () => ({ success: true, sessions: [] }) })
    const status = readerChannels()
    expect(status.sessions).toBe(true)
    expect(status.messages).toBe(false)
  })

  it('缺口说明点名要接的通道（接线的同事照着这个名字加 handler）', () => {
    const text = channelGapText({
      sessions: true,
      messages: false,
      imageData: false,
      voiceData: true,
      videoData: false,
      fileData: true,
      search: false,
      messageCounts: true,
    })
    expect(text).toContain('chat:getMessages')
    expect(text).toContain('chat:getImageDataByIdentity')
    expect(text).toContain('chat:searchMessages')
    // 已经有的通道不该出现在"尚未接入"里
    expect(text).not.toContain('chat:getVoiceData')
  })

  it('全部就绪时没有缺口说明', () => {
    expect(
      channelGapText({ sessions: true, messages: true, imageData: true, voiceData: true, videoData: true, fileData: true, search: true, messageCounts: true }),
    ).toBeNull()
  })
})

describe('loadReaderSessions', () => {
  it('通道缺失 → channelMissing（与"账号没有会话"区分开）', async () => {
    stubChat({})
    const result = await loadReaderSessions()
    expect(result.channelMissing).toBe(true)
    expect(result.sessions).toEqual([])
    expect(result.error).toContain('chat:getSessions')
  })

  it('按最近活跃降序，并把 messageCountHint 归一成条数', async () => {
    stubChat({
      getSessions: async () => ({
        success: true,
        sessions: [
          { username: 'old@chatroom', displayName: '旧群', lastTimestamp: 1000, messageCountHint: 12 },
          { username: 'new@chatroom', displayName: '新群', lastTimestamp: 3000, messageCountHint: 34 },
        ],
      }),
    })
    const result = await loadReaderSessions()
    expect(result.error).toBeUndefined()
    expect(result.sessions.map((session) => session.id)).toEqual(['new@chatroom', 'old@chatroom'])
    expect(result.sessions[0].messageCount).toBe(34)
  })

  it('缺条数时补一次真实计数（只在通道存在时）', async () => {
    const getSessionMessageCounts = vi.fn(async () => ({ success: true, counts: { 'a@chatroom': 5072 } }))
    stubChat({
      getSessions: async () => ({ success: true, sessions: [{ username: 'a@chatroom', displayName: 'A', lastTimestamp: 1 }] }),
      getSessionMessageCounts,
    })
    const result = await loadReaderSessions()
    expect(getSessionMessageCounts).toHaveBeenCalledWith(['a@chatroom'])
    expect(result.sessions[0].messageCount).toBe(5072)
  })

  it('计数通道抛错也不影响会话列表本身', async () => {
    stubChat({
      getSessions: async () => ({ success: true, sessions: [{ username: 'a@chatroom', lastTimestamp: 1 }] }),
      getSessionMessageCounts: async () => {
        throw new Error('boom')
      },
    })
    const result = await loadReaderSessions()
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0].messageCount).toBeNull()
  })

  it('引擎明确报错时把原因带出来（不是显示成"没有会话"）', async () => {
    stubChat({ getSessions: async () => ({ success: false, error: '数据库未连接' }) })
    const result = await loadReaderSessions()
    expect(result.sessions).toEqual([])
    expect(result.error).toBe('数据库未连接')
  })

  it('丢字段的行被丢掉（没有 username 的行渲染出来只会是空行）', async () => {
    stubChat({ getSessions: async () => ({ success: true, sessions: [{ displayName: '没有 id' }, { username: 'ok' }] }) })
    const result = await loadReaderSessions()
    expect(result.sessions.map((session) => session.id)).toEqual(['ok'])
  })
})

describe('loadMessagePage', () => {
  it('没有 chat:getMessages 时明确报 channelMissing，且不返回任何消息', async () => {
    stubChat({ getNewMessages: async () => ({ success: true, messages: [{ localId: 1, localType: 1 }] }) })
    const page = await loadMessagePage({ sessionId: 's1' })
    expect(page.channelMissing).toBe(true)
    expect(page.messages).toBeUndefined()
    expect(page.error).toContain('chat:getMessages')
  })

  it('正常一页：归一消息、带上 hasMore 与 nextOffset', async () => {
    const getMessages = vi.fn(async () => ({
      success: true,
      messages: [
        { messageKey: 'k1', localId: 5, createTime: 1790388300, localType: 1, parsedContent: 'hello' },
        { messageKey: 'k2', localId: 6, createTime: 1790390545, localType: 3 },
      ],
      hasMore: true,
      nextOffset: 2,
    }))
    stubChat({ getMessages })
    const page = await loadMessagePage({ sessionId: 's1', limit: 60 })
    expect(page.messages?.map((item) => item.key)).toEqual(['k1', 'k2'])
    expect(page.hasMore).toBe(true)
    expect(page.nextOffset).toBe(2)
    expect(page.messages?.[0].ts).toBe(1790388300000)
  })

  it('毫秒入参被换算成引擎要的秒（引擎的 start/end 是秒）', async () => {
    const getMessages = vi.fn(async () => ({ success: true, messages: [], hasMore: false, nextOffset: 0 }))
    stubChat({ getMessages })
    await loadMessagePage({ sessionId: 's1', startTime: 1790388300000, endTime: 1790474700000 })
    expect(getMessages).toHaveBeenCalledWith('s1', 0, 60, 1790388300, 1790474700, false)
  })

  it('引擎回 success:false 时把错误带出来，不吞成空页', async () => {
    stubChat({ getMessages: async () => ({ success: false, error: '打开消息游标失败' }) })
    const page = await loadMessagePage({ sessionId: 's1' })
    expect(page.error).toBe('打开消息游标失败')
    expect(page.messages).toBeUndefined()
  })

  it('IPC 抛错也变成 error（页面显示原因，而不是一直转圈）', async () => {
    stubChat({
      getMessages: async () => {
        throw new Error('Error invoking remote method')
      },
    })
    const page = await loadMessagePage({ sessionId: 's1' })
    expect(page.error).toContain('Error invoking remote method')
  })

  it('没有 nextOffset 时用 offset + 本页条数兜底（下一页不会原地打转）', async () => {
    stubChat({ getMessages: async () => ({ success: true, messages: [{ localId: 1 }, { localId: 2 }], hasMore: true }) })
    const page = await loadMessagePage({ sessionId: 's1', offset: 10, limit: 2 })
    expect(page.nextOffset).toBe(12)
  })
})

describe('exact search hit lookup', () => {
  it('passes database/table/id kind and normalizes the returned exact message', async () => {
    const getMessageByIdentity = vi.fn(async () => ({
      success: true,
      message: { messageKey: 'shard-k', localId: 12, serverId: '90012', createTime: 1790388300, localType: 1, parsedContent: 'needle', _db_path: 'C:/wx/message_2.db', _table_name: 'Msg_abc' },
    }))
    stubChat({ getMessageByIdentity })
    const result = await loadMessageByIdentity({ sessionId: 's1', localId: '12', ts: 1790388300000, db: 'message_2.db', table: 'Msg_abc', idKind: 'local' })
    expect(getMessageByIdentity).toHaveBeenCalledWith({ sessionId: 's1', localId: '12', ts: 1790388300000, db: 'message_2.db', table: 'Msg_abc', idKind: 'local' })
    expect(result.message?.key).toBe('shard-k')
    expect(result.message?.text).toBe('needle')
    expect(result.message?.db).toBe('C:/wx/message_2.db')
    expect(result.message?.table).toBe('Msg_abc')
  })

  it('rejects a returned row from a different shard even when its local id and timestamp match', async () => {
    stubChat({ getMessageByIdentity: async () => ({
      success: true,
      message: { messageKey: 'wrong-shard', localId: 12, createTime: 1790388300, localType: 1, _db_path: 'C:/wx/message_3.db', _table_name: 'Msg_abc' },
    }) })
    const result = await loadMessageByIdentity({ sessionId: 's1', localId: '12', ts: 1790388300000, db: 'message_2.db', table: 'Msg_abc', idKind: 'local' })
    expect(result.message).toBeUndefined()
    expect(result.error).toContain('与索引位置不一致')
  })

  it('passes a large server ID as text without numeric coercion', async () => {
    const serverId = '9007199254740993'
    const getMessageByIdentity = vi.fn(async () => ({
      success: true,
      message: { serverIdRaw: serverId, localId: 0, createTime: 1790388300, localType: 1, _db_path: 'C:/wx/message_2.db', _table_name: 'Msg_A' },
    }))
    stubChat({ getMessageByIdentity })
    const result = await loadMessageByIdentity({ sessionId: 's1', localId: serverId, ts: 1790388300000, db: 'message_2.db', table: 'Msg_A', idKind: 'server' })
    expect(getMessageByIdentity).toHaveBeenCalledWith({ sessionId: 's1', localId: serverId, ts: 1790388300000, db: 'message_2.db', table: 'Msg_A', idKind: 'server' })
    expect(result.message?.messageId).toBe(serverId)
  })

  it('matches an int64 local ID after IPC kept the raw token beside the rounded number', () => {
    const localIdRaw = '9007199254740993'
    const message = normalizeMessage({
      messageKey: 'fixture-message-key',
      localId: Number(localIdRaw),
      localIdRaw,
      serverId: 0,
      serverIdRaw: '0',
      createTime: 1790388300,
      localType: 1,
      _db_path: 'C:/wx/message_2.db',
      _table_name: 'Msg_A',
    }, 's1')
    const identity = {
      sessionId: 's1', localId: localIdRaw, ts: 1790388300000,
      db: 'message_2.db', table: 'Msg_A', idKind: 'local' as const,
    }

    expect(message.localId).toBe(0)
    expect(message.messageId).toBe(localIdRaw)
    expect(message.idKind).toBe('local')
    expect(messageMatchesIdentity(message, identity)).toBe(true)
    expect(messageMatchesIdentity(message, { ...identity, localId: String(Number(localIdRaw)) })).toBe(false)
  })

  it('matches uint64 server identity when IPC returns the signed SQLite int64 alias', () => {
    const serverId = '18446744073709551610'
    const message = normalizeMessage({
      messageKey: 'fixture-server-message-key',
      localId: 0,
      localIdRaw: '0',
      serverId: -6,
      serverIdRaw: serverId,
      createTime: 1790388300,
      localType: 1,
      _db_path: 'C:/wx/message_2.db',
      _table_name: 'Msg_A',
    }, 's1')
    const identity = {
      sessionId: 's1', localId: serverId, ts: 1790388300000,
      db: 'message_2.db', table: 'Msg_A', idKind: 'server' as const,
    }

    expect(message.localId).toBe(0)
    expect(message.messageId).toBe(serverId)
    expect(message.idKind).toBe('server')
    expect(messageMatchesIdentity(message, identity)).toBe(true)
    expect(messageMatchesIdentity(message, { ...identity, localId: '-6' })).toBe(false)
  })

  it('rejects unsafe numeric IDs before IPC', async () => {
    const getMessageByIdentity = vi.fn()
    stubChat({ getMessageByIdentity })
    const result = await loadMessageByIdentity({ sessionId: 's1', localId: Number('9007199254740993'), ts: 1790388300000, idKind: 'server' })
    expect(getMessageByIdentity).not.toHaveBeenCalled()
    expect(result.error).toContain('字符串 ID')
  })
})

describe('媒体通道', () => {
  it('图片通道缺失时说清楚（不返回空 src 让 <img> 静默失败）', async () => {
    stubChat({})
    const result = await loadMessageImage(normalizeMessage({ localId: 42, createTime: 1790388300, localType: 3 }, 's1'))
    expect(result.url).toBeUndefined()
    expect(result.error).toContain('chat:getImageDataByIdentity')
  })

  it('图片通道携带消息精确身份并返回 base64 → data URL', async () => {
    const getImageDataByIdentity = vi.fn(async () => ({ success: true, data: 'iVBORw0KGgo' }))
    stubChat({ getImageDataByIdentity })
    const message = normalizeMessage({ localId: 42, createTime: 1790388300, localType: 3, _db_path: 'C:/wx/message_2.db', _table_name: 'Msg_abc' }, 's1')
    const result = await loadMessageImage(message)
    expect(getImageDataByIdentity).toHaveBeenCalledWith({ sessionId: 's1', localId: '42', ts: 1790388300000, db: 'C:/wx/message_2.db', table: 'Msg_abc', idKind: 'local' })
    expect(result.url).toBe('data:image/png;base64,iVBORw0KGgo')
  })

  it('语音：裸 silk / 非音频数据不当作可播放音频（渲染层没有 silk 解码器）', async () => {
    stubChat({ getVoiceData: async () => ({ success: true, data: 'AAAA', mime: 'application/octet-stream' }) })
    const result = await loadMessageVoice('s1', 42, 1790388300000)
    expect(result.url).toBeUndefined()
    expect(result.error).toContain('silk')
  })

  it('语音：引擎回 wav base64 → 可播放', async () => {
    stubChat({ getVoiceData: async () => ({ success: true, data: 'AAA', mime: 'audio/wav' }) })
    const result = await loadMessageVoice('s1', 42, 1790388300000)
    expect(result.url).toBe('data:audio/wav;base64,AAA')
  })

  it('语音：当前引擎省略 MIME 时按已解码 WAV 合同补 audio/wav', async () => {
    stubChat({ getVoiceData: async () => ({ success: true, data: 'UklGRg==' }) })
    const result = await loadMessageVoice('s1', 42, 1790388300000)
    expect(result.url).toBe('data:audio/wav;base64,UklGRg==')
  })

  it('视频通道返回本地 URL 时携带分片身份并可直接播放', async () => {
    const getVideoData = vi.fn(async () => ({ success: true, url: 'weport-media://local/C%3A%5Ccache%5Cclip.mp4' }))
    stubChat({ getVideoData })
    const result = await loadMessageVideo(normalizeMessage({ localId: 42, createTime: 1790388300, localType: 43, videoMd5: 'a'.repeat(32), _db_path: 'C:/wx/message_2.db', _table_name: 'Msg_abc' }, 's1'))
    expect(getVideoData).toHaveBeenCalledWith({ sessionId: 's1', localId: '42', ts: 1790388300000, db: 'C:/wx/message_2.db', table: 'Msg_abc', idKind: 'local' })
    expect(result.url).toContain('weport-media://local/')
  })

  it('只存在 serverId 时用 server 身份定位视频', async () => {
    const getVideoData = vi.fn(async () => ({ success: true, url: 'weport-media://local/C%3A%5Ccache%5Cclip.mp4' }))
    stubChat({ getVideoData })
    await loadMessageVideo(normalizeMessage({ localId: 0, serverId: '90012', createTime: 1790388300, localType: 43 }, 's1'))
    expect(getVideoData).toHaveBeenCalledWith({ sessionId: 's1', localId: '90012', ts: 1790388300000, db: undefined, table: undefined, idKind: 'server' })
  })

  it('文件通道返回路径和名字时携带分片身份并保留系统打开路径', async () => {
    const getFileData = vi.fn(async () => ({ success: true, localPath: 'C:\\wx\\FileStorage\\File\\report.pdf', fileName: 'report.pdf' }))
    stubChat({ getFileData })
    const result = await loadMessageFile(normalizeMessage({ localId: 42, createTime: 1790388300, localType: 49, fileName: 'report.pdf', _db_path: 'C:/wx/message_2.db', _table_name: 'Msg_abc' }, 's1'))
    expect(getFileData).toHaveBeenCalledWith({ sessionId: 's1', localId: '42', ts: 1790388300000, db: 'C:/wx/message_2.db', table: 'Msg_abc', idKind: 'local' })
    expect(result.path).toContain('report.pdf')
    expect(result.fileName).toBe('report.pdf')
    expect(result.url).toContain('weport-media://local/')
  })
})

describe('searchSession', () => {
  const loaded: ReaderMessage[] = [
    normalizeMessage({ localId: 1, createTime: 100, localType: 1, parsedContent: '项目进度' }, 's1'),
    normalizeMessage({ localId: 2, createTime: 200, localType: 1, parsedContent: '无关' }, 's1'),
  ]

  it('没有引擎搜索通道时退回"已加载消息"的本地过滤，并明确标注', async () => {
    stubChat({})
    const result = await searchSession('s1', '项目', loaded)
    expect(result.engineSearch).toBe(false)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].index).toBe(0)
  })

  it('有引擎搜索通道时用引擎结果，index 为 -1（不在已加载窗口里）', async () => {
    stubChat({
      searchMessages: async () => ({
        success: true,
        messages: [{ messageKey: 'k9', localId: 9, createTime: 900, localType: 1, parsedContent: '项目' }],
      }),
    })
    const result = await searchSession('s1', '项目', loaded)
    expect(result.engineSearch).toBe(true)
    expect(result.hits[0].key).toBe('k9')
    expect(result.hits[0].index).toBe(-1)
  })

  it('引擎搜索失败时退回本地结果并带上原因', async () => {
    stubChat({ searchMessages: async () => ({ success: false, error: '索引未建立' }) })
    const result = await searchSession('s1', '项目', loaded)
    expect(result.engineSearch).toBe(false)
    expect(result.hits).toHaveLength(1)
    expect(result.error).toContain('索引未建立')
  })

  it('空关键词不发请求', async () => {
    const searchMessages = vi.fn()
    stubChat({ searchMessages })
    const result = await searchSession('s1', '   ', loaded)
    expect(result.hits).toEqual([])
    expect(searchMessages).not.toHaveBeenCalled()
  })
})
