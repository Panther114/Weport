import { ListFilter, X } from 'lucide-react'
import { activeScopeCount, kindLabel, type ScopeParams } from './searchQuery'

/**
 * 已生效条件的可见清单（v1.2 §6）。
 *
 * 界面上"正在按什么筛"必须是**看得见、点得掉**的：筛选藏在一个需要展开的面板里、
 * 或者只在输入框里以 `会话:xxx` 的形式存在，用户就会对"为什么只有 3 条结果"失去判断。
 * 所以每个条件都是一枚 chip，带自己的移除按钮；整行还有一个"清空"。
 */
export interface FilterChipsProps {
  scope: ScopeParams
  /** 会话 id → 显示名（显示名而不是 wxid） */
  sessionNames: Map<string, string>
  onRemove: (patch: Partial<ScopeParams>) => void
  onClearAll: () => void
  /** 打开筛选面板 */
  onOpenPanel: () => void
  panelOpen: boolean
  /** 面板按钮的锚点（浮层定位用） */
  anchorRef: React.RefObject<HTMLElement | null>
  /** 结果数/耗时等只读信息 */
  trailing?: React.ReactNode
}

interface Chip {
  key: string
  label: string
  title?: string
  onRemove: () => void
  tone?: number
}

export default function FilterChips(props: FilterChipsProps) {
  const { scope, sessionNames, onRemove, onClearAll, onOpenPanel, panelOpen, anchorRef, trailing } = props
  const count = activeScopeCount(scope)

  const chips: Chip[] = [
    ...scope.tags.map((tag) => ({
      key: `tag:${tag}`,
      label: `标签：${tag}`,
      onRemove: () => onRemove({ tags: scope.tags.filter((item) => item !== tag) }),
    })),
    ...scope.sessionIds.map((id) => ({
      key: `session:${id}`,
      label: `会话：${sessionNames.get(id) || id}`,
      title: id,
      onRemove: () => onRemove({ sessionIds: scope.sessionIds.filter((item) => item !== id) }),
    })),
    ...scope.senders.map((sender) => ({
      key: `sender:${sender}`,
      label: `发送者：${sender}`,
      onRemove: () => onRemove({ senders: scope.senders.filter((item) => item !== sender) }),
    })),
    ...(scope.from || scope.to
      ? [
          {
            key: 'range',
            label: `时间：${scope.from || '不限'} ~ ${scope.to || '不限'}`,
            onRemove: () => onRemove({ from: '', to: '' }),
          },
        ]
      : []),
    ...scope.kinds.map((kind) => ({
      key: `kind:${kind}`,
      label: `类型：${kindLabel(kind)}`,
      onRemove: () => onRemove({ kinds: scope.kinds.filter((item) => item !== kind) }),
    })),
  ]

  return (
    <div className="sp-filters">
      <div className="sp-filters-right">
        <button
          ref={anchorRef as React.RefObject<HTMLButtonElement>}
          type="button"
          className={`sp-filter-btn${count > 0 ? ' is-on' : ''}`}
          aria-expanded={panelOpen}
          aria-haspopup="dialog"
          onClick={onOpenPanel}
        >
          <ListFilter size={13} aria-hidden />
          筛选{count > 0 ? `（${count}）` : ''}
        </button>
      </div>

      {chips.length > 0 ? (
        <>
          <div className="sp-chip-list">
            {chips.map((chip) => (
              <span className="sp-chip" key={chip.key} title={chip.title}>
                <span className="sp-chip-text">{chip.label}</span>
                <button type="button" className="sp-chip-x" aria-label={`移除条件 ${chip.label}`} onClick={chip.onRemove}>
                  <X size={11} aria-hidden />
                </button>
              </span>
            ))}
          </div>
          <button type="button" className="sp-clear-all" onClick={onClearAll}>
            清空全部
          </button>
        </>
      ) : (
        <span className="sp-filters-hint">未加筛选条件 · 输入框支持 标签: 会话: 发送者: 从: 到: 类型:</span>
      )}

      {trailing && <span className="sp-filters-trailing">{trailing}</span>}
    </div>
  )
}
