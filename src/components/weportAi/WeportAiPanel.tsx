import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import ReferencePicker, { type ReferenceCandidate, type ReferencePickerHandle } from '../reference/ReferencePicker'
import FloatingLayer from '../ui/FloatingLayer'
import { findActiveMention, referenceKindLabel, rewriteMentionQuery, stripMention, type ChatReference } from '../../utils/mentionTrigger'
import { loadReferenceCandidates } from '../../utils/sessionCandidates'
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
  Images,
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
type AiToolCall = { id: string; name: string; args: Record<string, unknown>; friendly: string; ok?: boolean; result?: string; imageCount?: number }
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
  | { type: 'deltas'; chatId: string; items: Array<{ kind: 'text' | 'reasoning'; delta: string }> }
  | { type: 'tool_start'; chatId: string; callId: string; name: string; args: Record<string, unknown>; friendly: string }
  | { type: 'tool_result'; chatId: string; callId: string; name: string; ok: boolean; summary: string; detail?: string; imageCount?: number }
  | { type: 'assistant_message'; chatId: string; message: AiMessage; timing?: { ttftMs: number; decodeMs: number; outputTokens: number } }
  | { type: 'chat_title'; chatId: string; title: string }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'done'; chatId: string; usage?: { promptTokens: number; completionTokens: number; reasoningTokens: number; totalTokens: number; promptCacheHitTokens?: number }; aborted?: boolean; context?: { promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number } }
  | { type: 'context'; chatId: string; promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number }

import { type AiAction, type ProviderCatalogEntry, type ProviderModelMetadata, type ProviderProfileSummary, type ProviderProtocol, type SetupInfo } from './aiPanelTypes'
type AiNote = { path: string; bytes: number; mtime: number; scope: 'memory' | 'notes' }

type LiveTool = { id: string; name: string; friendly: string; args?: Record<string, unknown>; ok?: boolean; summary?: string; result?: string; running: boolean; imageCount?: number }
type LiveState = { reasoning: string; text: string; tools: LiveTool[]; firstTokenAt?: number; lastTokenAt?: number }

/**
 * 每个模型步骤一个全新的 live 气泡：服务端在**每个** assistant 步骤（含工具
 * 轮次）完成后都会发 `assistant_message`，面板收到后把这一轮归档进 transcript
 * 并重置 live。于是：
 * - 工具卡只在当前步骤的气泡里出现，不再整轮堆在一个气泡顶部；
 * - `firstTokenAt`/`lastTokenAt` 每步重来 —— 实时 TPS 的分母是「这一步的解码」，
 *   不再把工具执行耗时和下一步的 TTFT 摊进去。
 */
function emptyLive(): LiveState {
  return { reasoning: '', text: '', tools: [], firstTokenAt: undefined, lastTokenAt: undefined }
}

function applyDelta(prev: LiveState | null, kind: 'text' | 'reasoning', delta: string): LiveState {
  const base = prev || emptyLive()
  const now = Date.now()
  return {
    reasoning: kind === 'reasoning' ? base.reasoning + delta : base.reasoning,
    text: kind === 'text' ? base.text + delta : base.text,
    tools: base.tools,
    firstTokenAt: base.firstTokenAt ?? now,
    lastTokenAt: now,
  }
}

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

/**
 * 流式阶段的 token 估算（无 usage 时才用）。按 DeepSeek 官方换算：
 * 1 个中文字符 ≈ 0.6 token，1 个英文字符 ≈ 0.3 token。
 *
 * 旧实现用压缩预算那个 `chars / 2.5`（0.4 tok/char）—— 那是「宁可早压缩」的
 * 保守系数，不是估算器：对中文为主的思考流它把读数**系统性压低约 1/3**，
 * 正是「TPS 看着偏低」的来源之一。
 */
function estimateTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (
      (code >= 0x3400 && code <= 0x9fff) || // CJK 扩展 A + 区间
      (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
      (code >= 0x3000 && code <= 0x303f) || // CJK 标点
      (code >= 0xff00 && code <= 0xffef) // 全角形式
    ) cjk += 1
  }
  return cjk * 0.6 + (text.length - cjk) * 0.3
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
  read_chat_images: Images,
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
 * 定价估算**已移除**（v1.0.1）。
 *
 * 面板上曾经有一个「单价」读数和一个「本轮花费」读数，数字来自 models.dev 的
 * 定价表。问题是那张表对国内可用的服务商覆盖很差：用户实际在用的模型大多没有
 * 收录，于是顶栏长期显示「未定价 / N/A」，偶尔出现的数字也只是**估算**——
 * 缓存折扣、批处理价、阶梯价、促销价都不在里面。一个大部分时候没有值、
 * 有值时又不可依赖的读数，比没有这个读数更糟：用户会照着它做判断。
 *
 * 真正的账单在服务商后台。token 用量（提示 / 补全 / 缓存命中）仍然照常显示，
 * 那是我们自己数出来的事实，不是估算。
 */

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
  const hasResult = typeof call.result === 'string' && call.result.length > 0
  const argsText = formatToolArgs(call.args)
  const hasArgs = argsText.length > 0
  // 运行中也要能展开：工具正在跑的时候用户最想看的就是"它到底带了什么参数"。
  // 旧实现只允许有 result 的卡片展开，于是进行中的调用点了没反应。
  const expandable = hasResult || hasArgs
  const isMemoryWrite =
    call.name === 'write_note' &&
    (String(call.args?.path || '').startsWith('memory/') || call.friendly.includes('memory/'))
  // 超紧凑单行：名字 + 证据标记 + 状态字形。没有卡片盒子、没有图标配对、没有
  // 徽章胶囊 —— 调用是**过程**，密度优先；细节全在点开后的 pre 里。
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
        <span className="ai-tool-chev">{open ? '▾' : '▸'}</span>
        <span className="ai-tool-friendly">{call.friendly}</span>
        {isMemoryWrite && <span className="ai-memory-write-badge">记忆</span>}
        {/* 「看过图」必须看得见：用户要能确认这次回答是基于画面，而不是模型猜的。 */}
        {call.imageCount ? (
          <span className="ai-tool-image-badge" title={`已把 ${call.imageCount} 张图片附给模型看`}>
            图×{call.imageCount}
          </span>
        ) : null}
        <span className="ai-tool-status">
          {call.ok === true ? '✓' : call.ok === false ? '✗' : live ? <span className="ai-spinner" /> : ''}
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
  // 候选是否**成功**读到 + 失败原因：空态文案是「读失败」还是「没有会话」取决于它。
  const [candidatesState, setCandidatesState] = useState<{ loading: boolean; ok: boolean; error?: string }>({
    loading: false,
    ok: true,
  })
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
      // 菜单渲染在 body 下的浮层里（不在 actionsRef 内），所以两处都要看：
      // 只查 actionsRef 会让"点菜单项"先把菜单关掉，点击落空。
      const target = e.target as Node
      if (actionsRef.current?.contains(target)) return
      if ((target as HTMLElement)?.closest?.('.ai-actions-layer')) return
      setActionsOpen(false)
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
          setLive((prev) => applyDelta(prev, 'reasoning', e.delta))
          break
        case 'text_delta':
          setLive((prev) => applyDelta(prev, 'text', e.delta))
          break
        case 'deltas': {
          // 批量 delta：一批只做一次状态更新（逐 token 更新会把整段 markdown
          // 每个 delta 都重新解析一遍，长回复下渲染层自己把自己拖慢）。
          const items = e.items
          setLive((prev) => {
            let cur = prev
            for (const item of items) cur = applyDelta(cur, item.kind, item.delta)
            return cur
          })
          break
        }
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
              t.id === e.callId
                ? { ...t, ok: e.ok, summary: e.summary, running: false, result: e.detail ?? t.result, imageCount: e.imageCount }
                : t,
            ),
          }))
          if (e.name === 'write_note' || e.name === 'list_notes') setNotesDirty(true)
          break
        case 'assistant_message': {
          // 每个步骤（含工具轮次）归档进 transcript，live 开一个全新的气泡 ——
          // 工具卡不再跨步骤累积，TPS 时间窗也回到本步（见 emptyLive 注释）。
          setLive(emptyLive())
          const msg = e as unknown as { message: AiMessage; timing?: AiMessage['timing'] }
          setMessages((prev) => (prev.some((m) => m.id === msg.message.id) ? prev : [...prev, msg.timing ? { ...msg.message, timing: msg.timing } : msg.message]))
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

  /**
   * 用户往上滚一次就**停跟随**，直到他滑回底部（或点"回到最新"）。
   *
   * 旧实现只看"距底 < 120px"：流式输出每来一个 delta 都会执行上面那个"贴底就滚到底"
   * 的 effect，用户刚往上拖 60px（还在判定区内）就被下一个 delta 拽回底部 ——
   * 表现就是"想上滚，画面一顿一顿地往下坠"。拖动滚动条时每次 scroll 事件也都在
   * 判定区内，所以只按距离判断永远拦不住。
   *
   * 现在改成**显式的用户意图**：滚轮 / 触摸拖动 / 拖动滚动条（pointerdown 后 600ms
   * 内的滚动）任一发生且不在底部，就停跟随；判定阈值也从 120px 收到 24px。
   */
  const userScrollIntentAt = useRef(0)
  const markUserScrollIntent = useCallback(() => {
    userScrollIntentAt.current = Date.now()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('wheel', markUserScrollIntent, { passive: true })
    el.addEventListener('touchmove', markUserScrollIntent, { passive: true })
    el.addEventListener('pointerdown', markUserScrollIntent)
    return () => {
      el.removeEventListener('wheel', markUserScrollIntent)
      el.removeEventListener('touchmove', markUserScrollIntent)
      el.removeEventListener('pointerdown', markUserScrollIntent)
    }
  }, [markUserScrollIntent])

  const handleThreadScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (!atBottom && Date.now() - userScrollIntentAt.current < 600) {
      stickToBottom.current = false
      setFollowPaused(true)
      return
    }
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

  // 实时 TPS：与 messageTps 同口径，只是 token 数用 CJK 感知的估算（流式阶段
  // 拿不到 usage）。解码时间同样从首个 token 起算，且因为每个步骤都重置 live，
  // 分母**不含**工具执行与下一步 TTFT —— 以前整轮一个气泡时这些全被摊进来。
  const liveTps = useMemo(() => {
    if (!live?.firstTokenAt) return null
    const tokens = estimateTokens((live.text || '') + (live.reasoning || ''))
    if (tokens === 0) return null
    // 用「最后一个 delta 的时间」而不是 Date.now()：模型停住时读数应当跟着停住，
    // 而不是被一个不断变大的分母慢慢稀释成越来越小的数字。
    const decodeMs = Math.max(1, (live.lastTokenAt || live.firstTokenAt) - live.firstTokenAt)
    return tokens / (decodeMs / 1000)
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
   *
   * 两个约束（都是用户报过的 bug）：
   * - 解包走 `utils/sessionCandidates`，`chat:getSessions` 的返回是 `{ sessions }`
   *   而不是 `{ data }` —— 以前按 `data` 解包，于是永远显示「先连接微信」。
   * - **失败/空结果不算"已加载"**：用户完全可以先打开这一页、再去连微信，
   *   若把那次失败标记成已加载，`@` 就再也不会重新读一次。
   */
  async function ensureReferenceCandidates(force = false): Promise<void> {
    if (candidatesLoaded.current && !force) return
    setCandidatesState((prev) => ({ ...prev, loading: true }))
    const result = await loadReferenceCandidates(() => api.chat.getSessions())
    setCandidatesState({ loading: false, ok: result.ok, error: result.error })
    if (result.ok) {
      candidatesLoaded.current = true
      setReferenceCandidates(result.candidates)
    } else {
      candidatesLoaded.current = false
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
    // 光标只有焦点还在输入框里时才可信：用户在弹层搜索框里打过字之后，
    // selectionStart 是旧值，用它切文本会切错位置。
    const caret = document.activeElement === node ? (node?.selectionStart ?? mention.caret) : mention.caret
    // **只加 chip，不往输入框里写 `@名称`**：同一份引用此前会出现两次
    // （输入框里一次、输入框上方的 chip 区一次），用户要的是只留 chip。
    const { value, caret: nextCaret } = stripMention(input, { start: mention.start, query: mention.query }, caret)
    handleInputChange(value)
    setReferences((prev) => (prev.some((item) => item.id === reference.id) ? prev : [...prev, reference]))
    setMention(null)
    requestAnimationFrame(() => {
      node?.focus()
      node?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  /**
   * 浮层搜索框改了查询串 → 改写输入框里的那段 `@查询`。
   *
   * 查询串的唯一来源是输入框的文本（弹层只是它的另一个视图）；两边各存一份
   * 状态最后一定会跑偏。
   */
  function setMentionQuery(query: string): void {
    if (!mention) return
    const node = inputRef.current
    const caret = document.activeElement === node ? (node?.selectionStart ?? mention.caret) : mention.caret
    const { value, caret: nextCaret } = rewriteMentionQuery(input, { start: mention.start, query: mention.query }, caret, query)
    handleInputChange(value)
    setMention({ start: mention.start, query: value.slice(mention.start + 1, nextCaret), caret: nextCaret })
    // 焦点在弹层搜索框里时不要抢回来 —— 用户正在那里打字。
    if (document.activeElement?.closest?.('.ref-picker')) return
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

  /** 当前模型的价格读数已移除 —— 见文件上方「定价估算已移除」的说明。 */

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
            {/* 这里曾经还有「单价」与「本轮花费」两个读数。定价估算在 v1.0.1 移除：
                它依赖 models.dev 的定价表，而那张表覆盖不到用户实际在用的服务商，
                于是长期显示「未定价」，偶尔出现的数字也只是估算。token 用量仍然显示
                —— 那是我们自己数的，不是估的。 */}
            {usage ? (
              <span className="ai-meter" data-tone="ok" title="最近一次请求的缓存命中率">
                <span className="ai-meter-label">缓存</span>
                <b>{usage.promptTokens > 0 ? Math.round((usage.cacheHitTokens / usage.promptTokens) * 100) : 0}%</b>
              </span>
            ) : null}
            {usage ? (
              <span className="ai-meter" title="本轮累计 token 用量（提示 / 补全）">
                <span className="ai-meter-label">本轮</span>
                <b>{fmtTokens(usage.totalTokens)} tok</b>
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
                  /* 工具轮次：模型先说的计划文字 + 思考片段与工具调用交错展示 */
                  <>
                    {m.content ? <AiMarkdown text={m.content} /> : null}
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
                  </>
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
              {/* 工具行排在文字**之后**：模型先说、再调用，时间序即视觉序。旧实现
                  把工具栈放最上面，新一轮的卡一来就压在上一段文字头顶上。 */}
              {live.tools.length > 0 && (
                <div className="ai-tool-stack">
                  {live.tools.map((t) => (
                    <ToolChip
                      key={t.id}
                      call={{ id: t.id, name: t.name, args: t.args || {}, friendly: t.friendly, ok: t.ok, result: t.result, imageCount: t.imageCount }}                      live={t.running}
                    />
                  ))}
                </div>
              )}
              {/* 流式期间的实时读数：与 DSH 同一口径（首 token 之后的解码速度）。
                  token 数用 CJK 感知估算；每个步骤 live 都会重置，所以分母只含
                  本步解码，不含工具执行与下一次 TTFT。 */}
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
          <ReferencePicker
            ref={pickerRef}
            anchor={inputRef}
            query={mention.query}
            candidates={referenceCandidates}
            loading={candidatesState.loading}
            ok={candidatesState.ok}
            error={candidatesState.error}
            onQueryChange={setMentionQuery}
            onPick={pickReference}
            onClose={() => setMention(null)}
            pickedIds={references.map((item) => item.id)}
            onReturnFocus={() => inputRef.current?.focus()}
          />
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
              /* 浮层渲染到 body 下：输入条在页面底部，菜单向上展开，挂在文档流里
                 会被主区域的滚动/裁切吃掉一半。 */
              <FloatingLayer
                anchor={actionsRef}
                open
                placement="top-start"
                gap={8}
                width={320}
                minHeight={120}
                className="ai-actions-layer"
              >
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
              </FloatingLayer>
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
                {usage.reasoningTokens > 0 ? `（思考 ${usage.reasoningTokens.toLocaleString()}）` : ''}
                {usage.promptTokens > 0
                  ? ` · 提示 ${usage.promptTokens.toLocaleString()} / 补全 ${usage.completionTokens.toLocaleString()}`
                  : ''}
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


