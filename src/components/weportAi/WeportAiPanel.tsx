import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles,
  Plus,
  Settings2,
  Trash2,
  MessageSquareText,
  FileText,
  Brain,
  Send,
  Square,
  Users,
  BookOpen,
  User as UserIcon,
  Info,
  FilePenLine,
  FolderOpen,
  KeyRound,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Zap,
  Eye,
  Pencil,
  RefreshCw,
  Bug,
  CheckCircle2,
  XCircle,
  MemoryStick,
} from 'lucide-react'
import AiMarkdown from './AiMarkdown'

type AiChatMeta = { id: string; title: string; createdAt: number; updatedAt: number }
type AiToolCall = { id: string; name: string; args: Record<string, unknown>; friendly: string; ok: boolean; result?: string }
type AiMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  toolCalls?: AiToolCall[]
  createdAt: number
}
type AiEvent =
  | { type: 'status'; chatId: string; running: boolean }
  | { type: 'reasoning_delta'; chatId: string; delta: string }
  | { type: 'text_delta'; chatId: string; delta: string }
  | { type: 'tool_start'; chatId: string; callId: string; name: string; args: Record<string, unknown>; friendly: string }
  | { type: 'tool_result'; chatId: string; callId: string; name: string; ok: boolean; summary: string; detail?: string }
  | { type: 'assistant_message'; chatId: string; message: AiMessage }
  | { type: 'chat_title'; chatId: string; title: string }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'done'; chatId: string; usage?: { promptTokens: number; completionTokens: number; reasoningTokens: number; totalTokens: number; promptCacheHitTokens?: number }; aborted?: boolean; context?: { promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number } }
  | { type: 'context'; chatId: string; promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number }

type SetupInfo = {
  hasApiKey: boolean
  baseUrl: string
  model: string
  maxTokens: number
  reasoningEffort: string
  maxSteps: number
  customPrompt: string
  workspaceRoot: string
  exportPath: string
  dbReady: boolean
  disabledTools: string[]
  maxToolChars: number
  conversationLimit: number
}

type AiAction = { id: string; name: string; prompt: string }
type AiNote = { path: string; bytes: number; mtime: number; scope: 'memory' | 'notes' }

type LiveTool = { id: string; name: string; friendly: string; ok?: boolean; summary?: string; running: boolean }
type LiveState = { reasoning: string; text: string; tools: LiveTool[] }

const TOOL_ICON: Record<string, React.ComponentType<{ size?: number | string; strokeWidth?: number | string }>> = {
  list_sessions: Users,
  get_social_overview: Users,
  get_relationship_candidates: Users,
  sample_session_history: BookOpen,
  review_prior_analyses: MemoryStick,
  get_group_members: Users,
  read_session_messages: BookOpen,
  read_day_events: BookOpen,
  read_period_events: BookOpen,
  search_messages: BookOpen,
  get_session_stats: Info,
  list_dates: BookOpen,
  get_contact_info: UserIcon,
  get_self_overview: Info,
  list_notes: FileText,
  read_note: FileText,
  write_note: FilePenLine,
}

const TOOL_LABELS: Array<[string, string]> = [
  ['list_sessions', '会话列表'],
  ['get_social_overview', '社交活动概览'],
  ['get_relationship_candidates', '关系候选多维筛选'],
  ['sample_session_history', '早中近期分层抽样'],
  ['review_prior_analyses', '回顾既往分析'],
  ['get_group_members', '群成员名单'],
  ['read_session_messages', '读取会话消息'],
  ['read_day_events', '单日跨会话时间线'],
  ['read_period_events', '区间跨会话时间线'],
  ['search_messages', '全文搜索'],
  ['get_session_stats', '会话统计'],
  ['list_dates', '活跃日历'],
  ['get_contact_info', '联系人资料'],
  ['get_self_overview', '分析范围概览'],
  ['list_notes', '记忆/笔记列表'],
  ['read_note', '读取记忆/笔记'],
  ['write_note', '写入记忆/笔记'],
]

function fmtTime(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 把大数字格式化为 1.0M / 64K / 1024 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

// deepseek-v4-flash 官方价格（USD / 1M tokens，2026-08 官网定价）
const DEEPSEEK_PRICES = {
  inputCacheHit: 0.0028,
  inputCacheMiss: 0.14,
  output: 0.28,
}

function estimateCost(promptTokens: number, cacheHitTokens: number, completionTokens: number): number {
  const miss = Math.max(0, promptTokens - cacheHitTokens)
  return (
    (miss * DEEPSEEK_PRICES.inputCacheMiss +
      cacheHitTokens * DEEPSEEK_PRICES.inputCacheHit +
      completionTokens * DEEPSEEK_PRICES.output) /
    1_000_000
  )
}

/** 把一整段思考过程按句边界拆成 n 段，与 n 个工具调用交错展示 */
function splitReasoning(reasoning: string, n: number): string[] {
  if (!reasoning) return []
  if (n <= 1) return [reasoning]
  const sentences = reasoning.split(/(?<=[。！？!?.])\s+/).filter((s) => s.trim().length > 0)
  if (sentences.length === 0) return [reasoning]
  if (sentences.length <= n) {
    const chunks: string[] = Array(n).fill('')
    sentences.forEach((s, i) => {
      chunks[i % n] += (chunks[i % n] ? ' ' : '') + s
    })
    return chunks
  }
  const per = Math.ceil(sentences.length / n)
  const chunks: string[] = []
  for (let i = 0; i < n; i += 1) {
    chunks.push(sentences.slice(i * per, (i + 1) * per).join(' '))
  }
  return chunks
}

function ToolChip({ call, live }: { call: AiToolCall; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[call.name] || Info
  const hasResult = typeof call.result === 'string' && call.result.length > 0
  const isMemoryWrite =
    call.name === 'write_note' &&
    (String(call.args?.path || '').startsWith('memory/') || call.friendly.includes('memory/'))
  return (
    <div className={`ai-tool-card${call.ok ? ' ok' : call.ok === false ? ' err' : ''}${live ? ' live' : ''}${isMemoryWrite ? ' memory-write' : ''}`}>
      <button
        type="button"
        className={`ai-tool-row${open ? ' open' : ''}`}
        onClick={() => hasResult && setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown size={12} className={`ai-tool-chev${open ? ' open' : ''}`} />
        <span className="ai-tool-icon">
          <Icon size={13} strokeWidth={1.8} />
        </span>
        <span className="ai-tool-friendly">{call.friendly}</span>
        {isMemoryWrite && <span className="ai-memory-write-badge">长期记忆已修改</span>}
        <span className="ai-tool-status">
          {call.ok === true ? <CheckCircle2 size={13} /> : call.ok === false ? <XCircle size={13} /> : live ? <span className="ai-spinner" /> : null}
        </span>
      </button>
      {open && hasResult && (
        <div className="ai-tool-detail">
          <pre>{call.result}</pre>
        </div>
      )}
    </div>
  )
}

export default function WeportAiPanel() {
  const api = window.electronAPI
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [chats, setChats] = useState<AiChatMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<LiveState | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [usage, setUsage] = useState<{
    totalTokens: number
    promptTokens: number
    completionTokens: number
    reasoningTokens: number
    cacheHitTokens: number
  } | null>(null)
  const [ctxStats, setCtxStats] = useState<{ promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number } | null>(null)
  const [notes, setNotes] = useState<AiNote[]>([])
  const [notesDirty, setNotesDirty] = useState(false)
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [memoryDir, setMemoryDir] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actions, setActions] = useState<AiAction[]>([])
  const [actionsOpen, setActionsOpen] = useState(false)
  const [wsCollapsed, setWsCollapsed] = useState(false)
  const [viewingNote, setViewingNote] = useState<{ note: AiNote; content: string } | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugLines, setDebugLines] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const stickToBottom = useRef(true)
  const actionsRef = useRef<HTMLDivElement | null>(null)

  const refreshChats = useCallback(async () => {
    try {
      const res = await api.ai.listChats()
      setChats(res.chats || [])
      return res.chats || []
    } catch {
      return []
    }
  }, [api])

  const refreshActions = useCallback(async () => {
    try {
      const res = await api.ai.listActions()
      setActions(res.actions || [])
    } catch {
      setActions([])
    }
  }, [api])

  const openChat = useCallback(
    async (id: string) => {
      // 切换前自动清理：空的「新对话」没有保留价值，直接删除
      if (activeId && activeId !== id && messages.length === 0) {
        const prev = activeId
        setActiveId(null)
        void api.ai.deleteChat(prev).then(() => void refreshChats())
      }
      setActiveId(id)
      setMessages([])
      setLive(null)
      setError('')
      setUsage(null)
      setNotes([])
      try {
        const data = await api.ai.getChat(id)
        if (data) {
          setMessages(data.messages || [])
          setWorkspaceDir(data.workspaceDir)
          setMemoryDir(data.memoryDir)
          // 缓存命中率/用量是「该会话专属」的：切换会话后显示各自上次运行的数据
          const last = data.lastRun as
            | {
                usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number; reasoningTokens?: number; promptCacheHitTokens?: number }
                context?: { promptTokens?: number; cacheHitTokens?: number; lastRequestTokens?: number; recentRate?: number; contextWindow?: number }
              }
            | undefined
          if (last?.context) {
            setCtxStats({
              promptTokens: last.context.promptTokens || 0,
              cacheHitTokens: last.context.cacheHitTokens || 0,
              lastRequestTokens: last.context.lastRequestTokens || 0,
              recentRate: last.context.recentRate || 0,
              contextWindow: last.context.contextWindow || 1000000,
            })
          } else {
            setCtxStats(null)
          }
          setUsage(
            last?.usage
              ? {
                  totalTokens: last.usage.totalTokens || 0,
                  promptTokens: last.usage.promptTokens || 0,
                  completionTokens: last.usage.completionTokens || 0,
                  reasoningTokens: last.usage.reasoningTokens || 0,
                  cacheHitTokens: last.usage.promptCacheHitTokens || 0,
                }
              : null,
          )
        }
        const n = await api.ai.listNotes(id)
        setNotes(n.notes || [])
      } catch { /* noop */ }
    },
    [api, activeId, messages.length, refreshChats],
  )

  const ensureChat = useCallback(async () => {
    const list = await refreshChats()
    if (list.length === 0) {
      const created = await api.ai.createChat()
      await refreshChats()
      await openChat(created.chat.id)
    } else if (!activeId) {
      await openChat(list[0].id)
    }
  }, [refreshChats, openChat, activeId, api])

  useEffect(() => {
    void api.ai.getSetup().then(setSetup).catch(() => undefined)
    void ensureChat()
    void refreshActions()

    const onDocClick = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) setActionsOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)

    const unsub = api.ai.onEvent((e: AiEvent) => {
      if (e.chatId !== activeId && activeId) return
      switch (e.type) {
        case 'status':
          setRunning(e.running)
          break
        case 'context':
          setCtxStats({ promptTokens: e.promptTokens, cacheHitTokens: e.cacheHitTokens, lastRequestTokens: e.lastRequestTokens, recentRate: e.recentRate, contextWindow: e.contextWindow })
          break
        case 'reasoning_delta':
          setLive((prev) => ({ reasoning: (prev?.reasoning || '') + e.delta, text: prev?.text || '', tools: prev?.tools || [] }))
          break
        case 'text_delta':
          setLive((prev) => ({ reasoning: prev?.reasoning || '', text: (prev?.text || '') + e.delta, tools: prev?.tools || [] }))
          break
        case 'tool_start':
          setLive((prev) => ({
            reasoning: prev?.reasoning || '',
            text: prev?.text || '',
            tools: [
              ...(prev?.tools || []).filter((t) => t.id !== e.callId),
              { id: e.callId, name: e.name, friendly: e.friendly, running: true },
            ],
          }))
          break
        case 'tool_result':
          setLive((prev) => ({
            reasoning: prev?.reasoning || '',
            text: prev?.text || '',
            tools: (prev?.tools || []).map((t) =>
              t.id === e.callId ? { ...t, ok: e.ok, summary: e.summary, running: false } : t,
            ),
          }))
          if (e.name === 'write_note' || e.name === 'list_notes') setNotesDirty(true)
          break
        case 'assistant_message': {
          setLive(null)
          const msg = e as unknown as { message: AiMessage }
          setMessages((prev) => [...prev, msg.message])
          break
        }
        case 'chat_title':
          void refreshChats()
          break
        case 'error':
          if (e.message) {
            setError(e.message)
            setLive(null)
          }
          break
        case 'done': {
          setUsage(
            e.usage
              ? {
                  totalTokens: e.usage.totalTokens,
                  promptTokens: e.usage.promptTokens,
                  completionTokens: e.usage.completionTokens,
                  reasoningTokens: e.usage.reasoningTokens,
                  cacheHitTokens: (e.usage as { promptCacheHitTokens?: number }).promptCacheHitTokens || 0,
                }
              : null,
          )
          if (e.context) setCtxStats(e.context)
          setLive(null)
          void refreshChats()
          void (async () => {
            if (activeId) {
              try {
                const data = await api.ai.getChat(activeId)
                if (data) setMessages(data.messages || [])
              } catch { /* noop */ }
            }
          })()
          if (notesDirty) {
            setNotesDirty(false)
            if (activeId) {
              void api.ai.listNotes(activeId).then((n) => setNotes(n.notes || [])).catch(() => undefined)
            }
          }
          break
        }
      }
    })
    return () => {
      unsub()
      document.removeEventListener('mousedown', onDocClick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    if (notesDirty && activeId) {
      setNotesDirty(false)
      void api.ai.listNotes(activeId).then((n) => setNotes(n.notes || [])).catch(() => undefined)
    }
  }, [notesDirty, activeId, api])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, live])

  const handleThreadScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  useEffect(() => {
    if (running) inputRef.current?.focus()
  }, [running])

  const resizeInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(38, Math.min(el.scrollHeight, 160))}px`
  }, [])

  // 任何输入变化（键盘输入到第二行自动换行 / 粘贴 / 快捷动作填入）都同步扩展输入框高度
  useEffect(() => {
    resizeInput()
  }, [input, resizeInput])

  function handleInputChange(value: string) {
    setInput(value)
  }

  function resetInputHeight() {
    const el = inputRef.current
    if (el) el.style.height = 'auto'
  }

  async function handleSend(textOverride?: string) {
    const text = (textOverride ?? input).trim()
    if (!text || !activeId || running) return
    setInput('')
    resetInputHeight()
    stickToBottom.current = true
    setError('')
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content: text, createdAt: Date.now() }])
    setLive({ reasoning: '', text: '', tools: [] })
    try {
      const res = await api.ai.send(activeId, text)
      if (!res.success && res.error && !running) {
        setError(res.error)
        setLive(null)
        const data = await api.ai.getChat(activeId)
        if (data) setMessages(data.messages || [])
      }
    } catch (e) {
      setError(String(e))
      setLive(null)
    }
  }

  async function handleNewChat() {
    // 当前已是空的「新对话」→ 复用，不再重复创建
    if (activeId && messages.length === 0) {
      setLive(null)
      setError('')
      inputRef.current?.focus()
      return
    }
    const created = await api.ai.createChat()
    await refreshChats()
    await openChat(created.chat.id)
  }

  async function handleDelete(chatId: string) {
    setDeleteConfirmId(chatId)
  }

  async function confirmDelete() {
    if (!deleteConfirmId) return
    const chatId = deleteConfirmId
    setDeleteConfirmId(null)
    await api.ai.deleteChat(chatId)
    const list = await refreshChats()
    if (chatId === activeId) {
      setActiveId(null)
      if (list.length > 0) await openChat(list[0].id)
      else await handleNewChat()
    }
  }

  function handleStop() {
    if (activeId) void api.ai.abort(activeId)
  }

  /** 拖拽排序：把被拖会话移动到目标会话之前，并持久化 */
  function handleDrop(dragChatId: string, targetChatId: string) {
    if (!dragChatId || dragChatId === targetChatId) return
    setChats((prev) => {
      const from = prev.findIndex((c) => c.id === dragChatId)
      const to = prev.findIndex((c) => c.id === targetChatId)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      void api.ai.reorderChats(next.map((c) => c.id)).catch(() => undefined)
      return next
    })
    setDragId(null)
  }

  function startRename(c: AiChatMeta) {
    setEditingId(c.id)
    setEditDraft(c.title)
  }

  async function saveRename() {
    const id = editingId
    setEditingId(null)
    if (id) {
      const title = editDraft.trim()
      if (title) await api.ai.renameChat(id, title)
    }
    await refreshChats()
  }

  const chat = useMemo(() => chats.find((c) => c.id === activeId) || null, [chats, activeId])
  const showEmptyHint = messages.length === 0 && !live

  const memoryNotes = notes.filter((n) => n.scope === 'memory')
  const chatNotes = notes.filter((n) => n.scope === 'notes')

  async function refreshNotesList() {
    if (!activeId) return
    try {
      const n = await api.ai.listNotes(activeId)
      setNotes(n.notes || [])
    } catch { /* noop */ }
  }

  async function viewNote(note: AiNote) {
    if (!activeId) return
    try {
      const res = await api.ai.readNoteFile(activeId, note.path)
      setViewingNote({ note, content: res.content ?? '（读取失败或文件不存在）' })
    } catch {
      setViewingNote({ note, content: '（读取失败）' })
    }
  }

  async function deleteNote(note: AiNote) {
    if (!activeId) return
    await api.ai.deleteNoteFile(activeId, note.path)
    await refreshNotesList()
  }

  function openMemoryFolder() {
    if (memoryDir) void api.shell.openPath(memoryDir)
  }

  return (
    <div className={`ai-shell${wsCollapsed ? ' ws-hidden' : ''}`}>
      {/* 左栏：对话列表 */}
      <aside className="ai-side">
        <button className="ai-new-chat" type="button" onClick={() => void handleNewChat()}>
          <Plus size={14} />
          新建对话
        </button>
        <div className="ai-chat-list" role="list" aria-label="WeportAI 对话">
          {chats.map((c) => (
            <div
              key={c.id}
              className={`ai-chat-item${c.id === activeId ? ' active' : ''}${dragId === c.id ? ' dragging' : ''}`}
              data-active={c.id === activeId}
              role="listitem"
              draggable={editingId !== c.id}
              onDragStart={(e) => {
                setDragId(c.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId) handleDrop(dragId, c.id)
              }}
              onDragEnd={() => setDragId(null)}
            >
              {editingId === c.id ? (
                <input
                  className="ai-chat-rename"
                  value={editDraft}
                  autoFocus
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={() => void saveRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void saveRename()
                    } else if (e.key === 'Escape') {
                      setEditingId(null)
                    }
                  }}
                  spellCheck={false}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="ai-chat-main"
                    onClick={() => void openChat(c.id)}
                    title={c.title}
                  >
                    <MessageSquareText size={13} strokeWidth={1.8} />
                    <span>{c.title}</span>
                  </button>
                  <button
                    type="button"
                    className="ai-chat-del"
                    title="重命名对话"
                    onClick={() => startRename(c)}
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    type="button"
                    className="ai-chat-del"
                    title="删除对话"
                    onClick={() => void handleDelete(c.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="ai-side-foot">
          <span className="ai-model-tag">
            <Sparkles size={11} />
            {setup?.model || '…'}
          </span>
          <div className="ai-side-foot-row">
            <button
              type="button"
              className="ai-settings-btn"
              onClick={() => {
                setDebugOpen(true)
                void api.ai.getDebugLog(400).then((r) => setDebugLines(r.lines || [])).catch(() => undefined)
              }}
              title="调试日志（查看最近一次任务与 API 请求记录）"
            >
              <Bug size={14} />
              调试日志
            </button>
            <button type="button" className="ai-settings-btn" onClick={() => setSettingsOpen(true)} title="WeportAI 设置">
              <Settings2 size={14} />
              设置
            </button>
          </div>
        </div>
      </aside>

      {/* 中栏：对话 */}
      <main className="ai-main">
        {!setup?.hasApiKey && (
          <div className="ai-warn-banner warn">
            未配置 API 密钥 — 打开左下角「设置」填入你的 DeepSeek API Key 后才能使用。
          </div>
        )}

        <div className="ai-thread" ref={scrollRef} onScroll={handleThreadScroll}>
          {showEmptyHint && (
            <div className="ai-empty">
              <div className="ai-empty-mark">
                <Sparkles size={22} strokeWidth={1.6} />
              </div>
              <h2>WeportAI · 聊天历史分析助手</h2>
              <p>
                基于 DeepSeek V4 Flash 的本地聊天记录分析环境。它能跨会话查看某一天的完整时间线、搜索任意关键词、统计互动，
                并把发现持续写入导出目录下的 <code>WeportAI/memory/</code> 长期记忆。
              </p>
              <div className="ai-empty-tips">
                <div><strong>试试这样问：</strong></div>
                <ul>
                  <li>「分析我是什么人」— 全量扫描所有会话与时间窗，输出人格画像</li>
                  <li>「8月8日发生了什么」— 跨会话重建当天完整时间线</li>
                  <li>「我和小明的聊天关系怎么样」— 互动模式与关系状态分析</li>
                  <li>「把发现写入 memory/events.md」</li>
                </ul>
              </div>
            </div>
          )}

          {messages.map((m) =>
            m.role === 'tool' ? null : m.role === 'user' ? (
              <div key={m.id} className="ai-msg user">
                <div className="ai-msg-bubble">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="ai-msg assistant">
                {m.toolCalls && m.toolCalls.length > 0 ? (
                  /* 工具轮次：思考片段与工具调用交错展示 */
                  <div className="ai-step-stack">
                    {m.toolCalls.map((c, i) => {
                      const chunks = splitReasoning(m.reasoning || '', m.toolCalls?.length || 0)
                      const chunk = chunks[i]
                      return (
                        <div key={c.id} className="ai-step">
                          {chunk && (
                            <details className="ai-reasoning inline">
                              <summary>
                                <Brain size={12} />
                                思考
                              </summary>
                              <pre>{chunk}</pre>
                            </details>
                          )}
                          <ToolChip call={c} />
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <>
                    {m.reasoning && (
                      <details className="ai-reasoning">
                        <summary>
                          <Brain size={12} />
                          思考过程
                        </summary>
                        <pre>{m.reasoning}</pre>
                      </details>
                    )}
                    {m.content ? <AiMarkdown text={m.content} /> : null}
                  </>
                )}
              </div>
            ),
          )}

          {live && (
            <div className="ai-msg assistant live">
              {live.tools.length > 0 && (
                <div className="ai-tool-stack">
                  {live.tools.map((t) => (
                    <ToolChip key={t.id} call={{ id: t.id, name: t.name, args: {}, friendly: t.friendly, ok: t.ok ?? false }} live />
                  ))}
                </div>
              )}
              {live.reasoning && (
                <details className="ai-reasoning" open={!live.text && live.tools.length === 0}>
                  <summary>
                    <Brain size={12} />
                    思考中…
                  </summary>
                  <pre>{live.reasoning}</pre>
                </details>
              )}
              {live.text ? (
                <div className="ai-live-text">
                  <AiMarkdown text={live.text} />
                  <span className="ai-caret" />
                </div>
              ) : (
                <div className="ai-thinking">
                  <span className="ai-spinner" />
                  <span className="ai-thinking-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  正在思考
                  {live.tools.length > 0 ? <span className="ai-thinking-hint">（正在分析上一步结果…）</span> : <span>…</span>}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="ai-msg err">
              <div className="ai-error-bubble">{error}</div>
            </div>
          )}
        </div>

        <div className="ai-composer">
          <div className="ai-actions-wrap" ref={actionsRef}>
            <button
              type="button"
              className="ai-actions-btn"
              title="快捷动作"
              disabled={running || busy}
              onClick={() => setActionsOpen((v) => !v)}
            >
              <Zap size={14} />
            </button>
            {actionsOpen && (
              <div className="ai-actions-menu">
                <div className="ai-actions-head">快捷动作（在设置中管理）</div>
                {actions.length === 0 ? (
                  <div className="ai-actions-empty">还没有动作 — 在设置里添加</div>
                ) : (
                  actions.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="ai-action-item"
                      onClick={() => {
                        setInput(a.prompt)
                        setActionsOpen(false)
                        inputRef.current?.focus()
                      }}
                    >
                      <strong>{a.name}</strong>
                      <span>{a.prompt.slice(0, 60)}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <textarea
            ref={inputRef}
            className="ai-input"
            value={input}
            placeholder={running ? '正在执行…' : '分析你的聊天记录…（Enter 发送，Shift+Enter 换行）'}
            rows={1}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleSend()
              } else if (e.key === 'Enter' && e.shiftKey) {
                // Shift+Enter：插入换行，输入框自动向上扩展
                window.requestAnimationFrame(() => handleInputChange(e.currentTarget.value))
              }
            }}
            spellCheck={false}
          />
          <button
            className="ai-send"
            type="button"
            disabled={running || !input.trim() || busy}
            onClick={() => void handleSend()}
            title="发送"
          >
            <Send size={15} />
          </button>
          {running && (
            <button className="ai-send stop" type="button" onClick={handleStop} title="停止">
              <Square size={13} />
            </button>
          )}
        </div>
      </main>

      {/* 右栏折叠把手：贴在中栏与右栏的边界上，不占独立列 */}
      <button
        type="button"
        className="ai-ws-toggle"
        title={wsCollapsed ? '展开记忆面板' : '收起记忆面板'}
        onClick={() => setWsCollapsed((v) => !v)}
      >
        <ChevronRight size={15} />
      </button>

      {/* 右栏：记忆与笔记 */}
      <aside className={`ai-workspace${wsCollapsed ? ' collapsed' : ''}`}>
        <div className="ai-ws-body">
          <div className="ai-ws-head">
            <span>记忆 · 笔记</span>
            <div className="ai-ws-head-actions">
              <button type="button" className="ai-ws-refresh" title="刷新文件列表" onClick={() => void refreshNotesList()}>
                <RefreshCw size={12} />
              </button>
              <button type="button" className="ai-ws-refresh" title="打开记忆文件夹" onClick={openMemoryFolder}>
                <FolderOpen size={12} />
              </button>
            </div>
          </div>
          <div className="ai-ws-path" title={workspaceDir}>
            {workspaceDir || '—'}
          </div>
          <div className="ai-ws-list">
            {notes.length === 0 ? (
              <div className="ai-ws-empty">
                还没有记忆文件。让 AI「把发现写入 memory/xxx.md」，文件会出现在这里；
                memory/ 为跨对话共享的长期记忆，notes/ 为当前对话草稿。
              </div>
            ) : (
              <>
                {memoryNotes.length > 0 && (
                  <>
                    <div className="ai-ws-group">
                      <MemoryStick size={11} />
                      记忆 memory/
                    </div>
                    {memoryNotes.map((n) => (
                      <div className="ai-ws-note" key={n.path}>
                        <button type="button" className="ai-ws-note-main" title="查看内容" onClick={() => void viewNote(n)}>
                          <FileText size={12} strokeWidth={1.8} />
                          <div>
                            <strong>{n.path.replace(/^memory\//, '')}</strong>
                            <span>
                              {n.bytes} B · {fmtTime(n.mtime)}
                            </span>
                          </div>
                        </button>
                        <button type="button" className="ai-ws-note-del" title="删除此文件" onClick={() => void deleteNote(n)}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {chatNotes.length > 0 && (
                  <>
                    <div className="ai-ws-group">
                      <FileText size={11} />
                      笔记 notes/
                    </div>
                    {chatNotes.map((n) => (
                      <div className="ai-ws-note" key={n.path}>
                        <button type="button" className="ai-ws-note-main" title="查看内容" onClick={() => void viewNote(n)}>
                          <FileText size={12} strokeWidth={1.8} />
                          <div>
                            <strong>{n.path.replace(/^notes\//, '')}</strong>
                            <span>
                              {n.bytes} B · {fmtTime(n.mtime)}
                            </span>
                          </div>
                        </button>
                        <button type="button" className="ai-ws-note-del" title="删除此文件" onClick={() => void deleteNote(n)}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
          <div className="ai-ws-usage">
            <span>上下文窗口 · 缓存命中 · 费用估算</span>
            <div className="ai-bar-row">
              <div className="ai-bar-label">
                <span>上下文（最近一次请求）</span>
                <em>
                  {ctxStats ? `${Math.round((ctxStats.lastRequestTokens / Math.max(1, ctxStats.contextWindow)) * 100)}%` : '—'}
                </em>
              </div>
              <div className="ai-bar">
                <div
                  className="ai-bar-fill ctx"
                  style={{
                    width: ctxStats
                      ? `${Math.min(100, (ctxStats.lastRequestTokens / Math.max(1, ctxStats.contextWindow)) * 100)}%`
                      : '0%',
                  }}
                />
              </div>
              <span className="ai-bar-sub">
                {ctxStats
                  ? `${ctxStats.lastRequestTokens.toLocaleString()} / ${fmtTokens(ctxStats.contextWindow)}`
                  : '—'}
              </span>
            </div>
            <div className="ai-bar-row">
              <div className="ai-bar-label">
                <span>缓存命中（本次累计）</span>
                <em>
                  {ctxStats ? `${Math.round((ctxStats.cacheHitTokens / Math.max(1, ctxStats.promptTokens)) * 100)}%` : '—'}
                </em>
              </div>
              <div className="ai-bar">
                <div
                  className="ai-bar-fill cache"
                  style={{
                    width: ctxStats
                      ? `${Math.min(100, (ctxStats.cacheHitTokens / Math.max(1, ctxStats.promptTokens)) * 100)}%`
                      : '0%',
                  }}
                />
              </div>
              <span className="ai-bar-sub">
                {ctxStats
                  ? `${ctxStats.cacheHitTokens.toLocaleString()} / ${ctxStats.promptTokens.toLocaleString()} · 近3次 ${ctxStats.recentRate}%`
                  : '—'}
              </span>
            </div>
            {usage && (
              <span className="ai-bar-total">
                本次共 {usage.totalTokens.toLocaleString()} tokens
                {usage.reasoningTokens > 0 ? `（思考 ${usage.reasoningTokens.toLocaleString()}）` : ''} · 约 $
                {estimateCost(
                  usage.promptTokens,
                  usage.cacheHitTokens,
                  usage.completionTokens,
                ).toFixed(4)}
                （官方价估算）
              </span>
            )}
          </div>
        </div>
      </aside>

      {viewingNote && (
        <div className="modal-backdrop" onClick={() => setViewingNote(null)}>
          <div className="modal modal-wide ai-note-view" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3>
              <FileText size={15} />
              {viewingNote.note.path}
              <span className="hint">
                {' '}
                · {viewingNote.note.bytes} B · {fmtTime(viewingNote.note.mtime)}
              </span>
            </h3>
            <pre>{viewingNote.content}</pre>
            <div className="modal-actions">
              <button
                type="button"
                className="danger-btn"
                onClick={() => {
                  void deleteNote(viewingNote.note)
                  setViewingNote(null)
                }}
              >
                <Trash2 size={13} />
                删除文件
              </button>
              <button className="secondary-btn" type="button" onClick={() => setViewingNote(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmId && (
        <div className="modal-backdrop" onClick={() => setDeleteConfirmId(null)}>
          <div className="modal danger" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ai-del-title">
            <h3 id="ai-del-title">
              <Trash2 size={15} />
              删除这个对话？
            </h3>
            <p>
              将删除该对话的全部消息记录与其 <code>notes/</code> 草稿笔记。
              共享长期记忆 <code>memory/</code> 不受影响。此操作不可恢复。
            </p>
            <div className="modal-actions">
              <button className="secondary-btn" type="button" onClick={() => setDeleteConfirmId(null)}>
                取消
              </button>
              <button className="danger-btn" type="button" onClick={() => void confirmDelete()}>
                <Trash2 size={13} />
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {debugOpen && (
        <div className="modal-backdrop" onClick={() => setDebugOpen(false)}>
          <div className="modal modal-wide ai-debug" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ai-debug-title">
            <h3 id="ai-debug-title">
              <Bug size={15} />
              WeportAI 调试日志
              <span className="hint">（最近一次任务与 API 请求/响应记录，用于排查问题）</span>
            </h3>
            <div className="ai-debug-toolbar">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void api.ai.getDebugLog(400).then((r) => setDebugLines(r.lines || [])).catch(() => undefined)}
              >
                <RefreshCw size={12} />
                刷新
              </button>
              <button
                type="button"
                className="ghost-btn danger-text"
                onClick={() => void api.ai.clearDebugLog().then(() => setDebugLines([]))}
              >
                <Trash2 size={12} />
                清空日志
              </button>
            </div>
            <pre className="ai-debug-pre">
              {debugLines.length === 0
                ? '（暂无日志 — 完成一次任务后，这里会记录每一步的 API 请求与错误详情）'
                : debugLines.map((line) => fmtDebugLine(line)).join('\n')}
            </pre>
            <div className="modal-actions">
              <button className="secondary-btn" type="button" onClick={() => setDebugOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && setup && (
        <AiSettingsModal
          setup={setup}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setSetup(next)
            setSettingsOpen(false)
          }}
        />
      )}
    </div>
  )
}


function fmtDebugLine(raw: string): string {
  try {
    const e = JSON.parse(raw) as Record<string, any>
    const time = new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false })
    const chat = String(e.chatId || '').slice(0, 8)
    switch (e.kind) {
      case 'request':
        return `[${time}] 请求 chat=${chat} 模型=${e.model} 消息数=${e.messages} 大小≈${Math.round((e.estChars || 0) / 1024)}KB 上限=${e.maxTokens}`
      case 'response':
        return `[${time}] 响应 chat=${chat} 内容=${e.contentChars || 0}字 思考=${e.reasoningChars || 0}字 工具调用=${e.toolCalls || 0} 结束=${e.finishReason || '—'} tokens=${e.usage?.totalTokens ?? '—'}（缓存命中 ${e.usage?.promptCacheHitTokens ?? 0}） 耗时=${e.durationMs ?? '—'}ms`
      case 'error':
        return `[${time}] 错误 chat=${chat} HTTP=${e.httpStatus ?? '—'} 详情=${String(e.error || '').slice(0, 400)} 耗时=${e.durationMs ?? '—'}ms`
      default:
        return `[${time}] ${JSON.stringify(e).slice(0, 400)}`
    }
  } catch {
    return raw.slice(0, 400)
  }
}

function AiRangeSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (v: number) => void
}) {
  return (
    <div className="ai-slider-field">
      <div className="ai-slider-label">
        <span>{label}</span>
        <strong>
          {value.toLocaleString()}
          {unit}
        </strong>
      </div>
      <input
        className="ai-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

function AiSettingsModal({
  setup,
  onClose,
  onSaved,
}: {
  setup: SetupInfo
  onClose: () => void
  onSaved: (next: SetupInfo) => void
}) {
  const api = window.electronAPI
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(setup.baseUrl)
  const [model, setModel] = useState(setup.model)
  const [maxTokens, setMaxTokens] = useState(setup.maxTokens)
  const [effort, setEffort] = useState(setup.reasoningEffort)
  const [maxSteps, setMaxSteps] = useState(setup.maxSteps)
  const [customPrompt, setCustomPrompt] = useState(setup.customPrompt)
  const [workspaceRoot, setWorkspaceRoot] = useState(setup.workspaceRoot)
  const [maxToolChars, setMaxToolChars] = useState(setup.maxToolChars)
  const [conversationLimit, setConversationLimit] = useState(setup.conversationLimit)
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set(setup.disabledTools))
  const [actions, setActions] = useState<AiAction[]>([])
  const [saving, setSaving] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)

  useEffect(() => {
    void api.ai.listActions().then((r) => setActions(r.actions || [])).catch(() => undefined)
  }, [api])

  async function save() {
    setSaving(true)
    try {
      await api.ai.setSetup({
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
        maxTokens: Number(maxTokens) || 32768,
        reasoningEffort: effort,
        maxSteps: Number(maxSteps) || 48,
        customPrompt,
        workspaceRoot: workspaceRoot.trim() || undefined,
        maxToolChars: Number(maxToolChars) || 20000,
        conversationLimit: Number(conversationLimit) || 60,
        disabledTools: Array.from(disabledTools),
      })
      await api.ai.saveActions(actions)
      const next = await api.ai.getSetup()
      onSaved(next)
    } finally {
      setSaving(false)
    }
  }

  async function pickWorkspace() {
    const dir = await api.dialog.openDirectory({ title: '选择 WeportAI 工作区根目录（memory/ 与 notes/ 存放于此）' })
    if (dir) setWorkspaceRoot(dir)
  }

  function toggleTool(name: string) {
    setDisabledTools((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function updateAction(id: string, patch: Partial<AiAction>) {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  function addAction() {
    setActions((prev) => [...prev, { id: `action-${Date.now()}`, name: '新动作', prompt: '' }])
  }

  function removeAction(id: string) {
    setActions((prev) => prev.filter((a) => a.id !== id))
  }

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal modal-wide ai-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        <h3 id="ai-settings-title">
          <Sparkles size={15} />
          WeportAI 设置
        </h3>
        <p className="hint">
          连接 DeepSeek 的 OpenAI 兼容接口。API 密钥只会加密保存在这台电脑上，绝不会上传到任何服务器。
        </p>

        <div className="ai-settings-body">
          <div className="ai-settings-section">
            <div className="ai-settings-sec-head">
              <KeyRound size={13} />
              连接
            </div>
            <div className="ai-settings-grid">
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="aiApiKey">API Key</label>
                <input
                  id="aiApiKey"
                  className="path-input ai-input-wide"
                  type="password"
                  value={apiKey}
                  placeholder={setup.hasApiKey ? '已配置（留空则保持不变）' : 'sk-…'}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="hint" style={{ marginTop: 4 }}>
                  {setup.hasApiKey ? (
                    <span className="st-ok">✓ 本机已保存密钥</span>
                  ) : (
                    <span>尚未配置 — 请从 DeepSeek 平台获取并粘贴（sk- 开头）</span>
                  )}
                </p>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="aiBaseUrl">
                  接口地址
                  <span className="hint">（默认为 DeepSeek 官方地址，如无必要请勿更改）</span>
                </label>
                <input
                  id="aiBaseUrl"
                  className="path-input ai-input-wide"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="aiModel">
                  模型
                  <span className="hint">（默认 deepseek-v4-flash，如无必要请勿修改）</span>
                </label>
                <input
                  id="aiModel"
                  className="path-input ai-input-wide"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  spellCheck={false}
                />
              </div>
            </div>
          </div>

          <div className="ai-settings-section">
            <div className="ai-settings-sec-head">
              <Brain size={13} />
              模型与执行
            </div>
            <div className="ai-settings-grid">
              <div className="field">
                <label>思考强度</label>
                <div className="seg" role="radiogroup" aria-label="思考强度">
                  {([
                    ['low', 'Low'],
                    ['high', 'High'],
                    ['max', 'Max'],
                  ] as Array<[string, string]>).map(([v, label]) => (
                    <button key={v} type="button" data-active={effort === v} onClick={() => setEffort(v)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="ai-sliders">
              <AiRangeSlider label="最大输出长度" value={maxTokens} min={1024} max={393216} step={1024} unit=" tokens" onChange={setMaxTokens} />
              <AiRangeSlider label="最大执行步数" value={maxSteps} min={4} max={128} step={1} unit=" 步" onChange={setMaxSteps} />
              <AiRangeSlider label="每轮工具结果总上限" value={maxToolChars} min={2000} max={60000} step={1000} unit=" 字" onChange={setMaxToolChars} />
              <AiRangeSlider label="对话记忆条数（越多越费 token）" value={conversationLimit} min={10} max={200} step={5} unit=" 条" onChange={setConversationLimit} />
            </div>
          </div>

          <div className="ai-settings-section">
            <div className="ai-settings-sec-head">
              <FolderOpen size={13} />
              工作区
            </div>
            <div className="field">
              <label htmlFor="aiWorkspaceRoot">
                工作区根目录（AI 的长期记忆 <code>memory/</code> 与对话草稿 <code>notes/</code> 都存放在这里）
              </label>
              <div className="path-row">
                <input
                  id="aiWorkspaceRoot"
                  className="path-input"
                  value={workspaceRoot}
                  onChange={(e) => setWorkspaceRoot(e.target.value)}
                  placeholder="默认：导出目录/WeportAI，或用户数据目录/WeportAI"
                  spellCheck={false}
                />
                <button className="ghost-btn" type="button" onClick={() => void pickWorkspace()}>
                  浏览
                </button>
              </div>
            </div>
          </div>

          <div className="ai-settings-section">
            <div className="ai-settings-sec-head">
              <FilePenLine size={13} />
              提示词
            </div>
            <div className="field">
              <label htmlFor="aiCustomPrompt">
                自定义提示词
                <span className="hint">（追加在系统提示词之后，可约束分析风格、目标与输出格式）</span>
              </label>
              <textarea
                id="aiCustomPrompt"
                className="ai-prompt-textarea"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder={'例如：始终用中文回答；先建立整体时间线再深入细节；每次回答前先检查并更新记忆。'}
                rows={4}
                spellCheck={false}
              />
            </div>
          </div>

          <div className="ai-settings-section">
            <div className="ai-settings-sec-head">
              <Zap size={13} />
              快捷动作（点击后填入输入框，可改后发送）
            </div>
            {actions.map((a) => (
              <div className="ai-action-edit" key={a.id}>
                <input
                  className="path-input ai-action-name"
                  value={a.name}
                  placeholder="动作名称"
                  onChange={(e) => updateAction(a.id, { name: e.target.value })}
                  spellCheck={false}
                />
                <textarea
                  className="ai-prompt-textarea ai-action-prompt"
                  value={a.prompt}
                  placeholder="动作要发送给 AI 的提示词…"
                  rows={2}
                  onChange={(e) => updateAction(a.id, { prompt: e.target.value })}
                  spellCheck={false}
                />
                <button type="button" className="ghost-btn danger-text" onClick={() => removeAction(a.id)} title="删除动作">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="ghost-btn" onClick={addAction}>
              <Plus size={12} />
              添加动作
            </button>
          </div>

          <div className="ai-settings-section">
            <div className="ai-settings-sec-head">
              <Settings2 size={13} />
              工具开关（关闭后该工具不再提供给 AI）
            </div>
            <div className="ai-tool-toggles">
              {TOOL_LABELS.map(([name, label]) => {
                const off = disabledTools.has(name)
                return (
                  <label key={name} className={`ai-tool-toggle${off ? ' off' : ''}`}>
                    <input type="checkbox" checked={!off} onChange={() => toggleTool(name)} />
                    <span>{label}</span>
                    <code>{name}</code>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="ai-settings-section">
            <div className="ai-settings-sec-head">
              <Trash2 size={13} />
              记忆管理
            </div>
            <p className="hint">
              记忆保存在工作区 <code>memory/</code> 文件夹（跨对话共享）。可在右侧面板逐条查看/删除，也可在此清空全部长期记忆。
            </p>
            <div className="btn-row">
              <button
                type="button"
                className={clearingMemory ? 'danger-btn' : 'secondary-btn'}
                disabled={saving}
                onClick={() => {
                  if (!clearingMemory) {
                    setClearingMemory(true)
                    window.setTimeout(() => setClearingMemory(false), 2600)
                    return
                  }
                  setClearingMemory(false)
                  void api.ai.clearMemory().then(() => {
                    onSaved(setup)
                  })
                }}
              >
                <Trash2 size={13} />
                {clearingMemory ? '再次点击确认清空长期记忆' : '清空全部长期记忆'}
              </button>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="secondary-btn" type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" type="button" disabled={saving} onClick={() => void save()}>
            <KeyRound size={13} />
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  )
}
