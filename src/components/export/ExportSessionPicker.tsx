import { Check, RefreshCw, Search, Users, UserRound } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'

export type ExportSessionType = 'all' | 'private' | 'group' | 'official'
export type ExportSelectionMode = 'all' | 'selected'

export interface ExportSessionPickerItem {
  username: string
  displayName?: string
  summary?: string
  avatarUrl?: string
  messageCountHint?: number
}

interface ExportSessionPickerProps {
  sessions: ExportSessionPickerItem[]
  totalSessions?: number
  selectedIds: Set<string>
  selectionMode: ExportSelectionMode
  search: string
  type: ExportSessionType
  loading: boolean
  onSearchChange: (value: string) => void
  onTypeChange: (value: ExportSessionType) => void
  onSelectionModeChange: (value: ExportSelectionMode) => void
  onToggle: (username: string) => void
  onToggleVisible: () => void
  onRefresh: () => void
  allVisibleSelected: boolean
  disabled?: boolean
}

function getSessionType(username: string): Exclude<ExportSessionType, 'all'> {
  if (username.startsWith('gh_')) return 'official'
  if (username.endsWith('@chatroom')) return 'group'
  return 'private'
}

function getInitial(session: ExportSessionPickerItem): string {
  const name = String(session.displayName || session.username).trim()
  return name ? name.slice(0, 1).toUpperCase() : '?'
}

export default function ExportSessionPicker({
  sessions,
  totalSessions = sessions.length,
  selectedIds,
  selectionMode,
  search,
  type,
  loading,
  onSearchChange,
  onTypeChange,
  onSelectionModeChange,
  onToggle,
  onToggleVisible,
  onRefresh,
  allVisibleSelected,
  disabled = false,
}: ExportSessionPickerProps) {
  const selectionCountLabel = selectionMode === 'all' ? `全部 ${totalSessions}` : `已选 ${selectedIds.size}`
  return (
    <div className="export-session-picker">
      <div className="export-session-picker-head">
        <div>
          <div className="export-session-picker-title">
            <Users size={14} />
            <strong>选择会话</strong>
            <span className="export-selection-count">{selectionCountLabel}</span>
          </div>
          <p className="hint">
            {selectionMode === 'all'
              ? '默认导出全部会话；切换为“仅选中”后，下面的勾选才会限制范围。'
              : '只导出勾选的联系人或群聊；筛选不会清除隐藏的已选项。'}
          </p>
        </div>
        <div className="export-session-picker-actions">
          <button
            className="ghost-btn compact"
            type="button"
            disabled={disabled || loading || sessions.length === 0}
            onClick={onToggleVisible}
          >
            {allVisibleSelected ? '取消全选' : '全选当前'}
          </button>
          <button
            className="ghost-btn icon-only"
            type="button"
            aria-label="刷新会话列表"
            title="刷新会话列表"
            disabled={disabled || loading}
            onClick={onRefresh}
          >
            <RefreshCw size={13} className={loading ? 'spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="export-session-picker-toolbar">
        <label className="export-session-search">
          <Search size={13} />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索联系人、群聊或微信号…"
            aria-label="搜索导出会话"
            disabled={disabled || loading}
          />
        </label>
        <div className="export-session-filters" role="radiogroup" aria-label="会话类型">
          {([
            ['all', '全部'],
            ['private', '私聊'],
            ['group', '群聊'],
            ['official', '公众号'],
          ] as Array<[ExportSessionType, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={type === value}
              data-active={type === value}
              disabled={disabled || loading}
              onClick={() => onTypeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="export-selection-mode" role="radiogroup" aria-label="导出范围">
        <span>导出范围</span>
        {([
          ['all', '全部会话'],
          ['selected', `仅选中（${selectedIds.size}）`],
        ] as Array<[ExportSelectionMode, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selectionMode === value}
            data-active={selectionMode === value}
            disabled={disabled || loading}
            onClick={() => onSelectionModeChange(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="export-session-list" role="listbox" aria-label="导出会话列表" aria-multiselectable="true">
        {loading ? (
          <div className="export-session-empty">正在加载会话…</div>
        ) : sessions.length === 0 ? (
          <div className="export-session-empty">没有匹配的会话</div>
        ) : (
          <Virtuoso
            data={sessions}
            style={{ height: 250 }}
            overscan={240}
            computeItemKey={(_index, session) => session.username}
            itemContent={(_index, session) => {
              const selected = selectedIds.has(session.username)
              const sessionType = getSessionType(session.username)
              const count = Number(session.messageCountHint)
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="export-session-row"
                  data-selected={selected}
                  disabled={disabled}
                  onClick={() => onToggle(session.username)}
                >
                  <span className="export-session-check" aria-hidden="true">
                    {selected && <Check size={11} strokeWidth={2.5} />}
                  </span>
                  {session.avatarUrl ? (
                    <img className="export-session-avatar" src={session.avatarUrl} alt="" />
                  ) : (
                    <span className={`export-session-avatar fallback ${sessionType}`}>
                      {sessionType === 'group' ? <Users size={13} /> : sessionType === 'private' ? getInitial(session) : <UserRound size={13} />}
                    </span>
                  )}
                  <span className="export-session-copy">
                    <strong>{session.displayName || session.username}</strong>
                    <span>{session.summary || session.username}</span>
                  </span>
                  <span className="export-session-count">
                    {Number.isFinite(count) && count >= 0 ? count.toLocaleString() : ''}
                  </span>
                </button>
              )
            }}
          />
        )}
      </div>
    </div>
  )
}
