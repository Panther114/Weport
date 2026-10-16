import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, X } from 'lucide-react'
import FloatingLayer from '../ui/FloatingLayer'
import { KIND_OPTIONS, dateToEpoch, type ScopeParams } from './searchQuery'
import { filterCandidates, type SessionCandidate } from './searchData'

/**
 * 作用域筛选面板（v1.2 §6）。
 *
 * 三个必须做到的点：
 *
 * 1. **飘在 body 下**。它是锚在「筛选」按钮上的浮层，如果留在文档流里，结果列表
 *    的滚动容器会把它裁掉（AGENTS.md 铁律 1）。所以走 FloatingLayer。
 * 2. **改动先落草稿，点「应用」才生效**。否则每勾一个会话就重搜一次，用户勾五个
 *    会话就是五次全库查询。
 * 3. **一键清空**。清空必须是**一个**动作：逐项点掉六个条件不是"一键"。
 */
export interface ScopePanelProps {
  open: boolean
  anchor: React.RefObject<HTMLElement | null>
  scope: ScopeParams
  candidates: SessionCandidate[]
  /** 会话候选读取失败的原因（面板里如实显示，不假装列表是空的） */
  candidatesError?: string
  /** 已打标签的会话 id（用来按标签筛会话候选；没有标签数据时传 undefined） */
  taggedSessions?: Set<string>
  recentSessions: string[]
  onApply: (scope: ScopeParams) => void
  onClear: () => void
  onClose: () => void
}

function toDraft(scope: ScopeParams): ScopeParams {
  return {
    tags: [...scope.tags],
    sessionIds: [...scope.sessionIds],
    senders: [...scope.senders],
    from: scope.from,
    to: scope.to,
    kinds: [...scope.kinds],
  }
}

export default function ScopePanel(props: ScopePanelProps) {
  const { open, anchor, scope, candidates, candidatesError, taggedSessions, recentSessions, onApply, onClear, onClose } = props
  const [draft, setDraft] = useState<ScopeParams>(() => toDraft(scope))
  const [sessionQuery, setSessionQuery] = useState('')
  const panelRef = useRef<HTMLDivElement | null>(null)

  // 每次打开都把草稿对齐到当前生效的条件：上次取消的编辑不该留到下一次
  useEffect(() => {
    if (open) {
      setDraft(toDraft(scope))
      setSessionQuery('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /**
   * 浮层渲染在 body 下，`ref.contains(target)` 在锚点按钮上会失效 —— 点锚点会被
   * 判成"点外面"，于是"点筛选按钮关面板"永远关不掉（点一下立即被重新打开）。
   * 所以这里同时排除锚点自己。
   */
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (anchor.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, anchor, onClose])

  const visibleCandidates = useMemo(
    () =>
      filterCandidates(candidates, {
        keyword: sessionQuery,
        selected: draft.sessionIds,
        tagged: taggedSessions,
        recent: recentSessions,
        limit: 60,
      }),
    [candidates, sessionQuery, draft.sessionIds, taggedSessions, recentSessions],
  )

  const datesInvalid = useMemo(() => {
    if (draft.from && dateToEpoch(draft.from, 'start') === undefined) return true
    if (draft.to && dateToEpoch(draft.to, 'end') === undefined) return true
    const from = dateToEpoch(draft.from, 'start')
    const to = dateToEpoch(draft.to, 'end')
    return from !== undefined && to !== undefined && from > to
  }, [draft.from, draft.to])

  const toggle = (field: 'sessionIds' | 'kinds' | 'tags', value: string) => {
    setDraft((prev) => {
      const list = prev[field]
      return { ...prev, [field]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value] }
    })
  }

  if (!open) return null

  return (
    <FloatingLayer anchor={anchor} open={open} placement="bottom-start" width={430} className="sp-scope-layer" role="dialog" aria-label="筛选条件">
      <div className="sp-scope" ref={panelRef}>
        <div className="sp-scope-group">
          <div className="sp-scope-title">
            <span>会话</span>
            {draft.sessionIds.length > 0 && <span className="sp-scope-count">{draft.sessionIds.length}</span>}
          </div>
          {candidatesError ? (
            <p className="sp-scope-note">{candidatesError} —— 仍可直接输入关键词搜索</p>
          ) : (
            <>
              <input
                className="sp-scope-input"
                type="search"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="输入会话名筛选"
                aria-label="筛选会话"
              />
              {visibleCandidates.length === 0 ? (
                <p className="sp-scope-note">没有匹配的会话</p>
              ) : (
                <div className="sp-scope-chips" role="group" aria-label="选择会话">
                  {visibleCandidates.map((item) => {
                    const on = draft.sessionIds.includes(item.username)
                    return (
                      <button
                        key={item.username}
                        type="button"
                        className={`sp-scope-chip${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        title={item.username}
                        onClick={() => toggle('sessionIds', item.username)}
                      >
                        {item.displayName}
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div className="sp-scope-group">
          <div className="sp-scope-title">
            <CalendarDays size={12} aria-hidden />
            <span>时间范围</span>
          </div>
          <div className="sp-scope-dates">
            <label className="sp-scope-date">
              <span>从</span>
              <input
                type="date"
                value={draft.from}
                onChange={(event) => setDraft((prev) => ({ ...prev, from: event.target.value }))}
                aria-label="起始日期"
              />
            </label>
            <label className="sp-scope-date">
              <span>到</span>
              <input
                type="date"
                value={draft.to}
                onChange={(event) => setDraft((prev) => ({ ...prev, to: event.target.value }))}
                aria-label="结束日期"
              />
            </label>
          </div>
          {datesInvalid && <p className="sp-scope-note is-warn">日期无效或起止颠倒，请检查</p>}
        </div>

        <div className="sp-scope-group">
          <div className="sp-scope-title">
            <span>消息类型</span>
            {draft.kinds.length > 0 && <span className="sp-scope-count">{draft.kinds.length}</span>}
          </div>
          <div className="sp-scope-chips" role="group" aria-label="选择消息类型">
            {KIND_OPTIONS.map((option) => {
              const on = draft.kinds.includes(option.value)
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`sp-scope-chip${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle('kinds', option.value)}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="sp-scope-group">
          <div className="sp-scope-title">
            <span>发送者</span>
          </div>
          <input
            className="sp-scope-input"
            type="text"
            value={draft.senders.join(',')}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                senders: event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              }))
            }
            placeholder="wxid 或昵称，多个用英文逗号分隔"
            aria-label="发送者"
          />
        </div>

        <div className="sp-scope-actions">
          <button type="button" className="ghost-btn" onClick={onClear}>
            <X size={13} aria-hidden />
            清空全部条件
          </button>
          <div className="sp-scope-actions-right">
            <button type="button" className="secondary-btn" onClick={onClose}>
              取消
            </button>
            <button type="button" className="primary-btn" disabled={datesInvalid} onClick={() => onApply(draft)}>
              应用
            </button>
          </div>
        </div>
      </div>
    </FloatingLayer>
  )
}
