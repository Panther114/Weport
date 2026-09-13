import { Globe, Link2, Lock } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WeCloneVisibility } from '../../types/weclone'

const OPTIONS: Array<{ value: WeCloneVisibility; label: string; icon: LucideIcon; title: string }> = [
  { value: 'private', label: 'PRIVATE', icon: Lock, title: '私密 · 仅自己可见（默认）' },
  { value: 'public', label: 'PUBLIC', icon: Globe, title: '公开 · 任何知道地址的人都可对话' },
  { value: 'link', label: 'LINK', icon: Link2, title: '链接可见 · 仅持有分享链接的人可对话' },
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
