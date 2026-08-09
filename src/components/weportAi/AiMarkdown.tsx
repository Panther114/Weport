import { useMemo } from 'react'
import { marked } from 'marked'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

marked.setOptions({
  gfm: true,
  breaks: true,
})

// 模型输出中的原生 HTML 一律转义为纯文本，避免注入
marked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
  },
})

export default function AiMarkdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    try {
      return marked.parse(text || '')
    } catch {
      return String(text || '')
    }
  }, [text])
  return <div className={`ai-md${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
