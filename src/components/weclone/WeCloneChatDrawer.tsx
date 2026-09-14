import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Send, Sparkles, X } from 'lucide-react'
import type { WeCloneListItem } from '../../types/weclone'

/**
 * 和分身对话的抽屉。
 *
 * 用户报的「我不知道现在怎么跟我的分身说话」是真实缺口：生成完了、上传完了，
 * 界面里没有任何入口，只能去终端敲 `weport weclone.chat`。这里补上入口 ——
 * 知识库在服务器上，所以每轮就是一次 HTTP 调用，不涉及本地 AI provider。
 *
 * 注意 `clone.id` 与本机档案的关系：本机档案的 id 是目录名，服务器只认
 * `serverId`。选择走哪一条在 service 侧决定（`chatWithClone`），这里不重复判断。
 */
export default function WeCloneChatDrawer({
  clone,
  serverConfigured,
  onClose,
}: {
  clone: WeCloneListItem
  serverConfigured: boolean
  onClose: () => void
}) {
  const api = window.electronAPI
  type Turn = { role: 'user' | 'assistant'; content: string; error?: boolean; hint?: string }
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, sending])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, sending])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    const history = turns
      .filter((t) => !t.error)
      .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content }))
    setTurns((prev) => [...prev, { role: 'user', content: text }])
    setInput('')
    setSending(true)
    setElapsed(null)
    try {
      const res = await api.weclone.chat(clone.id, text, history)
      if (res.success && res.reply) {
        setTurns((prev) => [...prev, { role: 'assistant', content: res.reply as string }])
        setElapsed(typeof res.elapsedMs === 'number' ? res.elapsedMs : null)
      } else {
        // 失败信息原样带出来：最有用的是「连不上 127.0.0.1:8099」这类具体原因，
        // 不是重新包装成「请求失败」。
        setTurns((prev) => [...prev, { role: 'assistant', content: res.error || '对话失败', error: true, hint: res.hint }])
      }
    } catch (e) {
      setTurns((prev) => [...prev, { role: 'assistant', content: String(e), error: true }])
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="modal-backdrop weclone-chat-backdrop" onClick={() => !sending && onClose()}>
      <div
        className="modal weclone-chat"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="weclone-chat-title"
      >
        <div className="weclone-chat-head">
          <div className="weclone-chat-title">
            <Sparkles size={15} />
            <div>
              <h3 id="weclone-chat-title">{clone.displayName || clone.wxid || clone.id}</h3>
              <span className="hint">
                {serverConfigured
                  ? '对话由服务器上的知识库驱动；回答风格来自你的聊天语料。'
                  : '尚未配置服务器，发送会提示如何配置。'}
              </span>
            </div>
          </div>
          <button className="icon-btn-ghost" type="button" aria-label="关闭" disabled={sending} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="weclone-chat-thread" ref={threadRef}>
          {turns.length === 0 && (
            <div className="weclone-chat-empty">
              <p>说点什么试试。它会用你聊天语料里学到的方式回答。</p>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`weclone-turn ${t.role}${t.error ? ' err' : ''}`}>
              <div className="weclone-bubble">{t.content}</div>
              {t.hint && (
                <p className="weclone-turn-hint">
                  <AlertTriangle size={12} /> {t.hint}
                </p>
              )}
            </div>
          ))}
          {sending && (
            <div className="weclone-turn assistant">
              <div className="weclone-bubble pending">
                <Loader2 size={13} className="spin" /> 正在生成…
              </div>
            </div>
          )}
        </div>

        <div className="weclone-chat-composer">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            placeholder="输入消息…（Enter 发送 / Shift+Enter 换行）"
            disabled={sending}
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button className="primary-btn" type="button" disabled={sending || !input.trim()} onClick={() => void send()}>
            {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            发送
          </button>
        </div>
        {elapsed !== null && <div className="weclone-chat-foot">上一轮用时 {(elapsed / 1000).toFixed(1)}s</div>}
      </div>
    </div>
  )
}
