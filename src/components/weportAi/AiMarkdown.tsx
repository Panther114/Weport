import { useMemo } from 'react'
import { marked, type Tokens } from 'marked'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

marked.setOptions({
  gfm: true,
  breaks: true,
})

/** 只允许 http(s) / mailto，拦截 javascript:、data:、file:、vbscript: 等危险协议 */
function safeUrl(raw: unknown): string | null {
  const href = String(raw || '').trim()
  if (!href) return null
  if (/^https?:\/\//i.test(href)) return href
  if (/^mailto:/i.test(href)) return href
  if (href.startsWith('//')) return `https:${href}`
  return null
}

// 模型输出中的原生 HTML 一律转义为纯文本；链接/图片 URL 必须过协议白名单
marked.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }: Tokens.Link) {
      const safeHref = safeUrl(href)
      const text = this.parser.parseInline(tokens)
      if (!safeHref) return text
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
    },
    image({ href, title, text }: Tokens.Image) {
      const safeSrc = safeUrl(href)
      if (!safeSrc) return escapeHtml(text)
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      const altAttr = text ? ` alt="${escapeHtml(text)}"` : ''
      return `<img src="${escapeHtml(safeSrc)}"${altAttr}${titleAttr} loading="lazy" />`
    },
  },
})

export default function AiMarkdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    try {
      return marked.parse(text || '')
    } catch {
      return escapeHtml(String(text || ''))
    }
  }, [text])
  return <div className={`ai-md${className ? ` ${className}` : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
