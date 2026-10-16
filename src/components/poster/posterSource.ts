/**
 * 海报内容来源（v1.2 §4）：阅读器选中消息、会话消息、朋友圈与手写引用 → `PosterItem[]`。
 *
 * 会话、分页和图片解密复用主应用现有通道；文件媒体通过附件解析通道按需读取。
 * 缺少能力时返回具名说明，不把空结果伪装成“没有内容”。PNG 写入仍走 `poster:saveImage`。
 */
import type { PosterItem, PosterItemKind, PosterSession } from './posterTypes.ts'
import type { ReaderMessage } from '../reader/readerTypes'
import { localFileUrl } from '../../utils/mediaUrl'

/** Convert a selected reader range to the poster editor's source model. */
export function posterItemsFromReaderMessages(messages: ReaderMessage[]): PosterItem[] {
    return messages.map((message) => {
        const stickerPath = message.kind === 'sticker' && message.stickerLocalPath ? localFileUrl(message.stickerLocalPath) : undefined
        const kind: PosterItemKind = message.kind === 'image' || stickerPath
            ? 'image'
            : message.kind === 'quote' || message.kind === 'voice' || message.kind === 'file' || message.kind === 'link' || message.kind === 'sticker' || message.kind === 'system'
                ? message.kind
                : message.kind === 'text'
                    ? 'text'
                    : 'other'
        return {
            key: message.key,
            sessionId: message.sessionId,
            localId: Number.isSafeInteger(message.localId) && message.localId > 0 ? message.localId : undefined,
            messageId: message.messageId || (message.idKind === 'server' ? message.serverId : message.localId > 0 ? String(message.localId) : undefined),
            serverId: message.serverId,
            idKind: message.idKind || (message.localId > 0 ? 'local' : message.serverId ? 'server' : undefined),
            db: message.db,
            table: message.table,
            senderName: message.isSend ? '我' : message.senderName || message.senderUsername,
            senderUsername: message.senderUsername,
            senderAvatarUrl: message.senderAvatarUrl,
            isSend: message.isSend,
            ts: message.ts,
            kind,
            text: message.text || (kind === 'image' ? '图片' : kind === 'voice' ? '语音' : kind === 'file' ? message.fileName || '文件' : '消息'),
            quote: message.quote,
            imageSrc: stickerPath,
            imageUnavailable: kind === 'image' && !stickerPath,
            imageAlt: message.fileName || (kind === 'image' ? '聊天图片' : message.kind === 'sticker' ? '表情' : message.text),
            visible: true,
        }
    })
}

/**
 * `chat.getMessages` is checked at runtime so test harnesses and alternate shells
 * report a named capability gap rather than throwing `is not a function`.
 */
type PosterChatBridge = Partial<{
    getMessages: NonNullable<Window['electronAPI']['chat']['getMessages']>
    getImageDataByIdentity: NonNullable<Window['electronAPI']['chat']['getImageDataByIdentity']>
}>

function chatBridge(): PosterChatBridge {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI
    return (api?.chat ?? {}) as PosterChatBridge
}

export interface PosterChannelStatus {
    sessions: boolean
    messages: boolean
    images: boolean
    sns: boolean
    /** 缺失通道的中文名（界面直接列出来） */
    missing: string[]
}

export function posterChannelStatus(): PosterChannelStatus {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI
    const sessions = typeof api?.chat?.getSessions === 'function'
    const messages = typeof chatBridge().getMessages === 'function'
    const images = typeof chatBridge().getImageDataByIdentity === 'function'
    const sns = typeof api?.sns?.getTimeline === 'function'
    const missing: string[] = []
    if (!sessions) missing.push('会话列表（chat:getSessions）')
    if (!messages) missing.push('消息分页（chat:getMessages）')
    if (!images) missing.push('精确图片解密（chat:getImageDataByIdentity）')
    if (!sns) missing.push('朋友圈时间线（sns:getTimeline）')
    return { sessions, messages, images, sns, missing }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

interface EngineSessionLike {
    username?: unknown
    displayName?: unknown
    sessionDisplayName?: unknown
    summary?: unknown
    sortTimestamp?: unknown
    lastTimestamp?: unknown
    messageCountHint?: unknown
    avatarUrl?: unknown
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** 引擎给的是秒（实测），毫秒原样保留 —— 差 1000 倍就是 1970 年。 */
export function normalizeTimestamp(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

export function sessionKindOf(username: string): PosterSession['kind'] {
    if (username.endsWith('@chatroom')) return 'group'
    if (username.startsWith('gh_') || username.startsWith('mp_')) return 'official'
    return 'private'
}

export function normalizeSession(raw: unknown): PosterSession | null {
    if (!raw || typeof raw !== 'object') return null
    const s = raw as EngineSessionLike
    const username = str(s.username).trim()
    if (!username) return null
    const name = str(s.displayName || s.sessionDisplayName).trim() || username
    const count = Number(s.messageCountHint)
    return {
        id: username,
        name,
        kind: sessionKindOf(username),
        lastAt: normalizeTimestamp(s.sortTimestamp ?? s.lastTimestamp),
        summary: str(s.summary).trim(),
        avatarUrl: str(s.avatarUrl).trim() || undefined,
        messageCount: Number.isFinite(count) && count > 0 ? count : null,
    }
}

export async function loadSessions(): Promise<{ sessions: PosterSession[]; error?: string; channelMissing?: boolean }> {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI
    if (typeof api?.chat?.getSessions !== 'function') {
        return { sessions: [], channelMissing: true, error: '引擎未接入：会话列表（chat:getSessions）' }
    }
    try {
        const result = await api.chat.getSessions()
        if (!result?.success) return { sessions: [], error: result?.error || '读取会话列表失败' }
        const sessions = (result.sessions ?? [])
            .map(normalizeSession)
            .filter((s): s is PosterSession => Boolean(s))
            .sort((a, b) => b.lastAt - a.lastAt)
        return { sessions }
    } catch (e) {
        return { sessions: [], error: String(e) }
    }
}

// ---------------------------------------------------------------------------
// 消息 → 条目
// ---------------------------------------------------------------------------

interface EngineMessageLike {
    messageKey?: unknown
    messageId?: unknown
    localId?: unknown
    serverId?: unknown
    serverIdRaw?: unknown
    idKind?: unknown
    createTime?: unknown
    isSend?: unknown
    senderUsername?: unknown
    senderDisplayName?: unknown
    senderAvatarUrl?: unknown
    parsedContent?: unknown
    content?: unknown
    localType?: unknown
    quotedContent?: unknown
    quotedSender?: unknown
    imageMd5?: unknown
    imageDatName?: unknown
    voiceDurationSeconds?: unknown
    fileName?: unknown
    fileSize?: unknown
    linkTitle?: unknown
    linkUrl?: unknown
    emojiCdnUrl?: unknown
    emojiThumbUrl?: unknown
    emojiMd5?: unknown
    appMsgKind?: unknown
    appMsgDesc?: unknown
    xmlType?: unknown
    chatRecordTitle?: unknown
    chatRecordList?: unknown
    db?: unknown
    table?: unknown
    _db_path?: unknown
    _table_name?: unknown
}

/** 引擎的 `localType` → 海报要画的种类（与 `parseMessageContent` 的分派一致）。 */
export function messageKindOf(localType: number, hasImage: boolean, appKind: string): PosterItemKind {
    if (localType === 1 || localType === 0) return 'text'
    if (localType === 3) return 'image'
    if (localType === 34) return 'voice'
    if (localType === 43 || localType === 62) return hasImage ? 'image' : 'other'
    if (localType === 47) return 'sticker'
    if (localType === 50) return 'other'
    if (localType === 10000 || localType === 10002) return 'system'
    if (localType === 42) return 'text'
    if (localType === 48) return 'text'
    if (localType === 49 || localType === 6 || localType === 74) {
        const kind = appKind.toLowerCase()
        if (kind.includes('file')) return 'file'
        if (kind.includes('link') || kind.includes('url')) return 'link'
        if (kind.includes('quote') || kind.includes('refer')) return 'quote'
        if (kind.includes('image')) return 'image'
        return 'link'
    }
    return hasImage ? 'image' : 'other'
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 引擎消息 → 海报条目。引擎没给的字段一律留空，**不猜**。 */
export function normalizeMessage(raw: unknown, index: number, sessionId: string): PosterItem | null {
    if (!raw || typeof raw !== 'object') return null
    const m = raw as EngineMessageLike
    const localId = Number(m.localId)
    const safeLocalId = Number.isSafeInteger(localId) && localId > 0 ? localId : undefined
    const serverId = str(m.serverIdRaw || m.serverId).trim()
    const rawMessageId = str(m.messageId).trim()
    const textualLocalId = typeof m.localId === 'string' && /^\d+$/.test(m.localId.trim()) ? m.localId.trim() : ''
    const idKind = m.idKind === 'server' ? 'server' : m.idKind === 'local' ? 'local' : textualLocalId || safeLocalId ? 'local' : serverId ? 'server' : undefined
    const messageId = rawMessageId || (idKind === 'server' ? serverId : textualLocalId || (safeLocalId ? String(safeLocalId) : '')) || undefined
    const key = str(m.messageKey).trim() || (safeLocalId ? `${sessionId}:${safeLocalId}` : `${sessionId}:#${index}`)
    const localType = Number(m.localType) || 0
    const appKind = str(m.appMsgKind || m.xmlType)
    const hasImage = Boolean(str(m.imageMd5).trim() || str(m.imageDatName).trim())
    const kind = messageKindOf(localType, hasImage, appKind)
    const text = str(m.parsedContent || m.content).trim()
    const quoteSender = str(m.quotedSender).trim()
    const quoteText = str(m.quotedContent).trim()
    const chatRecordTitle = str(m.chatRecordTitle).trim()

    let meta = ''
    if (kind === 'voice') {
        const seconds = Number(m.voiceDurationSeconds)
        meta = Number.isFinite(seconds) && seconds > 0 ? `语音 ${Math.round(seconds)}″` : '语音'
    } else if (kind === 'file') {
        meta = [str(m.fileName).trim(), formatBytes(Number(m.fileSize))].filter(Boolean).join(' · ') || '文件'
    } else if (kind === 'image') meta = '图片'
    else if (kind === 'sticker') meta = '表情'
    if (chatRecordTitle) meta = meta || `聊天记录：${chatRecordTitle}`

    return {
        key,
        sessionId,
        senderName: str(m.senderDisplayName || m.senderUsername).trim(),
        senderUsername: str(m.senderUsername).trim() || undefined,
        senderAvatarUrl: str(m.senderAvatarUrl).trim() || undefined,
        isSend: Number(m.isSend) === 1,
        ts: normalizeTimestamp(m.createTime),
        kind,
        text: text || meta,
        quote: quoteText ? { sender: quoteSender, text: quoteText } : undefined,
        imageSrc: undefined,
        // 图片要经 `chat:getImageData` 解密成 data URL 才能画进 canvas（`loadItemImage`）；
        // 在解密之前它**明确标成未解密**，画占位块而不是空白
        imageUnavailable: kind === 'image',
        imageAlt: str(m.fileName).trim() || (kind === 'image' ? '聊天图片' : meta),
        localId: safeLocalId,
        messageId,
        serverId: serverId || undefined,
        idKind,
        db: str(m.db || m._db_path).trim() || undefined,
        table: str(m.table || m._table_name).trim() || undefined,
        visible: true,
    }
}

/**
 * 从 base64 头部猜图片类型（`chat:getImageData` 只回 base64，不给 MIME）。
 *
 * 猜错的后果不是"图裂"而是**整张海报导出失败**（data URL 的 MIME 不对时，
 * `img` 不会解码，html2canvas 画一块空白）。所以按魔数判定，认不出来时用 png
 * 兜底而不是猜 `jpeg` —— 微信图片里 png 截图占比很高。
 */
export function imageMimeFromBase64(data: string): string {
    if (data.startsWith('/9j/')) return 'image/jpeg'
    if (data.startsWith('iVBOR')) return 'image/png'
    if (data.startsWith('R0lGOD')) return 'image/gif'
    if (data.startsWith('UklGR')) return 'image/webp'
    if (data.startsWith('Qk')) return 'image/bmp'
    return 'image/png'
}

/** 单条消息的图片 → data URL。失败时返回原因，**不返回半个地址**。 */
export async function loadItemImage(
    item: PosterItem
): Promise<{ success: boolean; src?: string; error?: string }> {
    if (item.imageSrc?.startsWith('data:')) return { success: true, src: item.imageSrc }
    const bridge = chatBridge()
    const idKind = item.idKind || (item.localId !== undefined ? 'local' : item.serverId ? 'server' : undefined)
    const identityId = item.messageId || (idKind === 'server' ? item.serverId : item.localId)
    if (typeof bridge.getImageDataByIdentity !== 'function' || identityId === undefined || !idKind) {
        return { success: false, error: '引擎未接入：精确图片解密（chat:getImageDataByIdentity）' }
    }
    try {
        const result = await bridge.getImageDataByIdentity({
            sessionId: item.sessionId,
            localId: identityId,
            ts: item.ts,
            db: item.db,
            table: item.table,
            idKind,
        }, { excludeThumbnail: true })
        if (!result?.success || !result.data) return { success: false, error: result?.error || '图片解密失败' }
        return { success: true, src: `data:${imageMimeFromBase64(result.data)};base64,${result.data}` }
    } catch (e) {
        return { success: false, error: String(e) }
    }
}

export interface LoadSessionItemsInput {
    sessionId: string
    /** 毫秒（界面口径）；0 = 不限 */
    startTs?: number
    endTs?: number
    onlyMine?: boolean
    onlyText?: boolean
    /** 最多取多少条（超过会截断并在返回值里说明） */
    max?: number
    pageSize?: number
}

export interface LoadSessionItemsResult {
    items: PosterItem[]
    truncated: boolean
    scanned: number
    error?: string
    channelMissing?: boolean
}

/** 毫秒 → 引擎要的秒。 */
export function toEngineSeconds(ms: number): number {
    if (!Number.isFinite(ms) || ms <= 0) return 0
    return Math.floor(ms / 1000)
}

/**
 * 拉一段会话消息。
 *
 * `startTime/endTime` 是**秒**（`chatService.getMessages` 的口径）；界面给的是毫秒，
 * 在 `toEngineSeconds` 一处换算（这个 1000 倍错过一次就够糟了，所以只留一个出口）。
 *
 * 逐页取到 `max` 或没有更多为止。筛选（只看我的 / 只看文本）**在本地做**：引擎的
 * `getMessages` 没有这两个参数，而在渲染层过滤多取几页比给引擎加参数便宜。
 */
export async function loadSessionItems(input: LoadSessionItemsInput): Promise<LoadSessionItemsResult> {
    const bridge = chatBridge()
    if (typeof bridge.getMessages !== 'function') {
        return { items: [], truncated: false, scanned: 0, channelMissing: true, error: '引擎未接入：消息分页（chat:getMessages）' }
    }
    const max = Math.max(1, input.max ?? 300)
    const pageSize = Math.max(1, Math.min(input.pageSize ?? 60, max))
    const startTime = toEngineSeconds(input.startTs ?? 0)
    const endTime = toEngineSeconds(input.endTs ?? 0)
    const items: PosterItem[] = []
    let offset = 0
    let scanned = 0
    let truncated = false
    try {
        for (;;) {
            const page = await bridge.getMessages(input.sessionId, offset, pageSize, startTime, endTime, false)
            if (!page?.success) return { items, truncated, scanned, error: page?.error || '读取消息失败' }
            const batch = page.messages ?? []
            scanned += batch.length
            for (let i = 0; i < batch.length; i++) {
                const item = normalizeMessage(batch[i], i, input.sessionId)
                if (!item) continue
                if (input.onlyMine && !item.isSend) continue
                if (input.onlyText && item.kind !== 'text') continue
                items.push(item)
            }
            if (!page.hasMore || batch.length === 0) break
            if (items.length >= max || scanned >= max * 3) {
                truncated = items.length > max || page.hasMore === true
                break
            }
            offset = Number(page.nextOffset)
            if (!Number.isFinite(offset) || offset <= 0) break
        }
        const capped = items.slice(0, max)
        return { items: capped, truncated: truncated || items.length > max, scanned }
    } catch (e) {
        return { items, truncated, scanned, error: String(e) }
    }
}

// ---------------------------------------------------------------------------
// 朋友圈
// ---------------------------------------------------------------------------

interface SnsMediaLike {
    url?: unknown
    thumb?: unknown
    key?: unknown
}

interface SnsPostLike {
    id?: unknown
    username?: unknown
    nickname?: unknown
    avatarUrl?: unknown
    createTime?: unknown
    contentDesc?: unknown
    media?: unknown
    linkTitle?: unknown
}

export async function loadSnsItems(options: {
    usernames?: string[]
    keyword?: string
    startTs?: number
    endTs?: number
    limit?: number
    /** 是否把图片经代理通道落成 data URL（画进 canvas 必须） */
    inlineImages?: boolean
}): Promise<{ items: PosterItem[]; error?: string; channelMissing?: boolean }> {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI
    if (typeof api?.sns?.getTimeline !== 'function') {
        return { items: [], channelMissing: true, error: '引擎未接入：朋友圈时间线（sns:getTimeline）' }
    }
    const limit = Math.max(1, Math.min(options.limit ?? 30, 200))
    try {
        const result = await api.sns.getTimeline(
            limit,
            0,
            options.usernames,
            options.keyword,
            toEngineSeconds(options.startTs ?? 0),
            toEngineSeconds(options.endTs ?? 0)
        )
        if (!result?.success) return { items: [], error: result?.error || '读取朋友圈失败' }
        const posts = (result.timeline ?? []) as SnsPostLike[]
        const items: PosterItem[] = []
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i]
            const id = str(post.id).trim() || `sns:${i}`
            const nickname = str(post.nickname).trim()
            const text = str(post.contentDesc).trim()
            const media = Array.isArray(post.media) ? (post.media as SnsMediaLike[]) : []
            items.push({
                key: id,
                sessionId: str(post.username).trim() || 'sns',
                senderName: nickname,
                senderUsername: str(post.username).trim() || undefined,
                senderAvatarUrl: str(post.avatarUrl).trim() || undefined,
                isSend: false,
                ts: normalizeTimestamp(post.createTime),
                kind: media.length > 0 ? 'image' : 'text',
                text: text || str(post.linkTitle).trim(),
                imageUnavailable: media.length > 0,
                imageAlt: '朋友圈图片',
                visible: true,
            })
            if (options.inlineImages && media.length > 0) {
                const src = await proxyMedia(media[0])
                if (src) {
                    const created = items[items.length - 1]
                    created.imageSrc = src
                    created.imageUnavailable = false
                }
            }
        }
        return { items }
    } catch (e) {
        return { items: [], error: String(e) }
    }
}

/** 单张朋友圈图片 → data URL（`sns:proxyImage`，与灯箱同一条路）。 */
export async function proxyMedia(media: SnsMediaLike): Promise<string | undefined> {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI
    if (typeof api?.sns?.proxyImage !== 'function') return undefined
    const url = str(media.url).trim() || str(media.thumb).trim()
    if (!url) return undefined
    const key = media.key
    try {
        const result = await api.sns.proxyImage(
            typeof key === 'string' && key ? { url, key } : url
        )
        if (result?.success && typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:')) {
            return result.dataUrl
        }
        return undefined
    } catch {
        return undefined
    }
}

/** 手写引用：不碰引擎，纯本地条目。 */
export function manualQuoteItem(input: { text: string; senderName?: string; isSend?: boolean; ts?: number; key?: string }): PosterItem {
    return {
        key: input.key ?? `manual:${Date.now()}`,
        sessionId: 'manual',
        senderName: (input.senderName ?? '我').trim() || '我',
        isSend: input.isSend ?? true,
        ts: input.ts ?? Date.now(),
        kind: 'text',
        text: input.text,
        visible: true,
    }
}
