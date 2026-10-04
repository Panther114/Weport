import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

/**
 * 搜索输入框（v1.2 §6）。
 *
 * 键盘约定（全局命令面板通用的一套，不要另发明）：
 *   ↑ / ↓   在联想词之间移动（联想没开时移动结果高亮，见 SearchResults）
 *   Enter   打开当前高亮项；联想没开时交回页面（打开结果）
 *   Esc     先关联想，再清空输入（一次 Esc 只做一件事，不会把用户辛苦打的字一扫而空）
 *
 * 联想词走 `<ul role="listbox">`，输入框用 `aria-activedescendant` 指向高亮项 ——
 * 焦点始终留在输入框里，屏幕阅读器读的是"当前选项"，而不是每按一下箭头就丢焦点。
 */
export interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  /** 前缀联想词（已取回）。空数组表示不显示下拉 */
  suggestions: string[]
  /** 键盘：上下移动结果高亮（联想关闭时） */
  onMoveResult?: (delta: 1 | -1) => void
  /** 键盘：打开当前高亮的结果 */
  onOpenResult?: () => void
  /** 键盘：Esc 清空后回调（页面跟着清 URL 片段） */
  onClear?: () => void
  /** 输入框右侧的统计/耗时等只读信息 */
  meta?: React.ReactNode
  inputRef?: React.RefObject<HTMLInputElement | null>
}

export default function SearchBar({
  value,
  onChange,
  suggestions,
  onMoveResult,
  onOpenResult,
  onClear,
  meta,
  inputRef,
}: SearchBarProps) {
  const [active, setActive] = useState(-1)
  /**
   * 下拉里的词正好就是当前输入时**不展开**。
   *
   * 这一条是键盘优先的关键：用户打完"合同"（正好是一个联想词）之后再按 ↓，应当是
   * "看下一条结果"，而不是"再看一遍我刚打的字"。下拉只在还想继续往下打时才有价值。
   *
   * 判据是"输入恰好等于**某一个**联想词"，不是"联想只有一个" —— 引擎一次会回
   * 好几条（`合同` / `合同 类型:图片` / …），只比第一条挡不住。
   */
  const trimmed = value.trim()
  const open = suggestions.length > 0 && !suggestions.some((item) => item === trimmed)
  const ownRef = useRef<HTMLInputElement | null>(null)
  const ref = inputRef ?? ownRef

  // 联想词换了就重置高亮，否则高亮会停在一个已经不存在的位置上
  useEffect(() => {
    setActive(-1)
  }, [suggestions])

  const accept = (index: number) => {
    const picked = suggestions[index]
    if (picked === undefined) return
    onChange(picked)
    setActive(-1)
    ref.current?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const delta = event.key === 'ArrowDown' ? 1 : -1
      /**
       * 这两个键在本组件里**一律就地处理并吃掉**：输入框是结果区键盘的拥有者
       * （先联想、再结果）。让它继续冒泡到外层的结果区处理器会出现"按一次 ↓
       * 移两行、按一次 Enter 打开两次"（实测过 `opened=2`），所以这里
       * `stopPropagation` 而不是靠 `defaultPrevented` 协商 —— React 的合成事件
       * 在传播途中 `defaultPrevented` 还可能是 false，协商不可靠。
       */
      event.stopPropagation()
      if (open) {
        event.preventDefault()
        setActive((prev) => {
          const next = prev + delta
          if (next < 0) return suggestions.length - 1
          if (next >= suggestions.length) return 0
          return next
        })
        return
      }
      event.preventDefault()
      onMoveResult?.(delta)
      return
    }
    if (event.key === 'Enter') {
      event.stopPropagation()
      if (open && active >= 0) {
        event.preventDefault()
        accept(active)
        return
      }
      event.preventDefault()
      if (!open) onOpenResult?.()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (open) {
        setActive(-1)
        onChange('')
        return
      }
      if (value) {
        onChange('')
        return
      }
      onClear?.()
    }
  }

  return (
    <div className="sp-search">
      <div className="sp-search-box">
        <Search size={15} className="sp-search-icon" aria-hidden />
        <input
          ref={ref}
          className="sp-search-input"
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索消息、会话；或用 标签: / 会话: / 从: 到: / 类型: 加条件"
          aria-label="搜索"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? 'sp-suggest' : undefined}
          aria-activedescendant={open && active >= 0 ? `sp-suggest-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        {value && (
          <button
            type="button"
            className="sp-search-clear"
            aria-label="清空搜索"
            title="清空（Esc）"
            onClick={() => {
              onChange('')
              ref.current?.focus()
            }}
          >
            <X size={13} aria-hidden />
          </button>
        )}
        {meta && <span className="sp-search-meta">{meta}</span>}
      </div>

      {open && (
        <ul className="sp-suggest" role="listbox" id="sp-suggest" aria-label="搜索建议">
          {suggestions.map((item, index) => (
            <li key={item}>
              <button
                type="button"
                id={`sp-suggest-${index}`}
                role="option"
                aria-selected={index === active}
                className={`sp-suggest-item${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                // 用 mouseDown 而不是 click：click 之前输入框会先失焦，联想可能已经被关掉
                onMouseDown={(event) => {
                  event.preventDefault()
                  accept(index)
                }}
              >
                <Search size={12} aria-hidden />
                <span className="sp-suggest-text">{item}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
