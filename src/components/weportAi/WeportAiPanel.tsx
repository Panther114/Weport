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
  Loader2,
} from 'lucide-react'
import AiMarkdown from './AiMarkdown'
import './providerProfiles.css'

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
  baseUrlError?: string
  model: string
  reasoningEffort: string
  customPrompt: string
  workspaceRoot: string
  exportPath: string
  dbReady: boolean
  disabledTools: string[]
  activeProfileId: string
  profiles: ProviderProfileSummary[]
  catalog: ProviderCatalogEntry[]
}

type ProviderProtocol = 'openai' | 'openai-compatible' | 'anthropic' | 'google' | 'gemini-compatible'
type ProviderCatalogEntry = {
  id: string
  name: string
  description: string
  protocol: ProviderProtocol
  baseUrl: string
  defaultModel: string
  models: string[]
  allowCustomBaseUrl?: boolean
  protocolOptions?: ProviderProtocol[]
  apiKeyOptional?: boolean
}
type ProviderProfileSummary = {
  id: string
  name: string
  displayName: string
  providerId: string
  protocol: ProviderProtocol
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKeyHint: string
  updatedAt: number
  discovery?: { models: string[]; fetchedAt: number; error?: string }
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
  // 用于异步回调里的会话一致性判断（openChat 的 getChat 可能晚于后续切换返回）
  const activeIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

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
      // 切换前中止旧会话的运行：否则旧会话的 status:false 事件会被下面的
      // chatId 过滤丢弃，running 永远卡在 true，Stop 也会打到错误的会话
      if (activeId && activeId !== id) {
        void api.ai.abort(activeId)
        setRunning(false)
      }
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
        // 期间用户又切换了会话 → 丢弃过期响应，防止 A→B→A 时旧数据覆盖新会话
        if (activeIdRef.current !== id) return
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
        if (activeIdRef.current !== id) return
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
    void api.ai.getSetup().then((value) => setSetup(value as unknown as SetupInfo)).catch(() => undefined)
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
              title="日志（查看最近一次任务与 API 请求记录）"
            >
              <Bug size={14} />
              日志
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
        {setup && !setup.hasApiKey && (
          <div className="ai-warn-banner warn">
            当前服务尚未配置 API key — 打开左下角「设置」完成提供商配置后才能使用。
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
                基于所选 AI 提供商的本地聊天记录分析环境。它能跨会话查看某一天的完整时间线、搜索任意关键词、统计互动，
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
              WeportAI 日志
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
          onChanged={(next) => setSetup(next)}
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
        return `[${time}] 请求 chat=${chat} 模型=${e.model} 消息数=${e.messages} 大小≈${Math.round((e.estChars || 0) / 1024)}KB`
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

function AiSettingsModal({
  setup,
  onClose,
  onChanged,
  onSaved,
}: {
  setup: SetupInfo
  onClose: () => void
  onChanged?: (next: SetupInfo) => void
  onSaved: (next: SetupInfo) => void
}) {
  const api = window.electronAPI
  const [profiles, setProfiles] = useState(setup.profiles || [])
  const [catalog, setCatalog] = useState(setup.catalog || [])
  const [activeProfileId, setActiveProfileId] = useState(setup.activeProfileId || '')
  const [editingId, setEditingId] = useState<string | null>(setup.activeProfileId || setup.profiles?.[0]?.id || null)
  const initial = setup.profiles?.find((p) => p.id === (setup.activeProfileId || setup.profiles?.[0]?.id))
  const [draft, setDraft] = useState({
    name: initial?.name || '新 AI 服务',
    providerId: initial?.providerId || 'deepseek',
    protocol: initial?.protocol || 'openai-compatible' as ProviderProtocol,
    baseUrl: initial?.baseUrl || '',
    model: initial?.model || '',
    apiKey: '',
  })
  const [customPrompt, setCustomPrompt] = useState(setup.customPrompt)
  const [workspaceRoot, setWorkspaceRoot] = useState(setup.workspaceRoot)
  const [effort, setEffort] = useState(setup.reasoningEffort)
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set(setup.disabledTools))
  const [actions, setActions] = useState<AiAction[]>([])
  const [saving, setSaving] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)
  const [error, setError] = useState('')
  const [discovering, setDiscovering] = useState<string | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<string[]>(initial?.discovery?.models || [])
  const [modelDiscoveryDone, setModelDiscoveryDone] = useState(Boolean(initial?.discovery?.fetchedAt))
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addDraft, setAddDraft] = useState(() => {
    const entry = (setup.catalog || []).find((item) => item.id === 'deepseek') || (setup.catalog || [])[0]
    return {
      name: entry?.name || '新 AI 服务',
      providerId: entry?.id || 'deepseek',
      protocol: (entry?.protocol || 'openai-compatible') as ProviderProtocol,
      baseUrl: entry?.baseUrl || '',
      model: entry?.defaultModel || '',
      apiKey: '',
    }
  })
  const [addFetchedModels, setAddFetchedModels] = useState<string[]>([])
  const [addFetching, setAddFetching] = useState(false)
  const [addDiscoveryDone, setAddDiscoveryDone] = useState(false)
  const [addError, setAddError] = useState('')
  const [addSaving, setAddSaving] = useState(false)

  const selectedCatalog = catalog.find((entry) => entry.id === draft.providerId)
  const selectedModels = Array.from(new Set([
    ...fetchedModels,
    ...(selectedCatalog?.models || []),
    ...(editingId ? profiles.find((p) => p.id === editingId)?.discovery?.models || [] : []),
    ...(draft.model ? [draft.model] : []),
  ]))

  useEffect(() => {
    void api.ai.listActions().then((r) => setActions(r.actions || [])).catch(() => undefined)
  }, [api])

  function startEdit(profile: ProviderProfileSummary) {
    setEditingId(profile.id)
    setDraft({ name: profile.name, providerId: profile.providerId, protocol: profile.protocol, baseUrl: profile.baseUrl, model: profile.model, apiKey: '' })
    setFetchedModels(profile.discovery?.models || [])
    setModelDiscoveryDone(Boolean(profile.discovery?.fetchedAt))
    setError('')
  }

  function openAddDialog() {
    const entry = catalog.find((item) => item.id === 'deepseek') || catalog[0]
    setAddDraft({
      name: entry?.name ? `${entry.name} · 新配置` : '新 AI 服务',
      providerId: entry?.id || 'deepseek',
      protocol: (entry?.protocol || 'openai-compatible') as ProviderProtocol,
      baseUrl: entry?.baseUrl || '',
      model: entry?.defaultModel || '',
      apiKey: '',
    })
    setAddFetchedModels([])
    setAddDiscoveryDone(false)
    setAddError('')
    setAddOpen(true)
  }

  function startAdd() {
    openAddDialog()
  }

  function selectProvider(providerId: string) {
    const entry = catalog.find((item) => item.id === providerId)
    if (!entry) return
    setFetchedModels([])
    setModelDiscoveryDone(false)
    setDraft((prev) => ({
      ...prev,
      providerId,
      protocol: entry.protocolOptions?.includes(prev.protocol) ? prev.protocol : entry.protocol,
      baseUrl: entry.baseUrl || (entry.allowCustomBaseUrl ? '' : prev.baseUrl),
      model: entry.defaultModel || prev.model,
      name: prev.name === '新 AI 服务' || prev.name === selectedCatalog?.name ? entry.name : prev.name,
    }))
  }

  function selectAddProvider(providerId: string) {
    const entry = catalog.find((item) => item.id === providerId)
    if (!entry) return
    setAddFetchedModels([])
    setAddDiscoveryDone(false)
    setAddError('')
    setAddDraft((prev) => ({
      ...prev,
      providerId,
      protocol: entry.protocolOptions?.includes(prev.protocol) ? prev.protocol : entry.protocol,
      baseUrl: entry.baseUrl || (entry.allowCustomBaseUrl ? '' : prev.baseUrl),
      model: entry.defaultModel || prev.model,
      name: prev.name === '新 AI 服务' || prev.name.startsWith(catalog.find((c) => c.id === prev.providerId)?.name || '') ? (entry.name ? `${entry.name} · 新配置` : prev.name) : prev.name,
    }))
  }

  async function fetchAddModels() {
    setAddFetching(true)
    setAddError('')
    try {
      const result = await api.ai.fetchModels({
        providerId: addDraft.providerId,
        protocol: addDraft.protocol,
        baseUrl: addDraft.baseUrl.trim() || undefined,
        apiKey: addDraft.apiKey.trim() || undefined,
      })
      if (!result.success || !result.models?.length) {
        setAddFetchedModels([])
        setAddDiscoveryDone(false)
        setAddError(result.error || '未获取到可用模型')
        return
      }
      const models = Array.from(new Set(result.models.map(String).filter(Boolean)))
      setAddFetchedModels(models)
      setAddDiscoveryDone(true)
      setAddDraft((prev) => ({ ...prev, model: models.includes(prev.model) ? prev.model : models[0] || '' }))
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAddFetching(false)
    }
  }

  async function saveAddProfile() {
    setAddSaving(true)
    setAddError('')
    try {
      if (!addDraft.name.trim()) {
        setAddError('请填写配置名称')
        return
      }
      const catalogEntry = catalog.find((c) => c.id === addDraft.providerId)
      const needsKey = catalogEntry ? catalogEntry.apiKeyOptional !== true : true
      if (needsKey && !addDraft.apiKey.trim()) {
        setAddError('请填写 API key（本地服务除外）')
        return
      }
      if (!addDraft.model.trim()) {
        setAddError('请选择模型（先获取模型列表）')
        return
      }
      if (!addDiscoveryDone) {
        setAddError('请先验证并获取模型列表')
        return
      }
      if (addDiscoveryDone && addFetchedModels.length > 0 && !addFetchedModels.includes(addDraft.model.trim())) {
        setAddError('请选择已获取的模型')
        return
      }
      const result = await api.ai.saveProfile({
        name: addDraft.name.trim(),
        providerId: addDraft.providerId,
        protocol: addDraft.protocol,
        baseUrl: addDraft.baseUrl.trim(),
        model: addDraft.model.trim(),
        apiKey: addDraft.apiKey.trim() || undefined,
      })
      if (!result.success) {
        setAddError(result.error || '添加提供商失败')
        return
      }
      const next = await refreshSetup()
      if (result.profile) {
        setEditingId(result.profile.id)
        setDraft({
          name: result.profile.name,
          providerId: result.profile.providerId,
          protocol: result.profile.protocol,
          baseUrl: result.profile.baseUrl,
          model: result.profile.model,
          apiKey: '',
        })
        setFetchedModels(result.profile.discovery?.models || [])
        setModelDiscoveryDone(Boolean(result.profile.discovery?.fetchedAt))
      }
      // 使新配置立即成为当前生效项
      if (result.profile?.id) {
        try { await api.ai.activateProfile(result.profile.id); await refreshSetup() } catch { /* noop */ }
      }
      setAddOpen(false)
      if (next.baseUrlError) setError(next.baseUrlError)
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAddSaving(false)
    }
  }

  async function refreshSetup() {
    const next = (await api.ai.getSetup()) as unknown as SetupInfo
    setProfiles(next.profiles || [])
    setCatalog(next.catalog || catalog)
    setActiveProfileId(next.activeProfileId || '')
    if (next.baseUrlError) setError(next.baseUrlError)
    onChanged?.(next)
    return next
  }

  async function saveProfile(): Promise<boolean> {
    setSaving(true)
    setError('')
    try {
      if (!draft.model.trim()) {
        setError('请选择模型')
        return false
      }
      if (!editingId && !modelDiscoveryDone) {
        setError('请先获取模型列表，再保存新的服务配置')
        return false
      }
      if (modelDiscoveryDone && fetchedModels.length > 0 && !fetchedModels.includes(draft.model.trim())) {
        setError('请选择已获取的模型')
        return false
      }
      const result = await api.ai.saveProfile({
        id: editingId || undefined,
        name: draft.name.trim(),
        providerId: draft.providerId,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        apiKey: draft.apiKey.trim() || undefined,
      })
      if (!result.success) {
        setError(result.error || '保存服务配置失败')
        return false
      }
      const next = await refreshSetup()
      if (result.profile) {
        setEditingId(result.profile.id)
      }
      if (next.baseUrlError) {
        setError(next.baseUrlError)
        return false
      }
      return true
    } catch (e) {
      setError(String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  async function fetchDraftModels() {
    if (editingId && !draft.apiKey.trim()) {
      await discover(editingId)
      return
    }
    setFetchingModels(true)
    setError('')
    try {
      const result = await api.ai.fetchModels({
        providerId: draft.providerId,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim() || undefined,
        apiKey: draft.apiKey.trim() || undefined,
      })
      if (!result.success || !result.models?.length) {
        setFetchedModels([])
        setModelDiscoveryDone(false)
        setError(result.error || '未获取到可用模型')
        return
      }
      const models = Array.from(new Set(result.models.map(String).filter(Boolean)))
      setFetchedModels(models)
      setModelDiscoveryDone(true)
      setDraft((prev) => ({ ...prev, model: models.includes(prev.model) ? prev.model : models[0] || '' }))
    } catch (e) {
      setError(String(e))
    } finally {
      setFetchingModels(false)
    }
  }

  async function activate(id: string) {
    setError('')
    try {
      const result = await api.ai.activateProfile(id)
      if (!result.success) {
        setError(result.error || '启用服务失败')
        return
      }
      await refreshSetup()
    } catch (e) {
      setError(String(e))
    }
  }

  async function removeProfile(id: string) {
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      return
    }
    setConfirmDelete(null)
    setError('')
    try {
      const result = await api.ai.deleteProfile(id)
      if (!result.success) {
        setError(result.error || '删除服务失败')
        return
      }
      const next = await refreshSetup()
      if (editingId === id) {
        const replacement = next.profiles?.[0]
        if (replacement) startEdit(replacement)
        else {
          setEditingId(null)
          setDraft({ name: '新 AI 服务', providerId: 'deepseek', protocol: 'openai-compatible' as ProviderProtocol, baseUrl: 'https://api.deepseek.com', model: '', apiKey: '' })
          setFetchedModels([])
          setModelDiscoveryDone(false)
        }
      }
    } catch (e) {
      setError(String(e))
    }
  }

  async function discover(profileId: string) {
    setDiscovering(profileId)
    setError('')
    try {
      await api.ai.setSetup({ discoverProfileId: profileId })
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 450))
        const next = (await api.ai.getSetup()) as unknown as SetupInfo
        const current = next.profiles?.find((p) => p.id === profileId)
        setProfiles(next.profiles || [])
        if (current?.discovery?.fetchedAt && current.discovery.fetchedAt > Date.now() - 20000) {
          setActiveProfileId(next.activeProfileId || '')
          setFetchedModels(current.discovery.models || [])
          setModelDiscoveryDone(Boolean(current.discovery.models?.length))
          if (current.discovery.error) setError(current.discovery.error)
          break
        }
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setDiscovering(null)
    }
  }

  async function saveAll() {
    setSaving(true)
    setError('')
    try {
      // 若当前无可编辑的 profile（首次使用且尚未添加），跳过 profile 保存，仅保存其他设置
      if (editingId || profiles.length > 0) {
        if (!(await saveProfile())) return
      }
      await api.ai.setSetup({
        reasoningEffort: effort,
        customPrompt,
        workspaceRoot: workspaceRoot.trim() || undefined,
        disabledTools: Array.from(disabledTools),
      })
      await api.ai.saveActions(actions)
      const next = await refreshSetup()
      onSaved(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  async function pickWorkspace() {
    const dir = await api.dialog.openDirectory({ title: '选择 WeportAI 工作区根目录' })
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

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal modal-wide ai-settings ai-provider-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        <h3 id="ai-settings-title"><Sparkles size={15} /> WeportAI 设置</h3>
        <p className="hint">服务配置按 profile 管理。API key 只在本机加密保存，列表、摘要和 discovery 结果都不会返回原始密钥。</p>
        {error && <div className="ai-profile-error">{error}</div>}

        <div className="ai-profile-layout">
          <section className="ai-profile-list" aria-label="AI 服务列表">
            <div className="ai-settings-sec-head"><KeyRound size={13} /> AI 提供商</div>
            {profiles.map((profile) => (
              <div key={profile.id} className={`ai-profile-row${profile.id === activeProfileId ? ' active' : ''}`}>
                <button type="button" className="ai-profile-main" onClick={() => startEdit(profile)}>
                  <strong>{profile.name}</strong>
                  <span>{profile.providerId} · {profile.model}</span>
                  <small>{profile.hasApiKey ? `密钥 ${profile.apiKeyHint}` : '未配置密钥'} · {profile.protocol}</small>
                  {profile.discovery?.error && <em className="ai-profile-discovery-error">{profile.discovery.error}</em>}
                </button>
                <div className="ai-profile-actions">
                  {profile.id === activeProfileId ? <span className="ai-profile-badge">当前</span> : <button type="button" className="ghost-btn" onClick={() => void activate(profile.id)}>启用</button>}
                  <button type="button" className="ghost-btn" onClick={() => void discover(profile.id)} disabled={discovering === profile.id}><RefreshCw size={12} /> {discovering === profile.id ? '读取中' : '发现模型'}</button>
                  <button type="button" className="ghost-btn danger-text" onClick={() => void removeProfile(profile.id)}>{confirmDelete === profile.id ? '再次确认删除' : '删除'}</button>
                </div>
              </div>
            ))}
            <button type="button" className="secondary-btn ai-profile-add" onClick={startAdd}><Plus size={13} /> 添加新提供商</button>
          </section>

          <section className="ai-profile-editor">
            <div className="ai-settings-sec-head"><Settings2 size={13} /> {editingId ? '编辑服务' : profiles.length === 0 ? '暂无服务' : '选择服务'}</div>
            {profiles.length === 0 && !editingId ? (
              <div className="ai-editor-empty">
                <p>还没有配置任何 AI 提供商。</p>
                <button type="button" className="primary-btn" onClick={openAddDialog}><Plus size={13} /> 添加第一个提供商</button>
              </div>
            ) : !editingId && profiles.length > 0 ? (
              <div className="ai-editor-empty">
                <p>从左侧选择一个服务进行编辑，或添加新的提供商。</p>
                <button type="button" className="secondary-btn" onClick={() => profiles[0] && startEdit(profiles[0])}>编辑 “{profiles[0].name}”</button>
              </div>
            ) : (
              <>
                <div className="ai-settings-grid ai-provider-fields">
                  <div className="field"><label htmlFor="aiProfileName">配置名称</label><input id="aiProfileName" className="path-input ai-input-wide" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                  <div className="field"><label htmlFor="aiProvider">Provider</label><select id="aiProvider" className="path-input" value={draft.providerId} onChange={(e) => selectProvider(e.target.value)}>{catalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></div>
                  <div className="field"><label htmlFor="aiApiKey">API key</label><input id="aiApiKey" className="path-input ai-input-wide" type="password" value={draft.apiKey} placeholder={editingId ? `已保存 ${profiles.find((p) => p.id === editingId)?.apiKeyHint || '密钥'}；留空保持不变` : (selectedCatalog?.apiKeyOptional ? '本地服务可留空' : '输入 API key')} onChange={(e) => { setDraft({ ...draft, apiKey: e.target.value }); setModelDiscoveryDone(false) }} autoComplete="off" spellCheck={false} /></div>
                  <div className="field"><label htmlFor="aiModel">Model</label><select id="aiModel" className="path-input" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} disabled={selectedModels.length === 0}><option value="">{selectedModels.length ? '选择模型' : '先获取模型列表'}</option>{selectedModels.map((model) => <option key={model} value={model}>{model}</option>)}</select></div>
                  {(selectedCatalog?.allowCustomBaseUrl || selectedCatalog?.id === 'custom') && <div className="field ai-provider-custom-url"><label htmlFor="aiBaseUrl">自定义接口地址</label><input id="aiBaseUrl" className="path-input ai-input-wide" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} spellCheck={false} /></div>}
                  {(selectedCatalog?.allowCustomBaseUrl || selectedCatalog?.id === 'custom') && <div className="field"><label htmlFor="aiProtocol">协议</label><select id="aiProtocol" className="path-input" value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as ProviderProtocol })}>{(selectedCatalog?.protocolOptions || [selectedCatalog?.protocol || draft.protocol]).map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}</select></div>}
                </div>
                <div className="ai-profile-discovery">
                  <button type="button" className="ghost-btn" onClick={() => void fetchDraftModels()} disabled={saving || fetchingModels || Boolean(discovering)}><RefreshCw size={12} /> {fetchingModels || discovering ? '正在获取模型…' : '获取模型列表'}</button>
                  <span className="ai-profile-discovery-hint">{modelDiscoveryDone ? `已获取 ${fetchedModels.length} 个模型` : '验证 API key 并读取可用模型'}</span>
                  {editingId && profiles.find((p) => p.id === editingId)?.discovery?.error && <span className="ai-profile-discovery-error">{profiles.find((p) => p.id === editingId)?.discovery?.error}</span>}
                </div>
                <div className="btn-row"><button type="button" className="primary-btn" disabled={saving || (!editingId && !modelDiscoveryDone)} onClick={() => void saveProfile()}>{saving ? '保存中…' : '保存 profile'}</button></div>
              </>
            )}
          </section>
        </div>

        <div className="ai-settings-section"><div className="ai-settings-sec-head"><FolderOpen size={13} /> 工作区</div><div className="field"><label htmlFor="aiWorkspaceRoot">工作区根目录</label><div className="path-row"><input id="aiWorkspaceRoot" className="path-input" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} /><button className="ghost-btn" type="button" onClick={() => void pickWorkspace()}>浏览</button></div></div></div>
        <div className="ai-settings-section"><div className="ai-settings-sec-head"><FilePenLine size={13} /> 提示词</div><textarea id="aiCustomPrompt" className="ai-prompt-textarea" value={customPrompt} onChange={(e) => setCustomPrompt(e.target.value)} rows={4} spellCheck={false} /></div>
        <div className="ai-settings-section"><div className="ai-settings-sec-head"><Zap size={13} /> 快捷动作</div>{actions.map((a) => <div className="ai-action-edit" key={a.id}><input className="path-input ai-action-name" value={a.name} onChange={(e) => updateAction(a.id, { name: e.target.value })} /><textarea className="ai-prompt-textarea ai-action-prompt" value={a.prompt} onChange={(e) => updateAction(a.id, { prompt: e.target.value })} rows={2} /><button type="button" className="ghost-btn danger-text" onClick={() => setActions((prev) => prev.filter((item) => item.id !== a.id))}><Trash2 size={12} /></button></div>)}<button type="button" className="ghost-btn" onClick={() => setActions((prev) => [...prev, { id: `action-${Date.now()}`, name: '新动作', prompt: '' }])}><Plus size={12} /> 添加动作</button></div>
        <div className="ai-settings-section"><div className="ai-settings-sec-head"><Settings2 size={13} /> 工具开关</div><div className="ai-tool-toggles">{TOOL_LABELS.map(([name, label]) => <label key={name} className={`ai-tool-toggle${disabledTools.has(name) ? ' off' : ''}`}><input type="checkbox" checked={!disabledTools.has(name)} onChange={() => toggleTool(name)} /><span>{label}</span><code>{name}</code></label>)}</div></div>
        <div className="modal-actions"><button className="secondary-btn" type="button" disabled={saving} onClick={onClose}>取消</button><button className="primary-btn" type="button" disabled={saving} onClick={() => void saveAll()}><KeyRound size={13} /> 保存设置</button></div>
      </div>
      {addOpen && (
        <div className="ai-add-overlay" onClick={() => !addSaving && setAddOpen(false)}>
          <div className="ai-add-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ai-add-title">
            <div className="ai-add-head">
              <div className="ai-add-title">
                <div className="ai-add-icon"><Sparkles size={16} /></div>
                <div>
                  <h3 id="ai-add-title">添加 AI 提供商</h3>
                  <p>从目录挑选提供商，验证密钥后选择模型，创建即可启用</p>
                </div>
              </div>
              <button type="button" className="icon-btn-ghost" aria-label="关闭" onClick={() => !addSaving && setAddOpen(false)}><XCircle size={16} /></button>
            </div>

            {addError && <div className="ai-profile-error" style={{ marginBottom: 12 }}>{addError}</div>}

            <div className="ai-add-catalog">
              <div className="ai-add-section-label"><span>① 选择提供商</span><small>{catalog.length} 个可用</small></div>
              <div className="ai-add-grid">
                {catalog.map((entry) => {
                  const isSelected = addDraft.providerId === entry.id
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`ai-add-card${isSelected ? ' selected' : ''}`}
                      onClick={() => selectAddProvider(entry.id)}
                    >
                      <div className="ai-add-card-head">
                        <strong>{entry.name}</strong>
                        {isSelected && <span className="ai-add-check"><CheckCircle2 size={13} /></span>}
                      </div>
                      <span className="ai-add-card-desc">{entry.description}</span>
                      <span className="ai-add-card-meta">
                        <code>{entry.protocol}</code>
                        <span title={entry.baseUrl}>{entry.baseUrl ? entry.baseUrl.replace(/^https?:\/\//, '').slice(0, 28) || '自定义地址' : '自定义地址'}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="ai-add-form">
              <div className="ai-add-section-label"><span>② 配置详情</span><small>带 * 为必填</small></div>
              <div className="ai-settings-grid ai-provider-fields">
                <div className="field"><label htmlFor="aiAddName">配置名称 *</label><input id="aiAddName" className="path-input ai-input-wide" value={addDraft.name} onChange={(e) => setAddDraft({ ...addDraft, name: e.target.value })} placeholder="例如：我的 DeepSeek" /></div>
                <div className="field"><label htmlFor="aiAddKey">API Key {catalog.find((c) => c.id === addDraft.providerId)?.apiKeyOptional ? '(可选)' : '*'}</label>
                  <input id="aiAddKey" className="path-input ai-input-wide" type="password" value={addDraft.apiKey} onChange={(e) => { setAddDraft({ ...addDraft, apiKey: e.target.value }); setAddDiscoveryDone(false) }} placeholder={catalog.find((c) => c.id === addDraft.providerId)?.apiKeyOptional ? '本地服务可留空' : '粘贴 API key'} autoComplete="off" spellCheck={false} />
                </div>
                {(catalog.find((c) => c.id === addDraft.providerId)?.allowCustomBaseUrl || addDraft.providerId === 'custom') && (
                  <div className="field ai-provider-custom-url"><label htmlFor="aiAddBaseUrl">自定义接口地址 {catalog.find((c) => c.id === addDraft.providerId)?.id === 'azure-openai' ? '*' : ''}</label><input id="aiAddBaseUrl" className="path-input ai-input-wide" value={addDraft.baseUrl} onChange={(e) => setAddDraft({ ...addDraft, baseUrl: e.target.value })} placeholder="https://..." spellCheck={false} /></div>
                )}
                {(catalog.find((c) => c.id === addDraft.providerId)?.allowCustomBaseUrl || addDraft.providerId === 'custom') && (
                  <div className="field"><label htmlFor="aiAddProtocol">协议</label><select id="aiAddProtocol" className="path-input" value={addDraft.protocol} onChange={(e) => setAddDraft({ ...addDraft, protocol: e.target.value as ProviderProtocol })}>{(catalog.find((c) => c.id === addDraft.providerId)?.protocolOptions || [catalog.find((c) => c.id === addDraft.providerId)?.protocol || addDraft.protocol]).map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}</select></div>
                )}
                <div className="field"><label htmlFor="aiAddModel">模型 *</label>
                  <div className="ai-add-model-row">
                    <select id="aiAddModel" className="path-input" value={addDraft.model} onChange={(e) => setAddDraft({ ...addDraft, model: e.target.value })} disabled={addFetchedModels.length === 0 && !(catalog.find((c) => c.id === addDraft.providerId)?.models?.length)}>
                      <option value="">{addFetchedModels.length || catalog.find((c) => c.id === addDraft.providerId)?.models?.length ? '选择模型' : '先获取模型列表'}</option>
                      {Array.from(new Set([...addFetchedModels, ...(catalog.find((c) => c.id === addDraft.providerId)?.models || []), ...(addDraft.model ? [addDraft.model] : [])].filter(Boolean))).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <button type="button" className="ghost-btn ai-add-fetch" onClick={() => void fetchAddModels()} disabled={addFetching}>
                      {addFetching ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                      {addFetching ? '获取中…' : '获取模型'}
                    </button>
                  </div>
                  <span className="ai-profile-discovery-hint">{addDiscoveryDone ? `✓ 已验证 · ${addFetchedModels.length} 个模型可用` : addFetching ? '正在验证密钥并拉取模型…' : '验证 API key 后自动刷新模型列表'}</span>
                </div>
              </div>
            </div>

            <div className="ai-add-actions">
              <button type="button" className="secondary-btn" disabled={addSaving} onClick={() => setAddOpen(false)}>取消</button>
              <button type="button" className="primary-btn" disabled={addSaving || !addDiscoveryDone || !addDraft.name.trim() || !addDraft.model.trim()} onClick={() => void saveAddProfile()}>
                {addSaving ? '创建中…' : '确认添加并启用'}
              </button>
            </div>
            <p className="hint" style={{ marginTop: 8, textAlign: 'center', fontSize: 11 }}>添加后将自动设为当前提供商，可在左侧列表随时切换</p>
          </div>
        </div>
      )}
    </div>
  )
}
