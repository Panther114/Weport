import { useEffect, useMemo, useRef, useState } from 'react'
import FloatingLayer from '../ui/FloatingLayer'
import './evidencePreview.scss'
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
  if (/^weport-evidence:[a-f0-9]{64}$/.test(href)) return href
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
      if (safeHref.startsWith('weport-evidence:')) return `<a class="ai-evidence-link" href="${safeHref}" aria-label="查看引用的原始消息">${text}</a>`
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
    },
    image({ href, title, text }: Tokens.Image) {
      const safeSrc = safeUrl(href)
      if (!safeSrc || safeSrc.startsWith('weport-evidence:')) return escapeHtml(text)
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      const altAttr = text ? ` alt="${escapeHtml(text)}"` : ''
      return `<img src="${escapeHtml(safeSrc)}"${altAttr}${titleAttr} loading="lazy" />`
    },
  },
})

export default function AiMarkdown({ text, className }: { text: string; className?: string }) {
  type EvidenceResult = Awaited<ReturnType<typeof window.electronAPI.ai.resolveEvidence>>
  const anchor = useRef<HTMLElement | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revision = useRef(0)
  const [preview, setPreview] = useState<{ loading: boolean; result?: EvidenceResult } | null>(null)
  const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null }
  const close = () => { cancelClose(); revision.current++; anchor.current = null; setPreview(null) }
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(close, 180) }
  useEffect(() => {
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current); revision.current++ }
  }, [])
  useEffect(() => { close() }, [text])
  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [!!preview])
  async function showSource(target: EventTarget | null) {
    const link = target instanceof Element ? target.closest<HTMLElement>('a.ai-evidence-link') : null
    if (!link) return
    cancelClose()
    if (anchor.current === link) return
    anchor.current = link
    const request = ++revision.current
    setPreview({ loading: true })
    try {
      const result = await window.electronAPI.ai.resolveEvidence((link.getAttribute('href') || '').slice('weport-evidence:'.length))
      if (revision.current === request) setPreview({ loading: false, result })
    } catch {
      if (revision.current === request) setPreview({ loading: false, result: { success: false, error: '无法读取引用消息，请重试。' } })
    }
  }
  function openSource() {
    if (preview?.result?.success && preview.result.reference) {
      window.dispatchEvent(new CustomEvent('weport:verified-evidence', { detail: preview.result.reference }))
      close()
    }
  }
  const html = useMemo(() => {
    try {
      return marked.parse(text || '')
    } catch {
      return escapeHtml(String(text || ''))
    }
  }, [text])
  // Keep the prop identity stable: replacing innerHTML during hover would
  // detach the anchor that FloatingLayer is measuring.
  const markup = useMemo(() => ({ __html: html }), [html])
  return <>
    <div className={`ai-md${className ? ` ${className}` : ''}`}
      onPointerOver={event => void showSource(event.target)}
      onPointerOut={event => {
        const link = event.target instanceof Element ? event.target.closest('a.ai-evidence-link') : null
        if (link && !(event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) scheduleClose()
      }}
      onFocus={event => void showSource(event.target)} onBlur={scheduleClose}
      onClick={event => {
        const link = event.target instanceof Element ? event.target.closest('a.ai-evidence-link') : null
        if (!link) return
        event.preventDefault()
        if (anchor.current === link && preview?.result?.success) openSource()
        else void showSource(link)
      }} dangerouslySetInnerHTML={markup} />
    <FloatingLayer key={anchor.current?.getAttribute('href') || ''} anchor={anchor} open={!!preview} width={380} className="ai-evidence-layer" role="dialog" aria-label="引用的原始消息">
      <div className="ai-evidence-preview" onPointerEnter={cancelClose} onPointerLeave={scheduleClose}
        onFocus={cancelClose} onBlur={scheduleClose}>
        {preview?.loading ? <p role="status">正在读取原始消息…</p> : preview?.result?.success && preview.result.message ? <>
          <div className="ai-evidence-meta"><strong>{preview.result.message.sender}</strong>
            <time>{new Date(preview.result.message.createTime * 1000).toLocaleString('zh-CN')}</time></div>
          <div className="ai-evidence-content">{preview.result.message.content || '（此消息没有文本内容）'}</div>
          <button type="button" onClick={openSource}>在聊天记录中打开</button>
        </> : <p role="status">{preview?.result?.error || '原始消息不可用。'}</p>}
      </div>
    </FloatingLayer>
  </>
}
