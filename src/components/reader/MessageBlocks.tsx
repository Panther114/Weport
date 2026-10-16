/**
 * 消息内容块：每种消息类型内联渲染的那一部分。
 *
 * ## 每个 DOM 节点都要有理由
 *
 * 一个 5000 条的会话滚动时，任何"每条多一个包装层"的写法都会在滚动里现形。这里
 * 的约束是单条消息 ≤200 个 DOM 节点（普通文本 3-6 个，媒体 8-12 个），并且：
 * - 图片**进入视口才解密**（`IntersectionObserver`，rootMargin 300px 预取一屏）；
 * - 解密结果进模块级 LRU（按字节封顶），滚回去不重复走 IPC；
 * - 没有通道的能力（图片/视频/语音/文件原文）一律显示**说明 + 禁用态**，
 *   不装假播放器、不放假图片。
 *
 * ## 为什么媒体不用 `cdnThumbUrl` 直连
 *
 * 引擎能解析出 CDN 地址，但那是微信的服务器：渲染层直接请求会绕过主进程的解密与
 * 缓存，也把用户的 IP 暴露给 CDN，且缩略图本来就要 AES 密钥。媒体一律走引擎通道。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Download, ExternalLink, FileText, Gift, Image as ImageIcon, Link2, MapPin, Play, Star, UserRound, Volume2 } from 'lucide-react'
import { renderTextWithEmoji } from '../../utils/renderTextWithEmoji'
import type { ReaderMessage } from './readerTypes'
import { formatBytes, formatDuration, splitHighlight, splitMentions } from './readerMessage'

export interface BlockActions {
  onOpenImage: (message: ReaderMessage) => void
  onCopy: (message: ReaderMessage) => void
}

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

/**
 * 文本渲染：@ 高亮 + 微信表情 + 搜索命中三件事叠在一起。
 *
 * 优先级：命中高亮 > @ 提及 > 表情。命中时不再解析表情（`[微笑]` 变成图片会
 * 让"我搜的就是这几个字"这件事在视觉上消失）。
 */
export const RichText = memo(function RichText({
  text,
  highlight,
  className,
}: {
  text: string
  highlight?: string
  className?: string
}) {
  const node = useMemo(() => {
    if (!text) return null
    if (highlight && highlight.trim()) {
      return splitHighlight(text, highlight).map((segment, index) =>
        segment.hit ? (
          <mark className="reader-hit" key={index}>
            {segment.value}
          </mark>
        ) : (
          <span key={index}>{segment.value}</span>
        ),
      )
    }
    const segments = splitMentions(text)
    if (segments.length <= 1 && (!segments[0] || segments[0].type !== 'mention')) {
      return renderTextWithEmoji(text)
    }
    return segments.map((segment, index) =>
      segment.type === 'mention' ? (
        <span className="reader-mention" key={index}>
          {segment.value}
        </span>
      ) : (
        <span key={index}>{renderTextWithEmoji(segment.value)}</span>
      ),
    )
  }, [text, highlight])
  return <div className={className || 'reader-text'}>{node}</div>
})

// ---------------------------------------------------------------------------
// 引用
// ---------------------------------------------------------------------------

const COLLAPSE_LENGTH = 120

/** 引用块：嵌套在气泡里，长的可折叠。 */
export const QuoteBlock = memo(function QuoteBlock({ sender, text }: { sender: string; text: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > COLLAPSE_LENGTH
  const shown = long && !expanded ? `${text.slice(0, COLLAPSE_LENGTH)}…` : text
  return (
    <div className="reader-quote">
      <div className="reader-quote-head">
        <span className="reader-quote-sender">{sender}</span>
        {long && (
          <button
            type="button"
            className="reader-quote-toggle"
            onClick={(event) => {
              // 多选态下整行可点；展开引用不该顺手把这条消息选中
              event.stopPropagation()
              setExpanded((value) => !value)
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
      <div className="reader-quote-text">{shown}</div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

/**
 * 已解密图片的字节上限。
 *
 * base64 在渲染层是**字符串**，一个 3 MB 的截图就是 4 MB 常驻（UTF-16 下翻倍），
 * 滚一遍几百张图的会话会直接把渲染进程撑爆。60 MB 大约够一屏到两屏，超出就按
 * 最久未用淘汰；被淘汰的图滚回来时重新解密（本地磁盘解密 ≈ 几十毫秒）。
 */
const IMAGE_CACHE_BYTES = 60 * 1024 * 1024
const imageCache = new Map<string, { url: string; bytes: number }>()
const imagePending = new Map<string, Promise<{ url?: string; error?: string }>>()
let imageCacheBytes = 0

function cacheKey(message: ReaderMessage | undefined): string {
  return message?.key || ''
}

function rememberImage(key: string, url: string): void {
  const bytes = url.startsWith('data:') ? url.length : 4096
  if (imageCache.has(key)) imageCache.delete(key)
  imageCache.set(key, { url, bytes })
  imageCacheBytes += bytes
  while (imageCacheBytes > IMAGE_CACHE_BYTES && imageCache.size > 1) {
    const oldest = imageCache.keys().next().value as string | undefined
    if (!oldest) break
    imageCacheBytes -= imageCache.get(oldest)?.bytes || 0
    imageCache.delete(oldest)
  }
}

/** 供测试/诊断使用：清空图片缓存。 */
export function clearReaderImageCache(): void {
  imageCache.clear()
  imageCacheBytes = 0
}

export function readerImageCacheSize(): number {
  return imageCache.size
}

const loadSource = () => import('./readerSource')

export interface ImageState {
  url?: string
  error?: string
  loading: boolean
}

/** 解密一张图（带进程内缓存与并发合并）。组件与灯箱共用同一条路径。 */
export function useReaderImage(message: ReaderMessage | undefined, enabled: boolean): ImageState {
  const key = cacheKey(message)
  const cached = imageCache.get(key)
  const [state, setState] = useState<ImageState & { key: string }>({
    key,
    url: cached?.url,
    loading: false,
    error: undefined,
  })

  useEffect(() => {
    if (!enabled || !message) return
    const hit = imageCache.get(key)
    if (hit) {
      setState({ key, url: hit.url, loading: false })
      return
    }
    let alive = true
    let pending = imagePending.get(key)
    if (!pending) {
      pending = loadSource().then((module) => module.loadMessageImage(message))
      imagePending.set(key, pending)
      pending.finally(() => imagePending.delete(key))
    }
    setState((prev) => (prev.key === key && prev.loading ? prev : { key, loading: true }))
    void pending.then((result) => {
      if (!alive) return
      if (result.url) {
        rememberImage(key, result.url)
        setState({ key, url: result.url, loading: false })
      } else {
        setState({ key, loading: false, error: result.error || '图片解密失败' })
      }
    })
    return () => {
      alive = false
    }
  }, [key, message, enabled])

  return state.key === key ? state : { url: cached?.url, loading: enabled, error: undefined }
}

/** 图片气泡。进视口才开始解密。 */
export const ImageBlock = memo(function ImageBlock({
  message,
  onOpen,
  imageChannel,
}: {
  message: ReaderMessage
  onOpen: (message: ReaderMessage) => void
  imageChannel: boolean
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host || visible) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [visible])

  const state = useReaderImage(message, visible && imageChannel)

  return (
    <div className="reader-image" ref={hostRef}>
      {!imageChannel && (
        <div className="reader-media-missing" title="引擎未提供精确图片解密通道 chat:getImageDataByIdentity">
          <ImageIcon size={18} />
          <span>图片需要引擎接入解密通道后显示</span>
        </div>
      )}
      {imageChannel && state.url && (
        <button
          type="button"
          className="reader-image-btn"
          onClick={(event) => {
            event.stopPropagation()
            onOpen(message)
          }}
          title="打开大图"
        >
          <img src={state.url} alt="图片消息" decoding="async" loading="lazy" />
        </button>
      )}
      {imageChannel && !state.url && (
        <div className="reader-media-skeleton" data-state={state.error ? 'error' : 'loading'}>
          {state.error ? <span>{state.error}</span> : <span>正在解密…</span>}
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// 视频 / 语音 / 文件
// ---------------------------------------------------------------------------

/**
 * 视频：必须**显式点击**才加载文件（V12 §3 的媒体要求）。没有视频通道时按钮
 * 禁用并说明原因 —— 不做一个点了没反应的播放按钮。
 */
export const VideoBlock = memo(function VideoBlock({ message, videoChannel }: { message: ReaderMessage; videoChannel: boolean }) {
  const [media, setMedia] = useState<{ url?: string; error?: string; loading: boolean }>({ loading: false })
  const loadVideo = () => {
    if (media.loading || media.url) return
    setMedia({ loading: true })
    void loadSource()
      .then((module) => module.loadMessageVideo(message))
      .then((result) => setMedia({ url: result.url, error: result.error, loading: false }))
      .catch((error: unknown) => setMedia({ error: error instanceof Error ? error.message : String(error), loading: false }))
  }
  return (
    <div className="reader-video">
      <div className="reader-video-stage">
        {media.url ? (
          <video className="reader-video-player" src={media.url} controls playsInline preload="metadata" />
        ) : (
          <>
            <div className="reader-video-poster" aria-hidden />
            <button
              type="button"
              className="reader-play"
              disabled={!videoChannel || media.loading}
              title={videoChannel ? '点击加载视频' : '引擎未提供视频通道'}
              onClick={(event) => {
                event.stopPropagation()
                loadVideo()
              }}
            >
              <Play size={18} />
              <span>{media.loading ? '正在读取…' : videoChannel ? (media.error ? '重试加载' : '加载视频') : '需要引擎支持'}</span>
            </button>
          </>
        )}
      </div>
      {media.error ? <span className="reader-media-error" role="status">{media.error}</span> : null}
      {message.videoDurationSeconds ? <span className="reader-badge">{formatDuration(message.videoDurationSeconds)}</span> : null}
    </div>
  )
})

/**
 * 语音。
 *
 * 渲染层**没有** silk 解码器（`silk-wasm` 只在主进程用，见
 * `electron/services/chatService.ts:9390`），因此默认是"时长 + 说明"这一诚实态；
 * 只有引擎真的回了可直接播放的音频（`audio/*` data URL 或本地文件）时才渲染
 * `<audio>`。
 */
export const VoiceBlock = memo(function VoiceBlock({ message, voiceChannel }: { message: ReaderMessage; voiceChannel: boolean }) {
  const [audio, setAudio] = useState<{ url?: string; error?: string; loading: boolean }>({ loading: false })

  const play = () => {
    if (audio.url || audio.loading) return
    setAudio({ loading: true })
    void loadSource().then(async (module) => {
      const result = await module.loadMessageVoice(message.sessionId, message.localId, message.ts, message.serverId, message.senderUsername)
      setAudio({ url: result.url, error: result.error, loading: false })
    }).catch((error: unknown) => {
      setAudio({ error: error instanceof Error ? error.message : String(error), loading: false })
    })
  }

  const duration = message.voiceDurationSeconds ? formatDuration(message.voiceDurationSeconds) : '语音'
  const transcript = message.voiceTranscript ? (
    <span className="reader-voice-transcript">
      <span className="reader-voice-transcript-label">微信转写</span>
      <RichText text={message.voiceTranscript} />
    </span>
  ) : null
  if (!voiceChannel) {
    return (
      <div className="reader-voice" title="渲染层没有 silk 解码器，语音需要引擎提供可播放的音频数据（chat:getVoiceData）">
        <Volume2 size={14} />
        <span className="reader-voice-duration">{duration}</span>
        <span className="reader-voice-hint">音频需要导出后播放</span>
        {transcript}
      </div>
    )
  }
  return (
    <div className="reader-voice">
      <button
        type="button"
        className="reader-voice-btn"
        onClick={(event) => {
          event.stopPropagation()
          play()
        }}
        disabled={!message.localId && !message.serverId}
      >
        <Volume2 size={14} />
        <span className="reader-voice-duration">{duration}</span>
      </button>
      {audio.url && <audio className="reader-audio" src={audio.url} controls />}
      {audio.loading && <span className="reader-voice-hint">正在读取…</span>}
      {audio.error && <span className="reader-voice-hint">音频需要导出后播放</span>}
      {transcript}
    </div>
  )
})

/** 文件：读取后内联预览常见媒体/PDF，其它类型可交给系统默认程序打开。 */
export const FileBlock = memo(function FileBlock({ message, fileChannel }: { message: ReaderMessage; fileChannel: boolean }) {
  const [media, setMedia] = useState<{ url?: string; path?: string; fileName?: string; error?: string; loading: boolean }>({ loading: false })
  const loadFile = () => {
    if (media.loading || media.url) return
    setMedia({ loading: true })
    void loadSource()
      .then((module) => module.loadMessageFile(message))
      .then((result) => setMedia({ ...result, loading: false }))
      .catch((error: unknown) => setMedia({ error: error instanceof Error ? error.message : String(error), loading: false }))
  }
  const fileName = media.fileName || message.fileName || message.text || '文件'
  const ext = fileName.split('.').pop()?.toLowerCase() || message.fileExt?.toLowerCase() || ''
  const imageFile = /^(?:png|jpe?g|gif|webp|bmp)$/.test(ext)
  const videoFile = /^(?:mp4|mov|m4v|webm|mkv)$/.test(ext)
  const audioFile = /^(?:mp3|m4a|aac|wav|ogg|flac)$/.test(ext)
  const pdfFile = ext === 'pdf'

  const openFile = () => {
    if (media.path && window.electronAPI?.shell?.openPath) {
      void window.electronAPI.shell.openPath(media.path)
      return
    }
    if (media.url) window.open(media.url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="reader-file" title={fileChannel ? '点「读取附件」查看或打开本地文件' : '引擎未提供文件读取通道'}>
      <FileText size={18} />
      <div className="reader-file-main">
        <div className="reader-file-name">{fileName}</div>
        <div className="reader-file-meta">
          {message.fileExt ? <span>{message.fileExt}</span> : null}
          {message.fileSize ? <span>{formatBytes(message.fileSize)}</span> : null}
          {!media.url ? (
            <button type="button" className="reader-file-action" disabled={!fileChannel || media.loading || (!message.localId && !message.serverId)} onClick={loadFile}>
              <Download size={12} />
              {media.loading ? '读取中…' : media.error ? '重试' : '读取附件'}
            </button>
          ) : (
            <button type="button" className="reader-file-action" onClick={openFile}><ExternalLink size={12} />系统打开</button>
          )}
        </div>
        {media.error ? <div className="reader-file-error" role="status">{media.error}</div> : null}
        {media.url && imageFile ? <img className="reader-file-preview" src={media.url} alt={fileName} loading="lazy" /> : null}
        {media.url && videoFile ? <video className="reader-file-preview" src={media.url} controls playsInline preload="metadata" /> : null}
        {media.url && audioFile ? <audio className="reader-audio" src={media.url} controls /> : null}
        {media.url && pdfFile ? <iframe className="reader-file-pdf" src={media.url} title={fileName} loading="lazy" /> : null}
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// 链接 / 小程序 / 位置 / 名片 / 通话 / 转账 / 红包 / 表情 / 聊天记录
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export const LinkBlock = memo(function LinkBlock({ message }: { message: ReaderMessage }) {
  const url = message.linkUrl || ''
  return (
    <div className="reader-link">
      <div className="reader-link-thumb" title="链接缩略图需要引擎的媒体通道（chat:getImageData）后显示">
        <Link2 size={18} />
      </div>
      <div className="reader-link-main">
        <div className="reader-link-title">{message.linkTitle || message.text || '链接'}</div>
        {message.linkDesc ? <div className="reader-link-desc">{message.linkDesc}</div> : null}
        {url ? (
          <div className="reader-link-url" title={url}>
            {hostOf(url)}
          </div>
        ) : null}
      </div>
      {url ? (
        <button
          type="button"
          className="reader-link-open"
          title={`用系统浏览器打开 ${url}`}
          onClick={(event) => {
            event.stopPropagation()
            // 链接用系统浏览器打开：阅读器不内置浏览器，也不碰微信客户端（D14）
            void window.electronAPI?.shell?.openExternal?.(url)
          }}
        >
          <ExternalLink size={14} />
        </button>
      ) : null}
    </div>
  )
})

export const LocationBlock = memo(function LocationBlock({ message }: { message: ReaderMessage }) {
  const label = message.locationLabel || message.locationPoiname || '位置'
  const coords = message.locationLat && message.locationLng ? `${message.locationLat.toFixed(5)}, ${message.locationLng.toFixed(5)}` : ''
  return (
    <div className="reader-card-row">
      <MapPin size={16} />
      <div className="reader-row-main">
        <div>{label}</div>
        {coords ? <div className="reader-row-sub">{coords}</div> : null}
      </div>
    </div>
  )
})

export const CardBlock = memo(function CardBlock({ message }: { message: ReaderMessage }) {
  return (
    <div className="reader-card-row">
      <UserRound size={16} />
      <div className="reader-row-main">
        <div>{message.cardNickname || message.text || '名片'}</div>
        {message.cardUsername ? <div className="reader-row-sub">{message.cardUsername}</div> : null}
      </div>
    </div>
  )
})

export const CompactRow = memo(function CompactRow({
  icon,
  title,
  sub,
  tone,
}: {
  icon: React.ReactNode
  title: string
  sub?: string
  tone?: 'pat' | 'system' | 'transfer' | 'redpacket'
}) {
  return (
    <div className="reader-card-row" data-tone={tone || 'plain'}>
      {icon}
      <div className="reader-row-main">
        <div>{title}</div>
        {sub ? <div className="reader-row-sub">{sub}</div> : null}
      </div>
    </div>
  )
})

/** 表情包：磁盘上有缓存就直接渲染，否则只显示一个徽标（不去连微信 CDN）。 */
export const StickerBlock = memo(function StickerBlock({ message }: { message: ReaderMessage }) {
  const [failed, setFailed] = useState(false)
  const url = message.stickerLocalPath
    ? `weport-media://local/${encodeURIComponent(message.stickerLocalPath.replace(/\\/g, '/'))}`
    : ''
  if (url && !failed) {
    return (
      <div className="reader-sticker">
        <img src={url} alt="表情" decoding="async" onError={() => setFailed(true)} />
      </div>
    )
  }
  return (
    <div className="reader-sticker-fallback" title="表情包需要引擎的媒体通道（本地缓存路径或解密后的图）后显示">
      <Gift size={16} />
      <span>表情</span>
      {message.stickerMd5 ? <code>{message.stickerMd5.slice(0, 8)}</code> : null}
    </div>
  )
})

export const ChatRecordBlock = memo(function ChatRecordBlock({ message }: { message: ReaderMessage }) {
  return (
    <div className="reader-record">
      <div className="reader-record-head">
        <FileText size={14} />
        <span>{message.chatRecordTitle || '聊天记录'}</span>
      </div>
      <div className="reader-record-sub">共 {message.chatRecordCount || '若干'} 条 · 展开需要导出后的数据</div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// 分派
// ---------------------------------------------------------------------------

/** 行内操作按钮（复制 / 打开）—— 供气泡底部复用。 */
export function RowActionButton({
  icon,
  label,
  onClick,
  disabled,
  title,
  active,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
  active?: boolean
}) {
  return (
    <button
      type="button"
      className="reader-action"
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      data-active={active ? 'true' : undefined}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

export const CopyAction = memo(function CopyAction({ onCopy, message }: { onCopy: (message: ReaderMessage) => void; message: ReaderMessage }) {
  const [done, setDone] = useState(false)
  /**
   * "已复制"的复位定时器要跟着组件走。
   *
   * 消息列表是虚拟滚动的：行会**随滚动随手卸载**。不清理的话，卸载之后那 1.6 秒到点还会
   * 回调一次 `setDone`（React 18 不再警告了，但这是纯浪费，而且连点两次只留最后一个 timer）。
   */
  const resetTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
  }, [])
  return (
    <RowActionButton
      icon={done ? <Check size={13} /> : <Copy size={13} />}
      label={done ? '已复制' : '复制'}
      onClick={() => {
        onCopy(message)
        setDone(true)
        if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
        resetTimer.current = window.setTimeout(() => setDone(false), 1600)
      }}
    />
  )
})

export const StarAction = memo(function StarAction({
  marked,
  onToggle,
  disabled,
  title,
}: {
  marked: boolean
  onToggle: () => void
  disabled: boolean
  title: string
}) {
  return (
    <button
      type="button"
      className="reader-action"
      onClick={onToggle}
      disabled={disabled}
      title={title}
      data-active={marked ? 'true' : undefined}
    >
      <Star size={13} fill={marked ? 'currentColor' : 'none'} />
      <span>{marked ? '已标记' : '标记'}</span>
    </button>
  )
})
