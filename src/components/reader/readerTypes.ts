/**
 * 阅读器（v1.2 §3）的形状定义。
 *
 * 这一层只做一件事：把**引擎的原样返回**（`chatService.ChatSession` /
 * `chatService.Message`，见 `electron/services/chatService.ts:24` 与 `:42`）翻译成
 * 阅读器真正消费的字段，其余一律丢掉。
 *
 * 为什么不在组件里直接摸 `message.linkTitle`：`Message` 有 70 多个可选字段，
 * 每个组件各自判断一次「这个字段在不在」，就会出现 5 份互相不一致的兜底逻辑
 * （`sessionCandidates.ts` 的注释记过同一个坑）。分派与兜底集中在这里，组件只认
 * `kind` 和已经落定的字段。
 */

/** 会话类型。与 `chatService.getSessions` 里的 username 形态一一对应。 */
export type ReaderSessionKind = 'group' | 'private' | 'official'

/**
 * 消息类型 —— 取值来自 `chatService.parseMessageContent()` 的 switch
 * （`electron/services/chatService.ts:6186-6255`）与 type 49 的细分
 * （`parseType49`，同文件 :6258）。
 */
export type ReaderMessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'voice'
  | 'file'
  | 'link'
  | 'sticker'
  | 'quote'
  | 'location'
  | 'card'
  | 'call'
  | 'system'
  | 'pat'
  | 'redpacket'
  | 'transfer'
  | 'chatrecord'
  | 'miniprogram'
  | 'music'
  | 'finder'
  | 'gift'
  | 'announcement'
  | 'revoked'
  | 'other'

/** 会话列表里的一行。 */
export interface ReaderSession {
  id: string
  name: string
  kind: ReaderSessionKind
  /** 毫秒时间戳（末条消息时间）。0 = 引擎没给。 */
  lastAt: number
  /** 消息条数；`null` = 引擎没给（不是 0，界面上必须区分开）。 */
  messageCount: number | null
  unreadCount: number
  summary: string
  avatarUrl?: string
  isMuted?: boolean
  isFolded?: boolean
}

/** 一条消息（阅读器视角）。 */
export interface ReaderMessage {
  /** 引擎的 `messageKey`，会话内唯一 —— 列表 key、标记、跳转都用它。 */
  key: string
  sessionId: string
  localId: number
  /** Exact local/server message ID as text; preserves values beyond Number's safe range. */
  messageId?: string
  idKind?: 'local' | 'server'
  serverId?: string
  /** 毫秒时间戳；引擎给的是秒，`normalizeTimestamp` 已经归一。 */
  ts: number
  isSend: boolean
  senderName: string
  senderUsername: string
  senderAvatarUrl?: string
  kind: ReaderMessageKind
  /** 文本（`parsedContent`，已由引擎解出 emoji/引用/XML）。 */
  text: string
  /** Existing WeChat-native conversion text, when stored with the voice row. */
  voiceTranscript?: string
  quote?: { sender: string; text: string }
  /** 图片：定位用。渲染还要走解密通道。 */
  imageMd5?: string
  imageDatName?: string
  /** 表情包（localType 47）。 */
  stickerUrl?: string
  stickerMd5?: string
  /** 表情包在磁盘上的缓存路径（引擎解出来的 castle 路径，有就能直接渲染）。 */
  stickerLocalPath?: string
  /** 视频。 */
  videoMd5?: string
  videoDurationSeconds?: number
  /** 语音。 */
  voiceDurationSeconds?: number
  /** 文件。 */
  fileName?: string
  fileSize?: number
  fileExt?: string
  fileMd5?: string
  /** Message storage location hints used only to disambiguate exact media lookup. */
  db?: string
  table?: string
  /** 链接卡片。 */
  linkTitle?: string
  linkUrl?: string
  linkThumb?: string
  linkDesc?: string
  appName?: string
  /** 位置。 */
  locationLabel?: string
  locationPoiname?: string
  locationLat?: number
  locationLng?: number
  /** 名片（localType 42）。 */
  cardUsername?: string
  cardNickname?: string
  cardAvatarUrl?: string
  /** 合并转发（localType 49 type 19 / 81604378673）。 */
  chatRecordTitle?: string
  chatRecordCount: number
  /** 被撤回（防撤回触发器留下的占位，v1.2 §3 只读态展示）。 */
  revoked: boolean
}

/** 一页消息。`nextOffset` 直接回传给引擎的 offset 参数。 */
export interface ReaderMessagePage {
  messages: ReaderMessage[]
  hasMore: boolean
  nextOffset: number
}

/** 会话内搜索命中（本地过滤的降级形态也是这个形状）。 */
export interface ReaderSearchHit {
  key: string
  /** 命中在 `messages` 里的下标（本地过滤时一定有；引擎搜索时可能为 -1）。 */
  index: number
  ts: number
  senderName: string
  excerpt: string
  localId?: number
  serverId?: string
  db?: string
  table?: string
  idKind?: 'local' | 'server'
}

/** 引擎 raw 消息：只声明阅读器会读的字段，其余不猜。 */
export interface EngineMessageLike {
  messageKey?: unknown
  localId?: unknown
  /** Exact decimal local_id preserved by the main process when its Number is unsafe. */
  localIdRaw?: unknown
  messageId?: unknown
  idKind?: unknown
  serverId?: unknown
  serverIdRaw?: unknown
  createTime?: unknown
  sortSeq?: unknown
  isSend?: unknown
  senderUsername?: unknown
  senderDisplayName?: unknown
  senderAvatarUrl?: unknown
  parsedContent?: unknown
  content?: unknown
  rawContent?: unknown
  localType?: unknown
  quotedContent?: unknown
  quotedSender?: unknown
  imageMd5?: unknown
  imageDatName?: unknown
  emojiCdnUrl?: unknown
  emojiThumbUrl?: unknown
  emojiMd5?: unknown
  emojiLocalPath?: unknown
  voiceDurationSeconds?: unknown
  voiceTranscript?: unknown
  videoMd5?: unknown
  fileMd5?: unknown
  fileName?: unknown
  fileSize?: unknown
  fileExt?: unknown
  db?: unknown
  table?: unknown
  _db_path?: unknown
  _table_name?: unknown
  linkTitle?: unknown
  linkUrl?: unknown
  linkThumb?: unknown
  appMsgDesc?: unknown
  appMsgKind?: unknown
  appMsgAppName?: unknown
  appMsgLocationLabel?: unknown
  xmlType?: unknown
  locationLabel?: unknown
  locationPoiname?: unknown
  locationLat?: unknown
  locationLng?: unknown
  cardUsername?: unknown
  cardNickname?: unknown
  cardAvatarUrl?: unknown
  chatRecordTitle?: unknown
  chatRecordList?: unknown
  transferPayerUsername?: unknown
  transferReceiverUsername?: unknown
}

/** 引擎 raw 会话：`ChatSession` 的可选字段。 */
export interface EngineSessionLike {
  username?: unknown
  displayName?: unknown
  sessionDisplayName?: unknown
  lastMsgSender?: unknown
  lastSenderDisplayName?: unknown
  summary?: unknown
  sortTimestamp?: unknown
  lastTimestamp?: unknown
  lastMsgType?: unknown
  messageCountHint?: unknown
  unreadCount?: unknown
  avatarUrl?: unknown
  isFolded?: unknown
  isMuted?: unknown
}
