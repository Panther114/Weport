/**
 * 阅读器工具条：会话身份 + 注解（收藏/标签）+ 本会话工具（导出、复制范围、跳日期）
 * + 会话内搜索。
 *
 * 两个纪律都在这里落地：
 *
 * - **浮层走 `components/ui/FloatingLayer`**（AGENTS.md 铁律 1）：标签面板、搜索命中
 *   面板都在滚动容器里、也都会靠近窗口边缘，内联 `position: absolute` 迟早被裁掉。
 *   浮层挂到 `<body>` 之后"点外面关闭"必须改成看浮层根节点，而不是 `ref.contains`
 *   —— 浮层已经不是这个子树的一部分了（`FloatingLayer` 打了
 *   `data-floating-layer` 标记，下面的 `useDismiss` 用它判断）。
 * - **长任务的进度不在这里**：导出走 `export:exportSessions`，进度由主进程推到
 *   `BackgroundTasks` / `ExportProgressBar`（铁律 3）。这里只显示"已开始/失败"这一行
 *   本地结果，切页也不会丢。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarClock,
  Copy,
  Download,
  ImagePlus,
  Search,
  Star,
  Tag,
  X,
} from 'lucide-react'
import FloatingLayer from '../ui/FloatingLayer'
import type { ReaderChannelStatus } from './readerSource'
import type { ReaderSearchHit, ReaderSession } from './readerTypes'
import { SESSION_KIND_LABEL, formatCount } from './readerMessage'

/** 点浮层外面关闭。挂到 body 的浮层不能用 `ref.contains` 判断（见文件头注释）。 */
function useDismiss(open: boolean, onClose: () => void, anchor: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (!target) return
      if (anchor.current?.contains(target)) return
      if (target.closest?.('[data-floating-layer="true"]')) return
      onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose, anchor])
}

export interface ExportState {
  busy: boolean
  message?: string
  error?: string
}

export interface ReaderToolbarProps {
  session: ReaderSession | null
  channels: ReaderChannelStatus
  annotationsReady: boolean
  favorite: boolean
  tags: string[]
  onToggleFavorite: () => void
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void

  keyword: string
  onKeyword: (value: string) => void
  hits: ReaderSearchHit[]
  hitsNote: string
  activeHitKey: string
  searching: boolean
  onHit: (hit: ReaderSearchHit) => void

  jumpDate: string
  onJumpDate: (value: string) => void
  onResetWindow: () => void
  loadingWindow: boolean

  exporting: ExportState
  onExport: () => void
  onCreatePoster: () => void
  posterEnabled: boolean

  pickMode: boolean
  pickedCount: number
  onTogglePickMode: () => void
  onCopyPicked: () => void
  onClearPicked: () => void
}

export function ReaderToolbar({
  session,
  channels,
  annotationsReady,
  favorite,
  tags,
  onToggleFavorite,
  onAddTag,
  onRemoveTag,
  keyword,
  onKeyword,
  hits,
  hitsNote,
  activeHitKey,
  searching,
  onHit,
  jumpDate,
  onJumpDate,
  onResetWindow,
  loadingWindow,
  exporting,
  onExport,
  onCreatePoster,
  posterEnabled,
  pickMode,
  pickedCount,
  onTogglePickMode,
  onCopyPicked,
  onClearPicked,
}: ReaderToolbarProps) {
  const [tagOpen, setTagOpen] = useState(false)
  const [hitsOpen, setHitsOpen] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const tagAnchor = useRef<HTMLButtonElement | null>(null)
  const searchAnchor = useRef<HTMLDivElement | null>(null)

  const closeTags = useCallback(() => setTagOpen(false), [])
  const closeHits = useCallback(() => setHitsOpen(false), [])
  useDismiss(tagOpen, closeTags, tagAnchor)
  useDismiss(hitsOpen, closeHits, searchAnchor)

  if (!session) {
    return (
      <header className="reader-toolbar reader-toolbar-empty">
        <span className="reader-hint">从左侧选择一个会话开始阅读</span>
      </header>
    )
  }

  return (
    <header className="reader-toolbar">
      <div className="reader-toolbar-id">
        <span className="reader-toolbar-name" title={session.id}>
          {session.name}
        </span>
        <span className="reader-toolbar-kind">{SESSION_KIND_LABEL[session.kind]}</span>
        <span className="reader-toolbar-count" title="消息条数">
          {formatCount(session.messageCount)} 条
        </span>
        {session.unreadCount > 0 ? <span className="reader-toolbar-unread">未读 {session.unreadCount}</span> : null}
      </div>

      <div className="reader-toolbar-tools">
        {/* 收藏（会话级：localId 为空的那种收藏） */}
        <button
          type="button"
          className="reader-tool"
          data-active={favorite ? 'true' : undefined}
          disabled={!annotationsReady}
          title={annotationsReady ? (favorite ? '取消收藏这个会话' : '收藏这个会话') : '注解通道不可用（annotations:mutate 未接线）'}
          onClick={onToggleFavorite}
        >
          <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
          <span>{favorite ? '已收藏' : '收藏'}</span>
        </button>

        {/* 标签 */}
        <button
          type="button"
          className="reader-tool"
          ref={tagAnchor}
          data-active={tagOpen ? 'true' : undefined}
          disabled={!annotationsReady}
          title={annotationsReady ? '给这个会话打标签' : '注解通道不可用（annotations:mutate 未接线）'}
          aria-expanded={tagOpen}
          onClick={() => setTagOpen((value) => !value)}
        >
          <Tag size={14} />
          <span>标签{tags.length ? ` ${tags.length}` : ''}</span>
        </button>

        {/* 导出本会话：走既有的导出流程，进度由主进程推到全局进度条 */}
        <button
          type="button"
          className="reader-tool"
          disabled={exporting.busy}
          title="把这个会话交给导出流程（格式与目录沿用导出页的设置）"
          onClick={onExport}
        >
          <Download size={14} />
          <span>{exporting.busy ? '导出中…' : '导出本会话'}</span>
        </button>

        {/* 复制一段消息 */}
        <button
          type="button"
          className="reader-tool"
          data-active={pickMode ? 'true' : undefined}
          title="进入多选，点消息选取一段后复制为文本"
          onClick={onTogglePickMode}
        >
          <Copy size={14} />
          <span>{pickMode ? `已选 ${pickedCount}` : '复制范围'}</span>
        </button>
        {pickMode && (
          <>
            <button type="button" className="ghost-btn" disabled={!posterEnabled} onClick={onCreatePoster} title="把选中的消息送到海报工作室">
              <ImagePlus size={13} />制作海报
            </button>
            <button type="button" className="ghost-btn" disabled={pickedCount === 0} onClick={onCopyPicked}>
              复制为文本
            </button>
            <button type="button" className="ghost-btn" onClick={onClearPicked}>
              清空
            </button>
          </>
        )}

        {/* 跳到某一天 */}
        <label className="reader-jump" title="跳到某一天（按日期重新取窗口）">
          <CalendarClock size={14} />
          <input
            type="date"
            className="reader-jump-input"
            value={jumpDate}
            disabled={!channels.messages}
            onChange={(event) => onJumpDate(event.target.value)}
          />
        </label>
        {loadingWindow && <span className="reader-toolbar-note">正在跳转…</span>}
        <button
          type="button"
          className="ghost-btn"
          disabled={!channels.messages}
          title="回到最新消息"
          onClick={onResetWindow}
        >
          回到最新
        </button>

        {/* 会话内搜索 */}
        <div className="reader-search" ref={searchAnchor}>
          <Search size={14} />
          <input
            className="reader-search-input"
            value={keyword}
            placeholder="在这个会话里搜索"
            aria-label="会话内搜索"
            onChange={(event) => {
              onKeyword(event.target.value)
              setHitsOpen(true)
            }}
            onFocus={() => setHitsOpen(true)}
          />
          {keyword && (
            <button
              type="button"
              className="reader-search-clear"
              title="清空搜索"
              onClick={() => {
                onKeyword('')
                setHitsOpen(false)
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {(exporting.message || exporting.error) && (
        <div className="reader-toolbar-result" data-error={exporting.error ? 'true' : undefined} role="status">
          {exporting.error || exporting.message}
        </div>
      )}

      {tagOpen && (
        <FloatingLayer anchor={tagAnchor} open={tagOpen} width={260} className="reader-popover" aria-label="会话标签">
          <div className="reader-tag-panel">
            <div className="reader-tag-list">
              {tags.length === 0 && <span className="reader-hint">还没有标签</span>}
              {tags.map((tag) => (
                <button
                  type="button"
                  key={tag}
                  className="chip chip-active"
                  title="点击移除这个标签"
                  onClick={() => onRemoveTag(tag)}
                >
                  {tag}
                  <X size={11} />
                </button>
              ))}
            </div>
            <form
              className="reader-tag-form"
              onSubmit={(event) => {
                event.preventDefault()
                onAddTag(tagDraft)
                setTagDraft('')
              }}
            >
              <input
                className="filter-input"
                value={tagDraft}
                placeholder="新标签，回车添加"
                onChange={(event) => setTagDraft(event.target.value)}
              />
            </form>
            <div className="reader-popover-note">标签只写本机配置，不动微信数据</div>
          </div>
        </FloatingLayer>
      )}

      {hitsOpen && keyword.trim() && (
        <FloatingLayer anchor={searchAnchor} open={hitsOpen} width={360} className="reader-popover" aria-label="搜索结果">
          <div className="reader-hits">
            <div className="reader-hits-note">
              {searching ? '正在搜索…' : hitsNote}
            </div>
            {hits.length === 0 && !searching && <div className="reader-hint">没有命中</div>}
            <ul className="reader-hits-list">
              {hits.map((hit) => (
                <li key={hit.key}>
                  <button
                    type="button"
                    className="reader-hit-row"
                    data-active={hit.key === activeHitKey ? 'true' : undefined}
                    onClick={() => {
                      onHit(hit)
                      setHitsOpen(false)
                    }}
                  >
                    <span className="reader-hit-time">{new Date(hit.ts).toLocaleDateString('zh-CN')}</span>
                    <span className="reader-hit-sender">{hit.senderName}</span>
                    <span className="reader-hit-excerpt">{hit.excerpt}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </FloatingLayer>
      )}
    </header>
  )
}
