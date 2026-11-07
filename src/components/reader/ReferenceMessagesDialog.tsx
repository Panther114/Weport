import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { identityForMessage } from './readerSource'
import { normalizeMessage } from './readerMessage'
import type { EngineMessageLike, ReaderMessage } from './readerTypes'
import './referenceMessages.css'

export default function ReferenceMessagesDialog({ target, onClose, onOpen }: { target: ReaderMessage; onClose: () => void; onOpen: (message: ReaderMessage) => void }) {
  const [messages, setMessages] = useState<ReaderMessage[]>([])
  const [total, setTotal] = useState(0)
  const [ambiguous, setAmbiguous] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [snapshotAt, setSnapshotAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const load = useCallback(async (offset: number, force = false) => {
    const revision = ++request.current
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.chat.getMessageReferences(identityForMessage(target), { offset, limit: 50, force })
      if (revision !== request.current) return
      if (!result.success) throw new Error(result.error || '检索引用失败')
      const rows = (result.messages || []).map((row, index) => normalizeMessage(row as EngineMessageLike, target.sessionId, index))
      setMessages(previous => offset ? [...previous, ...rows] : rows)
      setTotal(result.total || 0)
      setAmbiguous(result.ambiguousCount || 0)
      setHasMore(result.hasMore === true)
      setSnapshotAt(result.snapshotAt || 0)
    } catch (error) { if (revision === request.current) setError(String(error)) }
    finally { if (revision === request.current) setBusy(false) }
  }, [target])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    void load(0)
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, select, textarea, [tabindex="0"]') || [])]
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { request.current++; document.removeEventListener('keydown', keyboard); previous?.focus() }
  }, [load, onClose])
  return createPortal(<div className="reader-reference-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialog} className="reader-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="reader-reference-title">
      <div className="reader-reference-head"><h2 id="reader-reference-title">引用此消息的消息</h2><button ref={closeButton} type="button" className="icon-btn-ghost" onClick={onClose} aria-label="关闭引用列表"><X size={18} /></button></div>
      <blockquote>{target.text || target.quote?.text || '原消息'}</blockquote>
      {snapshotAt ? <p className="hint">共 {total} 条 · 检索于 {new Date(snapshotAt).toLocaleString('zh-CN')}</p> : null}
      {ambiguous ? <p role="status">另有 {ambiguous} 条引用因来源 ID 重复无法精确归属，未列入结果。</p> : null}
      {error ? <p role="alert" className="wp-error">{error}</p> : null}
      <div className="reader-reference-list">
        {messages.map(message => <button key={message.key} type="button" onClick={() => onOpen(message)}><span>{message.senderName || message.senderUsername} · {new Date(message.ts).toLocaleString('zh-CN')}</span><p>{message.text || message.quote?.text || '媒体引用消息'}</p></button>)}
        {!busy && !error && !total ? <p>在当前可读取的会话记录中没有找到引用。</p> : null}
      </div>
      {busy ? <p role="status">正在检索；切换页面后任务仍会继续。</p> : null}
      <div className="reader-reference-actions"><button type="button" className="ghost-btn" disabled={busy} onClick={() => void load(0, true)}>重新检索</button>{hasMore ? <button type="button" className="primary-btn" disabled={busy} onClick={() => void load(messages.length)}>加载更多</button> : null}</div>
    </section>
  </div>, document.body)
}
