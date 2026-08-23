import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import type { FormEvent } from 'react'
import { ApiError, chatStream, formatDate, getClone } from '../api/client'
import type { ChatMessage, CloneDetail } from '../api/client'
import NotFound from './NotFound'

const VISIBILITY_LABEL: Record<string, string> = {
  public: '公开',
  link: '链接分享',
  private: '私有',
}

const MD_TITLES: Record<string, string> = {
  profile: '个人画像',
  relationships: '人际关系',
  knowledge: '知识与记忆',
  timeline: '经历时间线',
  language: '语言风格',
}

interface MdsSection {
  key: string
  title: string
  text: string
}

function toSections(mds: Record<string, string>): MdsSection[] {
  return Object.entries(mds)
    .filter(([, text]) => typeof text === 'string' && text.trim().length > 0)
    .map(([key, text]) => {
      const bare = key.replace(/\.md$/, '')
      return { key: bare, title: MD_TITLES[bare] ?? key, text }
    })
}

type Phase = 'loading' | 'need-secret' | 'error' | 'ready'

export default function Chat() {
  const params = useParams()
  const id = params.id ?? ''
  const [searchParams, setSearchParams] = useSearchParams()
  const secret = searchParams.get('secret') ?? ''

  const [detail, setDetail] = useState<CloneDetail | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [loadErr, setLoadErr] = useState('')
  const [secretInput, setSecretInput] = useState('')

  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [sendErr, setSendErr] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // ---- 加载克隆元数据（id / secret 变化时重试）----
  useEffect(() => {
    if (!id) return
    let alive = true
    setPhase('loading')
    setDetail(null)
    setLoadErr('')
    getClone(id, secret || undefined)
      .then((d) => {
        if (!alive) return
        setDetail(d)
        setPhase('ready')
      })
      .catch((err: unknown) => {
        if (!alive) return
        const status = err instanceof ApiError ? err.status : 0
        if (status === 401 || status === 403) {
          // 未授权：link 克隆缺密钥 / 密钥错误 / 私有克隆
          setLoadErr(secret ? '密钥无效，或该克隆不对外开放。' : '')
          setPhase('need-secret')
        } else {
          setLoadErr(err instanceof Error ? err.message : '加载失败，请稍后重试')
          setPhase('error')
        }
      })
    return () => {
      alive = false
    }
  }, [id, secret])

  // ---- 切换克隆 / 密钥时重置会话并中断进行中的流 ----
  useEffect(() => {
    abortRef.current?.abort()
    setMsgs([])
    setSendErr('')
  }, [id, secret])

  // ---- 离开页面时中断流 ----
  useEffect(() => () => abortRef.current?.abort(), [])

  // ---- 新消息自动滚到底 ----
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [msgs, streaming])

  const appendDelta = useCallback((delta: string) => {
    setMsgs((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'assistant') {
        return [...prev.slice(0, -1), { role: 'assistant', content: last.content + delta }]
      }
      return [...prev, { role: 'assistant', content: delta }]
    })
  }, [])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || streaming || phase !== 'ready' || !id) return
    setSendErr('')
    setInput('')
    const history: ChatMessage[] = [...msgs, { role: 'user', content: text }]
    setMsgs(history)
    setStreaming(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await chatStream(id, {
        messages: history,
        secret: secret || undefined,
        signal: controller.signal,
        onDelta: appendDelta,
      })
    } catch (err) {
      // 中止属正常操作（停止按钮 / 离开页面），静默保留已生成内容
      if ((err as Error)?.name !== 'AbortError') {
        setSendErr(err instanceof Error ? err.message : '发送失败，请稍后重试')
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
    }
  }

  const submitSecret = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const next = secretInput.trim()
    if (!next) return
    setSearchParams({ secret: next }, { replace: true })
  }

  if (!id) return <NotFound />

  if (phase === 'loading') {
    return <div className="page-loading muted">加载中…</div>
  }

  if (phase === 'need-secret') {
    return (
      <section className="gate card">
        <h1>需要访问密钥</h1>
        <p className="muted">该克隆通过链接分享。请输入分享密钥继续；私有克隆仅所有者可访问。</p>
        {loadErr && (
          <div className="banner banner-error" role="alert">
            <span>{loadErr}</span>
          </div>
        )}
        <form className="gate-form" onSubmit={submitSecret}>
          <input
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            placeholder="16 位访问密钥"
            autoFocus
            aria-label="访问密钥"
          />
          <button type="submit" className="btn btn-primary" disabled={!secretInput.trim()}>
            解锁
          </button>
        </form>
        <Link className="btn btn-ghost" to="/">返回浏览</Link>
      </section>
    )
  }

  if (phase === 'error') {
    return (
      <section className="gate card">
        <h1>加载失败</h1>
        <p className="muted">{loadErr}</p>
        <Link className="btn btn-primary" to="/">返回浏览</Link>
      </section>
    )
  }

  // ---- ready ----
  const meta = detail?.meta
  const sections = detail ? toSections(detail.mds) : []
  const visLabel = VISIBILITY_LABEL[detail?.visibility ?? ''] ?? '未知'
  const showTyping = streaming && (msgs.length === 0 || msgs[msgs.length - 1].role === 'user')

  return (
    <div className="chat-page">
      <section className="chat-head card">
        <div className="chat-id">
          <span className="avatar avatar-lg">{(meta?.displayName ?? '?').slice(0, 1)}</span>
          <div className="chat-id-text">
            <h1>{meta?.displayName ?? id}</h1>
            <div className="chips">
              <span className={`chip ${detail?.visibility === 'public' ? 'chip-accent' : ''}`}>
                {visLabel}
              </span>
              <span className="chip">知识截止 {formatDate(meta?.knowledgeCutoff)}</span>
              <span className="chip">{(meta?.messageCount ?? 0).toLocaleString()} 条消息</span>
            </div>
          </div>
        </div>
        {sections.length > 0 && (
          <details className="mds-box">
            <summary>
              人格档案 · {sections.length} 个文件
              <span className="muted">（匿名与链接访客仅见部分内容）</span>
            </summary>
            {sections.map((s) => (
              <div className="mds-section" key={s.key}>
                <h4>{s.title}</h4>
                <p>{s.text}</p>
              </div>
            ))}
          </details>
        )}
      </section>

      <section className="chat-scroll card" aria-live="polite">
        {msgs.length === 0 && !streaming && (
          <div className="chat-empty muted">向 TA 发出第一条消息吧 —— TA 会以 TA 的方式回应。</div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}>
            {m.content}
          </div>
        ))}
        {showTyping && (
          <div className="bubble bubble-assistant typing" aria-label="正在输入">
            <span />
            <span />
            <span />
          </div>
        )}
        <div ref={bottomRef} />
      </section>

      {sendErr && (
        <div className="banner banner-error" role="alert">
          <span>{sendErr}</span>
          <button type="button" className="banner-close" onClick={() => setSendErr('')} aria-label="关闭">
            ×
          </button>
        </div>
      )}

      <form
        className="composer card"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          placeholder={streaming ? 'TA 正在回复…' : '输入消息，Enter 发送，Shift+Enter 换行'}
          disabled={streaming}
        />
        {streaming ? (
          <button type="button" className="btn btn-ghost" onClick={() => abortRef.current?.abort()}>
            停止
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
            发送
          </button>
        )}
      </form>
      <p className="muted footnote">内容由 AI 基于脱敏语料生成，可能不准确，请注意甄别。</p>
    </div>
  )
}
