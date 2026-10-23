import '../v13Controls.css'
import { useLayoutEffect, useRef, useState } from 'react'

export type PreparedContext = Awaited<ReturnType<Window['electronAPI']['ai']['previewContext']>>
export default function ContextBoundary({ sessionIds, disabled, onPrepared, localOnly, onLocalOnly }: {
  sessionIds: string[]; disabled: boolean; onPrepared: (context: PreparedContext | null) => void; localOnly: boolean; onLocalOnly: (value: boolean) => void
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preview, setPreview] = useState<PreparedContext | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sessionSignature = [...sessionIds].sort().join('\0')
  const revision = useRef(0)
  const invalidate = () => { revision.current++; setPreview(null); setBusy(false); onPrepared(null) }
  useLayoutEffect(() => { invalidate() }, [sessionSignature])
  useLayoutEffect(() => () => { revision.current++ }, [])
  return <section className="ai-context-boundary v13-controls" aria-label="数据范围与发送预览">
    <h3>数据范围</h3>
    <label className="ai-local-only"><input type="checkbox" checked={localOnly} disabled={disabled} onChange={event => onLocalOnly(event.target.checked)} />仅使用本机模型端点</label>
    <p>默认分析可调用当前账号的聊天工具。选择 @ 会话和日期后，可预览最多 100 条消息、16,000 字的上下文；发送时只使用此预览，并关闭额外工具读取。</p>
    <label>开始日期<input type="date" value={from} disabled={disabled} onChange={event => { setFrom(event.target.value); invalidate() }} /></label>
    <label>结束日期<input type="date" value={to} disabled={disabled} onChange={event => { setTo(event.target.value); invalidate() }} /></label>
    <p>已选择 {sessionIds.length} 个会话。缩小范围或切换范围时，请新建对话，避免复用旧上下文。</p>
    <button type="button" className="secondary-btn" disabled={busy || disabled || !sessionIds.length || !from || !to} onClick={async () => {
      invalidate(); const request = revision.current; setBusy(true); setError('')
      try {
        const accountId = await window.electronAPI.dataAccess.currentAccount()
        if (request !== revision.current) return
        const result = await window.electronAPI.ai.previewContext({ accountId, sessionIds, from: new Date(`${from}T00:00:00`).getTime(), to: new Date(`${to}T23:59:59.999`).getTime() })
        if (request !== revision.current) return
        setPreview(result); onPrepared(result)
      } catch (error) { if (request === revision.current) setError(error instanceof Error ? error.message : String(error)) }
      finally { if (request === revision.current) setBusy(false) }
    }}>预览选中的上下文</button>
    {error ? <p role="alert">{error}</p> : null}
    {preview ? <><p>发送时将附加以下原文与来源链接；不再额外读取聊天。{preview.truncated ? '范围内仍有未读取消息。' : ''}</p><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{preview.text}</pre><button type="button" className="secondary-btn" disabled={disabled} onClick={invalidate}>取消仅预览范围</button></> : null}
  </section>
}
