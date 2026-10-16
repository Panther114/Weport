/**
 * 会话栏（阅读器的左列）。
 *
 * 数据来自 `chat:getSessions`（已有通道，见 `src/utils/sessionCandidates.ts` 记录的
 * 形状坑：返回是 `{ success, sessions }`，不是 `{ data }`）。列表**虚拟化**：V12 §3
 * 的验收里会话量是 10 万级，一个 `map` 就是几秒钟的白屏。
 *
 * 标签 / 收藏 / 未读数与条数都从注解 store 与会话行上直接读，界面不推演 ——
 * 注解的真实状态在 `annotations:list` 的返回里（`src/hooks/useAnnotations.ts`）。
 */
import { memo } from 'react'
import { Bell, BellOff, Star } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import { Avatar } from '../Avatar'
import type { ReaderSession, ReaderSessionKind } from './readerTypes'
import { SESSION_KIND_LABEL, formatCount, formatRelativeTime } from './readerMessage'

export interface SessionBadges {
  tags: string[]
  marks: number
  favorite: boolean
}

export interface SessionRailProps {
  sessions: ReaderSession[]
  loading: boolean
  error?: string
  kind: 'all' | ReaderSessionKind
  keyword: string
  selectedId: string
  /** 每个会话的标签/标记/收藏摘要；缺省表示还没有注解数据。 */
  badges: Record<string, SessionBadges>
  /** 注解通道是否可用（不可用时标签区不显示，也不假装是空）。 */
  annotationsReady: boolean
  onKind: (kind: 'all' | ReaderSessionKind) => void
  onKeyword: (keyword: string) => void
  onSelect: (session: ReaderSession) => void
}

const KIND_FILTERS: Array<{ id: 'all' | ReaderSessionKind; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'group', label: '群聊' },
  { id: 'private', label: '私聊' },
  { id: 'official', label: '公众号' },
]

const SessionItem = memo(function SessionItem({
  session,
  badges,
  selected,
  onSelect,
}: {
  session: ReaderSession
  badges?: SessionBadges
  selected: boolean
  onSelect: (session: ReaderSession) => void
}) {
  return (
    <button
      type="button"
      className="reader-session"
      data-active={selected ? 'true' : undefined}
      onClick={() => onSelect(session)}
      title={`${session.name}（${SESSION_KIND_LABEL[session.kind]}）`}
    >
      <Avatar className="reader-session-avatar" src={session.avatarUrl} name={session.name} size={34} lazy />
      <div className="reader-session-main">
        <div className="reader-session-top">
          <span className="reader-session-name">{session.name}</span>
          <span className="reader-session-time">{formatRelativeTime(session.lastAt)}</span>
        </div>
        <div className="reader-session-sub">
          <span className="reader-session-summary">{session.summary || '（没有可显示的摘要）'}</span>
        </div>
        <div className="reader-session-foot">
          <span className="reader-session-count" title="消息条数">
            {formatCount(session.messageCount)} 条
          </span>
          {session.unreadCount > 0 ? <span className="reader-session-unread">{session.unreadCount}</span> : null}
          {session.isMuted ? (
            <span className="reader-session-flag" title="免打扰">
              <BellOff size={11} />
            </span>
          ) : (
            <span className="reader-session-flag" title="消息通知开启">
              <Bell size={11} />
            </span>
          )}
          {badges?.favorite ? (
            <span className="reader-session-flag" title="已收藏">
              <Star size={11} fill="currentColor" />
            </span>
          ) : null}
          {badges?.marks ? (
            <span className="reader-session-flag" title={`${badges.marks} 条消息被标记`}>
              <Star size={11} />
              {badges.marks}
            </span>
          ) : null}
          {badges?.tags?.slice(0, 2).map((tag) => (
            <span className="reader-tag" key={tag}>
              {tag}
            </span>
          ))}
          {badges?.tags && badges.tags.length > 2 ? <span className="reader-tag">+{badges.tags.length - 2}</span> : null}
        </div>
      </div>
    </button>
  )
})

/**
 * 会话栏。
 *
 * `memo` 在这里是有实际意义的：会话栏是阅读器页的子节点，而翻页 / 标记 / 备注都会让
 * 父组件重渲染。props 全是稳定引用（`badges` 与 `sessions` 都来自父组件的 useMemo，
 * 回调是 useCallback），所以 memo 之后"加载更早的消息"不会再重建整个会话列表。
 */
export const SessionRail = memo(function SessionRail({
  sessions,
  loading,
  error,
  kind,
  keyword,
  selectedId,
  badges,
  annotationsReady,
  onKind,
  onKeyword,
  onSelect,
}: SessionRailProps) {
  return (
    <aside className="reader-rail" aria-label="会话列表">
      <div className="reader-rail-head">
        <input
          className="filter-input reader-rail-search"
          value={keyword}
          onChange={(event) => onKeyword(event.target.value)}
          placeholder="搜索会话名 / wxid"
          aria-label="搜索会话"
        />
        <div className="reader-rail-filters" role="tablist" aria-label="会话类型">
          {KIND_FILTERS.map((option) => (
            <button
              type="button"
              key={option.id}
              className="chip"
              role="tab"
              aria-selected={kind === option.id}
              data-active={kind === option.id ? 'true' : undefined}
              onClick={() => onKind(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {!annotationsReady && (
          <div className="reader-rail-note" title="annotations:list 未接线，标签与收藏无法读取">
            注解通道未接入：标签 / 收藏暂不显示
          </div>
        )}
      </div>

      <div className="reader-rail-list">
        {loading && sessions.length === 0 && <div className="reader-hint">正在读取会话…</div>}
        {!loading && error && <div className="reader-hint reader-hint-error">读取会话失败：{error}</div>}
        {!loading && !error && sessions.length === 0 && (
          <div className="reader-hint">没有匹配的会话（先到「连接微信」页完成连接与密钥）</div>
        )}
        {sessions.length > 0 && (
          <Virtuoso
            className="reader-rail-virtuoso"
            data={sessions}
            computeItemKey={(_, session) => session.id}
            itemContent={(_, session) => (
              <SessionItem
                session={session}
                badges={badges[session.id]}
                selected={session.id === selectedId}
                onSelect={onSelect}
              />
            )}
          />
        )}
      </div>
    </aside>
  )
})
