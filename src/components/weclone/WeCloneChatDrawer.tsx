import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, MessageSquarePlus, Pencil, Send, Sparkles, Trash2, X } from 'lucide-react'
import type { WeCloneListItem } from '../../types/weclone'
import { splitReplyBubbles } from '../../utils/weCloneBubbles'

/**
 * 和分身对话的抽屉。
 *
 * **全程在本机完成**（v1.0 起）：主进程读出这个人格克隆的五份 MD，在你本机的
 * 语料上做一次 BM25 检索挑出相关片段，连同多轮历史一起交给**你自己配置的模型**。
 * 没有服务器、不上传、也没有联网检索 —— 所以这里的失败原因只有两类：还没生成过
 * 克隆，或者模型 key 不可用。
 *
 * v1.0.1 加了**对话历史**（左侧列表）：可以开新话题、回看以前聊过的、双击改标题、
 * 删掉不要的。历史存在本机 `{userData}/weclone-chats/<cloneId>.json`，一条对话一个
 * 话题，标题默认取第一句话，随时能改。
 */
export default function WeCloneChatDrawer({
  clone,
  onClose,
}: {
  clone: WeCloneListItem
  onClose: () => void
}) {
  const api = window.electronAPI
  type Turn = { role: 'user' | 'assistant'; content: string; at?: number; error?: boolean; hint?: string }
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [lastStats, setLastStats] = useState<string | null>(null)
  const [chats, setChats] = useState<WeCloneChatSummary[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [listReady, setListReady] = useState(false)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const refreshChats = useCallback(
    async (selectId?: string | null) => {
      const res = await api.weclone.listChats(clone.id)
      const list = res.chats || []
      setChats(list)
      return selectId === undefined ? list : list
    },
    [api.weclone, clone.id]
  )

  const openChat = useCallback(
    async (id: string) => {
      const res = await api.weclone.getChat(clone.id, id)
      if (res.success && res.chat) {
        setChatId(res.chat.id)
        setTurns(res.chat.turns.map((t) => ({ ...t })))
        setElapsed(null)
        setLastStats(null)
      }
    },
    [api.weclone, clone.id]
  )

  // 打开抽屉：先列历史，然后接上最近聊过的那一条（没有历史就是一个空的新对话）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await refreshChats()
      if (cancelled) return
      setListReady(true)
      if (list.length > 0) await openChat(list[0].id)
      inputRef.current?.focus()
    })()
    return () => {
      cancelled = true
    }
  }, [openChat, refreshChats])

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, sending])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending) {
        if (renaming) setRenaming(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, sending, renaming])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    const history = turns
      .filter((t) => !t.error)
      .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content }))
    const withUser: Turn[] = [...turns, { role: 'user', content: text, at: Date.now() }]
    setTurns(withUser)
    setInput('')
    setSending(true)
    setElapsed(null)
    try {
      const res = await api.weclone.chat(clone.id, text, history)
      let next: Turn[]
      if (res.success && res.reply) {
        next = [...withUser, { role: 'assistant', content: res.reply as string, at: Date.now() }]
        setTurns(next)
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
            ? [
                m.model,
                // 两路检索分开报：命中 0 段和命中 20 段是完全不同的两件事，
                // 而"语气样本 0 条"恰好解释了"它说话怎么不像我"
                `历史片段 ${m.corpusHits} 段`,
                `语气样本 ${m.voiceSamples ?? 0} 条`,
                // 敏感话题策略也摆在这里：它是**每个克隆自己的设置**，
                // 用户看到"它怎么什么都答"时，这一句就是解释
                m.refusal === 'off' ? '敏感话题：不设限' : '敏感话题：以本人方式带过',
                `用时 ${m.retrieveCostMs}ms`,
              ].join(' · ')
            : null
        )
      } else {
        // 失败信息原样带出来：最有用的是「人格档案不完整」这类具体原因，
        // 不是重新包装成「请求失败」。失败也存进历史 —— 用户回头能看到当时是怎么
        // 失败的，而不是打开一条空对话。
        next = [
          ...withUser,
          { role: 'assistant' as const, content: res.error || '对话失败', at: Date.now(), error: true, hint: res.hint },
        ]
        setTurns(next)
      }
      // 每轮回答后整段落盘（一轮最多几十条消息，整份重写最简单也最不容易坏）
      const saved = await api.weclone.saveChat({
        cloneId: clone.id,
        chatId: chatId || undefined,
        turns: next.map((t) => ({ role: t.role, content: t.content, at: t.at })),
      })
      if (saved.success && saved.chatId) setChatId(saved.chatId)
      await refreshChats()
    } catch (e) {
      setTurns([...withUser, { role: 'assistant', content: String(e), at: Date.now(), error: true }])
    } finally {
      setSending(false)
    }
  }

  async function commitRename() {
    if (!renaming) return
    const value = renaming.value.trim()
    const id = renaming.id
    setRenaming(null)
    if (!value) return
    await api.weclone.renameChat(clone.id, id, value)
    await refreshChats()
  }

  async function removeChat(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      return
    }
    setConfirmDelete(null)
    await api.weclone.deleteChat(clone.id, id)
    const list = await refreshChats()
    if (chatId === id) {
      if (list.length > 0) await openChat(list[0].id)
      else {
        setChatId(null)
        setTurns([])
        setElapsed(null)
        setLastStats(null)
      }
    }
  }

  const fmtTime = (ms: number) => {
    const d = new Date(ms)
    const today = new Date()
    const sameDay = d.toDateString() === today.toDateString()
    return sameDay
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${d.getMonth() + 1}/${d.getDate()}`
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
        {/* 左：对话历史。这是"回看过去 / 改标题 / 删除"的唯一入口 */}
        <aside className="weclone-chat-side" aria-label="对话历史">
          <div className="weclone-chat-side-head">
            <strong>对话</strong>
            <button
              type="button"
              className="ghost-btn weclone-chat-new"
              title="开一个新话题"
              onClick={() => {
                setChatId(null)
                setTurns([])
                setElapsed(null)
                setLastStats(null)
                setRenaming(null)
                inputRef.current?.focus()
              }}
            >
              <MessageSquarePlus size={13} /> 新对话
            </button>
          </div>
          <div className="weclone-chat-list">
            {listReady && chats.length === 0 && <p className="weclone-chat-list-empty">还没有对话记录。</p>}
            {chats.map((c) => {
              const active = c.id === chatId
              return (
                <div key={c.id} className={`weclone-chat-item${active ? ' active' : ''}`}>
                  {renaming?.id === c.id ? (
                    <div className="weclone-chat-rename">
                      <input
                        className="path-input"
                        value={renaming.value}
                        autoFocus
                        maxLength={60}
                        spellCheck={false}
                        onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename()
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => void commitRename()}
                      />
                      <button type="button" className="icon-btn-ghost" aria-label="保存标题" onMouseDown={(e) => e.preventDefault()} onClick={() => void commitRename()}>
                        <Check size={13} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <button type="button" className="weclone-chat-item-main" onClick={() => void openChat(c.id)} title={c.preview || c.title}>
                        <span className="weclone-chat-item-title">{c.title}</span>
                        <span className="weclone-chat-item-meta">
                          {fmtTime(c.updatedAt)} · {c.turnCount} 条
                        </span>
                      </button>
                      <div className="weclone-chat-item-actions">
                        <button
                          type="button"
                          className="icon-btn-ghost"
                          aria-label="重命名"
                          title="重命名"
                          onClick={() => setRenaming({ id: c.id, value: c.title })}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className={`icon-btn-ghost${confirmDelete === c.id ? ' danger-text' : ''}`}
                          aria-label={confirmDelete === c.id ? '再次确认删除' : '删除对话'}
                          title={confirmDelete === c.id ? '再点一次删除' : '删除对话'}
                          onMouseLeave={() => setConfirmDelete((prev) => (prev === c.id ? null : prev))}
                          onClick={() => void removeChat(c.id)}
                        >
                          {confirmDelete === c.id ? <Check size={12} /> : <Trash2 size={12} />}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </aside>

        <div className="weclone-chat-main">
          <div className="weclone-chat-head">
            <div className="weclone-chat-title">
              <Sparkles size={15} />
              <div>
                <h3 id="weclone-chat-title">
                  {clone.displayName || clone.wxid || clone.id}
                  {chatId ? <span className="weclone-chat-topic"> · {chats.find((c) => c.id === chatId)?.title || '对话'}</span> : null}
                </h3>
                <span className="hint">
                  人格档案与语料都在本机；每轮先在本机检索相关历史片段，再取几条你在同一话题上
                  说过的原话作语气参照，一起交给你的模型。会跟着你的语言回答。
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
            {turns.map((t, i) => {
              /**
               * 一条回复 = **多条气泡**（v1.0.1）。
               *
               * 主进程的形态整形把回复按"连发短消息"切成几段、用空行连接；
               * 旧版把整段塞进一个 `.weclone-bubble`（`white-space: pre-wrap`），
               * 于是那些段落显示成一张卡片里的空行 —— 用户报的"多行长诗 + 莫名
               * 两个换行"。切片规则是纯函数（utils/weCloneBubbles），有单测。
               * 空内容（极少数失败轮次）退回原始文本，不能什么都不显示。
               */
              const parts = splitReplyBubbles(t.content)
              const bubbles = parts.length > 0 ? parts : [t.content]
              return (
                <div key={i} className={`weclone-turn ${t.role}${t.error ? ' err' : ''}`}>
                  {bubbles.map((part, index) => (
                    <div className="weclone-bubble" key={index}>
                      {part}
                    </div>
                  ))}
                  {t.hint && (
                    <p className="weclone-turn-hint">
                      <AlertTriangle size={12} /> {t.hint}
                    </p>
                  )}
                </div>
              )
            })}
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
    </div>
  )
}
