import { useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from 'react'
import { Hash, Megaphone, Search, User, X } from 'lucide-react'
import FloatingLayer from '../ui/FloatingLayer'
import {
  filterReferenceCandidates,
  referenceKindLabel,
  type ChatReference,
  type ReferenceKind,
} from '../../utils/mentionTrigger'
import { emptyReferenceHint } from '../../utils/sessionCandidates'

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
  /** 触发这次引用的输入框：浮层跟着它的位置走（见 components/ui/FloatingLayer） */
  anchor: RefObject<HTMLElement | null>
  /** 当前 `@` 之后的查询串（由输入框光标位置推导，见 utils/mentionTrigger.ts） */
  query: string
  candidates: ReferenceCandidate[]
  loading?: boolean
  /**
   * 候选是**成功读到**的吗（默认 true）。
   *
   * 「读失败」与「真的没有会话」是两回事：前者要说原因，后者才该提示去连接微信。
   * 两者都渲染成「先连接微信」正是用户报的那个 bug。
   */
  ok?: boolean
  error?: string
  /**
   * 查询串变化。**弹层里的搜索框是真的能打字的**：它把新查询交回父级，
   * 父级改写自己输入框里的那段 `@查询`（唯一来源），再回灌进来。
   */
  onQueryChange: (query: string) => void
  onPick: (reference: ChatReference) => void
  onClose: () => void
  /** 关闭后把焦点交还输入框（父级实现） */
  onReturnFocus?: () => void
  ref?: React.Ref<ReferencePickerHandle>
}

/**
 * `@` 会话选择器。
 *
 * 整个 harness 都是围绕微信数据库的，所以「引用哪一个会话」是最常用的输入
 * 动作 —— 它必须像引用文件一样顺手：输入即筛选、全键盘可操作、不打断打字。
 *
 * 几个刻意的设计：
 * - **渲染到 body 下的浮层**（FloatingLayer）。旧版挂在文档流里，在 WeBot 的
 *   滚动容器（`.webot { overflow-y: auto }`）内向上展开时会被整块裁掉 ——
 *   用户看到的是"弹窗在顶部被切掉"。浮层化之后，任何祖先的 overflow 都管不到它。
 * - 候选列表由调用方提供（已按会话时间排好序）；这里只做筛选与排序，不自己
 *   读 WCDB，避免每敲一个字符就查一次数据库。
 * - 上限 60 条：5000 个会话的账号也不会因为渲染整列而卡顿。
 * - **搜索框是真输入框**（v1.0.1）。旧版是 `readOnly` 的"展示型"输入框：
 *   点它会把焦点从输入框抢走，之后打字一个字符也进不去，用户看到的就是
 *   "搜索不能用"。现在它自己收键盘，并把查询串同步回输入框；
 *   同时 **不自动聚焦** —— 打出一个 `@` 就被抢走焦点会让正常打字断掉。
 */
export default function ReferencePicker({
  anchor,
  query,
  candidates,
  loading,
  ok = true,
  error,
  onQueryChange,
  onPick,
  onClose,
  onReturnFocus,
  ref,
}: Props) {
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

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

  /** 键盘导航：父级输入框与弹层搜索框共用同一份逻辑 */
  const navigate = (event: { key: string; preventDefault: () => void; shiftKey?: boolean }): boolean => {
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
    if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      const picked = filtered[activeIndex]
      if (!picked) return false
      event.preventDefault()
      onPick({ id: picked.id, label: picked.label, kind: picked.kind })
      onReturnFocus?.()
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      onReturnFocus?.()
      return true
    }
    return false
  }

  useImperativeHandle(ref, () => ({ handleKeyDown: navigate }), [filtered, activeIndex, onPick, onClose, onReturnFocus])

  /**
   * 点击浮层内部不应关闭它。
   *
   * 父级输入框的 `onBlur` 会延迟关闭选择器（点击条目时先触发 blur）。搜索框
   * 在浮层里，用户点它是想"在这里打字"，而不是想关掉选择器 —— 所以父级用
   * `relatedTarget` 判断焦点是否落进 `.ref-picker`，这里负责提供那个锚点。
   */
  return (
    <FloatingLayer
      anchor={anchor}
      open
      placement="top-start"
      gap={6}
      width={380}
      minHeight={180}
      className="ref-picker-layer"
      role="dialog"
      aria-label="引用会话"
    >
      <div className="ref-picker" data-ref-picker="true">
        <div className="ref-picker-search">
          <Search size={13} className="ref-picker-search-icon" aria-hidden />
          {/* 真输入框：查询串的唯一来源仍是父级输入框的文本，这里只是它的另一个
              视图 —— 打字 → onQueryChange → 父级改写 `@查询` → 回灌 value。 */}
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              const consumed = navigate(e)
              if (!consumed && e.key === ' ') e.preventDefault()
            }}
            placeholder="搜索联系人、群聊或微信号…"
            aria-label="搜索会话"
            spellCheck={false}
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              className="ref-picker-clear"
              aria-label="清空搜索"
              onClick={() => {
                onQueryChange('')
                searchRef.current?.focus()
              }}
            >
              <X size={11} />
            </button>
          ) : null}
          <span className="ref-picker-count">{filtered.length}</span>
        </div>

        <div className="ref-picker-list" role="listbox" ref={listRef} aria-label="会话列表">
          {filtered.length === 0 ? (
            <div className="ref-picker-empty" data-state={ok ? 'empty' : 'error'}>
              {emptyReferenceHint({ loading, ok, error, hasCandidates: candidates.length > 0 })}
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
                onReturnFocus?.()
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
    </FloatingLayer>
  )
}

function KindIcon({ kind }: { kind: ReferenceKind }) {
  // 图标跟着类型走：群聊/私聊/公众号在列表里必须一眼可辨，否则几百个
  // 候选里根本分不出哪个是群。
  const Icon = kind === 'group' ? Hash : kind === 'official' ? Megaphone : User
  return <Icon size={14} strokeWidth={1.7} />
}
