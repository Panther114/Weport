import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, RefreshCw, Search, Star, Users, UserRound, X } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import FloatingLayer from '../ui/FloatingLayer'

export type ExportSessionType = 'all' | 'private' | 'group' | 'official' | 'favorites'
export type ExportSelectionMode = 'all' | 'selected'
type ExportSessionKind = 'private' | 'group' | 'official'

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
  favoriteIds: Set<string>
  favoritesReady: boolean
  selectionMode: ExportSelectionMode
  search: string
  type: ExportSessionType
  loading: boolean
  onSearchChange: (value: string) => void
  onTypeChange: (value: ExportSessionType) => void
  onSelectionModeChange: (value: ExportSelectionMode) => void
  onToggle: (username: string) => void
  onToggleFavorite: (username: string) => void
  onToggleVisible: () => void
  onRefresh: () => void
  allVisibleSelected: boolean
  disabled?: boolean
}

function getSessionType(username: string): ExportSessionKind {
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
  favoriteIds,
  favoritesReady,
  selectionMode,
  search,
  type,
  loading,
  onSearchChange,
  onTypeChange,
  onSelectionModeChange,
  onToggle,
  onToggleFavorite,
  onToggleVisible,
  onRefresh,
  allVisibleSelected,
  disabled = false,
}: ExportSessionPickerProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const dialogId = useId()
  const selectionCountLabel = selectionMode === 'all' ? `全部 ${totalSessions}` : `已选 ${selectedIds.size}`

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className={`export-session-picker${open ? ' is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="export-scope-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Users size={14} />
        <span className="export-scope-trigger-copy">
          <strong>导出范围</strong>
          <span>{selectionMode === 'all' ? '全部会话' : `仅选中 ${selectedIds.size} 个会话`}</span>
        </span>
        <span className="export-selection-count">{selectionCountLabel}</span>
        <ChevronDown size={14} className="export-scope-trigger-chevron" />
      </button>

      <FloatingLayer
        anchor={triggerRef}
        open={open}
        placement="bottom-start"
        gap={6}
        minHeight={180}
        className="export-session-popover-layer"
      >
        <div ref={popoverRef} id={dialogId} className="export-session-popover" role="dialog" aria-label="选择导出会话">
          <div className="export-session-picker-head">
            <div>
              <div className="export-session-picker-title">
                <Users size={14} />
                <strong>选择会话</strong>
                <span className="export-selection-count">{selectionCountLabel}</span>
              </div>
              <p className="hint">
                {selectionMode === 'all'
                  ? '当前会导出全部会话；切换为“仅选中”后，只导出下面勾选的会话。'
                  : '默认只导出勾选的会话；筛选不会清除隐藏的已选项。可收藏常用联系人，之后按收藏筛选。'}
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
              <button
                className="ghost-btn icon-only"
                type="button"
                aria-label="关闭导出范围菜单"
                title="关闭"
                onClick={() => setOpen(false)}
              >
                <X size={13} />
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
                ['favorites', '收藏'],
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
                  const favorite = favoriteIds.has(session.username)
                  return (
                    <div key={session.username} className="export-session-row-wrap">
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
                      <button
                        type="button"
                        className="export-session-favorite"
                        data-favorite={favorite}
                        aria-label={favorite ? `取消收藏 ${session.displayName || session.username}` : `收藏 ${session.displayName || session.username}`}
                        aria-pressed={favorite}
                        title={favorite ? '取消收藏' : '收藏联系人'}
                        disabled={disabled || !favoritesReady}
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleFavorite(session.username)
                        }}
                      >
                        <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  )
                }}
              />
            )}
          </div>
        </div>
      </FloatingLayer>
    </div>
  )
}
