import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  hint?: string
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon: Icon, title, hint }) => (
  <div className="wp-empty empty-state">
    <Icon size={34} strokeWidth={1.3} className="empty-state-icon" />
    <span className="empty-state-title">{title}</span>
    {hint && <span className="empty-state-hint">{hint}</span>}
  </div>
)
