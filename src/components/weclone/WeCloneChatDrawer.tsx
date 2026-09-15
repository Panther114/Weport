import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Send, Sparkles, X } from 'lucide-react'
import type { WeCloneListItem } from '../../types/weclone'

/**
 * 和分身对话的抽屉。
 *
 * **全程在本机完成**（v1.0 起）：主进程读出这个人格克隆的五份 MD，在你本机的
 * 语料上做一次 BM25 检索挑出相关片段，连同多轮历史一起交给**你自己配置的模型**。
 * 没有服务器、不上传、也没有联网检索 —— 所以这里的失败原因只有两类：还没生成过
 * 克隆，或者模型 key 不可用。
 */
export default function WeCloneChatDrawer({
  clone,
  onClose,
}: {
  clone: WeCloneListItem
  onClose: () => void
}) {
  const api = window.electronAPI
  type Turn = { role: 'user' | 'assistant'; content: string; error?: boolean; hint?: string; stats?: string }
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [lastStats, setLastStats] = useState<string | null>(null)
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
        // 把本地检索的命中情况显示出来：这是唯一会悄悄退化的环节，
        // 看不到数字就没法判断"它答得敷衍"是模型问题还是根本没检索到东西。
        //
        // 同时报出**是哪个模型答的**：这一面曾经被强制绑到一个本机连不通的网关上，
        // 用户只能看到一句 "Internal server error"。把服务名摆出来，用户一眼就能
        // 确认它用的正是自己在设置里配的那个（本机是 DeepSeek）。
        const m = res.meta
        setLastStats(
          m
            ? `${m.model} · 本地检索命中 ${m.corpusHits} 段 · 用时 ${m.retrieveCostMs}ms`
            : null
        )
      } else {
        // 失败信息原样带出来：最有用的是「人格档案不完整」这类具体原因，
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
                人格档案与语料都在本机；每轮会先在本机检索相关聊天片段，再交给你的模型。
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
        {elapsed !== null && (
          <div className="weclone-chat-foot">
            上一轮用时 {(elapsed / 1000).toFixed(1)}s
            {lastStats ? ` · ${lastStats}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}
