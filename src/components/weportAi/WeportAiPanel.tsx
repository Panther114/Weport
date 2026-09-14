import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import ReferencePicker, { type ReferenceCandidate, type ReferencePickerHandle } from '../reference/ReferencePicker'
import { applyMention, findActiveMention, referenceKindLabel, type ChatReference } from '../../utils/mentionTrigger'
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
// `ok` 允许缺省：调用还在进行中时既不是成功也不是失败，`undefined` 让
// ToolChip 渲染转圈而不是把它标成失败。
type AiToolCall = { id: string; name: string; args: Record<string, unknown>; friendly: string; ok?: boolean; result?: string }
type AiMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  toolCalls?: AiToolCall[]
  createdAt: number
  timing?: { ttftMs: number; decodeMs: number; outputTokens: number }
}
type AiEvent =
  | { type: 'status'; chatId: string; running: boolean }
  | { type: 'reasoning_delta'; chatId: string; delta: string }
  | { type: 'text_delta'; chatId: string; delta: string }
  | { type: 'tool_start'; chatId: string; callId: string; name: string; args: Record<string, unknown>; friendly: string }
  | { type: 'tool_result'; chatId: string; callId: string; name: string; ok: boolean; summary: string; detail?: string }
  | { type: 'assistant_message'; chatId: string; message: AiMessage; timing?: { ttftMs: number; decodeMs: number; outputTokens: number } }
  | { type: 'chat_title'; chatId: string; title: string }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'done'; chatId: string; usage?: { promptTokens: number; completionTokens: number; reasoningTokens: number; totalTokens: number; promptCacheHitTokens?: number }; aborted?: boolean; context?: { promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number } }
  | { type: 'context'; chatId: string; promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number }

import { type AiAction, type ProviderCatalogEntry, type ProviderModelMetadata, type ProviderProfileSummary, type ProviderProtocol, type SetupInfo } from './aiPanelTypes'
type AiNote = { path: string; bytes: number; mtime: number; scope: 'memory' | 'notes' }

type LiveTool = { id: string; name: string; friendly: string; args?: Record<string, unknown>; ok?: boolean; summary?: string; result?: string; running: boolean }
type LiveState = { reasoning: string; text: string; tools: LiveTool[]; firstTokenAt?: number; lastTokenAt?: number }

/**
 * 输出速度读数，口径与 DSH 一致：
 *
 *   TPS = outputTokens / (decodeMs / 1000)
 *
 * 其中 `decodeMs` 只算「首 token 之后」的解码时间，不含 TTFT。用总耗时算出来的
 * 数字会把长前缀的等待时间摊进吞吐里，慢的不像话还没有可比性。
 *
 * 显示规则也照搬 DSH：≥10 取整，<10 保留一位小数，负数夹到 0。
 */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** 一轮结束后的读数：`52.3 tok/s`；没有计时数据（旧记录）时返回 null。 */
function messageTps(timing: AiMessage['timing']): number | null {
  if (!timing || timing.decodeMs <= 0 || timing.outputTokens <= 0) return null
  return timing.outputTokens / (timing.decodeMs / 1000)
}

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


function fmtTime(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 把大数字格式化为 1.0M / 64K / 1024。未知（undefined/0）渲染为 `—`。 */
function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/**
 * Cost of one run, priced from the model's OWN published rates.
 *
 * models.dev prices are USD per million tokens. The previous implementation
 * hard-coded DeepSeek's rates in the renderer and applied them to every
 * provider, which was wrong by 3–6× on DeepSeek itself (real V4 Pro is
 * 0.435 / 0.87, not 0.14 / 0.28) and meaningless everywhere else.
 *
 * Returns `null` — rendered as `N/A`, never `$0.00` — whenever the metadata has
 * no usable input or output price, because an unpriced model and a free model
 * are different things.
 */
function estimateRunCost(
  cost: ProviderModelMetadata['cost'] | undefined,
  usage: { promptTokens: number; cacheHitTokens: number; completionTokens: number },
): number | null {
  if (!cost || cost.input === undefined || cost.output === undefined) return null
  const prompt = Math.max(0, usage.promptTokens)
  const cacheHit = Math.min(prompt, Math.max(0, usage.cacheHitTokens))
  const completion = Math.max(0, usage.completionTokens)
  const cacheRead = cost.cacheRead ?? cost.input
  return ((prompt - cacheHit) * cost.input + cacheHit * cacheRead + completion * cost.output) / 1_000_000
}

/**
 * 取当前模型的价格。
 *
 * 必须走 `setup.modelCosts[模型 id]`，**不能**读 `profile.cost`：
 * `ProviderProfileSummary` 不带 `cost` 字段，于是"有定价的模型"在顶栏显示成
 * 「未定价」—— 一个会让人误判价格的假读数（踩过一次）。`modelCosts` 是主进程
 * 按模型 id 解出来的权威表。
 */
function lookupCost(
  setup: SetupInfo | null,
  model: string | undefined,
): ProviderModelMetadata['cost'] | undefined {
  const id = String(model || '').trim()
  if (!setup || !id) return undefined
  const fromMap = setup.modelCosts?.[id]
  if (fromMap) return fromMap
  const profile = setup.profiles.find((p) => p.model === id)
  return profile?.cost
}

/** `$0.0123`, or the literal `N/A` when the model has no published price. */
function fmtCost(value: number | null): string {
  return value === null ? 'N/A' : `$${value.toFixed(4)}`
}

/**
 * 每百万 token 单价，`$0.14 / $0.28`。缺哪一项就写 `—`。
 *
 * 价格来自 models.dev（USD / 1M tokens），**运行时抓取、不是写死的**：
 * 新模型和新定价自己就会进来，不需要发版。面板必须把来源与取数时间一起显示，
 * 否则用户没办法判断这个数字是不是过期了。
 */
function fmtPrice(cost: ProviderModelMetadata['cost'] | undefined): string {
  if (!cost || (cost.input === undefined && cost.output === undefined)) return '未定价'
  const one = (v: number | undefined) => (v === undefined ? '—' : `$${v}`)
  return `${one(cost.input)} / ${one(cost.output)}`
}

function costTooltip(cost: ProviderModelMetadata['cost'] | undefined): string | undefined {
  const c = cost
  if (!c || (c.input === undefined && c.output === undefined)) {
    return '这个模型没有公开定价（models.dev 未收录）。未定价 ≠ 免费，请以提供商账单为准。'
  }
  return [
    `输入 ${c.input ?? '—'} / 输出 ${c.output ?? '—'} USD 每百万 token`,
    c.cacheRead !== undefined ? `缓存读取 ${c.cacheRead}` : null,
    c.cacheWrite !== undefined ? `缓存写入 ${c.cacheWrite}` : null,
    c.reasoning !== undefined ? `推理 ${c.reasoning}` : null,
    '来源：models.dev（运行时抓取，24 小时 TTL）',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Capability chips + the real context window for the active model.
 *
 * Every chip is driven by resolved metadata, and a missing field simply produces
 * no chip — the panel never claims a capability it cannot back up. There is
 * deliberately no fallback to the global `weportAiContextWindow` here: that value
 * is the *config* default, so showing it as the model's window would recreate the
 * exact "128k model reported against 1M" bug this workstream removed.
 *
 * The protocol chip matters because a multi-protocol gateway may route this
 * model on a different wire format than the profile's own default.
 */
function ModelMetaLine({ meta }: { meta: ProviderModelMetadata | null }) {
  if (!meta) return null
  const capabilities = meta.capabilities
  const chips: string[] = []
  if (meta.contextWindow && meta.contextWindow > 0) chips.push(`${fmtTokens(meta.contextWindow)} 上下文`)
  if (capabilities?.reasoning) chips.push('思考')
  if (capabilities?.toolCall) chips.push('工具调用')
  if (capabilities?.attachment) chips.push('图片/文件')
  if (meta.reasoningOptions?.some((option) => option.type === 'effort')) chips.push('推理档位')
  if (meta.protocol) chips.push(meta.protocol)
  if (chips.length === 0) return null
  return (
    <span className="ai-bar-sub">
      {chips.join(' · ')}
      {meta.source && meta.source !== 'bundled' ? ` · 元数据 ${meta.source}` : ''}
    </span>
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

/** 参数展开区：`{"path":"notes/x.md"}` 这种原始入参是排查工具行为最直接的证据 */
function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function ToolChip({ call, live }: { call: AiToolCall; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[call.name] || Info
  const hasResult = typeof call.result === 'string' && call.result.length > 0
  const argsText = formatToolArgs(call.args)
  const hasArgs = argsText.length > 0
  // 运行中也要能展开：工具正在跑的时候用户最想看的就是"它到底带了什么参数"。
  // 旧实现只允许有 result 的卡片展开，于是进行中的调用点了没反应。
  const expandable = hasResult || hasArgs
  const isMemoryWrite =
    call.name === 'write_note' &&
    (String(call.args?.path || '').startsWith('memory/') || call.friendly.includes('memory/'))
  return (
    <div className={`ai-tool-card${call.ok ? ' ok' : call.ok === false ? ' err' : ''}${live ? ' live' : ''}${isMemoryWrite ? ' memory-write' : ''}`}>
      <button
        type="button"
        className={`ai-tool-row${open ? ' open' : ''}`}
        onClick={() => expandable && setOpen((v) => !v)}
        disabled={!expandable}
        aria-expanded={open}
        title={expandable ? (open ? '收起详情' : '展开参数与结果') : undefined}
      >
        {expandable ? (
          <ChevronDown size={12} className={`ai-tool-chev${open ? ' open' : ''}`} />
        ) : (
          <span className="ai-tool-chev-placeholder" />
        )}
        <span className="ai-tool-icon">
          <Icon size={13} strokeWidth={1.8} />
        </span>
        <span className="ai-tool-friendly">{call.friendly}</span>
        {isMemoryWrite && <span className="ai-memory-write-badge">长期记忆已修改</span>}
        <span className="ai-tool-status">
          {call.ok === true ? <CheckCircle2 size={13} /> : call.ok === false ? <XCircle size={13} /> : live ? <span className="ai-spinner" /> : null}
        </span>
      </button>
      {open && expandable && (
        <div className="ai-tool-detail">
          {hasArgs && (
            <>
              <div className="ai-tool-detail-label">参数</div>
              <pre>{argsText}</pre>
            </>
          )}
          {hasResult && (
            <>
              <div className="ai-tool-detail-label">结果</div>
              <pre>{call.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function WeportAiPanel({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const api = window.electronAPI
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [chats, setChats] = useState<AiChatMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<LiveState | null>(null)
  const [input, setInput] = useState('')
  // `@` 引用：在输入框里打 `@` 会弹出会话选择器，与 WeBot 任务描述共用同一个
  // 组件和同一套纯逻辑（utils/mentionTrigger.ts）。
  const [mention, setMention] = useState<{ start: number; query: string; caret: number } | null>(null)
  const [references, setReferences] = useState<ChatReference[]>([])
  const [referenceCandidates, setReferenceCandidates] = useState<ReferenceCandidate[]>([])
  const pickerRef = useRef<ReferencePickerHandle>(null)
  const candidatesLoaded = useRef(false)
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
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  /** 待删除的记忆/笔记文件：非空时弹出确认框 */
  const [noteDeleteTarget, setNoteDeleteTarget] = useState<AiNote | null>(null)
  const [compacting, setCompacting] = useState(false)
  /** 轻量提示（压缩结果这类不需要打断操作的信息） */
  const [notice, setNotice] = useState('')
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
  /** 用户主动上滚后暂停自动跟随；`ai-thread` 右下角给一个「回到底部」的入口 */
  const [followPaused, setFollowPaused] = useState(false)
  /** 流式读数的重算触发器（每 400ms +1） */
  const [nowTick, setNowTick] = useState(0)
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
      // 同步更新 ref，别等下面那个 effect：`getChat` 的响应可能在 React 提交
      // 这次 setActiveId 之前就回来，那样第 391 行的守卫会把响应当成"过期"丢弃，
      // 页面就永远停在空态（真机上表现为「打开 WeportAI 看不到上次的对话」）。
      activeIdRef.current = id
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
              // A missing window means "unknown" and must render as `—`. The old
              // `|| 1000000` fallback is what made a 128k model look like it was
              // using 4% of its window.
              contextWindow: last.context.contextWindow || 0,
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
          setLive((prev) => {
            const now = Date.now()
            return {
              reasoning: (prev?.reasoning || '') + e.delta,
              text: prev?.text || '',
              tools: prev?.tools || [],
              firstTokenAt: prev?.firstTokenAt ?? now,
              lastTokenAt: now,
            }
          })
          break
        case 'text_delta':
          setLive((prev) => {
            const now = Date.now()
            return {
              reasoning: prev?.reasoning || '',
              text: (prev?.text || '') + e.delta,
              tools: prev?.tools || [],
              firstTokenAt: prev?.firstTokenAt ?? now,
              lastTokenAt: now,
            }
          })
          break
        case 'tool_start':
          setLive((prev) => ({
            reasoning: prev?.reasoning || '',
            text: prev?.text || '',
            firstTokenAt: prev?.firstTokenAt,
            lastTokenAt: prev?.lastTokenAt,
            tools: [
              ...(prev?.tools || []).filter((t) => t.id !== e.callId),
              { id: e.callId, name: e.name, friendly: e.friendly, args: e.args, running: true },
            ],
          }))
          break
        case 'tool_result':
          setLive((prev) => ({
            reasoning: prev?.reasoning || '',
            text: prev?.text || '',
            firstTokenAt: prev?.firstTokenAt,
            lastTokenAt: prev?.lastTokenAt,
            tools: (prev?.tools || []).map((t) =>
              t.id === e.callId ? { ...t, ok: e.ok, summary: e.summary, running: false, result: e.detail ?? t.result } : t,
            ),
          }))
          if (e.name === 'write_note' || e.name === 'list_notes') setNotesDirty(true)
          break
        case 'assistant_message': {
          setLive(null)
          const msg = e as unknown as { message: AiMessage; timing?: AiMessage['timing'] }
          setMessages((prev) => [...prev, msg.timing ? { ...msg.message, timing: msg.timing } : msg.message])
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
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    stickToBottom.current = atBottom
    // 只有"用户自己滚上去"才切到暂停跟随；程序化滚动到底部不算改变意图。
    setFollowPaused(!atBottom)
  }, [])

  const resumeFollow = useCallback(() => {
    stickToBottom.current = true
    setFollowPaused(false)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // 流式期间每 400ms 让读数重新计算一次。没有这个 tick，速度只在收到新 delta
  // 时刷新 —— 模型卡住不动时读数会定格在旧值上，看起来像还在飞速输出。
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setNowTick((v) => v + 1), 400)
    return () => window.clearInterval(timer)
  }, [live])

  // 实时 TPS：与 messageTps 同口径，只是 token 数用字符数估算（流式阶段拿不到
  // usage）。解码时间同样从首个 token 起算，不含首 token 等待。
  const liveTps = useMemo(() => {
    if (!live?.firstTokenAt) return null
    const chars = (live.text?.length || 0) + (live.reasoning?.length || 0)
    if (chars === 0) return null
    // 用「最后一个 delta 的时间」而不是 Date.now()：模型停住时读数应当跟着停住，
    // 而不是被一个不断变大的分母慢慢稀释成越来越小的数字。
    const decodeMs = Math.max(1, (live.lastTokenAt || live.firstTokenAt) - live.firstTokenAt)
    return chars / 2.5 / (decodeMs / 1000)
  }, [live, nowTick])

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

  /**
   * 懒加载会话候选：只有用户第一次打出 `@` 时才去读会话列表。
   * 打开 AI 页面本身不该触发一次全量会话查询。
   */
  async function ensureReferenceCandidates(): Promise<void> {
    if (candidatesLoaded.current) return
    candidatesLoaded.current = true
    try {
      const raw = (await api.chat.getSessions()) as { data?: unknown[] } | unknown[]
      const list = (Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : []) as Array<Record<string, unknown>>
      const mapped: ReferenceCandidate[] = []
      for (const session of list) {
        const id = String(session.username || '').trim()
        if (!id) continue
        const kind: ReferenceCandidate['kind'] = id.endsWith('@chatroom')
          ? 'group'
          : id.startsWith('gh_')
            ? 'official'
            : 'private'
        const label = String(session.displayName || session.remark || session.nickName || id)
        mapped.push({ id, label, kind, avatarUrl: session.avatarUrl as string | undefined })
      }
      setReferenceCandidates(
        mapped.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'group' ? -1 : b.kind === 'group' ? 1 : 0
          return a.label.localeCompare(b.label)
        })
      )
    } catch {
      setReferenceCandidates([])
    }
  }

  function syncMention(value: string, caret: number): void {
    const active = findActiveMention(value, caret)
    if (active) void ensureReferenceCandidates()
    setMention(active ? { ...active, caret } : null)
  }

  function pickReference(reference: ChatReference): void {
    if (!mention) return
    const node = inputRef.current
    const caret = node?.selectionStart ?? mention.caret
    const { value, caret: nextCaret } = applyMention(input, { start: mention.start, query: mention.query }, caret, reference.label)
    handleInputChange(value)
    setReferences((prev) => (prev.some((item) => item.id === reference.id) ? prev : [...prev, reference]))
    setMention(null)
    requestAnimationFrame(() => {
      node?.focus()
      node?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  async function handleSend(textOverride?: string) {
    const text = (textOverride ?? input).trim()
    if (!text || !activeId || running) return
    setInput('')
    setReferences([])
    resetInputHeight()
    stickToBottom.current = true
    setError('')
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content: text, createdAt: Date.now() }])
    setLive({ reasoning: '', text: '', tools: [] })
    try {
      // 引用以**追加**的一小段提示随这条用户消息一起发出，而不是改写系统提示
      // 或历史 —— 前者会摧毁前缀缓存，而这段提示本身就是本次新增的输入。
      const payload = references.length > 0
        ? `${text}\n\n（本次聚焦以下会话，请优先分析它们：${references
            .map((reference) => `${reference.label} = ${reference.id}`)
            .join('；')}）`
        : text
      const res = await api.ai.send(activeId, payload)
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

  /**
   * Metadata for the profile the run will actually use. This is what drives the
   * capability chips and the pricing line: the panel must describe the model
   * that is about to be called, not a hard-coded assumption.
   */
  const activeModelMeta = useMemo<ProviderModelMetadata | null>(() => {
    if (!setup) return null
    const profile = setup.profiles.find((p) => p.id === setup.activeProfileId) || setup.profiles[0]
    return profile || null
  }, [setup])

  /** 当前模型的价格：主进程按模型 id 解出的权威表（见 lookupCost 的说明） */
  const activeModelCost = useMemo(
    () => lookupCost(setup, setup?.model),
    [setup],
  )

  const runCost = useMemo(
    () =>
      usage
        ? estimateRunCost(activeModelCost, {
            promptTokens: usage.promptTokens,
            cacheHitTokens: usage.cacheHitTokens,
            completionTokens: usage.completionTokens,
          })
        : null,
    [usage, activeModelCost],
  )

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

  /**
   * 删除记忆/笔记文件前必须确认。
   *
   * 这些文件是 agent 长期记忆的唯一副本（`memory/` 跨会话共享），一次误点的
   * 代价是不可恢复的。对话删除早就有确认框，文件删除却一直是"点一下就没了"。
   */
  function requestDeleteNote(note: AiNote) {
    setNoteDeleteTarget(note)
  }

  async function confirmDeleteNote() {
    const note = noteDeleteTarget
    setNoteDeleteTarget(null)
    setViewingNote(null)
    if (!note || !activeId) return
    try {
      await api.ai.deleteNoteFile(activeId, note.path)
      await refreshNotesList()
    } catch {
      setError('删除文件失败')
    }
  }

  /** 手动压缩上下文：与 runChat 的自动压缩共用 service 侧实现。 */
  async function compactNow() {
    if (!activeId || compacting) return
    setCompacting(true)
    try {
      const res = await api.ai.compactChat(activeId)
      if (!res.success) {
        setError(res.error || '压缩失败')
      } else if (!res.changed) {
        pushLocalNotice('当前上下文尚未超过压缩阈值，未做改动')
      } else {
        pushLocalNotice(`已压缩：归档 ${res.dropped ?? 0} 条，保留 ${res.kept ?? 0} 条`)
        const data = await api.ai.getChat(activeId)
        setMessages(data?.messages || [])
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setCompacting(false)
    }
  }

  function openMemoryFolder() {
    if (memoryDir) void api.shell.openPath(memoryDir)
  }

  function pushLocalNotice(text: string) {
    setNotice(text)
    window.setTimeout(() => setNotice((current) => (current === text ? '' : current)), 4000)
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
            <button
              type="button"
              className="ai-settings-btn"
              onClick={onOpenSettings}
              title="AI 服务设置（提供商 · 模型 · 密钥）"
            >
              <Settings2 size={14} />
              设置
            </button>
          </div>
        </div>
      </aside>

      {/* 中栏：对话 */}
      <main className="ai-main">
        {/* 顶栏：会话标题 + 模型 + 上下文/缓存读数。原来主栏没有头，模型名塞在
            左栏底部，用户回答不出"我现在用的是哪个模型、上下文用了多少"。 */}
        <div className="ai-topbar">
          <h1>{chats.find((c) => c.id === activeId)?.title || 'WeportAI'}</h1>
          <div className="ai-topbar-meta">
            {setup?.model ? (
              <span className="ai-meter ai-meter-model" title={`当前 AI 服务与模型：${setup.model}`}>
                <span className="ai-meter-label">模型</span>
                <b>{setup.model}</b>
              </span>
            ) : null}
            {ctxStats && ctxStats.contextWindow > 0 ? (
              <span
                className="ai-meter"
                data-tone={ctxStats.promptTokens / ctxStats.contextWindow > 0.75 ? 'warn' : undefined}
                title="最近一次请求的上下文占用"
              >
                <span className="ai-meter-label">上下文</span>
                <b>{Math.round((ctxStats.promptTokens / ctxStats.contextWindow) * 100)}%</b>
              </span>
            ) : null}
            {/* 当前模型的单价（USD / 1M tokens）。放在顶栏而不是埋在设置里：
                "这一轮大概花了多少"必须先知道单价。未定价的模型明确写「未定价」，
                不能显示成 $0.00 —— 未定价和免费是两件事。 */}
            {setup?.model ? (
              <span
                className="ai-meter ai-meter-cost"
                data-tone={activeModelCost ? undefined : 'warn'}
                title={costTooltip(activeModelCost)}
              >
                <span className="ai-meter-label">单价</span>
                <b>{fmtPrice(activeModelCost)}</b>
              </span>
            ) : null}
            {usage ? (
              <span className="ai-meter" data-tone="ok" title="最近一次请求的缓存命中率">
                <span className="ai-meter-label">缓存</span>
                <b>{usage.promptTokens > 0 ? Math.round((usage.cacheHitTokens / usage.promptTokens) * 100) : 0}%</b>
              </span>
            ) : null}
            {usage ? (
              <span className="ai-meter" title={`本轮累计花费（按上面单价估算）：${fmtCost(runCost)}`}>
                <span className="ai-meter-label">本轮</span>
                <b>{fmtCost(runCost)}</b>
              </span>
            ) : null}
            {/* 压缩上下文的显式入口。自动压缩只在用户回合边界且超过 0.8 窗口时
                触发，长任务中途想主动腾空间没有别的办法。 */}
            <button
              type="button"
              className="ai-meter ai-meter-action"
              onClick={() => void compactNow()}
              disabled={!activeId || compacting || running}
              title="把较早的轮次折叠进摘要，保留最近一段原文。归档原文不会丢失。"
            >
              <span className="ai-meter-label">{compacting ? '压缩中…' : '压缩'}</span>
              <b>上下文</b>
            </button>
          </div>
        </div>

        {notice && (
          <div className="ai-notice" role="status">
            {notice}
          </div>
        )}

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
                {/* 本轮解码速度。只在有计时数据时出现（旧记录没有），不占位。 */}
                {(() => {
                  const tps = messageTps(m.timing)
                  if (tps === null) return null
                  return (
                    <div className="ai-msg-stats" title={`首 token ${(m.timing!.ttftMs / 1000).toFixed(1)}s · 解码 ${(m.timing!.decodeMs / 1000).toFixed(1)}s · ${m.timing!.outputTokens} tokens`}>
                      <span className="ai-msg-tps">{formatTokensPerSecond(tps)} tok/s</span>
                    </div>
                  )
                })()}
              </div>
            ),
          )}

          {live && (
            <div className="ai-msg assistant live">
              {live.tools.length > 0 && (
                <div className="ai-tool-stack">
                  {live.tools.map((t) => (
                    <ToolChip
                      key={t.id}
                      call={{ id: t.id, name: t.name, args: t.args || {}, friendly: t.friendly, ok: t.ok, result: t.result }}                      live={t.running}
                    />
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
              {/* 流式期间的实时读数：与 DSH 同一口径（首 token 之后的解码速度）。
                  token 数按字符数 / CHARS_PER_TOKEN 估算 —— 流式阶段没有 usage，
                  估算值用来给量级感知，落库后的正式读数走 messageTps。 */}
              {liveTps !== null && (
                <div className="ai-msg-stats live">
                  <span className="ai-msg-tps">{formatTokensPerSecond(liveTps)} tok/s</span>
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

        {/* 用户上滚阅读时暂停自动跟随，并给出明确的「回到最新」入口。
            旧实现只在"离底部 < 120px"时才继续跟随，但流式输出把滚动位置一直
            拽回底部，用户刚滚上去就被拉回来 —— 想读上面一段几乎不可能。 */}
        {followPaused && (
          <button type="button" className="ai-follow-resume" onClick={resumeFollow}>
            <ChevronDown size={13} />
            回到最新
            {running && <span className="ai-follow-live" />}
          </button>
        )}

        {/* 引用 chip 与选择器都放在 composer 之外：composer 是横向 flex，
            把弹层塞进去会被裁切。 */}
        {references.length > 0 && (
          <div className="ref-chips ai-ref-chips">
            {references.map((reference) => (
              <span className="ref-chip" key={reference.id}>
                @{reference.label}
                <span className="ai-ref-kind">{referenceKindLabel(reference.kind)}</span>
                <button
                  type="button"
                  onClick={() => setReferences((prev) => prev.filter((item) => item.id !== reference.id))}
                  aria-label={`移除引用 ${reference.label}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {mention && (
          <div className="ai-ref-picker">
            <ReferencePicker
              ref={pickerRef}
              query={mention.query}
              candidates={referenceCandidates}
              onQueryChange={(query) => setMention((prev) => (prev ? { ...prev, query } : prev))}
              onPick={pickReference}
              onClose={() => setMention(null)}
            />
          </div>
        )}

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
            placeholder={running ? '正在执行…' : '分析你的聊天记录…'}
            rows={1}
            onChange={(e) => {
              handleInputChange(e.target.value)
              syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyDown={(e) => {
              // 选择器优先消费按键（上下/回车/Tab/Esc）；没被消费才走发送逻辑，
              // 否则用户没法在引用选择器打开时正常打字。
              if (mention && pickerRef.current?.handleKeyDown(e as unknown as { key: string; preventDefault: () => void })) {
                e.preventDefault()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleSend()
              } else if (e.key === 'Enter' && e.shiftKey) {
                // Shift+Enter：插入换行，输入框自动向上扩展
                window.requestAnimationFrame(() => handleInputChange(e.currentTarget.value))
              } else if (mention && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) {
                setMention(null)
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
                        <button type="button" className="ai-ws-note-del" title="删除此文件" onClick={() => requestDeleteNote(n)}>
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
                        <button type="button" className="ai-ws-note-del" title="删除此文件" onClick={() => requestDeleteNote(n)}>
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
                  {/* No window ⇒ no honest percentage. Render `—` rather than a
                      number computed against a guessed 1M denominator. */}
                  {ctxStats && ctxStats.contextWindow > 0
                    ? `${Math.round((ctxStats.lastRequestTokens / ctxStats.contextWindow) * 100)}%`
                    : '—'}
                </em>
              </div>
              <div className="ai-bar">
                <div
                  className="ai-bar-fill ctx"
                  style={{
                    width:
                      ctxStats && ctxStats.contextWindow > 0
                        ? `${Math.min(100, (ctxStats.lastRequestTokens / ctxStats.contextWindow) * 100)}%`
                        : '0%',
                  }}
                />
              </div>
              <span className="ai-bar-sub">
                {ctxStats && ctxStats.contextWindow > 0
                  ? `${ctxStats.lastRequestTokens.toLocaleString()} / ${fmtTokens(ctxStats.contextWindow)}`
                  : ctxStats
                    ? `${ctxStats.lastRequestTokens.toLocaleString()} / 未知窗口`
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
                {usage.reasoningTokens > 0 ? `（思考 ${usage.reasoningTokens.toLocaleString()}）` : ''} · 约 {fmtCost(runCost)}
                {runCost === null ? '（模型未公布价格）' : '（按模型官方价估算）'}
              </span>
            )}
            <ModelMetaLine meta={activeModelMeta} />
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
                  requestDeleteNote(viewingNote.note)
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

      {noteDeleteTarget && (
        <div className="modal-backdrop" onClick={() => setNoteDeleteTarget(null)}>
          <div className="modal danger" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ai-del-file-title">
            <h3 id="ai-del-file-title">
              <Trash2 size={15} />
              删除这个文件？
            </h3>
            <p>
              <code>{noteDeleteTarget.path}</code>
              <br />
              {noteDeleteTarget.scope === 'memory'
                ? '这是跨会话共享的长期记忆，删除后 agent 将不再记得其中记录的内容，且不会随对话一起恢复。'
                : '这是本对话的草稿笔记。'}
              此操作不可恢复。
            </p>
            <div className="modal-actions">
              <button className="secondary-btn" type="button" onClick={() => setNoteDeleteTarget(null)}>
                取消
              </button>
              <button className="danger-btn" type="button" onClick={() => void confirmDeleteNote()}>
                <Trash2 size={13} />
                确认删除
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


