import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Hash, Megaphone, User } from 'lucide-react'
import {
  filterReferenceCandidates,
  referenceKindLabel,
  type ChatReference,
  type ReferenceKind,
} from '../../utils/mentionTrigger'

export interface ReferenceCandidate {
  id: string
  label: string
  kind: ReferenceKind
  subtitle?: string
  avatarUrl?: string
}

export interface ReferencePickerHandle {
  /**
   * 由父级输入框的 onKeyDown 转发按键；返回 true 表示这次按键已被消费
   * （父级不应再把它当成普通输入）。
   */
  handleKeyDown: (event: { key: string; preventDefault: () => void }) => boolean
}

interface Props {
  /** 当前 `@` 之后的查询串（由输入框光标位置推导，见 utils/mentionTrigger.ts）。 */
  query: string
  candidates: ReferenceCandidate[]
  loading?: boolean
  onQueryChange: (query: string) => void
  onPick: (reference: ChatReference) => void
  onClose: () => void
  ref?: React.Ref<ReferencePickerHandle>
}

/**
 * `@` 会话选择器。
 *
 * 整个 harness 都是围绕微信数据库的，所以「引用哪一个会话」是最常用的输入
 * 动作 —— 它必须像引用文件一样顺手：输入即筛选、全键盘可操作、不打断打字。
 *
 * 几个刻意的设计：
 * - 候选列表由调用方提供（已按会话时间排好序）；这里只做筛选与排序，不自己
 *   读 WCDB，避免每敲一个字符就查一次数据库。
 * - 上限 60 条：5000 个会话的账号也不会因为渲染整列而卡顿。
 * - **自己不抢焦点**：键盘事件由父级输入框转发进来（见 ReferencePickerHandle），
 *   所以打字不会被中断，选择完成后光标也还在原处。
 */
export default function ReferencePicker({
  query,
  candidates,
  loading,
  onQueryChange,
  onPick,
  onClose,
  ref,
}: Props) {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const filtered = useMemo(() => filterReferenceCandidates(candidates, query, 60), [candidates, query])

  // 筛选结果变化时把选中项夹回合法范围，否则会停在一个不存在的下标上，
  // 表现为「按回车没反应」。
  useEffect(() => {
    setActiveIndex((current) => (current >= filtered.length ? 0 : current))
  }, [filtered])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown(event) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActiveIndex((current) => (filtered.length === 0 ? 0 : (current + 1) % filtered.length))
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveIndex((current) => (filtered.length === 0 ? 0 : (current - 1 + filtered.length) % filtered.length))
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const picked = filtered[activeIndex]
          if (!picked) return false
          event.preventDefault()
          onPick({ id: picked.id, label: picked.label, kind: picked.kind })
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return true
        }
        return false
      },
    }),
    [filtered, activeIndex, onPick, onClose]
  )

  return (
    <div className="ref-picker" role="dialog" aria-label="引用会话">
      <div className="ref-picker-search">
        <span className="ref-picker-at" aria-hidden>
          @
        </span>
        {/* 展示型搜索框：真正的输入发生在父级输入框里，这里只回显查询串。
            readOnly + tabIndex=-1 保证 Tab 与鼠标都不会把焦点从打字位置抢走。 */}
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="搜索联系人、群聊或微信号…"
          aria-label="搜索会话"
          readOnly
          tabIndex={-1}
        />
        <span className="ref-picker-count">{filtered.length}</span>
      </div>

      <div className="ref-picker-list" role="listbox" ref={listRef} aria-label="会话列表">
        {loading && filtered.length === 0 ? <div className="ref-picker-empty">正在读取会话…</div> : null}
        {!loading && filtered.length === 0 ? (
          <div className="ref-picker-empty">
            {candidates.length === 0 ? '还没有可引用的会话（先连接微信）' : '没有匹配的会话'}
          </div>
        ) : null}

        {filtered.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            data-index={index}
            data-active={index === activeIndex}
            className="ref-picker-item"
            // onMouseDown 而不是 onClick：失焦处理会先于 click 触发，
            // 用 mousedown 抢在失焦之前完成选择。
            onMouseDown={(e) => {
              e.preventDefault()
              onPick({ id: candidate.id, label: candidate.label, kind: candidate.kind })
            }}
            onMouseEnter={() => setActiveIndex(index)}
          >
            <span className="ref-picker-avatar" aria-hidden>
              {candidate.avatarUrl ? (
                <img src={candidate.avatarUrl} alt="" draggable={false} />
              ) : (
                <KindIcon kind={candidate.kind} />
              )}
            </span>
            <span className="ref-picker-main">
              <span className="ref-picker-label">{candidate.label}</span>
              {candidate.subtitle ? <span className="ref-picker-sub">{candidate.subtitle}</span> : null}
            </span>
            <span className="ref-picker-kind" data-kind={candidate.kind}>
              {referenceKindLabel(candidate.kind)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function KindIcon({ kind }: { kind: ReferenceKind }) {
  // 图标跟着类型走：群聊/私聊/公众号在列表里必须一眼可辨，否则几百个
  // 候选里根本分不出哪个是群。
  const Icon = kind === 'group' ? Hash : kind === 'official' ? Megaphone : User
  return <Icon size={14} strokeWidth={1.7} />
}
