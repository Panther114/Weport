import { Globe, Link2, Lock } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WeCloneVisibility } from '../../types/weclone'

const OPTIONS: Array<{ value: WeCloneVisibility; label: string; icon: LucideIcon; title: string }> = [
  // 标签用中文：整页其它文案都是中文，唯独可见性写成 PRIVATE / PUBLIC / LINK，
  // 用户得先翻译一遍才知道点下去会发生什么 —— 而这正是决定谁能跟这个分身
  // 对话的开关。英文名保留在 title 里，方便对照文档。
  { value: 'private', label: '私密', icon: Lock, title: '私密 (PRIVATE) · 仅自己可见（默认）' },
  { value: 'public', label: '公开', icon: Globe, title: '公开 (PUBLIC) · 任何知道地址的人都可对话' },
  { value: 'link', label: '链接分享', icon: Link2, title: '链接可见 (LINK) · 仅持有分享链接的人可对话' },
]

interface WeCloneVisibilityToggleProps {
  value: WeCloneVisibility
  disabled?: boolean
  onChange: (v: WeCloneVisibility) => void
}

export default function WeCloneVisibilityToggle({ value, disabled, onChange }: WeCloneVisibilityToggleProps) {
  return (
    <div className="chip-group" role="radiogroup" aria-label="克隆可见性">
      {OPTIONS.map(({ value: v, label, icon: Icon, title }) => (
        <button
          className="chip"
          key={v}
          type="button"
          data-active={value === v}
          role="radio"
          aria-checked={value === v}
          disabled={disabled}
          title={title}
          onClick={() => onChange(v)}
        >
          <Icon size={11} strokeWidth={1.9} />
          {label}
        </button>
      ))}
    </div>
  )
}
