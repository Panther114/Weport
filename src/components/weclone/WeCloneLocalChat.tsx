import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, MessageSquareText, Send, X } from 'lucide-react'

interface LocalChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface WeCloneLocalChatProps {
  cloneId: string
  displayName: string
  open: boolean
  onClose: () => void
}

export default function WeCloneLocalChat({ cloneId, displayName, open, onClose }: WeCloneLocalChatProps) {
  const [messages, setMessages] = useState<LocalChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    } else {
      setMessages([])
      setInput('')
      setError('')
      setSending(false)
    }
  }, [open])

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, sending])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setError('')
    const newMessages: LocalChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setSending(true)
    try {
      const result = await window.electronAPI.weclone.chatLocal({
        id: cloneId,
        message: text,
        history: newMessages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      })
      if (result.success && result.reply) {
        setMessages((prev) => [...prev, { role: 'assistant', content: result.reply as string }])
      } else {
        setError(result.error || '本地对话失败')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setSending(false)
    }
  }, [cloneId, input, messages, sending])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleSend()
      }
      if (e.key === 'Escape') onClose()
    },
    [handleSend, onClose]
  )

  if (!open) return null

  return (
    <div className="wp-overlay" onClick={onClose}>
      <div
        className="wp-dialog weclone-local-chat"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`与 ${displayName} 本地对话`}
        style={{ width: 'min(560px, 90vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="wp-dialog-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
          <h3 style={{ margin: 0, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageSquareText size={16} />
            本地对话 · {displayName || cloneId}
          </h3>
          <button className="ghost-btn compact" type="button" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            minHeight: 200,
            maxHeight: '50vh',
          }}
        >
          {messages.length === 0 && (
            <p className="hint" style={{ textAlign: 'center', margin: '24px 0' }}>
              本地模式：使用已配置的 OpenCode Go API Key 直接在本地与分身对话，无需上传到 Railway。
              <br />
              首选 muse-spark-1.2-contributor，模型故障时自动降级到 glm-5 等备选模型。
              <br />
              试试：你好，你是谁？
            </p>
          )}
          {messages.map((m, idx) => (
            <div
              key={idx}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                padding: '8px 12px',
                borderRadius: 10,
                background: m.role === 'user' ? 'var(--accent)' : 'var(--panel)',
                color: m.role === 'user' ? '#000' : 'var(--text)',
                border: m.role === 'assistant' ? '1px solid var(--line)' : 'none',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              {m.content}
            </div>
          ))}
          {sending && (
            <div style={{ alignSelf: 'flex-start', padding: '8px 12px', color: 'var(--text-faint)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={13} className="spin" />
              思考中…
            </div>
          )}
          {error && (
            <p className="weclone-error-line" style={{ margin: 0, color: 'var(--danger, #ff6b6b)' }}>
              {error}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '1px solid var(--line)', alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={2}
            disabled={sending}
            style={{
              flex: 1,
              resize: 'none',
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              color: 'var(--text)',
              padding: '8px 10px',
              fontFamily: 'var(--font)',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <button className="primary-btn" type="button" disabled={sending || !input.trim()} onClick={() => void handleSend()}>
            {sending ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            发送
          </button>
        </div>
        <p className="hint" style={{ margin: '8px 0 0', fontSize: 11 }}>
          本地对话不经过 Railway，直接调用本地 LLM。需已配置 OpenCode Go API Key。
        </p>
      </div>
    </div>
  )
}
