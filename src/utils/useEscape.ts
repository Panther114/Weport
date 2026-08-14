import { useEffect } from 'react'

/** 按 Esc 触发回调（对话框统一关闭体验） */
export const useEscape = (onEscape: () => void, enabled = true) => {
  useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onEscape, enabled])
}
