/**
 * 一行消息。
 *
 * ## 这一层是性能的门面
 *
 * 5000 条会话滚动时，每帧真正被 React 处理的就是"这几行"。所以：
 * - `React.memo` + 传进来的全是**原始值**（string / number / boolean）：父组件
 *   每次翻页重建回调数组，行不会因此重渲染（`onXxx` 走 ref 稳定引用）；
 * - 日期分隔、未读锚点由**行自己**渲染（见 `readerWindow.ts` 顶部注释：行数恒等于
 *   消息数，双向插入的锚点才是精确的）；
 * - 悬停才出现的操作条不预先渲染占位（避免每条多 6 个节点）。
 *
 * 单条消息的 DOM 预算 ≈ 200 节点：普通文本 6 个，媒体 10 个左右，最复杂的
 * 群聊引用 + 标记 + 备注 ≈ 30 个。
 */
import { memo } from 'react'
import { AlertTriangle, ArrowRightLeft, Ban, Gift, Megaphone, MessageSquareQuote, Phone, Sparkles } from 'lucide-react'
import { Avatar } from '../Avatar'
import type { ReaderMessage } from './readerTypes'
import { formatClock, formatDayLabel } from './readerMessage'
import {
  CardBlock,
  ChatRecordBlock,
  CompactRow,
  CopyAction,
  FileBlock,
  ImageBlock,
  LinkBlock,
  LocationBlock,
  QuoteBlock,
  RichText,
  StarAction,
  StickerBlock,
  VideoBlock,
  VoiceBlock,
  type BlockActions,
} from './MessageBlocks'

export interface MessageRowProps {
  message: ReaderMessage
  /** 群聊里显示发送者昵称与头像。 */
  group: boolean
  showDay: boolean
  showUnreadAnchor: boolean
  marked: boolean
  note: string
  /** 注解通道可用时为 true；不可用时标记按钮禁用并说明原因。 */
  annotationsReady: boolean
  highlight?: string
  imageChannel: boolean
  videoChannel: boolean
  voiceChannel: boolean
  fileChannel: boolean
  /** 搜索命中的那一条（滚动定位后高亮整行）。 */
  active: boolean
  /** 多选态：整个会话进入"点消息选取一段"的模式。 */
  pickable: boolean
  picked: boolean
  onPick: (message: ReaderMessage) => void
  onToggleMark: (message: ReaderMessage) => void
  onEditNote: (message: ReaderMessage, note: string) => void
  onCopy: (message: ReaderMessage) => void
  /** 媒体/复制这类"内容块要用的回调"打包成稳定引用：行是 memo 的，回调逐帧新建就白 memo 了。 */
  actions: BlockActions
}

function MessageContent({
  message,
  highlight,
  imageChannel,
  videoChannel,
  voiceChannel,
  fileChannel,
  actions,
}: {
  message: ReaderMessage
  highlight?: string
  imageChannel: boolean
  videoChannel: boolean
  voiceChannel: boolean
  fileChannel: boolean
  actions: BlockActions
}) {
  const quote = message.quote ? <QuoteBlock sender={message.quote.sender} text={message.quote.text} /> : null

  switch (message.kind) {
    case 'text':
      return (
        <>
          {quote}
          <RichText text={message.text} highlight={highlight} />
        </>
      )
    case 'quote':
      return (
        <>
          {quote}
          <RichText text={message.text} highlight={highlight} />
          {!message.text && !quote ? (
            <CompactRow icon={<MessageSquareQuote size={16} />} title="引用消息（原文未解析）" />
          ) : null}
        </>
      )
    case 'image':
      return (
        <>
          {quote}
          <ImageBlock message={message} onOpen={actions.onOpenImage} imageChannel={imageChannel} />
        </>
      )
    case 'video':
      return (
        <>
          {quote}
          <VideoBlock message={message} videoChannel={videoChannel} />
        </>
      )
    case 'voice':
      return (
        <>
          {quote}
          <VoiceBlock message={message} voiceChannel={voiceChannel} />
        </>
      )
    case 'sticker':
      return (
        <>
          {quote}
          <StickerBlock message={message} />
        </>
      )
    case 'file':
      return (
        <>
          {quote}
          <FileBlock message={message} fileChannel={fileChannel} />
        </>
      )
    case 'link':
      return <LinkBlock message={message} />
    case 'miniprogram':
      return (
        <CompactRow
          icon={<Gift size={16} />}
          title={message.linkTitle || message.text || '小程序'}
          sub={message.appName || '小程序卡片'}
        />
      )
    case 'music':
      return <CompactRow icon={<Sparkles size={16} />} title={message.linkTitle || '音乐'} sub={message.linkUrl || ''} />
    case 'finder':
      return <CompactRow icon={<Sparkles size={16} />} title={message.linkTitle || '视频号'} sub={message.text} />
    case 'chatrecord':
      return <ChatRecordBlock message={message} />
    case 'location':
      return <LocationBlock message={message} />
    case 'card':
      return <CardBlock message={message} />
    case 'call':
      return <CompactRow icon={<Phone size={16} />} title={message.text || '通话'} />
    case 'transfer':
      return (
        <CompactRow
          icon={<ArrowRightLeft size={16} />}
          title={message.text || '转账'}
          sub="转账详情需要在微信或导出记录中查看"
          tone="transfer"
        />
      )
    case 'redpacket':
      return <CompactRow icon={<Gift size={16} />} title={message.text || '红包'} sub="红包详情不可读取（微信未保存在本地消息里）" tone="redpacket" />
    case 'pat':
      return <CompactRow icon={<Sparkles size={16} />} title={message.text || '拍一拍'} tone="pat" />
    case 'announcement':
      return <CompactRow icon={<Megaphone size={16} />} title={message.text || '群公告'} />
    case 'system':
      return (
        <CompactRow
          icon={message.revoked ? <Ban size={15} /> : <AlertTriangle size={15} />}
          title={message.text || '系统消息'}
          sub={message.revoked ? '原文保留需要防撤回通道（引擎未提供）' : undefined}
          tone="system"
        />
      )
    default:
      return (
        <>
          {quote}
          <RichText text={message.text || `[未识别的消息类型 ${message.kind}]`} highlight={highlight} />
        </>
      )
  }
}

/** 系统消息、拍一拍这类"居中细行"，不画气泡。 */
function isCentered(message: ReaderMessage): boolean {
  return message.kind === 'system' || message.kind === 'pat' || message.kind === 'announcement'
}

export const MessageRow = memo(function MessageRow({
  message,
  group,
  showDay,
  showUnreadAnchor,
  marked,
  note,
  annotationsReady,
  imageChannel,
  videoChannel,
  voiceChannel,
  fileChannel,
  highlight,
  active,
  pickable,
  picked,
  onPick,
  onToggleMark,
  onEditNote,
  onCopy,
  actions,
}: MessageRowProps) {
  const centered = isCentered(message)
  const showSender = group && !message.isSend && !centered
  return (
    <div className="reader-row-wrap" data-active={active ? 'true' : undefined}>
      {showDay && (
        <div className="reader-day" role="separator" aria-label={formatDayLabel(message.ts)}>
          <span>{formatDayLabel(message.ts)}</span>
        </div>
      )}
      {showUnreadAnchor && (
        <div className="reader-unread" role="separator" aria-label="未读起点">
          <span>以下是未读消息</span>
        </div>
      )}
      <div
        className="reader-row"
        data-send={message.isSend ? 'true' : 'false'}
        data-centered={centered ? 'true' : undefined}
        data-kind={message.kind}
        data-marked={marked ? 'true' : undefined}
        data-pickable={pickable ? 'true' : undefined}
        data-picked={picked ? 'true' : undefined}
        onClick={pickable ? () => onPick(message) : undefined}
        // 多选态下整行是一个可操作控件：键盘必须也能选（V12 §3 的验收里有
        // "键盘可完成选会话→搜索→打开图片→另存"，多选复制同样不能只靠鼠标）。
        role={pickable ? 'button' : undefined}
        tabIndex={pickable ? 0 : undefined}
        aria-pressed={pickable ? picked : undefined}
        onKeyDown={
          pickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onPick(message)
                }
              }
            : undefined
        }
      >
        {showSender && (
          <Avatar
            className="reader-avatar"
            src={message.senderAvatarUrl}
            name={message.senderName}
            size={30}
            lazy
          />
        )}
        <div className="reader-bubble-col">
          {showSender && <div className="reader-sender">{message.senderName || message.senderUsername}</div>}
          <div className="reader-bubble">
            <MessageContent
              message={message}
              highlight={highlight}
              imageChannel={imageChannel}
              videoChannel={videoChannel}
              voiceChannel={voiceChannel}
              fileChannel={fileChannel}
              actions={actions}
            />
          </div>
          <div className="reader-meta" onClick={(event) => event.stopPropagation()}>
            <span className="reader-time">{formatClock(message.ts)}</span>
            {note ? <span className="reader-note" title={note}>备注：{note}</span> : null}
            <div className="reader-actions">
              <StarAction
                marked={marked}
                disabled={!annotationsReady}
                title={annotationsReady ? (marked ? '取消标记' : '标记这条消息') : '注解通道不可用（annotations:mutate 未接线），标记不会保存'}
                onToggle={() => onToggleMark(message)}
              />
              <CopyAction message={message} onCopy={onCopy} />
              {!centered && (
                <NoteAction
                  disabled={!annotationsReady}
                  note={note}
                  onSave={(value) => onEditNote(message, value)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})

/** 备注编辑：一个内联输入，保存时回传（空串 = 删除备注）。 */
function NoteAction({
  note,
  onSave,
  disabled,
}: {
  note: string
  onSave: (value: string) => void
  disabled: boolean
}) {
  return (
    <form
      className="reader-note-form"
      onSubmit={(event) => {
        event.preventDefault()
        const input = event.currentTarget.elements.namedItem('note') as HTMLInputElement | null
        onSave((input?.value || '').trim())
      }}
    >
      <input
        className="reader-note-input"
        name="note"
        defaultValue={note}
        placeholder={disabled ? '注解通道不可用' : '备注（回车保存）'}
        disabled={disabled}
        title={disabled ? 'annotations:mutate 未接线，备注无法保存' : '备注保存在本机，不写入微信数据'}
      />
    </form>
  )
}
