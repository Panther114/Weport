/**
 * 阅读器的纯映射层：引擎 raw → 阅读器形状、消息类型分派、文本/时间/大小格式化。
 *
 * 这里全部是**纯函数**，没有任何 DOM / IPC 依赖：它们是单测能覆盖的那部分
 * （vitest 的 environment 是 `node`，见 `vitest.config.mts` —— 没有 jsdom，所以
 * 组件渲染测不了，能测的只有这一层）。
 */
import type {
  EngineMessageLike,
  EngineSessionLike,
  ReaderMessage,
  ReaderMessageKind,
  ReaderSession,
  ReaderSessionKind,
} from './readerTypes'

// ---------------------------------------------------------------------------
// 基础归一
// ---------------------------------------------------------------------------

const MAX_TIMESTAMP_MS = 1e11

/**
 * 时间戳归一：数据库里的 `create_time` 是**秒**（WeFlow 口径，见
 * `chatService.ts:2675` 的注释与本次实测：`at: 1790390545`），但个别路径塞进来的
 * 是毫秒。1e11 秒 ≈ 公元 5138 年，所以「小于 1e11 当秒」不会误伤任何真实毫秒值。
 */
export function normalizeTimestamp(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw < MAX_TIMESTAMP_MS ? Math.round(raw * 1000) : Math.round(raw)
}

/** 毫秒 → 引擎要的秒（`getMessages` 的 startTime/endTime 都是秒）。 */
export function toEngineSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value / 1000)
}

export function sessionKindOf(sessionId: string): ReaderSessionKind {
  const id = String(sessionId || '')
  if (id.endsWith('@chatroom')) return 'group'
  if (id.startsWith('gh_')) return 'official'
  return 'private'
}

export const SESSION_KIND_LABEL: Record<ReaderSessionKind, string> = {
  group: '群聊',
  private: '私聊',
  official: '公众号',
}

function str(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function boolText(value: string): string {
  return value.trim()
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export function normalizeSession(raw: EngineSessionLike): ReaderSession | null {
  const id = str(raw?.username).trim()
  if (!id) return null
  const name = str(raw.displayName) || str(raw.sessionDisplayName) || id
  const lastAt = normalizeTimestamp(
    num(raw.lastTimestamp) || num(raw.sortTimestamp),
  )
  // `messageCountHint` 是"缓存里的提示"，引擎自己也不保证有 —— 缺了就是 null，
  // 界面写"—"而不是写 0（写 0 会让人以为这个会话是空的）。
  const hint = Number(raw.messageCountHint)
  const messageCount = Number.isFinite(hint) && hint >= 0 ? Math.floor(hint) : null
  return {
    id,
    name,
    kind: sessionKindOf(id),
    lastAt,
    messageCount,
    unreadCount: Math.max(0, Math.floor(num(raw.unreadCount))),
    summary: str(raw.summary),
    avatarUrl: str(raw.avatarUrl) || undefined,
    isMuted: raw.isMuted === true,
    isFolded: raw.isFolded === true,
  }
}

/** 会话行排序：最近活跃优先（引擎已排序，这里只兜住引擎没排序的情况）。 */
export function sortSessions(sessions: ReaderSession[]): ReaderSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => (b.session.lastAt - a.session.lastAt) || (a.index - b.index))
    .map((entry) => entry.session)
}

export interface SessionFilter {
  kind: 'all' | ReaderSessionKind
  keyword: string
}

export function filterSessions(sessions: ReaderSession[], filter: SessionFilter): ReaderSession[] {
  const keyword = filter.keyword.trim().toLowerCase()
  return sessions.filter((session) => {
    if (filter.kind !== 'all' && session.kind !== filter.kind) return false
    if (!keyword) return true
    const haystack = `${session.name} ${session.id} ${session.summary}`.toLowerCase()
    return haystack.includes(keyword)
  })
}

// ---------------------------------------------------------------------------
// 消息类型分派
// ---------------------------------------------------------------------------

/** type 49 的细分：`parseType49` 只解出 `xmlType`/`appMsgKind`，没解出的靠文本兜底。 */
export function appMsgKindOf(raw: EngineMessageLike): ReaderMessageKind {
  const kind = str(raw.appMsgKind).toLowerCase()
  const xmlType = str(raw.xmlType)
  if (kind) {
    if (kind.includes('link')) return 'link'
    if (kind.includes('file')) return 'file'
    if (kind.includes('miniprogram') || kind.includes('appbrand')) return 'miniprogram'
    if (kind.includes('chatrecord') || kind.includes('record')) return 'chatrecord'
    if (kind.includes('transfer')) return 'transfer'
    if (kind.includes('redpacket') || kind.includes('hongbao')) return 'redpacket'
    if (kind.includes('music')) return 'music'
    if (kind.includes('finder')) return 'finder'
    if (kind.includes('gift')) return 'gift'
    if (kind.includes('location')) return 'location'
  }
  switch (xmlType) {
    case '5':
    case '49':
      return 'link'
    case '6':
      return 'file'
    case '19':
      return 'chatrecord'
    case '33':
    case '36':
      return 'miniprogram'
    case '51':
      return 'finder'
    case '53':
      return 'announcement'
    case '57':
      return 'quote'
    case '87':
      return 'announcement'
    case '2000':
      return 'transfer'
    case '2001':
      return 'redpacket'
    case '3':
      return 'music'
    default:
      break
  }
  if (str(raw.fileName)) return 'file'
  if (str(raw.linkUrl) || str(raw.linkTitle)) return 'link'
  if (Array.isArray(raw.chatRecordList) && raw.chatRecordList.length > 0) return 'chatrecord'
  if (str(raw.locationLabel) || str(raw.locationPoiname)) return 'location'
  if (str(raw.transferPayerUsername) || str(raw.transferReceiverUsername)) return 'transfer'
  return 'link'
}

/**
 * 消息类型分派。localType 取值表：`chatService.parseMessageContent()`
 * （`electron/services/chatService.ts:6186`）+ `MESSAGE_TYPE_MAP`
 * （`electron/services/export/constants.ts:1`）。
 */
export function messageKindOf(raw: EngineMessageLike): ReaderMessageKind {
  const localType = num(raw.localType)
  switch (localType) {
    case 1:
      return 'text'
    case 3:
      return 'image'
    case 34:
      return 'voice'
    case 42:
      return 'card'
    case 43:
      return 'video'
    case 47:
      return 'sticker'
    case 48:
      return 'location'
    case 49:
    case 34359738417:
    case 103079215153:
    case 25769803825:
      return appMsgKindOf(raw)
    case 50:
      return 'call'
    case 10000:
      return 'system'
    case 244813135921:
      return 'quote'
    case 266287972401:
      return 'pat'
    case 81604378673:
      return 'chatrecord'
    case 8594229559345:
      return 'redpacket'
    case 8589934592049:
      return 'transfer'
    default:
      break
  }
  if (Array.isArray(raw.chatRecordList) && raw.chatRecordList.length > 0) return 'chatrecord'
  return 'other'
}

const REVOKE_PATTERN = /(撤回了一条消息|recalled a message|撤回了)/i

/** 撤回是引擎自己的系统消息（localType 10000）；原文保留态需要防撤回通道，见上报的引擎缺口。 */
export function isRevokeSystemMessage(kind: ReaderMessageKind, text: string): boolean {
  return kind === 'system' && REVOKE_PATTERN.test(text)
}

export function messageKeyOf(raw: EngineMessageLike, sessionId: string, index = 0): string {
  const key = str(raw.messageKey).trim()
  if (key) return key
  const localId = str(raw.localIdRaw).trim() || str(raw.localId).trim() || String(num(raw.localId))
  const ts = normalizeTimestamp(raw.createTime)
  return `${sessionId}:${localId}:${ts}:${index}`
}

function quoteOf(raw: EngineMessageLike): ReaderMessage['quote'] {
  const text = boolText(str(raw.quotedContent))
  const sender = boolText(str(raw.quotedSender))
  if (!text && !sender) return undefined
  return { sender: sender || '引用', text }
}

/**
 * raw → 阅读器消息。
 *
 * `sessionId` 必传：引擎的 `Message` 里**没有** sessionId（会话是查询参数），
 * 阅读器的标记 / 收藏 / 跳转都要它，缺了就没法定位。
 */
export function normalizeMessage(raw: EngineMessageLike, sessionId: string, index = 0): ReaderMessage {
  const kind = messageKindOf(raw)
  const voiceTranscript = boolText(str(raw.voiceTranscript)) || undefined
  const text = kind === 'voice' && voiceTranscript
    ? voiceTranscript
    : boolText(str(raw.parsedContent) || str(raw.content))
  const chatRecordList = Array.isArray(raw.chatRecordList) ? raw.chatRecordList : []
  // WCDB's int64 local_id must cross IPC as a decimal string when Number has
  // already rounded it. Keep the safe numeric field for paging/UI arithmetic,
  // but use the exact token for identity matching and annotations.
  const exactLocalId = str(raw.localIdRaw).trim()
  const rawLocalId = exactLocalId || str(raw.localId).trim()
  const numericLocalId = num(exactLocalId || raw.localId)
  const localId = Number.isSafeInteger(numericLocalId) && numericLocalId > 0 ? numericLocalId : 0
  const serverId = str(raw.serverIdRaw) || str(raw.serverId)
  const explicitIdKind = raw.idKind === 'local' || raw.idKind === 'server' ? raw.idKind : undefined
  const idKind = explicitIdKind || (rawLocalId && rawLocalId !== '0' ? 'local' : localId > 0 ? 'local' : serverId ? 'server' : undefined)
  const rawMessageId = str(raw.messageId).trim() || (idKind === 'server'
    ? serverId
    : idKind === 'local'
      ? localId > 0 ? String(localId) : rawLocalId
      : '')
  const messageId = /^\d+$/.test(rawMessageId) && rawMessageId !== '0' ? rawMessageId : undefined
  return {
    key: messageKeyOf(raw, sessionId, index),
    sessionId,
    localId,
    messageId,
    idKind: messageId ? idKind : undefined,
    serverId: serverId || undefined,
    ts: normalizeTimestamp(raw.createTime),
    isSend: num(raw.isSend) === 1,
    senderName: str(raw.senderDisplayName) || str(raw.senderUsername) || '',
    senderUsername: str(raw.senderUsername),
    senderAvatarUrl: str(raw.senderAvatarUrl) || undefined,
    kind,
    text,
    voiceTranscript,
    quote: quoteOf(raw),
    imageMd5: str(raw.imageMd5) || undefined,
    imageDatName: str(raw.imageDatName) || undefined,
    stickerUrl: str(raw.emojiCdnUrl) || str(raw.emojiThumbUrl) || undefined,
    stickerMd5: str(raw.emojiMd5) || undefined,
    stickerLocalPath: str(raw.emojiLocalPath) || undefined,
    videoMd5: str(raw.videoMd5) || undefined,
    voiceDurationSeconds: num(raw.voiceDurationSeconds) || undefined,
    fileName: str(raw.fileName) || undefined,
    fileSize: num(raw.fileSize) || undefined,
    fileExt: str(raw.fileExt) || undefined,
    fileMd5: str(raw.fileMd5) || undefined,
    db: str(raw.db) || str(raw._db_path) || undefined,
    table: str(raw.table) || str(raw._table_name) || undefined,
    linkTitle: str(raw.linkTitle) || undefined,
    linkUrl: str(raw.linkUrl) || undefined,
    linkThumb: str(raw.linkThumb) || undefined,
    linkDesc: str(raw.appMsgDesc) || undefined,
    appName: str(raw.appMsgAppName) || undefined,
    locationLabel: str(raw.locationLabel) || str(raw.appMsgLocationLabel) || undefined,
    locationPoiname: str(raw.locationPoiname) || undefined,
    locationLat: num(raw.locationLat) || undefined,
    locationLng: num(raw.locationLng) || undefined,
    cardUsername: str(raw.cardUsername) || undefined,
    cardNickname: str(raw.cardNickname) || undefined,
    cardAvatarUrl: str(raw.cardAvatarUrl) || undefined,
    chatRecordTitle: str(raw.chatRecordTitle) || undefined,
    chatRecordCount: chatRecordList.length,
    revoked: isRevokeSystemMessage(kind, text),
  }
}

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

export type TextSegment = { type: 'text' | 'mention'; value: string }

const MENTION_PATTERN = /(@[^\s@，。！？、,.!?;；:：]{1,24})/g

/**
 * 切出 @ 提及片段。@ 高亮是 v1.2 §3 的群聊要求；引擎的 `<atuserlist>` 在
 * `message.source` 里（未归一），这里按文本切分，识别不了的名字就留在普通文本里
 * —— 只影响高亮，不丢内容。
 */
export function splitMentions(text: string): TextSegment[] {
  if (!text) return []
  const segments: TextSegment[] = []
  let lastIndex = 0
  MENTION_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MENTION_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    segments.push({ type: 'mention', value: match[1] })
    lastIndex = match.index + match[1].length
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) })
  return segments
}

export type HighlightSegment = { value: string; hit: boolean }

/**
 * 搜索命中高亮切片（大小写不敏感）。切完的价值是**不丢字符**：拼接所有 `value`
 * 必须原样等于输入 —— 高亮只是多包一层 `<mark>`。
 */
export function splitHighlight(text: string, needle: string): HighlightSegment[] {
  const source = String(text ?? '')
  const target = String(needle ?? '').trim()
  if (!source) return []
  if (!target) return [{ value: source, hit: false }]
  const haystack = source.toLowerCase()
  const lower = target.toLowerCase()
  const segments: HighlightSegment[] = []
  let cursor = 0
  while (cursor < source.length) {
    const index = haystack.indexOf(lower, cursor)
    if (index < 0) break
    if (index > cursor) segments.push({ value: source.slice(cursor, index), hit: false })
    segments.push({ value: source.slice(index, index + target.length), hit: true })
    cursor = index + target.length
  }
  if (segments.length === 0) return [{ value: source, hit: false }]
  if (cursor < source.length) segments.push({ value: source.slice(cursor), hit: false })
  return segments
}

/** 会话列表 / 搜索结果里的一行摘要（单行、已截断）。 */
export function messagePreviewText(message: ReaderMessage, limit = 60): string {
  const base = (() => {
    switch (message.kind) {
      case 'image':
        return '[图片]'
      case 'video':
        return '[视频]'
      case 'voice':
        return message.voiceTranscript
          ? `[语音转文字] ${message.voiceTranscript}`
          : message.voiceDurationSeconds ? `[语音 ${formatDuration(message.voiceDurationSeconds)}]` : '[语音]'
      case 'sticker':
        return '[表情]'
      case 'file':
        return `[文件] ${message.fileName || ''}`.trim()
      case 'link':
        return `[链接] ${message.linkTitle || message.text || ''}`.trim()
      case 'miniprogram':
        return `[小程序] ${message.linkTitle || message.text || ''}`.trim()
      case 'chatrecord':
        return `[聊天记录] ${message.chatRecordTitle || ''}`.trim()
      case 'redpacket':
        return message.text || '[红包]'
      case 'transfer':
        return message.text || '[转账]'
      case 'card':
        return `[名片] ${message.cardNickname || message.text || ''}`.trim()
      case 'location':
        return `[位置] ${message.locationLabel || message.locationPoiname || ''}`.trim()
      case 'call':
        return message.text || '[通话]'
      case 'quote':
      case 'text':
      case 'system':
      case 'pat':
      case 'announcement':
      default: {
        const text = message.text.trim()
        if (text) return text
        // 空内容的文本消息写"[空消息]"而不是"[text]"
        return message.kind === 'text' ? '[空消息]' : `[${message.kind}]`
      }
    }
  })()
  const flat = base.replace(/\s+/g, ' ').trim() || '[空消息]'
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 复制成文本：粘贴到别处仍然读得懂（媒体写成方括号说明，不写不存在的原文）。 */
export function messageToPlainText(message: ReaderMessage): string {
  const who = message.isSend ? '我' : (message.senderName || message.senderUsername || '对方')
  const time = formatDateTime(message.ts)
  const head = `[${time}] ${who}：`
  const body = (() => {
    switch (message.kind) {
      case 'image':
        return '[图片]'
      case 'video':
        return '[视频]'
      case 'voice':
        return message.voiceTranscript
          ? `[语音转文字] ${message.voiceTranscript}`
          : message.voiceDurationSeconds
            ? `[语音 ${formatDuration(message.voiceDurationSeconds)}]`
            : '[语音]'
      case 'sticker':
        return `[表情]${message.stickerMd5 ? ` ${message.stickerMd5}` : ''}`
      case 'file':
        return `[文件] ${message.fileName || ''}${message.fileSize ? ` (${formatBytes(message.fileSize)})` : ''}`.trim()
      case 'link':
        return `[链接] ${message.linkTitle || ''} ${message.linkUrl || ''}`.trim()
      case 'miniprogram':
        return `[小程序] ${message.linkTitle || ''}`.trim()
      case 'chatrecord':
        return `[聊天记录] ${message.chatRecordTitle || ''}（${message.chatRecordCount} 条）`.trim()
      case 'card':
        return `[名片] ${message.cardNickname || ''}${message.cardUsername ? ` (${message.cardUsername})` : ''}`.trim()
      case 'location':
        return `[位置] ${message.locationLabel || message.locationPoiname || ''}`.trim()
      default:
        return message.text || `[${message.kind}]`
    }
  })()
  const quote = message.quote ? `${message.quote.sender}：${message.quote.text}` : ''
  return [head, quote ? `  ↳ ${quote}` : '', `  ${body}`].filter(Boolean).join('\n')
}

/** 一段消息范围复制成文本。 */
export function rangeToPlainText(messages: ReaderMessage[]): string {
  return messages.map(messageToPlainText).join('\n')
}

// ---------------------------------------------------------------------------
// 时间 / 数值格式化
// ---------------------------------------------------------------------------

const CLOCK = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const DATE_LABEL = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
const FULL = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function formatClock(ts: number): string {
  if (!ts) return ''
  return CLOCK.format(new Date(ts))
}

export function formatDateTime(ts: number): string {
  if (!ts) return '时间未知'
  return FULL.format(new Date(ts))
}

export function formatDayLabel(ts: number, now = Date.now()): string {
  if (!ts) return '未知日期'
  const day = dayKeyOf(ts)
  if (day === dayKeyOf(now)) return '今天'
  if (day === dayKeyOf(now - 86400000)) return '昨天'
  const date = new Date(ts)
  const sameYear = new Date(now).getFullYear() === date.getFullYear()
  return sameYear
    ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(date)
    : DATE_LABEL.format(date)
}

/** 本地日期键 `YYYY-MM-DD`。用本地时区：用户说的"那一天"是本地的那一天。 */
export function dayKeyOf(ts: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** `<input type="date">` 的 `YYYY-MM-DD` → 当天的毫秒区间（左闭右开）。 */
export function dayRangeFromInput(value: string): { start: number; end: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const start = new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
  if (!Number.isFinite(start)) return null
  return { start, end: start + 86400000 }
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
  if (!ts) return ''
  const diff = now - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return formatClock(ts)
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`
  const date = new Date(ts)
  const sameYear = new Date(now).getFullYear() === date.getFullYear()
  return sameYear
    ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
    : new Intl.DateTimeFormat('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric' }).format(date)
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total}″`
  const minutes = Math.floor(total / 60)
  const rest = String(total % 60).padStart(2, '0')
  return `${minutes}′${rest}″`
}

export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0
  if (value <= 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value < 10000) return String(value)
  return `${(value / 10000).toFixed(1)} 万`
}

// ---------------------------------------------------------------------------
// 媒体 URL
// ---------------------------------------------------------------------------

/**
 * 本地文件 → `weport-media://`（主进程的协议 handler，见 `appMain.ts:7725`）。
 * 走协议比把 base64 塞进 IPC 便宜得多：不占渲染层内存、不用 JSON 编码 4/3 的膨胀。
 * 引擎的 `getImageData` 目前只回 base64，所以这条路是**为接线后的引擎预留**的。
 */
export function localMediaUrl(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  return `weport-media://local/${encodeURIComponent(normalized)}`
}

/** base64 头几个字节判格式：引擎只回裸 base64，不带 MIME。 */
export function imageMimeFromBase64(base64: string): string {
  const head = String(base64 || '').slice(0, 16)
  if (head.startsWith('/9j/')) return 'image/jpeg'
  if (head.startsWith('iVBOR')) return 'image/png'
  if (head.startsWith('R0lGOD')) return 'image/gif'
  if (head.startsWith('UklGR')) return 'image/webp'
  if (head.startsWith('Qk0')) return 'image/bmp'
  return 'image/jpeg'
}

/** 媒体通道的返回 → 可直接塞进 `<img src>` / `<video src>` 的 URL。 */
export function mediaUrlFromPayload(payload: unknown): { url?: string; error?: string } {
  if (!payload || typeof payload !== 'object') return { error: '媒体通道没有返回数据' }
  const record = payload as { success?: unknown; data?: unknown; url?: unknown; localPath?: unknown; filePath?: unknown; error?: unknown; mime?: unknown }
  if (record.success === false) return { error: String(record.error || '媒体读取失败') }
  const directUrl = str(record.url)
  if (/^(?:https?:|data:|blob:|weport-media:|file:)/i.test(directUrl)) return { url: directUrl }
  const localPath = str(record.localPath) || str(record.filePath)
  if (localPath) {
    if (/^(?:https?:|data:|blob:|weport-media:)/i.test(localPath)) return { url: localPath }
    return { url: localMediaUrl(localPath) }
  }
  const data = str(record.data)
  if (!data) return { error: '媒体通道没有返回数据' }
  if (data.startsWith('data:')) return { url: data }
  return { url: `data:${str(record.mime) || imageMimeFromBase64(data)};base64,${data}` }
}
