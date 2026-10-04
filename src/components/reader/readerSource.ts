/**
 * 阅读器的引擎适配层：探测通道、取数、把引擎的返回归一成阅读器形状。
 *
 * ## 通道检查
 *
 * The current Electron shell wires history paging, exact-hit lookup, message search,
 * and on-demand media. Runtime checks remain necessary for tests and alternate builds.
 * Missing channels get a visible explanation. `getNewMessages` is never substituted
 * for history, and exact identity includes the indexed shard/table to avoid duplicate ids.
 */
import type { EngineMessageLike, EngineSessionLike, ReaderMessage, ReaderMessagePage, ReaderSearchHit, ReaderSession } from './readerTypes'
import { mediaUrlFromPayload, normalizeMessage, normalizeSession, sortSessions } from './readerMessage'
import { searchLoadedMessages } from './readerWindow'

/** 引擎侧待接线的通道（名字与 `chatService` 方法一致）。 */
interface ReaderChatBridge {
  getSessions?: () => Promise<{ success: boolean; sessions?: unknown[]; error?: string }>
  getContactAvatar?: (username: string, chatroomId?: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
  getSessionMessageCounts?: (sessionIds: string[]) => Promise<{ success: boolean; counts?: Record<string, number>; error?: string }>
  getMessages?: (
    sessionId: string,
    offset?: number,
    limit?: number,
    startTime?: number,
    endTime?: number,
    ascending?: boolean,
  ) => Promise<{ success: boolean; messages?: unknown[]; hasMore?: boolean; nextOffset?: number; error?: string }>
  getImageDataByIdentity?: (identity: { sessionId: string; localId: string | number; ts: number; db?: string; table?: string; idKind?: 'local' | 'server' }, options?: { excludeThumbnail?: boolean }) => Promise<unknown>
  getVoiceData?: (sessionId: string, msgId: string, createTime?: number, serverId?: string | number, senderWxid?: string) => Promise<unknown>
  getMessageByIdentity?: (identity: { sessionId: string; localId: string | number; ts: number; db?: string; table?: string; idKind?: 'local' | 'server' }) => Promise<{ success: boolean; message?: unknown; error?: string }>
  getVideoData?: (identity: { sessionId: string; localId: string | number; ts: number; db?: string; table?: string; idKind?: 'local' | 'server' }) => Promise<unknown>
  getFileData?: (identity: { sessionId: string; localId: string | number; ts: number; db?: string; table?: string; idKind?: 'local' | 'server' }) => Promise<unknown>
  searchMessages?: (
    keyword: string,
    sessionId?: string,
    limit?: number,
    offset?: number,
    beginTimestamp?: number,
    endTimestamp?: number,
  ) => Promise<{ success: boolean; messages?: unknown[]; error?: string }>
}

export interface ReaderChannelStatus {
  sessions: boolean
  messages: boolean
  imageData: boolean
  voiceData: boolean
  videoData: boolean
  fileData: boolean
  search: boolean
  messageCounts: boolean
}

function chatBridge(): ReaderChatBridge | null {
  if (typeof window === 'undefined') return null
  const api = window.electronAPI as { chat?: ReaderChatBridge } | undefined
  return api?.chat ?? null
}

export function readerChannels(): ReaderChannelStatus {
  const chat = chatBridge()
  return {
    sessions: typeof chat?.getSessions === 'function',
    messages: typeof chat?.getMessages === 'function',
    imageData: typeof chat?.getImageDataByIdentity === 'function',
    voiceData: typeof chat?.getVoiceData === 'function',
    videoData: typeof chat?.getVideoData === 'function',
    fileData: typeof chat?.getFileData === 'function',
    search: typeof chat?.searchMessages === 'function',
    messageCounts: typeof chat?.getSessionMessageCounts === 'function',
  }
}

/**
 * 引擎缺口的人话说明。
 *
 * 页面上显示这段文字而不是"加载失败"：用户看不懂 `chat:getMessages 未注册`，
 * 但把通道名写出来，接线的同事一眼就知道该加什么。
 */
export function channelGapText(status: ReaderChannelStatus): string | null {
  const missing: string[] = []
  if (!status.messages) missing.push('消息分页（chat:getMessages）')
  if (!status.imageData) missing.push('图片解密（chat:getImageDataByIdentity）')
  if (!status.voiceData) missing.push('语音数据（chat:getVoiceData）')
  if (!status.videoData) missing.push('视频数据（chat:getVideoData）')
  if (!status.fileData) missing.push('文件数据（chat:getFileData）')
  if (!status.search) missing.push('会话内搜索（chat:searchMessages）')
  if (missing.length === 0) return null
  return `引擎尚未接入：${missing.join('、')}`
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface SessionsResult {
  sessions: ReaderSession[]
  /** 读失败的原因。空数组 + 无 error 才代表"这个账号真的没有会话"。 */
  error?: string
  channelMissing?: boolean
}

export async function loadReaderSessions(): Promise<SessionsResult> {
  const chat = chatBridge()
  if (typeof chat?.getSessions !== 'function') {
    return { sessions: [], error: '会话通道不可用（chat:getSessions）', channelMissing: true }
  }
  try {
    const payload = await chat.getSessions()
    if (payload && payload.success === false) {
      return { sessions: [], error: String(payload.error || '读取会话列表失败') }
    }
    const rows = Array.isArray(payload?.sessions) ? payload.sessions : []
    const sessions: ReaderSession[] = []
    for (const row of rows) {
      const session = normalizeSession(row as EngineSessionLike)
      if (session) sessions.push(session)
    }
    // 条数：`messageCountHint` 常常没有（引擎只回缓存里的提示），缺失时补一次真实计数。
    // **只在通道在的时候补**：一次 IPC 换整列数字，比每行写"—"有用。
    if (typeof chat.getSessionMessageCounts === 'function' && sessions.some((session) => session.messageCount === null)) {
      try {
        const counts = await chat.getSessionMessageCounts(sessions.map((session) => session.id))
        if (counts?.success && counts.counts) {
          for (const session of sessions) {
            const count = counts.counts[session.id]
            if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
              session.messageCount = Math.floor(count)
            }
          }
        }
      } catch {
        /* 条数拿不到不影响会话列表本身 */
      }
    }
    return { sessions: sortSessions(sessions) }
  } catch (error) {
    return { sessions: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** 补头像（`chat:getContactAvatar` 是**已经有的**通道，v1.0 通知页就在用）。 */
export async function loadAvatar(session: ReaderSession): Promise<string | undefined> {
  const chat = chatBridge()
  if (typeof chat?.getContactAvatar !== 'function') return undefined
  try {
    const result = await chat.getContactAvatar(session.id, session.kind === 'group' ? session.id : undefined)
    return result?.avatarUrl || undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 消息分页
// ---------------------------------------------------------------------------

export interface MessagePageQuery {
  sessionId: string
  offset?: number
  limit?: number
  /** 毫秒；引擎要秒，本函数负责换算。 */
  startTime?: number
  endTime?: number
}

export interface MessagePageResult extends Partial<ReaderMessagePage> {
  error?: string
  channelMissing?: boolean
}

export const READER_PAGE_SIZE = 60

/**
 * 取一页消息。
 *
 * 引擎契约（`chatService.getMessages`，`electron/services/chatService.ts:2613`，
 * 本次已用真库实测）：`offset=0` 是**最新**的一页，offset 变大就是往更早走；每页
 * 内部按时间升序；`nextOffset` 直接回传当下一页的 offset（它是"已消费的原始行数"，
 * 不是消息条数，所以不能自己累加 limit）。
 */
export async function loadMessagePage(query: MessagePageQuery): Promise<MessagePageResult> {
  const chat = chatBridge()
  if (typeof chat?.getMessages !== 'function') {
    return { error: '引擎未提供消息分页通道（chat:getMessages）', channelMissing: true }
  }
  const offset = Math.max(0, Math.floor(query.offset || 0))
  const limit = Math.max(1, Math.floor(query.limit || READER_PAGE_SIZE))
  const startTime = query.startTime ? Math.floor(query.startTime / 1000) : 0
  const endTime = query.endTime ? Math.floor(query.endTime / 1000) : 0
  try {
    const payload = await chat.getMessages(query.sessionId, offset, limit, startTime, endTime, false)
    if (!payload?.success) {
      return { error: String(payload?.error || '读取消息失败') }
    }
    const rows = Array.isArray(payload.messages) ? payload.messages : []
    const messages: ReaderMessage[] = rows.map((row, index) => normalizeMessage(row as EngineMessageLike, query.sessionId, index))
    const nextOffset = Number.isFinite(payload.nextOffset) ? Number(payload.nextOffset) : offset + messages.length
    return { messages, hasMore: payload.hasMore === true, nextOffset }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export interface MessageIdentityQuery {
  sessionId: string
  localId: string | number
  ts: number
  db?: string
  table?: string
  idKind?: 'local' | 'server'
}

function identityTimestampMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? (value < 1e12 ? Math.round(value * 1000) : Math.round(value)) : 0
}

function sameDatabaseIdentity(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected) return true
  if (!actual) return false
  const left = expected.trim().replace(/\\/g, '/').toLowerCase()
  const right = actual.trim().replace(/\\/g, '/').toLowerCase()
  if (left === right) return true
  const leftHasPath = left.includes('/')
  const rightHasPath = right.includes('/')
  if (leftHasPath && rightHasPath) return false
  return left.split('/').pop() === right.split('/').pop()
}

/** Validate the IPC response before letting an indexed identity select a message. */
export function messageMatchesIdentity(message: ReaderMessage, identity: MessageIdentityQuery): boolean {
  const expectedId = String(identity.localId ?? '').trim()
  const actualId = identity.idKind === 'server'
    ? String(message.idKind === 'server' ? message.messageId || message.serverId || '' : message.serverId || '').trim()
    : String(message.idKind === 'local' ? message.messageId || message.localId : message.localId).trim()
  if (!expectedId || actualId !== expectedId) return false
  const expectedTs = identityTimestampMs(Number(identity.ts))
  if (expectedTs && Math.abs(message.ts - expectedTs) > 1000) return false
  if (!sameDatabaseIdentity(identity.db, message.db)) return false
  if (identity.table && identity.table !== message.table) return false
  return true
}

function identityForMessage(message: ReaderMessage): MessageIdentityQuery {
  const idKind = message.idKind || (message.localId > 0 ? 'local' : 'server')
  return {
    sessionId: message.sessionId,
    localId: message.messageId || (message.localId > 0 ? message.localId : message.serverId || ''),
    ts: message.ts,
    db: message.db,
    table: message.table,
    idKind,
  }
}

/** Fetch the exact indexed hit, including its database/table identity when known. */
export async function loadMessageByIdentity(query: MessageIdentityQuery): Promise<{ message?: ReaderMessage; error?: string }> {
  if (typeof query.localId === 'number' && !Number.isSafeInteger(query.localId)) {
    return { error: '消息 ID 超出安全整数范围；请使用字符串 ID 精确定位' }
  }
  const chat = chatBridge()
  if (typeof chat?.getMessageByIdentity !== 'function') return { error: '引擎未提供精确消息通道（chat:getMessageByIdentity）' }
  try {
    const result = await chat.getMessageByIdentity(query)
    if (!result?.success || !result.message) return { error: String(result?.error || '未能精确读取搜索命中') }
    const message = normalizeMessage(result.message as EngineMessageLike, query.sessionId)
    if (!messageMatchesIdentity(message, query)) return { error: '引擎返回的消息与索引位置不一致，请重建搜索索引' }
    return { message }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// 媒体
// ---------------------------------------------------------------------------

/** 图片：引擎解密后回 base64 或本地路径（`mediaUrlFromPayload` 两种都认）。 */
export async function loadMessageImage(message: ReaderMessage): Promise<{ url?: string; error?: string }> {
  const chat = chatBridge()
  if (typeof chat?.getImageDataByIdentity !== 'function') {
    return { error: '引擎未提供精确图片通道（chat:getImageDataByIdentity）' }
  }
  try {
    const payload = await chat.getImageDataByIdentity(identityForMessage(message))
    return mediaUrlFromPayload(payload)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 语音：渲染层**没有** silk 解码器（`silk-wasm` 只在主进程里用：
 * `electron/services/chatService.ts:9390`）。这里只认引擎回**可直接播放**的音频
 * （`data:` / 本地路径）。回的是原始 silk 字节时返回 null，界面显示
 * 「音频需要导出后播放」而不是装一个假播放器。
 */
export async function loadMessageVoice(
  sessionId: string,
  localId: number,
  createTime: number,
  serverId?: string,
  senderWxid?: string,
): Promise<{ url?: string; error?: string }> {
  const chat = chatBridge()
  if (typeof chat?.getVoiceData !== 'function') {
    return { error: '引擎未提供语音通道（chat:getVoiceData）' }
  }
  try {
    let payload = await chat.getVoiceData(sessionId, String(localId), Math.floor(createTime / 1000), serverId, senderWxid)
    // ChatService decodes Silk and currently returns WAV bytes as base64 without a MIME
    // field. The generic media resolver defaults unknown base64 to image/jpeg, so state
    // that established engine contract explicitly here.
    if (payload && typeof payload === 'object') {
      const record = payload as { data?: unknown; mime?: unknown }
      if (typeof record.data === 'string' && record.data && !record.mime && !record.data.startsWith('data:')) {
        payload = { ...(payload as Record<string, unknown>), mime: 'audio/wav' }
      }
    }
    const parsed = mediaUrlFromPayload(payload)
    if (!parsed.url) return parsed
    // 裸 silk（`#!SILK`）或非音频 MIME 一律不播：`<audio>` 播不出来，只会静默失败。
    if (parsed.url.startsWith('data:') && !/^data:audio\//i.test(parsed.url)) {
      return { error: '语音数据不是可直接播放的音频（需要 silk 解码）' }
    }
    return parsed
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function loadMessageVideo(message: ReaderMessage): Promise<{ url?: string; error?: string }> {
  const chat = chatBridge()
  if (typeof chat?.getVideoData !== 'function') return { error: '引擎未提供视频通道（chat:getVideoData）' }
  try {
    return mediaUrlFromPayload(await chat.getVideoData({
      ...identityForMessage(message),
    }))
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function loadMessageFile(message: ReaderMessage): Promise<{ url?: string; path?: string; fileName?: string; error?: string }> {
  const chat = chatBridge()
  if (typeof chat?.getFileData !== 'function') return { error: '引擎未提供文件通道（chat:getFileData）' }
  try {
    const payload = await chat.getFileData({
      ...identityForMessage(message),
    })
    const parsed = mediaUrlFromPayload(payload)
    const record = payload && typeof payload === 'object' ? payload as { localPath?: unknown; filePath?: unknown; fileName?: unknown } : {}
    return {
      ...parsed,
      path: typeof record.localPath === 'string' ? record.localPath : typeof record.filePath === 'string' ? record.filePath : undefined,
      fileName: typeof record.fileName === 'string' ? record.fileName : undefined,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// 会话内搜索
// ---------------------------------------------------------------------------

export interface SessionSearchResult {
  hits: ReaderSearchHit[]
  /** false = 引擎没有搜索通道，`hits` 是**已加载消息**的本地过滤结果。 */
  engineSearch: boolean
  error?: string
}

export async function searchSession(
  sessionId: string,
  keyword: string,
  loaded: ReaderMessage[],
  limit = 200,
): Promise<SessionSearchResult> {
  const needle = keyword.trim()
  if (!needle) return { hits: [], engineSearch: false }
  const chat = chatBridge()
  if (typeof chat?.searchMessages !== 'function') {
    return { hits: searchLoadedMessages(loaded, needle, limit), engineSearch: false }
  }
  try {
    const payload = await chat.searchMessages(needle, sessionId, limit)
    if (!payload?.success) {
      return { hits: searchLoadedMessages(loaded, needle, limit), engineSearch: false, error: String(payload?.error || '搜索失败，已退回已加载消息') }
    }
    const rows = Array.isArray(payload.messages) ? payload.messages : []
    const hits: ReaderSearchHit[] = rows.map((row) => {
      const message = normalizeMessage(row as EngineMessageLike, sessionId)
      return {
        key: message.key,
        index: -1,
        ts: message.ts,
        senderName: message.isSend ? '我' : message.senderName || message.senderUsername,
        excerpt: message.text.slice(0, 80),
        localId: message.localId || undefined,
        serverId: message.serverId,
        db: message.db,
        table: message.table,
        idKind: message.localId > 0 ? 'local' : message.serverId ? 'server' : undefined,
      }
    })
    return { hits, engineSearch: true }
  } catch (error) {
    return { hits: searchLoadedMessages(loaded, needle, limit), engineSearch: false, error: error instanceof Error ? error.message : String(error) }
  }
}
