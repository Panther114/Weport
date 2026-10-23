import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, Sparkles } from 'lucide-react'
import { copyTextToClipboard } from '../../utils/clipboard'
import type { ReaderMessage } from './readerTypes'
import {
  prepareReaderDraftContext, readerDraftClones, requireReaderDraftClone,
  READER_DRAFT_MAX_CHARS, READER_DRAFT_MAX_MESSAGES, type ReaderDraftClone,
} from './readerDraftContext'
import './readerReplyDraft.css'

interface Props {
  accountId: string
  sessionId: string
  messages: ReaderMessage[]
  disabled: boolean
}

/** An inline workspace section, never a popup or a second WeClone history writer. */
export function ReaderReplyDraft({ accountId, sessionId, messages, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [clones, setClones] = useState<ReaderDraftClone[]>([])
  const [cloneId, setCloneId] = useState('')
  const [loading, setLoading] = useState(false)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftReady, setDraftReady] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [provider, setProvider] = useState('')
  const alive = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const { context, contextError } = useMemo(() => {
    try { return { context: prepareReaderDraftContext(accountId, sessionId, messages), contextError: '' } }
    catch (cause) { return { context: undefined, contextError: cause instanceof Error ? cause.message : String(cause) } }
  }, [accountId, sessionId, messages])

  const refresh = async () => {
    if (inFlight.current) return
    setLoading(true)
    setConsent(false)
    setCloneId('')
    setDraft('')
    setDraftReady(false)
    setProvider('')
    setNotice('')
    setError('')
    try {
      const result = await window.electronAPI.weclone.list()
      if (!alive.current) return
      if (!result.success) throw new Error(result.error || '无法读取本机分身，请重试。')
      setClones(readerDraftClones(result.clones, accountId))
    } catch (cause) {
      if (alive.current) { setClones([]); setError(cause instanceof Error ? cause.message : String(cause)) }
    } finally { if (alive.current) setLoading(false) }
  }

  const generate = async () => {
    if (!context || disabled || !consent || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setConsent(false)
    setDraft('')
    setDraftReady(false)
    setProvider('')
    setNotice('')
    setError('')
    try {
      // Recheck the explicitly chosen clone immediately before dispatch. Never saveChat.
      const listed = await window.electronAPI.weclone.list()
      if (!alive.current) return
      if (!listed.success) throw new Error(listed.error || '无法复核分身，请重试。')
      requireReaderDraftClone(listed.clones, context.accountId, cloneId)
      const result = await window.electronAPI.weclone.chat(cloneId, context.message, [], {
        accountId: context.accountId, sessionId: context.sessionId,
      })
      if (!alive.current) return
      if (!result.success || !result.reply?.trim()) throw new Error([result.error || '没有生成回复。', result.hint].filter(Boolean).join(' '))
      if (result.meta?.cloneId && result.meta.cloneId !== cloneId) throw new Error('返回的分身与选择不一致，请重试。')
      setDraft(result.reply)
      setDraftReady(true)
      setProvider([result.meta?.providerId, result.meta?.model].filter(Boolean).join(' · '))
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }

  return (
    <section className="reader-reply" aria-label="WeClone 回复草稿">
      <div className="reader-reply-heading">
        <button type="button" className="reader-reply-trigger" aria-expanded={open} onClick={() => {
          if (open) { setOpen(false); setConsent(false) }
          else { setOpen(true); if (!busy) void refresh() }
        }}>
          <Sparkles size={14} /><span>WeClone 回复草稿</span><ChevronDown size={14} className="reader-reply-chevron" data-open={open} />
        </button>
        <span className="reader-hint">先选消息，再预览 · 仅手动复制</span>
      </div>
      {open && <div className="reader-reply-body">
        <p className="reader-hint">仅使用你在「复制范围」中选取的文字，最多 {READER_DRAFT_MAX_MESSAGES} 条、{READER_DRAFT_MAX_CHARS.toLocaleString()} 字符。不会补入相邻消息；生成结果不写入分身对话历史。</p>
        <div className="reader-reply-controls">
          <label>本机分身
            <select className="filter-input" aria-label="选择草稿使用的分身" value={cloneId} disabled={loading || busy} onChange={(event) => {
              setCloneId(event.target.value); setConsent(false); setDraft(''); setDraftReady(false); setProvider(''); setNotice(''); setError('')
            }}>
              <option value="">请明确选择分身</option>
              {clones.map((clone) => <option key={clone.id} value={clone.id}>{clone.displayName || clone.wxid} · {clone.generatedAt}</option>)}
            </select>
          </label>
          <button type="button" className="ghost-btn" disabled={loading || busy} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新分身'}</button>
        </div>
        {!loading && !clones.length && <p className="reader-hint">当前账号没有可用的本机分身，请前往 WeClone 生成后刷新。</p>}
        <div className="reader-hint">账号：{accountId || '未选择'} · 会话：{sessionId} · 已选 {messages.length} 条</div>
        {(disabled || contextError) && <p className="reader-gap-error" role="status">{disabled ? '消息正在重新载入，请完成后重新选择范围。' : contextError}</p>}
        {context && !disabled && <>
          <label className="reader-reply-preview">所选聊天片段预览（完整草稿指令）
            <textarea readOnly value={context.message} rows={5} aria-label="发送片段完整预览" />
          </label>
          <p className="reader-hint">此请求会发往 WeClone 当前配置的模型服务，可能产生费用；服务不可用时可能按既有设置切换备用服务。除上方片段外，既有 WeClone 流程还会发送所选分身的人格档案、相关本地历史检索片段及语气样本；这些材料可能包含其他会话的内容。上方不是全部模型输入。</p>
          <label className="reader-reply-consent"><input type="checkbox" checked={consent} disabled={busy || !cloneId} onChange={(event) => setConsent(event.target.checked)} />我已审阅片段，同意本次使用所选分身及其检索资料调用配置的模型</label>
        </>}
        <button type="button" className="secondary-btn" disabled={busy || loading || disabled || !context || !cloneId || !consent} onClick={() => void generate()}>{busy ? '正在生成草稿…' : '生成一次草稿'}</button>
        {error && <p className="reader-gap-error" role="alert">{error}</p>}
        {draftReady && <div className="reader-reply-output">
          <label>回复草稿 · 请审核后自行使用<textarea aria-label="可编辑的回复草稿" value={draft} onChange={(event) => { setDraft(event.target.value); setNotice('') }} rows={4} /></label>
          {provider && <div className="reader-hint">{provider}</div>}
          <button type="button" className="ghost-btn" disabled={!draft.trim()} onClick={() => { void copyTextToClipboard(draft).then((ok) => { if (alive.current) setNotice(ok ? '草稿已复制，尚未发送。' : '复制失败，请手动选择草稿文字复制。') }) }}><Copy size={13} />复制草稿</button>
        </div>}
        {notice && <p className="reader-hint" role="status">{notice}</p>}
      </div>}
    </section>
  )
}
