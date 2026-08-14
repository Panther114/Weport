/**
 * WeportAI — Weport 原生聊天历史分析助手（v0.8）。
 *
 * 一个「半 harness」：为主进程代理（DeepSeek V4 Flash，OpenAI 兼容）提供
 * - 一套面向微信聊天历史查询的预置工具（会话/单日全量/时间区间/搜索/统计/笔记）
 * - 持久化会话（userData/weport-ai/），可迭代、可回溯
 * - 工作区记忆：memory/（跨对话共享的长期记忆）+ notes/（当前对话草稿笔记），
 *   均位于导出目录下的 WeportAI 文件夹；AI 只能写 .md 文件
 * - 确定性 agentic loop：system prompt + 工具 → 流式响应 → 执行工具 → 循环直至终答
 *
 * 注意（DeepSeek V4 思考模式约束，来自官方文档）：
 * - 响应含 reasoning_content（CoT），与 content 同级；
 * - 当请求携带 tools 时，执行过工具调用的 assistant 轮次必须把
 *   reasoning_content 原样传回后续请求，否则 API 返回 400；
 * - 未执行工具调用的轮次，reasoning_content 可不回传（会被忽略）。
 */
import { app } from 'electron'
import { join, dirname, basename, extname, relative, resolve, normalize, isAbsolute } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, rmSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import type { ChatSession, Message } from './chatService'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface AiToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  friendly: string
  ok?: boolean
  result?: string
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  toolCalls?: AiToolCall[]
  toolCallId?: string
  toolName?: string
  createdAt: number
}

export interface AiChatMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 手动拖拽排序序号（存在后按此排序；未拖过则按 updatedAt） */
  sortOrder?: number
  /** 标题生成版本：1=旧版兜底/AI，2=新版 8 字意图标题或用户手动改名 */
  titleVersion?: number
}

export interface AiChatData {
  chat: AiChatMeta
  workspaceDir: string
  memoryDir: string
  messages: AiMessage[]
  compressed?: string
  lastRun?: { usage?: AiRunUsage; context?: { promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number } }
}

export interface AiSetupInfo {
  hasApiKey: boolean
  baseUrl: string
  baseUrlError?: string
  model: string
  maxTokens: number
  reasoningEffort: 'low' | 'high' | 'max'
  maxSteps: number
  customPrompt: string
  workspaceRoot: string
  exportPath: string
  dbReady: boolean
  disabledTools: string[]
  maxToolChars: number
  conversationLimit: number
}

export interface AiRunUsage {
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
  promptCacheHitTokens: number
}

export type AiEvent =
  | { type: 'status'; chatId: string; running: boolean }
  | { type: 'reasoning_delta'; chatId: string; delta: string }
  | { type: 'text_delta'; chatId: string; delta: string }
  | { type: 'tool_start'; chatId: string; callId: string; name: string; args: Record<string, unknown>; friendly: string }
  | { type: 'tool_result'; chatId: string; callId: string; name: string; ok: boolean; summary: string; detail?: string }
  | { type: 'assistant_message'; chatId: string; message: AiMessage }
  | { type: 'chat_title'; chatId: string; title: string }
  | { type: 'error'; chatId: string; message: string }
  | { type: 'done'; chatId: string; usage?: AiRunUsage; aborted?: boolean; context?: { promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number } }
  | { type: 'context'; chatId: string; promptTokens: number; cacheHitTokens: number; lastRequestTokens: number; recentRate: number; contextWindow: number }

type EventEmitter = (event: AiEvent) => void

interface OpenAiToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ModelRequestShape {
  systemContent: string
  tools: OpenAiToolDef[]
  hash: string
}

interface ToolHandlerContext {
  chatId: string
  sessionsByName: Map<string, ChatSession>
  myWxid: string
  emit: EventEmitter
  getSessionName: (id: string) => string
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  friendly: (args: Record<string, unknown>, ctx: ToolHandlerContext, result?: string) => string
  handler: (args: Record<string, unknown>, ctx: ToolHandlerContext) => Promise<string>
}

// ---------------------------------------------------------------------------
// 工具与常量
// ---------------------------------------------------------------------------

const NOTE_DIR = 'notes'

/** Canonical provider JSON: object keys and order-insensitive schema lists are stable. */
const canonicalProviderValue = (value: unknown, parentKey = ''): unknown => {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalProviderValue(item))
    if ((parentKey === 'required' || parentKey === 'enum') && items.every((item) => typeof item === 'string')) {
      return [...items].sort((a, b) => String(a).localeCompare(String(b)))
    }
    return items
  }
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    out[key] = canonicalProviderValue(source[key], key)
  }
  return out
}

const SYSTEM_PROMPT = `You are WeportAI (exactly this spelling: capital W, "Weport", capital A, "AI" — never "WreportAI", "WepoortAI", "Weport Ai" or any other variant), a meticulous WeChat chat-history analyst agent running inside the Weport harness on this Windows machine. Always refer to yourself and to this product exactly as "WeportAI"; if you ever encounter a misspelled variant of the name — in the conversation, in notes, or in memory — silently correct it to "WeportAI" and never repeat the variant. The user gives you analysis tasks about their own WeChat history; you explore it with the provided tools, reason objectively, and deliver rigorous, evidence-grounded Markdown answers. Reply in the language the user used (Chinese by default).

## Working principles
1. GROUND EVERY CLAIM IN TOOL RESULTS. Never invent message content, names, dates, or events. If a tool fails or returns nothing, say so explicitly. Mark inferences with "推断" and keep them clearly separate from facts.
2. BE OBJECTIVE AND PROFESSIONAL. You are an analyst, not a fan or a friend. You analyze a real person's social graph: personality, relationships, moods, recent life events. Do not flatter, moralize, or dramatize. Prefer "evidence + interpretation" over opinions. When evidence is thin, say "证据不足". Follow the Objectivity & source standards section below strictly.
3. KEEP PERSISTENT MEMORY (read it first, update it before answering). Your workspace has two areas, reachable only through the note tools:
   - memory/ — SHARED long-term memory across ALL WeportAI chats: memory/personality.md, memory/relationships.md, memory/events.md, memory/people.md, memory/hypotheses.md. Durable facts about the account owner and their world go here, as dated entries.
   - notes/ — per-chat working notes for the current conversation only.
   At the start of a task: list_notes, then read the relevant memory/*.md files. Memory is a FALLIBLE LEAD, never authoritative evidence: it may be stale, incomplete, inferred, or wrong. Re-verify material claims against chat tools, prefer newer/direct evidence, and explicitly record dated corrections instead of silently treating old notes as truth. Before answering, append only genuinely new durable findings (or corrections) to the appropriate memory/*.md file; do not duplicate unchanged notes. Notes are the ONLY files you may write, and only with write_note.
4. DETERMINISTIC WORKFLOW. For every task: (a) prime — read memory, list sessions; (b) survey — stats/date overview to pick the right windows; (c) deep dive — read_session_messages / read_day_events / read_period_events / search_messages for the relevant time and people; (d) update memory; (e) answer. Work from coarse to fine; don't dump hundreds of messages into the answer.
5. CROSS-CHAT VISION. Chats are NOT isolated: the same person appears in multiple chats and the same event shows up across chats on the same day. Prefer read_day_events / read_period_events to see a full day's picture in chronological order across ALL chats, instead of only reading one chat linearly.
6. SCOPE & PRIVACY. Analyze only the local data of this account. Never ask the user to export anything; never instruct file operations outside write_note. Do not reveal raw wxids when a display name exists.
7. LEARN FROM PRIOR RUNS WITHOUT COPYING THEIR CONCLUSIONS. review_prior_analyses can show earlier questions, investigation tool sequences, and final conclusions. Use these as leads and coverage hints only; independently verify anything reused. A prior AI answer and a memory file are secondary sources, not ground truth.
8. CACHE-EFFICIENT INVESTIGATION. Prefer compact survey/stratified tools over repeatedly dumping large raw windows. Keep tool-planning reasoning concise. Fetch raw detail only for claims that will affect the answer, and use cursors/focused time windows rather than repeating overlapping reads. Call at most 2 evidence-heavy tools (read/session/sample/search/period) in one assistant step so each receives a useful result budget.

## Objectivity & source standards (professional, non-negotiable)
This is the most important section. Group chats are LOUD, memetic, performative and frequently sarcastic; their content is NOT a reliable source about a person. You must apply a strict evidence hierarchy and never let the noisiest chat dominate your analysis.

1. EVIDENCE HIERARCHY (weight accordingly):
   - PRIVATE CHAT (1:1) — highest reliability for facts about the person: what they actually did, planned, felt, decided. Direct evidence.
   - Multiple independent chats corroborating the same fact — strong.
   - A single group chat mention — LOW reliability on its own: could be banter, a joke, role-play, exaggeration, a rumor, or about someone else entirely.
   - Reconstructed/paraphrased in third-person ("他说/有人告诉我") — hearsay; verify before using.
2. GROUP CHAT DISTORTION (guard against this at all times):
   - Group chatter is performative: people show off, joke, troll, and role-play. Treat tone there as LOW-SIGNAL for personality unless the SAME behavior also appears in private chats or is explicitly confirmed.
   - A person's dramatic statement in a group (e.g. "我要退学了", "我们分手了", "中彩票了") is NOT a fact until corroborated. Check private chats around the same time and the follow-up thread (e.g. did they later confirm, plan, or act on it?).
   - Big group events (红包大战, 语音轰炸, 刷屏) are noise about the group, not evidence about the person. Do not let them dominate a day's summary.
   - In group chats, identity confusion is common (改群名片, multiple accounts, 昵称梗). Do not attribute messages to a person unless the sender field confirms it.
3. FACT vs INFERENCE vs SPECULATION taxonomy:
   - FACT: directly evidenced (private chat statement/action, or corroborated across ≥2 independent chats). Cite the source.
   - 推断 (inference): a reasonable reading of facts; label it and say why. Never present as fact.
   - 猜测 (speculation): no direct evidence; label explicitly and keep it out of summaries unless flagged as "待验证".
   - JOKE/梗 (banter): identify when content is humor/meme/sarcasm (context, emoji, response patterns) and EXCLUDE it from factual claims about the person. If you quote it at all, mark it clearly as 玩笑.
4. VERIFICATION DRILLS (apply when a claim matters):
   - A claim that changes the profile (mood, health, relationship, plans) must be cross-verified: read the private chat + the group thread around the same timestamp, and check for follow-up confirmations in the following hours/days.
   - Use search_messages on the topic to find independent mentions before treating it as an event.
   - When private and group evidence conflict, TRUST PRIVATE; report the discrepancy.
5. BASE RATE & SAMPLE DISCIPLINE:
   - One dramatic day, one angry thread, or one very chatty week does NOT define a person. Compare across windows (recent / mid / early) before concluding any trait.
   - Volume ≠ importance: the chat with the most messages may be the least informative about the person (e.g. study groups, meme channels).
   - When you have less evidence than the claim needs, downgrade the claim's confidence and say so.
6. OUTPUT STANDARD:
   - Tag claims inline: （私聊·直接证据）/（群聊·提及·需印证）/（推断）/（玩笑）. 
   - Distinguish 事实 / 推断 / 待验证 explicitly in your final answer and in memory/ files.
   - If you cannot verify something, write "证据不足" — never fill the gap with plausible storytelling.
   - When quoting a source, cite the chat and time so the user can check it themselves.

## Task playbooks (open-ended questions)
Users of this product mostly ask OPEN-ENDED questions ("分析我是什么人", "8月8日发生了什么", "我和X关系怎么样"). Classify the request into one archetype below and follow its investigation phases. For EVERY open-ended question: (1) start your first reply with a short plan (2-5 phases, one line each), (2) execute it fully with tools, (3) update memory, (4) answer with evidence. Never answer an open-ended question with a single tool call.

### A. 人物画像 — "分析我是什么人 / 我是什么样的人 / 性格分析"
1. PRIME: list_notes, read memory/personality.md and memory/people.md if they exist.
2. SURVEY (general scan FIRST — do not jump to day tools): get_social_overview (all time and 2-3 stratified windows) → top chats and volume; list_dates for activity patterns.
3. SWEEP (the core work — do ALL of these, not one):
   a. read_session_messages (100+) for the top 5-10 chats, spanning both recent and older messages (use startTime/endTime slices);
   b. read_period_events over at least 3 representative windows: recent 7 days, a mid window ~2-4 weeks ago, and an early window several months ago (adjust windows to the account's history span from list_dates);
   c. search_messages for recurring themes (school/work/考试/游戏/恋爱/编程/旅行 keywords) to map long-running interests and habits.
4. LATE STAGE ONLY (after the general picture exists): read_day_events for specific days that stood out in the survey, to confirm or deepen particular threads.
5. SYNTHESIS: extract 作息习惯, 兴趣主线, 说话风格, 情绪波动, 社交角色 (群里的角色/谁最常找他), 优先级/人生阶段. Update memory/personality.md + memory/people.md with dated evidence.
6. ANSWER: a structured profile (性格、兴趣、习惯、近期状态、社交网络), each trait with evidence citations, confidence markers, and 证据不足 caveats.

TOOL-DISCIPLINE RULE (applies to all playbooks): read_day_events and read_period_events are PRECISION tools for specific windows — they merge every chat and are expensive. Use them only when you already know which window matters (from get_social_overview / list_dates / search_messages). NEVER open with them for a broad profile task; open with the general scan (list_sessions + get_social_overview + read_session_messages across top chats).

### B. 某日/时段复盘 — "8月8日发生了什么 / 这周怎么了"
1. ALWAYS start with read_day_events(date) or read_period_events(start, end) — never read_session_messages first.
2. For the 2-5 most active chats that day, read_session_messages for fuller context of the key threads (the timeline is thin; the threads carry the meaning).
3. search_messages for the day's distinctive keywords to catch related mentions in OTHER chats the timeline might have truncated.
4. Correlate: the same plan/person appearing in a group AND a private chat on the same day is the strongest signal. Identify "who, what, when, why" per thread.
5. Update memory/events.md; answer as a chronological narrative with each event's significance.

### C. 关系分析 — "我和 X 的关系怎么样 / 谁是我最好的朋友"
1. PRIME: read memory/relationships.md and memory/people.md as fallible leads, then review_prior_analyses for prior coverage. Re-verify rather than copying either source.
2. Identify candidates with get_relationship_candidates, which deliberately scores duration, active-day breadth, recency and continuity in addition to volume. Do not equate its candidate score with closeness.
3. For each serious candidate, use sample_session_history to inspect early, middle and recent periods automatically; then use read_session_messages/search_messages only for focused follow-up. Compare who initiates, reciprocity, tone, topic depth, support, shared plans and relationship change. Never inspect only the newest messages.
4. Cross-chat check: read_period_events around the candidate's key dates to find shared group activities.
5. Update memory/relationships.md with new evidence/corrections; answer per-person: 亲密度证据, 互动模式, 变化趋势. Ranking must not be based on message volume alone.

### D. 事件追查 — "帮我找找搬家/生病/分手/考试那件事"
1. search_messages with the topic keyword AND 2-3 synonyms (搬家/房子/租房; 生病/医院/难受; 分手/复合/前任; 考试/模考/成绩).
2. From the hits, identify the date range, then read_period_events around it and read_session_messages of the involved chats for the surrounding days.
3. Reconstruct the event timeline across chats; update memory/events.md.

### E. 主题挖掘 — "大家最近在聊什么 / 群里在讨论什么"
1. read_period_events for the last 3-7 days; get_social_overview for the same range.
2. search_messages for the candidate themes; identify which chats/users drive each topic.
3. Answer with ranked topics + evidence.

### F. 数据统计 — "我们聊了多少 / 谁说话最多"
1. get_session_stats (with ranges if relevant), get_social_overview, list_dates.
2. Report exact numbers from tool output only; no estimation presented as fact.

## Tool selection guide (quick reference)
- Which chats exist / top chats by volume → list_sessions, get_social_overview
- What happened across ALL chats on a day or range → read_day_events / read_period_events (ALWAYS for "what happened" questions)
- Deep dive one chat's messages → read_session_messages with startTime/endTime slices
- Find a topic anywhere in history → search_messages
- Numbers / comparisons → get_session_stats, get_social_overview, list_dates
- Who a person is → get_contact_info (includes gender/region/signature when the DB stores them)
- WHO is in a group (roster, nicknames, roles, circles) → get_group_members — call it before analyzing a group's messages to understand the cast
- Remember / retrieve knowledge → list_notes, read_note, write_note (memory/ for durable facts, notes/ for scratch)

## Depth rules (non-negotiable for open-ended questions)
- Never conclude from one chat or one window. Sample MULTIPLE windows (recent + mid + early) and MULTIPLE chats before concluding.
- BE AGGRESSIVE — this product's users want depth, not surface: read 300-500 messages per session call; for every session you open, read at least TWO windows (recent AND older via startTime/endTime) unless the chat is tiny; deep-dive at least 6-10 sessions for profile/relationship questions; run 4-6 search_messages probes on different themes before synthesizing. Do NOT settle for the newest 50 messages of one chat.
- BREADTH OVER VOLUME: do NOT only chase high-volume chats. Small/quiet chats (low message counts, older chats, small groups, occasional private conversations) often carry the most personal signals — sample at least 5-8 of them (from list_sessions, pick chats that are NOT in the top 10 by volume) and read their recent windows too. The context window is huge (1M tokens); spend it.
- DEPTH FOR MAJOR CHATS: for the 3-5 most active chats, read 300-500 messages in EACH of at least 3 windows (recent / mid / early) instead of one slice of the newest messages. Use read_session_messages repeatedly with different startTime/endTime windows to walk further back in history (e.g. last 7 days, then 2-4 weeks ago, then months ago) — never stop at the first page.
- When a day/period event stands out, follow it up with search_messages + targeted read_session_messages — do not just re-quote the timeline.
- If evidence conflicts across chats or windows, report the conflict instead of smoothing it over.
- If the history volume is too large for one pass, analyze in layers (overview → windowed deep dives → synthesis) with MULTIPLE tool calls; never ask the user to narrow an open-ended question before you have actually surveyed the data.
- Keep tool results out of your answer text; cite compactly (群聊「名」· 日期 时间) instead of quoting raw message dumps.

## Mandatory memory protocol
1. At the START of EVERY task, your FIRST two tool calls must be: list_notes, then read EVERY existing memory/*.md file (memory/personality.md, relationships.md, events.md, people.md, hypotheses.md — they are small; read them all before doing anything else). Never skip this even if the user's question seems unrelated.
2. Before answering, append new durable facts to the appropriate memory/*.md files with the current date. Prefer append=true with dated entries over full overwrites.
3. When a later turn needs a fact you already wrote, read the memory file again — memory is your only persistence across turns.

## Answer format
- Use Markdown: short intro, sections, bullet lists, bold for key findings.
- Cite evidence inline like（群聊「周末出游」· 2026-08-08 14:32）.
- End with a short "下一步建议" if a follow-up analysis would add value.
- If a task needs more history than tools can return, state the truncation and suggest the next slice.`

// ---------------------------------------------------------------------------
// 工具实现（curated harness）
// ---------------------------------------------------------------------------

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** 归一化为 Unix 秒。接受：ISO 日期/时间字符串、Unix 秒、Unix 毫秒。0 → 0（不限） */
function normalizeTimeSec(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 10000000000 ? Math.floor(v / 1000) : Math.floor(v)
  }
  const s = String(v).trim()
  if (!s) return 0
  const n = Number(s)
  if (Number.isFinite(n)) return n > 10000000000 ? Math.floor(n / 1000) : Math.floor(n)
  const parsed = Date.parse(s)
  if (!Number.isFinite(parsed)) return 0
  return Math.floor(parsed / 1000)
}

function formatTime(sec: number): string {
  const d = new Date(sec * 1000)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 清除字符串中的孤立代理对（lone surrogate）。
 * 微信消息解析偶尔会产生不完整的 UTF-16 表情转义（如单独的 \uD83D），
 * JSON.stringify 会原样输出为 \uD83D —— JS 解析器接受，但 DeepSeek 的
 * Rust 后端拒绝（"unexpected end of hex escape"）→ HTTP 400。
 * 发送给 API 的每个字符串都必须经过这里。
 */
function sanitizeForApi(s: string): string {
  return String(s)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(?<![\uD800-\uDFFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

/**
 * 把历史消息里的错误拼写（WreportAI / WepoortAI / Weport Ai / wreport ai 等）
 * 统一规整为 "WeportAI"。早期轮次里模型曾把自己误写成 "WreportAI" 并被持久化，
 * 恢复会话时模型会照抄自己过去的错误自称。发送给 API 前必须清洗。
 */
function normalizeIdentityName(s: string): string {
  return String(s)
    .replace(/\bWepoort\s*AI\b/gi, 'WeportAI')
    .replace(/\bWreport\s*AI\b/gi, 'WeportAI')
    .replace(/\bWeport\s*AI\b/gi, 'WeportAI')
}

function dateKeyOf(sec: number): string {
  const d = new Date(sec * 1000)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function sessionTypeLabel(username: string): '群聊' | '私聊' | '公众号' {
  if (username.endsWith('@chatroom')) return '群聊'
  if (username.startsWith('gh_')) return '公众号'
  return '私聊'
}

function formatMessageLine(m: Message, sessionName: string, myWxid: string, sessionUsername?: string): string {
  let sender = sessionName
  if (m.isSend === 1) {
    sender = '我'
  } else if (m.senderUsername && m.senderUsername !== myWxid) {
    const s = String(m.senderDisplayName || '').trim()
    const raw = String(m.senderUsername || '').trim()
    sender = s && s !== raw ? `${s}(${raw})` : raw
  }
  const text = String(m.parsedContent || '').trim()
  const body = text || `[${String(m.rawContent || '').slice(0, 120) || '媒体消息'}]`
  // 跨会话时间线必须标明消息来自哪个群/会话，否则不同群的消息无法区分
  const sessionPrefix = sessionUsername?.endsWith('@chatroom') ? `「${sessionName}」· ` : ''
  return `[${formatTime(Number(m.createTime) || 0)}] ${sessionPrefix}${sender}: ${body}`
}

function countMatchesInRange(
  counts: Record<string, number> | undefined,
  startSec: number,
  endSec: number
): number {
  if (!counts) return 0
  const startKey = startSec > 0 ? dateKeyOf(startSec) : ''
  const endKey = endSec > 0 ? dateKeyOf(endSec) : ''
  let total = 0
  for (const [date, n] of Object.entries(counts)) {
    if (startKey && date < startKey) continue
    if (endKey && date > endKey) continue
    total += Number(n) || 0
  }
  return total
}

class WeportAiService {
  private configService: ConfigService
  private chats: AiChatMeta[] = []
  private chatsLoaded = false
  private dataDir = ''
  private sessionsDir = ''
  private running = new Map<string, AbortController>()
  /**
   * Previous serialized model input per running chat. Kept in memory only and
   * used to diagnose prefix stability without writing message contents to disk.
   */
  private previousApiInput = new Map<string, string>()
  private emitter: EventEmitter | null = null
  private sessionListCache: { at: number; sessions: ChatSession[] } = { at: 0, sessions: [] }
  private titleUpgrading = new Set<string>()

  constructor() {
    this.configService = ConfigService.getInstance()
  }

  // -------------------------------------------------------------------------
  // 基础设施
  // -------------------------------------------------------------------------

  setEventEmitter(emitter: EventEmitter): void {
    this.emitter = emitter
  }

  private emit(event: AiEvent): void {
    try {
      this.emitter?.(event)
    } catch (e) {
      console.warn('[WeportAI] 事件派发失败:', e)
    }
  }

  private ensureDirs(): void {
    if (this.dataDir) return
    this.dataDir = join(app.getPath('userData'), 'weport-ai')
    this.sessionsDir = join(this.dataDir, 'sessions')
    mkdirSync(this.sessionsDir, { recursive: true })
  }

  private loadChats(): AiChatMeta[] {
    this.ensureDirs()
    if (this.chatsLoaded) return this.chats
    try {
      const indexPath = join(this.dataDir, 'index.json')
      if (existsSync(indexPath)) {
        const raw = JSON.parse(readFileSync(indexPath, 'utf8')) as { chats?: AiChatMeta[] }
        this.chats = Array.isArray(raw.chats) ? raw.chats : []
      }
    } catch (e) {
      console.warn('[WeportAI] 读取会话索引失败:', e)
      this.chats = []
    }
    this.chatsLoaded = true
    // 排序：用户拖过（存在 sortOrder）→ 按 sortOrder；否则按最近活跃
    const anyOrdered = this.chats.some((c) => typeof c.sortOrder === 'number')
    if (anyOrdered) {
      this.chats.sort(
        (a, b) =>
          (typeof a.sortOrder === 'number' ? a.sortOrder : Number.MAX_SAFE_INTEGER) -
            (typeof b.sortOrder === 'number' ? b.sortOrder : Number.MAX_SAFE_INTEGER) ||
          b.updatedAt - a.updatedAt
      )
    } else {
      this.chats.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return this.chats
  }

  private persistChats(): void {
    try {
      const target = join(this.dataDir, 'index.json')
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ chats: this.chats }, null, 2), 'utf8')
      // 原子替换：崩溃/断电时索引不会剩半个 JSON（此前直接写最终文件，
      // 中途失败会把整个会话列表打成空）
      renameSync(tmp, target)
    } catch (e) {
      console.warn('[WeportAI] 写入会话索引失败:', e)
    }
  }

  private chatFilePath(chatId: string): string {
    return join(this.sessionsDir, `${chatId}.json`)
  }

  private chatArchivePath(chatId: string): string {
    return join(this.sessionsDir, `${chatId}.archive.jsonl`)
  }

  /** Preserve canonical old turns before the provider projection is compacted. */
  private archiveMessages(chatId: string, messages: AiMessage[]): void {
    if (messages.length === 0) return
    try {
      const { appendFileSync } = require('fs') as typeof import('fs')
      appendFileSync(this.chatArchivePath(chatId), messages.map((message) => JSON.stringify(message)).join('\n') + '\n', 'utf8')
    } catch (e) {
      console.warn('[WeportAI] 归档旧会话轮次失败:', e)
    }
  }

  private loadArchivedMessages(chatId: string): AiMessage[] {
    try {
      const path = this.chatArchivePath(chatId)
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AiMessage)
    } catch {
      return []
    }
  }

  private loadMessages(chatId: string): { messages: AiMessage[]; compressed: string; lastRun?: AiChatData['lastRun'] } {
    try {
      const p = this.chatFilePath(chatId)
      if (!existsSync(p)) return { messages: [], compressed: '' }
      const raw = JSON.parse(readFileSync(p, 'utf8')) as {
        messages?: AiMessage[]
        compressed?: string
        lastRun?: AiChatData['lastRun']
      }
      const messages = Array.isArray(raw.messages) ? raw.messages : []
      let compressed = typeof raw.compressed === 'string' ? raw.compressed : ''
      // 自愈：清洗持久化历史里遗留的错误自称（早期模型曾把名字误写为 WreportAI，
      // 恢复会话时会被照抄下去），并回写磁盘使旧会话永久修正。
      let mutated = false
      for (const m of messages) {
        if (m.role !== 'assistant' && m.role !== 'user') continue
        const cleaned = normalizeIdentityName(m.content || '')
        if (cleaned !== m.content) {
          m.content = cleaned
          mutated = true
        }
        if (m.reasoning) {
          const reasoning = normalizeIdentityName(m.reasoning)
          if (reasoning !== m.reasoning) {
            m.reasoning = reasoning
            mutated = true
          }
        }
      }
      const cleanedCompressed = normalizeIdentityName(compressed)
      if (cleanedCompressed !== compressed) {
        compressed = cleanedCompressed
        mutated = true
      }
      if (mutated) this.persistMessages(chatId, messages, compressed, raw.lastRun)
      return { messages, compressed, lastRun: raw.lastRun }
    } catch {
      return { messages: [], compressed: '' }
    }
  }

  private persistMessages(
    chatId: string,
    messages: AiMessage[],
    compressed = '',
    lastRun?: AiChatData['lastRun']
  ): void {
    try {
      const target = this.chatFilePath(chatId)
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(
        tmp,
        JSON.stringify({ chatId, messages, compressed, lastRun: lastRun || undefined }, null, 2),
        'utf8'
      )
      renameSync(tmp, target)
    } catch (e) {
      console.warn('[WeportAI] 写入会话消息失败:', e)
    }
  }

  /**
   * 上下文压缩（Reasonix 式「cache-aware context maintenance」）：
   * 当历史消息数量超过窗口上限、或估算体积过大时，把最旧的溢出部分压缩为摘要。
   *
   * Compression runs only at a user-turn boundary. During an agent loop the
   * request history must remain append-only: dropping its head changes token 0
   * of the conversation and destroys the provider's prefix-cache match.
   */
  private compressOverflow(
    messages: AiMessage[],
    limit: number,
    maxChars = 120000
  ): { kept: AiMessage[]; digest: string; dropped: AiMessage[] } {
    const messageChars = (m: AiMessage): number => {
      // Tool results are represented by their own role=tool message. Counting
      // call.result here as well would double-count the same provider payload.
      return m.content.length + (m.reasoning?.length || 0) + 40
    }
    const estimateChars = (list: AiMessage[]): number => {
      let total = 0
      for (const m of list) total += messageChars(m)
      return total
    }

    let dropCount = Math.max(0, messages.length - limit)
    let est = estimateChars(messages)
    while (est > maxChars && messages.length - dropCount > 10) {
      // 从最旧的消息开始丢弃（messages[0]、messages[1]…）
      const dropped = messages[dropCount]
      if (!dropped) break
      est -= messageChars(dropped)
      dropCount += 1
    }
    if (dropCount <= 0) return { kept: messages, digest: '', dropped: [] }

    const trimmed = messages.slice(0, dropCount)
    const lines = trimmed.map((m) => {
      if (m.role === 'assistant') {
        return `[AI ${m.toolCalls?.length ? `(工具${m.toolCalls.length}个)` : '回答'}] ${String(m.content || '').slice(0, 280)}`
      }
      if (m.role === 'user') return `[用户] ${String(m.content || '').slice(0, 140)}`
      return `[工具 ${m.toolName || ''}] ${String(m.content || '').slice(0, 140)}`
    })
    const digest = [
      '以下是更早轮次的关键内容摘要（为节省上下文，原始消息已压缩）：',
      ...lines,
      '（摘要结束 —— 新对话从这里继续）',
    ].join('\n')
    return { kept: messages.slice(dropCount), digest, dropped: trimmed }
  }

  private getWorkspaceRoot(): string {
    const configured = String(this.configService.get('weportAiWorkspaceRoot') || '').trim()
    if (configured) return configured
    const exportPath = String(this.configService.get('exportPath') || '').trim()
    if (exportPath) return join(exportPath, 'WeportAI')
    return join(app.getPath('userData'), 'WeportAI')
  }

  private chatWorkspaceDir(chatId: string): string {
    return join(this.getWorkspaceRoot(), 'chats', chatId)
  }

  /** 跨对话共享的长期记忆目录 */
  private memoryDir(): string {
    return join(this.getWorkspaceRoot(), 'memory')
  }

  private noteDir(chatId: string): string {
    return join(this.chatWorkspaceDir(chatId), 'notes')
  }

  /**
   * 校验笔记相对路径，返回 { target, scope }：
   * - 以 memory/ 开头 → 共享记忆目录（跨对话持久）
   * - 以 notes/ 开头（或省略前缀）→ 当前对话草稿笔记目录
   * 仅允许 .md 文件且必须位于工作区内。
   */
  private resolveWorkPath(chatId: string, relPath: string): { target: string; scope: 'memory' | 'notes' } | null {
    const p = String(relPath || '').trim().replace(/\\/g, '/')
    if (!p || isAbsolute(p) || p.includes('..') || p.startsWith('/')) return null
    if (!p.toLowerCase().endsWith('.md')) return null
    let base: string
    let scope: 'memory' | 'notes'
    let rel: string
    if (p.startsWith('memory/')) {
      base = this.memoryDir()
      scope = 'memory'
      rel = p.slice('memory/'.length)
    } else {
      base = this.noteDir(chatId)
      scope = 'notes'
      rel = p.startsWith('notes/') ? p.slice('notes/'.length) : p
    }
    const target = normalize(join(base, rel))
    if (!target.startsWith(base + '\\') && !target.startsWith(base + '/')) return null
    return { target, scope }
  }

  private listWorkFiles(chatId: string): Array<{ path: string; bytes: number; mtime: number; scope: 'memory' | 'notes' }> {
    const out: Array<{ path: string; bytes: number; mtime: number; scope: 'memory' | 'notes' }> = []
    const scan = (base: string, prefix: string, scope: 'memory' | 'notes') => {
      if (!existsSync(base)) return
      const walk = (dir: string) => {
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          return
        }
        for (const name of entries) {
          const full = join(dir, name)
          try {
            const st = statSync(full)
            if (st.isDirectory()) {
              walk(full)
            } else if (name.toLowerCase().endsWith('.md')) {
              out.push({
                path: `${prefix}${relative(base, full).replace(/\\/g, '/')}`,
                bytes: st.size,
                mtime: Math.floor(st.mtimeMs),
                scope,
              })
            }
          } catch { /* noop */ }
        }
      }
      walk(base)
    }
    scan(this.memoryDir(), 'memory/', 'memory')
    scan(this.noteDir(chatId), 'notes/', 'notes')
    out.sort((a, b) => a.path.localeCompare(b.path))
    return out
  }

  // -------------------------------------------------------------------------
  // 会话（Chat）管理
  // -------------------------------------------------------------------------

  listChats(): AiChatMeta[] {
    return this.loadChats()
  }

  createChat(title?: string): AiChatMeta {
    const chats = this.loadChats()
    // 新对话永远排在最上面：比现有最小的 sortOrder 再小 1（未拖过则从 0 开始）
    const minOrder = chats.reduce<number | undefined>((min, c) => {
      if (typeof c.sortOrder !== 'number') return min
      return min === undefined ? c.sortOrder : Math.min(min, c.sortOrder)
    }, undefined)
    const chat: AiChatMeta = {
      id: randomUUID(),
      title: String(title || '').trim().slice(0, 60) || '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sortOrder: minOrder === undefined ? 0 : minOrder - 1,
      titleVersion: 1,
    }
    chats.unshift(chat)
    this.persistChats()
    mkdirSync(this.memoryDir(), { recursive: true })
    mkdirSync(this.noteDir(chat.id), { recursive: true })
    return chat
  }

  /** 手动拖拽排序：按传入的 id 顺序写入 sortOrder */
  reorderChats(orderedIds: string[]): boolean {
    const chats = this.loadChats()
    const idSet = new Set(orderedIds.map(String).filter(Boolean))
    let assigned = 0
    for (const id of orderedIds) {
      const chat = chats.find((c) => c.id === id)
      if (!chat) continue
      chat.sortOrder = assigned
      assigned += 1
    }
    // 未参与拖拽的会话（理论上不存在）保持原序兜底
    for (const chat of chats) {
      if (!idSet.has(chat.id)) chat.sortOrder = assigned++
    }
    this.persistChats()
    return true
  }

  renameChat(chatId: string, title: string): boolean {
    const chat = this.loadChats().find((c) => c.id === chatId)
    if (!chat) return false
    chat.title = String(title || '').trim().slice(0, 60) || chat.title
    chat.titleVersion = 2 // 用户手动改名视为最终标题，不再被 AI 覆盖
    chat.updatedAt = Date.now()
    this.persistChats()
    return true
  }

  deleteChat(chatId: string): boolean {
    const chats = this.loadChats()
    const idx = chats.findIndex((c) => c.id === chatId)
    if (idx < 0) return false
    // 先中止正在进行的 agent 运行，避免删除后运行继续写回已删除的文件
    this.abort(chatId)
    this.running.delete(chatId)
    chats.splice(idx, 1)
    this.previousApiInput.delete(chatId)
    this.persistChats()
    try {
      rmSync(this.chatFilePath(chatId), { force: true })
      rmSync(this.chatArchivePath(chatId), { force: true })
      rmSync(this.chatWorkspaceDir(chatId), { recursive: true, force: true })
    } catch { /* noop */ }
    return true
  }

  getChat(chatId: string): AiChatData | null {
    const chat = this.loadChats().find((c) => c.id === chatId)
    if (!chat) return null
    const stored = this.loadMessages(chatId)
    // 打开会话时静默升级旧版（过长/复述原文）标题为 8 字意图标题
    this.upgradeStaleTitle(chatId)
    return {
      chat,
      workspaceDir: this.chatWorkspaceDir(chatId),
      memoryDir: this.memoryDir(),
      messages: stored.messages,
      compressed: stored.compressed,
      lastRun: stored.lastRun,
    }
  }

  listNotes(chatId: string): Array<{ path: string; bytes: number; mtime: number; scope: 'memory' | 'notes' }> {
    return this.listWorkFiles(chatId)
  }

  readNoteFile(chatId: string, path: string): string | null {
    const resolved = this.resolveWorkPath(chatId, path)
    if (!resolved || !existsSync(resolved.target)) return null
    try {
      return readFileSync(resolved.target, 'utf8')
    } catch {
      return null
    }
  }

  deleteNoteFile(chatId: string, path: string): boolean {
    const resolved = this.resolveWorkPath(chatId, path)
    if (!resolved || !existsSync(resolved.target)) return false
    try {
      rmSync(resolved.target, { force: true })
      return true
    } catch {
      return false
    }
  }

  /** 清空共享长期记忆目录（memory/），返回删除的文件数 */
  clearMemory(): { success: boolean; removed: number; error?: string } {
    const dir = this.memoryDir()
    if (!existsSync(dir)) return { success: true, removed: 0 }
    let removed = 0
    try {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const st = statSync(full)
        if (st.isDirectory()) rmSync(full, { recursive: true, force: true })
        else rmSync(full, { force: true })
        removed += 1
      }
      return { success: true, removed }
    } catch (e) {
      return { success: false, removed, error: String((e as Error)?.message || e) }
    }
  }

  getActions(): Array<{ id: string; name: string; prompt: string }> {
    const actions = this.configService.get('weportAiActions')
    return Array.isArray(actions) ? actions : []
  }

  saveActions(actions: Array<{ id: string; name: string; prompt: string }>): boolean {
    if (!Array.isArray(actions)) return false
    const cleaned = actions
      .map((a) => ({
        id: String(a?.id || '').trim(),
        name: String(a?.name || '').trim().slice(0, 40),
        prompt: String(a?.prompt || '').trim().slice(0, 4000),
      }))
      .filter((a) => a.id && a.name && a.prompt)
      .slice(0, 50)
    this.configService.set('weportAiActions', cleaned)
    return true
  }

  getSetup(): AiSetupInfo {
    return {
      hasApiKey: String(this.configService.get('weportAiApiKey') || '').trim().length > 0,
      baseUrl: String(this.configService.get('weportAiBaseUrl') || 'https://api.deepseek.com').trim(),
      baseUrlError: String(this.configService.get('weportAiBaseUrlError') || '').trim(),
      model: String(this.configService.get('weportAiModel') || 'deepseek-v4-flash').trim(),
      maxTokens: Number(this.configService.get('weportAiMaxTokens')) || 32768,
      reasoningEffort: this.configService.get('weportAiReasoningEffort') || 'high',
      maxSteps: Number(this.configService.get('weportAiMaxSteps')) || 48,
      customPrompt: String(this.configService.get('weportAiCustomPrompt') || ''),
      workspaceRoot: this.getWorkspaceRoot(),
      exportPath: String(this.configService.get('exportPath') || ''),
      dbReady: String(this.configService.get('dbPath') || '').trim().length > 0,
      disabledTools: Array.isArray(this.configService.get('weportAiDisabledTools'))
        ? (this.configService.get('weportAiDisabledTools') as string[])
        : [],
      maxToolChars: Number(this.configService.get('weportAiMaxToolChars')) || 12000,
      conversationLimit: Number(this.configService.get('weportAiConversationLimit')) || 60,
    }
  }

  updateSetup(patch: {
    apiKey?: string
    baseUrl?: string
    model?: string
    maxTokens?: number
    reasoningEffort?: string
    maxSteps?: number
    customPrompt?: string
    workspaceRoot?: string
    disabledTools?: string[]
    maxToolChars?: number
    conversationLimit?: number
  }): void {
    if (typeof patch.apiKey === 'string') {
      const trimmed = patch.apiKey.trim()
      this.configService.set('weportAiApiKey', trimmed)
    }
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
      const raw = patch.baseUrl.trim()
      // 安全校验：密钥以 Bearer 头发给 baseUrl，明文 http 会把密钥暴露在网络上。
      // 仅允许 https；localhost/127.0.0.1/[::1]（本地代理如 LM Studio/Ollama）例外。
      let parsed: URL | null = null
      try { parsed = new URL(raw) } catch { parsed = null }
      const host = parsed?.hostname?.toLowerCase() || ''
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
      const isSecure = parsed?.protocol === 'https:' || (parsed?.protocol === 'http:' && isLocalHost)
      if (!parsed) {
        this.configService.set('weportAiBaseUrlError', 'API 地址格式无效，应以 http(s):// 开头')
      } else if (!isSecure) {
        this.configService.set('weportAiBaseUrlError', 'API 地址必须使用 https（仅 localhost 可使用 http，避免密钥明文传输）')
      } else {
        this.configService.set('weportAiBaseUrlError', '')
        this.configService.set('weportAiBaseUrl', raw)
      }
    }
    if (typeof patch.model === 'string' && patch.model.trim()) {
      this.configService.set('weportAiModel', patch.model.trim())
    }
    if (typeof patch.maxTokens === 'number' && Number.isFinite(patch.maxTokens)) {
      this.configService.set('weportAiMaxTokens', Math.max(256, Math.min(393216, Math.floor(patch.maxTokens))))
    }
    if (patch.reasoningEffort === 'low' || patch.reasoningEffort === 'high' || patch.reasoningEffort === 'max') {
      this.configService.set('weportAiReasoningEffort', patch.reasoningEffort)
    }
    if (typeof patch.maxSteps === 'number' && Number.isFinite(patch.maxSteps)) {
      this.configService.set('weportAiMaxSteps', Math.max(4, Math.min(128, Math.floor(patch.maxSteps))))
    }
    if (typeof patch.customPrompt === 'string') {
      this.configService.set('weportAiCustomPrompt', patch.customPrompt)
    }
    if (typeof patch.workspaceRoot === 'string') {
      const root = patch.workspaceRoot.trim()
      this.configService.set('weportAiWorkspaceRoot', root)
    }
    if (Array.isArray(patch.disabledTools)) {
      this.configService.set('weportAiDisabledTools', patch.disabledTools.map(String).filter(Boolean).slice(0, 50))
    }
    if (typeof patch.maxToolChars === 'number' && Number.isFinite(patch.maxToolChars)) {
      this.configService.set('weportAiMaxToolChars', Math.max(1000, Math.min(100000, Math.floor(patch.maxToolChars))))
    }
    if (typeof patch.conversationLimit === 'number' && Number.isFinite(patch.conversationLimit)) {
      this.configService.set('weportAiConversationLimit', Math.max(10, Math.min(200, Math.floor(patch.conversationLimit))))
    }
  }

  // -------------------------------------------------------------------------
  // 会话列表 / 显示名（run 内缓存）
  // -------------------------------------------------------------------------

  private async loadSessionsFresh(): Promise<ChatSession[]> {
    const result = await chatService.getSessions()
    return result.success && Array.isArray(result.sessions) ? result.sessions : []
  }

  private async getSessionMap(): Promise<Map<string, ChatSession>> {
    if (Date.now() - this.sessionListCache.at < 15000 && this.sessionListCache.sessions.length > 0) {
      return new Map(this.sessionListCache.sessions.map((s) => [s.username, s]))
    }
    const sessions = await this.loadSessionsFresh()
    this.sessionListCache = { at: Date.now(), sessions }
    return new Map(sessions.map((s) => [s.username, s]))
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  private buildTools(): ToolDefinition[] {
    const disabled = new Set(
      (Array.isArray(this.configService.get('weportAiDisabledTools'))
        ? (this.configService.get('weportAiDisabledTools') as string[])
        : [])
        .map((name) => String(name || '').trim())
        .filter(Boolean)
    )
    return this.toolDefinitions().filter((t) => !disabled.has(t.name))
  }

  private toolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'list_sessions',
        description:
          'Page through WeChat chats with display name, type, count hint and activity time. For relationship ranking use get_relationship_candidates instead of paging every private chat. Use sort=oldest to deliberately discover distant/quiet history.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['all', 'group', 'private', 'official'], description: 'Filter by chat type (default all)' },
            keyword: { type: 'string', description: 'Optional keyword to filter by display name or username' },
            sort: { type: 'string', enum: ['recent', 'oldest', 'name'], description: 'Ordering (default recent)' },
            offset: { type: 'integer', minimum: 0, description: 'Pagination offset (default 0)' },
            limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Rows per page (default 25)' },
          },
        },
        friendly: (args, ctx, result) => {
          const n = result ? /(\d+) 个会话/.exec(result)?.[1] : ''
          return `浏览了会话列表${n ? `（${n} 个）` : ''}`
        },
        handler: async (args, ctx) => {
          const type = String(args.type || 'all')
          const keyword = String(args.keyword || '').trim().toLowerCase()
          const limit = clampInt(args.limit, 1, 30, 25)
          const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
          const sort = String(args.sort || 'recent')
          const sessionMap = await this.getSessionMap()
          const sessions = Array.from(sessionMap.values())
          const matching = sessions
            .filter((s) => {
              if (type === 'group' && !s.username.endsWith('@chatroom')) return false
              if (type === 'private' && s.username.endsWith('@chatroom')) return false
              if (type === 'private' && s.username.startsWith('gh_')) return false
              if (type === 'official' && !s.username.startsWith('gh_')) return false
              if (keyword) {
                const name = String(s.displayName || '').toLowerCase()
                const id = s.username.toLowerCase()
                if (!name.includes(keyword) && !id.includes(keyword)) return false
              }
              return true
            })
            .sort((a, b) => {
              if (sort === 'name') return String(a.displayName || a.username).localeCompare(String(b.displayName || b.username))
              const delta = Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0)
              return sort === 'oldest' ? -delta : delta
            })
          const rows = matching.slice(offset, offset + limit)
          if (rows.length === 0) return '没有找到符合条件的会话。'
          const lines = rows.map((s) => {
            const last = Number(s.lastTimestamp || 0)
            return `- ${sessionTypeLabel(s.username)}「${s.displayName || s.username}」 id=${s.username} 消息数≈${s.messageCountHint ?? '未知'} 最近活跃=${last ? formatTime(last) : '未知'}`
          })
          const next = offset + rows.length < matching.length ? `，nextOffset=${offset + rows.length}` : '，已到末尾'
          return `会话页：符合=${matching.length}，offset=${offset}，返回=${rows.length}${next}：\n` + lines.join('\n')
        },
      },
      {
        name: 'get_social_overview',
        description:
          'Cross-chat survey: message volume per chat (optionally within a date range), sorted by volume, plus totals and activity breadth. Use in the SURVEY phase of open-ended questions (e.g. "分析我是什么人") to decide which chats and time windows deserve deep dives.',
        parameters: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'Optional window start "YYYY-MM-DD"' },
            endDate: { type: 'string', description: 'Optional window end "YYYY-MM-DD"' },
            top: { type: 'integer', minimum: 3, maximum: 50, description: 'How many top chats to return (default 15)' },
          },
        },
        friendly: (args) => {
          const range = args.startDate || args.endDate ? `${String(args.startDate || '…')} ~ ${String(args.endDate || '现在')}` : '全部时间'
          return `生成了社交活动概览（${range}，按消息量排序）`
        },
        handler: async (args, ctx) => {
          const top = clampInt(args.top, 3, 50, 25)
          const startSec = normalizeTimeSec(args.startDate)
          const endSec = normalizeTimeSec(args.endDate)
          const sessionMap = await this.getSessionMap()
          const ids = Array.from(sessionMap.values()).map((s) => s.username)

          let rangeCounts: Record<string, number> | null = null
          if (startSec || endSec) {
            const batch = await wcdbService.getSessionMessageDateCountsBatch(ids)
            if (batch.success && batch.data) {
              rangeCounts = {}
              const startKey = startSec ? dateKeyOf(startSec) : ''
              const endKey = endSec ? dateKeyOf(endSec) : ''
              for (const [sid, counts] of Object.entries(batch.data)) {
                let total = 0
                for (const [date, n] of Object.entries(counts || {})) {
                  if (startKey && date < startKey) continue
                  if (endKey && date > endKey) continue
                  total += Number(n) || 0
                }
                if (total > 0) rangeCounts[sid] = total
              }
            }
          }
          const idsForCounts = rangeCounts ? Object.keys(rangeCounts) : ids
          const countsResult = await chatService.getSessionMessageCounts(idsForCounts)
          const rows = idsForCounts
            .map((sid) => {
              const session = sessionMap.get(sid)
              const count = rangeCounts ? rangeCounts[sid] || 0 : Number(countsResult.counts?.[sid] || 0)
              return {
                sid,
                name: session?.displayName || sid,
                type: sessionTypeLabel(sid),
                count,
                last: Number(session?.lastTimestamp || 0),
              }
            })
            .filter((r) => r.count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, top)
          if (rows.length === 0) return '该时间范围内没有消息活动。'
          const totalMessages = rows.reduce((n, r) => n + r.count, 0)
          const rangeLabel = rangeCounts
            ? `${startSec ? formatTime(startSec) : '起点'} ~ ${endSec ? formatTime(endSec) : '现在'}`
            : '全部时间'
          const header = `${rangeLabel}：TOP ${rows.length} 个会话合计≈${totalMessages.toLocaleString()} 条消息（另有若干低活跃会话未列出）：\n`
          return (
            header +
            rows.map((r) => `- ${r.type}「${r.name}」${r.count.toLocaleString()} 条${r.last ? ` 最近活跃=${formatTime(r.last)}` : ''}`).join('\n')
          )
        },
      },
      {
        name: 'get_relationship_candidates',
        description:
          'Build a compact PRIVATE-chat candidate set for relationship analysis. Ranks investigation priority using message volume, active-day breadth, relationship span, recent continuity and older-history continuity — not volume alone. The score only selects whom to inspect; it is NOT a closeness verdict. Follow with sample_session_history.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 3, maximum: 30, description: 'Candidate count (default 12)' },
            recentDays: { type: 'integer', minimum: 30, maximum: 730, description: 'Recent-continuity window (default 180 days)' },
          },
        },
        friendly: () => '按活跃跨度、持续性与消息量筛选了关系候选人',
        handler: async (args) => {
          const limit = clampInt(args.limit, 3, 30, 12)
          const recentDays = clampInt(args.recentDays, 30, 730, 180)
          const sessionMap = await this.getSessionMap()
          const sessions = Array.from(sessionMap.values()).filter(
            (s) => !s.username.endsWith('@chatroom') && !s.username.startsWith('gh_'),
          )
          const ids = sessions.map((s) => s.username)
          const batch = await wcdbService.getSessionMessageDateCountsBatch(ids)
          if (!batch.success || !batch.data) return `候选筛选失败：${batch.error || '无法读取消息日期统计'}`
          const recentCutoff = dateKeyOf(Math.floor(Date.now() / 1000) - recentDays * 86400)
          const rows = sessions
            .map((session) => {
              const entries = Object.entries(batch.data?.[session.username] || {})
                .map(([date, count]) => [date, Number(count) || 0] as const)
                .filter(([, count]) => count > 0)
                .sort((a, b) => a[0].localeCompare(b[0]))
              const total = entries.reduce((sum, [, count]) => sum + count, 0)
              const recent = entries.reduce((sum, [date, count]) => sum + (date >= recentCutoff ? count : 0), 0)
              const older = Math.max(0, total - recent)
              const first = entries[0]?.[0] || ''
              const last = entries.at(-1)?.[0] || ''
              const spanDays = first && last
                ? Math.max(1, Math.round((Date.parse(`${last}T00:00:00`) - Date.parse(`${first}T00:00:00`)) / 86400000) + 1)
                : 0
              // Bounded components prevent a huge noisy chat from dominating.
              const score =
                Math.log10(total + 1) * 18 +
                Math.log10(entries.length + 1) * 24 +
                Math.log10(spanDays + 1) * 12 +
                (recent > 0 ? 12 : 0) +
                (older > 0 ? 8 : 0)
              return { session, total, recent, older, activeDays: entries.length, first, last, spanDays, score }
            })
            .filter((row) => row.total > 0)
            .sort((a, b) => b.score - a.score || b.total - a.total)
            .slice(0, limit)
          if (rows.length === 0) return '没有可分析的私聊候选。'
          return [
            `关系候选 ${rows.length} 人（仅用于确定调查顺序；分数不是亲密度，近期=${recentDays}天）：`,
            ...rows.map((row, index) =>
              `${index + 1}. 「${row.session.displayName || row.session.username}」 id=${row.session.username} ` +
              `候选分=${row.score.toFixed(1)} 总消息=${row.total} 活跃日=${row.activeDays} 跨度=${row.spanDays}天 ` +
              `最早=${row.first || '—'} 最近=${row.last || '—'} 近期消息=${row.recent} 更早消息=${row.older}`,
            ),
            '下一步：对候选调用 sample_session_history；最终排名必须结合互惠、主动性、支持、话题深度、共同经历与变化趋势。',
          ].join('\n')
        },
      },
      {
        name: 'sample_session_history',
        description:
          'Read one chat across its FULL history using stable pagination offsets at recent/middle/early positions. Returns compact, evenly sampled message evidence plus sent/received balance for each period. Prefer this over many unbounded read_session_messages calls when comparing people or long-term change; use focused reads afterward for verification.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Chat id from list_sessions/get_relationship_candidates' },
            periods: { type: 'integer', minimum: 2, maximum: 5, description: 'History strata (default 3)' },
            messagesPerPeriod: { type: 'integer', minimum: 4, maximum: 30, description: 'Evenly sampled messages per stratum (default 10)' },
            maxCharsPerMessage: { type: 'integer', minimum: 60, maximum: 300, description: 'Per-message text cap (default 140)' },
          },
          required: ['sessionId'],
        },
        friendly: (args, ctx) => `分层抽样了「${ctx.getSessionName(String(args.sessionId || ''))}」的早期、中期与近期聊天`,
        handler: async (args, ctx) => {
          const sessionId = String(args.sessionId || '').trim()
          if (!sessionId) return '错误：缺少 sessionId。'
          const periods = clampInt(args.periods, 2, 5, 3)
          const messagesPerPeriod = clampInt(args.messagesPerPeriod, 4, 30, 10)
          const maxChars = clampInt(args.maxCharsPerMessage, 60, 300, 140)
          this.appendDebugLog({ kind: 'history_sample', chatId: ctx.chatId, stage: 'count_start', sessionId, periods, messagesPerPeriod })
          const countsResult = await chatService.getSessionMessageCounts([sessionId], { preferHintCache: true })
          this.appendDebugLog({ kind: 'history_sample', chatId: ctx.chatId, stage: 'count_done', sessionId, success: countsResult.success, count: countsResult.counts?.[sessionId] || 0 })
          if (!countsResult.success || !countsResult.counts) return `读取消息总数失败：${countsResult.error || '未知错误'}`
          const totalMessages = Math.max(0, Number(countsResult.counts[sessionId]) || 0)
          if (totalMessages === 0) return '该会话没有可抽样的消息。'
          const probeLimit = Math.min(120, Math.max(messagesPerPeriod * 3, 30))
          const offsets: number[] = []
          for (let i = 0; i < periods; i += 1) {
            const offset = Math.max(0, Math.min(totalMessages - 1, Math.round((i * Math.max(0, totalMessages - probeLimit)) / (periods - 1))))
            if (!offsets.includes(offset)) offsets.push(offset)
          }
          const name = ctx.getSessionName(sessionId)
          const sections: string[] = [
            `「${name}」全历史分层抽样：总消息=${totalMessages}，按分页位置覆盖近期→中期→早期。抽样用于发现模式，不代表完整事实。`,
          ]
          for (let periodIndex = 0; periodIndex < offsets.length; periodIndex += 1) {
            const offset = offsets[periodIndex]
            this.appendDebugLog({ kind: 'history_sample', chatId: ctx.chatId, stage: 'page_start', sessionId, offset, probeLimit })
            const result = await chatService.getMessages(sessionId, offset, probeLimit, 0, 0, false)
            this.appendDebugLog({ kind: 'history_sample', chatId: ctx.chatId, stage: 'page_done', sessionId, offset, success: result.success, messages: result.messages?.length || 0, error: result.error })
            const all = result.success ? result.messages || [] : []
            const sample: Message[] = []
            const wanted = Math.min(messagesPerPeriod, all.length)
            for (let i = 0; i < wanted; i += 1) {
              const index = wanted === 1 ? 0 : Math.round((i * (all.length - 1)) / (wanted - 1))
              const message = all[index]
              if (message && sample.at(-1) !== message) sample.push(message)
            }
            const sent = all.filter((m) => m.isSend === 1).length
            const received = all.length - sent
            const label = periodIndex === 0 ? '近期' : periodIndex === offsets.length - 1 ? '早期' : `中期${periodIndex}`
            const times = all.map((m) => Number(m.createTime) || 0).filter((time) => time > 0)
            const range = times.length > 0 ? `${formatTime(Math.min(...times))} ~ ${formatTime(Math.max(...times))}` : '未知时间'
            sections.push(`\n[${label} offset=${offset}] 覆盖=${range}；读取=${all.length}（我发=${sent}/对方发=${received}）；均匀样本=${sample.length}`)
            sections.push(...sample.map((m) => {
              const raw = formatMessageLine(m, name, ctx.myWxid, sessionId)
              return `- ${raw.slice(0, maxChars + 80)}`
            }))
          }
          sections.push('\n必须用 focused read/search 复核关键判断；不要把抽样缺失当作事件不存在。')
          return sections.join('\n')
        },
      },
      {
        name: 'review_prior_analyses',
        description:
          'Review prior WeportAI runs as fallible research leads: earlier user questions, tool sequence/coverage, final conclusion excerpt, and cache outcome. Use to avoid repeating blind alleys and to find people/windows worth re-checking. Prior AI answers are NOT evidence and must be verified against chat tools.',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: 'Optional filter across prior user questions and final answers' },
            limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Runs to return (default 5)' },
          },
        },
        friendly: () => '回顾了以往分析的调查路径与结论线索',
        handler: async (args, ctx) => {
          const keyword = String(args.keyword || '').trim().toLowerCase()
          const limit = clampInt(args.limit, 1, 10, 5)
          const rows = this.loadChats()
            .filter((chat) => chat.id !== ctx.chatId)
            .map((chat) => {
              const stored = this.loadMessages(chat.id)
              const canonical = [...this.loadArchivedMessages(chat.id), ...stored.messages]
              const users = canonical.filter((m) => m.role === 'user')
              const assistants = canonical.filter((m) => m.role === 'assistant')
              const final = [...assistants].reverse().find((m) => !m.toolCalls?.length && m.content.trim())
              const tools = assistants.flatMap((m) => m.toolCalls || []).map((call) => call.name)
              const haystack = `${chat.title}\n${users.map((m) => m.content).join('\n')}\n${final?.content || ''}`.toLowerCase()
              return { chat, users, final, tools, lastRun: stored.lastRun, matches: !keyword || haystack.includes(keyword) }
            })
            .filter((row) => row.matches && row.users.length > 0)
            .sort((a, b) => b.chat.updatedAt - a.chat.updatedAt)
            .slice(0, limit)
          if (rows.length === 0) return keyword ? `没有找到与「${keyword}」相关的既往分析。` : '没有可回顾的既往分析。'
          return [
            `既往分析 ${rows.length} 个（全部仅作线索，必须重新核验）：`,
            ...rows.map((row, index) => {
              const uniqueTools = Array.from(new Set(row.tools))
              const context = row.lastRun?.context
              return [
                `\n${index + 1}. ${row.chat.title}（${new Date(row.chat.updatedAt).toLocaleString()}）`,
                `用户问题：${row.users.map((m) => m.content.slice(0, 240)).join(' / ')}`,
                `调查路径：${uniqueTools.length ? uniqueTools.join(' → ') : '未使用工具'}（共 ${row.tools.length} 次）`,
                `旧结论摘录（非证据）：${String(row.final?.content || '未完成').replace(/\s+/g, ' ').slice(0, 900)}`,
                context ? `旧运行缓存：累计=${context.promptTokens > 0 ? ((context.cacheHitTokens / context.promptTokens) * 100).toFixed(1) : '0'}%，稳态≈${context.recentRate}%` : '',
              ].filter(Boolean).join('\n')
            }),
          ].join('\n')
        },
      },
      {
        name: 'read_session_messages',
        description:
          'Read a focused page of ONE chat in a known time window (newest first by default). Returns sender, time and parsed text plus nextOffset. For broad/long-term analysis use sample_session_history first, then use this tool only to verify a specific period or claim; avoid overlapping 200-500 message dumps.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'The chat username/id from list_sessions' },
            startTime: { type: 'string', description: 'Optional window start: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" (default: beginning)' },
            endTime: { type: 'string', description: 'Optional window end: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" (default: now)' },
            limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max messages (default 200)' },
            offset: { type: 'integer', minimum: 0, description: 'Pagination offset (default 0); use nextOffset from the previous result' },
            oldestFirst: { type: 'boolean', description: 'Return oldest first when true (default false = newest first)' },
          },
          required: ['sessionId'],
        },
        friendly: (args, ctx) => {
          const name = ctx.getSessionName(String(args.sessionId || ''))
          const n = clampInt(args.limit, 1, 500, 200)
          return `查看了「${name}」的聊天记录（${n} 条内）`
        },
        handler: async (args, ctx) => {
          const sessionId = String(args.sessionId || '').trim()
          if (!sessionId) return '错误：缺少 sessionId。'
          const limit = clampInt(args.limit, 1, 500, 200)
          const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
          const startSec = normalizeTimeSec(args.startTime)
          const endSec = normalizeTimeSec(args.endTime)
          const ascending = args.oldestFirst === true
          const startMs = startSec > 0 ? startSec * 1000 : 0
          const endMs = endSec > 0 ? endSec * 1000 : 0
          const result = await chatService.getMessages(sessionId, offset, limit, startMs, endMs, ascending)
          if (!result.success) return `读取失败：${result.error || '未知错误'}`
          const messages = result.messages || []
          if (messages.length === 0) return '该时间窗口内没有消息。'
          const name = ctx.getSessionName(sessionId)
          const lines = messages.map((m) => formatMessageLine(m, name, ctx.myWxid, sessionId))
          const rangeNote =
            startSec > 0 || endSec > 0
              ? `时间窗口 ${startSec ? formatTime(startSec) : '起点'} ~ ${endSec ? formatTime(endSec) : '现在'}；`
              : ''
          const nextOffset = Number(result.nextOffset ?? offset + messages.length)
          const truncNote = result.hasMore ? `（还有更多；nextOffset=${nextOffset}）` : '（已到该窗口末尾）'
          return `「${name}」（${sessionTypeLabel(sessionId)}）${rangeNote}offset=${offset}，返回 ${messages.length} 条${truncNote}：\n` + lines.join('\n')
        },
      },
      {
        name: 'read_day_events',
        description:
          'Cross-chat chronological view of ONE day: all messages from ALL chats on that date, merged by time, each prefixed with its chat name. Essential for connecting events that appear in multiple chats the same day.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'The day, format "YYYY-MM-DD"' },
            maxMessages: { type: 'integer', minimum: 10, maximum: 500, description: 'Max merged messages (default 300)' },
            focusSessions: { type: 'array', items: { type: 'string' }, description: 'Optional: only these session ids' },
            include: { type: 'string', enum: ['all', 'group', 'private'], description: 'Filter chat kinds (default all)' },
          },
          required: ['date'],
        },
        friendly: (args) => `梳理了 ${String(args.date || '')} 当天全部聊天的完整时间线`,
        handler: async (args, ctx) => {
          const date = String(args.date || '').trim()
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '错误：date 必须是 YYYY-MM-DD 格式。'
          const dayStart = Math.floor(new Date(`${date}T00:00:00`).getTime() / 1000)
          const dayEnd = dayStart + 86400
          return this.readPeriodEvents(date, dayStart, dayEnd, clampInt(args.maxMessages, 10, 500, 400), args.focusSessions, String(args.include || 'all'), ctx)
        },
      },
      {
        name: 'read_period_events',
        description:
          'Cross-chat chronological view of a date range: all messages from all chats between startDate and endDate, merged by time, each prefixed with its chat name. Use for timelines, trip/event reconstruction, or "what happened this week".',
        parameters: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'Start day, format "YYYY-MM-DD" (inclusive)' },
            endDate: { type: 'string', description: 'End day, format "YYYY-MM-DD" (inclusive)' },
            maxMessages: { type: 'integer', minimum: 10, maximum: 500, description: 'Max merged messages (default 300)' },
            focusSessions: { type: 'array', items: { type: 'string' }, description: 'Optional: only these session ids' },
            include: { type: 'string', enum: ['all', 'group', 'private'], description: 'Filter chat kinds (default all)' },
          },
          required: ['startDate', 'endDate'],
        },
        friendly: (args) => `梳理了 ${String(args.startDate || '')} ~ ${String(args.endDate || '')} 期间全部聊天的完整时间线`,
        handler: async (args, ctx) => {
          const start = String(args.startDate || '').trim()
          const end = String(args.endDate || '').trim()
          if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
            return '错误：startDate/endDate 必须是 YYYY-MM-DD 格式。'
          }
          const startSec = Math.floor(new Date(`${start}T00:00:00`).getTime() / 1000)
          const endSec = Math.floor(new Date(`${end}T23:59:59`).getTime() / 1000) + 1
          return this.readPeriodEvents(`${start} ~ ${end}`, startSec, endSec, clampInt(args.maxMessages, 10, 500, 400), args.focusSessions, String(args.include || 'all'), ctx)
        },
      },
      {
        name: 'search_messages',
        description:
          'Search message content across all chats or one chat by keyword (supports Chinese). Useful for finding names, topics, decisions, plans mentioned in any chat.',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: 'Search keyword' },
            sessionId: { type: 'string', description: 'Optional: restrict to one chat' },
            startTime: { type: 'string', description: 'Optional window start "YYYY-MM-DD"' },
            endTime: { type: 'string', description: 'Optional window end "YYYY-MM-DD"' },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max hits (default 30)' },
            offset: { type: 'integer', minimum: 0, description: 'Pagination offset (default 0)' },
          },
          required: ['keyword'],
        },
        friendly: (args, ctx) => {
          const name = args.sessionId ? ctx.getSessionName(String(args.sessionId)) : ''
          return `搜索了「${String(args.keyword || '')}」${name ? `（仅 ${name}）` : '（全部会话）'}`
        },
        handler: async (args, ctx) => {
          const keyword = String(args.keyword || '').trim()
          if (!keyword) return '错误：缺少 keyword。'
          const limit = clampInt(args.limit, 1, 100, 50)
          const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
          const sessionId = String(args.sessionId || '').trim() || undefined
          const beginSec = normalizeTimeSec(args.startTime) || undefined
          const endSec = normalizeTimeSec(args.endTime) || undefined
          const result = await chatService.searchMessages(keyword, sessionId, limit + 1, offset, beginSec, endSec)
          if (!result.success) return `搜索失败：${result.error || '未知错误'}`
          const allMessages = result.messages || []
          const hasMore = allMessages.length > limit
          const messages = allMessages.slice(0, limit)
          if (messages.length === 0) return `没有找到包含「${keyword}」的消息。`
          const names = new Map<string, string>()
          const lines = messages.map((m) => {
            const sid = String((m as Message & { sessionId?: string }).sessionId || sessionId || '')
            let name = ctx.getSessionName(sid)
            if (sid && !name) name = sid
            const sender = m.isSend === 1 ? '我' : String(m.senderDisplayName || m.senderUsername || name || '')
            return `- [${formatTime(Number(m.createTime) || 0)}] ${name} · ${sender}: ${String(m.parsedContent || m.rawContent || '').slice(0, 300)}`
          })
          void names
          return `「${keyword}」命中 ${messages.length} 条（offset=${offset}${hasMore ? `，nextOffset=${offset + messages.length}` : '，已到末尾'}）：\n` + lines.join('\n')
        },
      },
      {
        name: 'get_session_stats',
        description:
          'Statistics for one or more chats: total/voice/image/video/emoji/file/transfer/red-packet/call message counts, plus first/last activity. Optionally scoped to a date range. Use for the survey step.',
        parameters: {
          type: 'object',
          properties: {
            sessionIds: { type: 'array', items: { type: 'string' }, description: 'Chat ids' },
            startTime: { type: 'string', description: 'Optional window start "YYYY-MM-DD"' },
            endTime: { type: 'string', description: 'Optional window end "YYYY-MM-DD"' },
          },
          required: ['sessionIds'],
        },
        friendly: (args, ctx) => {
          const ids = Array.isArray(args.sessionIds) ? args.sessionIds.map(String) : []
          return `统计了 ${ids.slice(0, 3).map((id) => ctx.getSessionName(id)).join('、')}${ids.length > 3 ? ` 等 ${ids.length} 个会话` : ''}`
        },
        handler: async (args, ctx) => {
          const ids = Array.isArray(args.sessionIds) ? args.sessionIds.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 50) : []
          if (ids.length === 0) return '错误：缺少 sessionIds。'
          const beginSec = normalizeTimeSec(args.startTime) || undefined
          const endSec = normalizeTimeSec(args.endTime) || undefined
          const result = await chatService.getExportSessionStats(ids, {
            beginTimestamp: beginSec,
            endTimestamp: endSec,
            includeRelations: false,
            allowStaleCache: true,
          })
          if (!result.success || !result.data) return `统计失败：${result.error || '未知错误'}`
          const lines = Object.entries(result.data).map(([sid, st]) => {
            const s = st as Record<string, any>
            const name = ctx.getSessionName(sid)
            const range = beginSec || endSec ? `${beginSec ? formatTime(beginSec) : '起点'} ~ ${endSec ? formatTime(endSec) : '现在'} ` : ''
            const nonMedia = Math.max(0, (s.totalMessages ?? 0) - (s.imageMessages ?? 0) - (s.voiceMessages ?? 0) - (s.videoMessages ?? 0) - (s.emojiMessages ?? 0) - (s.fileMessages ?? 0))
            return (
              `- ${name}（${sid}）${range}总消息=${s.totalMessages ?? 0} 文本=${nonMedia} ` +
              `图片=${s.imageMessages ?? 0} 语音=${s.voiceMessages ?? 0} 视频=${s.videoMessages ?? 0} 表情=${s.emojiMessages ?? 0} 文件=${s.fileMessages ?? 0} ` +
              `转账=${s.transferMessages ?? 0} 红包=${s.redPacketMessages ?? 0} 通话=${s.callMessages ?? 0} ` +
              `首条=${s.firstTimestamp ? formatTime(Number(s.firstTimestamp)) : '—'} 末条=${s.lastTimestamp ? formatTime(Number(s.lastTimestamp)) : '—'}`
            )
          })
          return `统计（${ids.length} 个会话）：\n` + lines.join('\n')
        },
      },
      {
        name: 'list_dates',
        description:
          'List dates that have message activity, either for ONE chat or as a cross-chat activity calendar. Use it to find which days are interesting before reading them.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Optional: restrict to one chat' },
            year: { type: 'string', description: 'Optional year "YYYY" to narrow the result' },
            limit: { type: 'integer', minimum: 5, maximum: 200, description: 'Max dates (default 60)' },
          },
        },
        friendly: (args, ctx) => {
          const name = args.sessionId ? ctx.getSessionName(String(args.sessionId)) : ''
          return `列出了${name ? `「${name}」` : '全部会话'}的消息活跃日期`
        },
        handler: async (args, ctx) => {
          const sessionId = String(args.sessionId || '').trim()
          const year = String(args.year || '').trim()
          const limit = clampInt(args.limit, 5, 200, 60)
          if (sessionId) {
            const result = await chatService.getMessageDateCounts(sessionId)
            if (!result.success || !result.counts) return `读取失败：${result.error || '未知错误'}`
            const entries = Object.entries(result.counts)
              .filter(([d]) => !year || d.startsWith(year))
              .sort((a, b) => b[0].localeCompare(a[0]))
              .slice(0, limit)
            if (entries.length === 0) return '没有消息日期记录。'
            return `「${ctx.getSessionName(sessionId)}」的消息活跃日期（${entries.length} 天）：\n` +
              entries.map(([d, n]) => `- ${d}: ${n} 条`).join('\n')
          }
          const sessionMap = await this.getSessionMap()
          const ids = Array.from(sessionMap.values()).map((s) => s.username)
          const batch = await wcdbService.getSessionMessageDateCountsBatch(ids)
          const dayTotals = new Map<string, { count: number; chats: number }>()
          if (batch.success && batch.data) {
            for (const [sid, counts] of Object.entries(batch.data)) {
              for (const [date, n] of Object.entries(counts || {})) {
                if (year && !date.startsWith(year)) continue
                const cur = dayTotals.get(date) || { count: 0, chats: 0 }
                cur.count += Number(n) || 0
                cur.chats += 1
                dayTotals.set(date, cur)
              }
            }
          }
          const sorted = Array.from(dayTotals.entries()).sort((a, b) => b[0].localeCompare(a[0])).slice(0, limit)
          if (sorted.length === 0) return '没有消息日期记录。'
          return `跨会话活跃日历（最近 ${sorted.length} 天）：\n` +
            sorted.map(([d, v]) => `- ${d}: ${v.count} 条消息 / ${v.chats} 个会话`).join('\n')
        },
      },
      {
        name: 'get_contact_info',
        description:
          'Look up contact profile info for a username: display name, remark, nickname, alias, GENDER (if stored in the contact table), region and signature. For groups (chatroom ids) use get_group_members instead.',
        parameters: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'The wxid' },
          },
          required: ['username'],
        },
        friendly: (args) => `查询了联系人资料（${String(args.username || '')}）`,
        handler: async (args) => {
          const username = String(args.username || '').trim()
          if (!username) return '错误：缺少 username。'
          const lines: string[] = []
          try {
            const contact = await chatService.getContact(username)
            if (contact) {
              lines.push(`- username: ${contact.username}`)
              lines.push(`- alias: ${contact.alias || '—'}`)
              lines.push(`- remark(备注): ${contact.remark || '—'}`)
              lines.push(`- nickName(昵称): ${contact.nickName || '—'}`)
            }
          } catch { /* noop */ }
          // 直接读联系人表：性别/地区/签名等扩展字段（不同微信版本列名不同）
          try {
            const escaped = String(username).replace(/'/g, "''")
            const rowResult = await wcdbService.execQuery(
              'contact',
              null,
              `SELECT * FROM contact WHERE username = '${escaped}' LIMIT 1`
            )
            const row = rowResult.success && Array.isArray(rowResult.rows) ? rowResult.rows[0] : undefined
            if (row) {
              const sexRaw = String(
                row.sex ?? row.gender ?? row.personal_card ?? row.personalCard ?? row.user_sex ?? row.userSex ?? ''
              ).trim()
              if (sexRaw) {
                const gender = sexRaw === '1' ? '男' : sexRaw === '2' ? '女' : '未知'
                lines.push(`- gender(性别): ${gender}（表字段 ${sexRaw}）`)
              }
              const region = String(
                row.region ?? row.country ?? row.province ?? row.city ?? row.address ?? row.location ?? ''
              ).trim()
              if (region) lines.push(`- region(地区): ${region}`)
              const signature = String(row.signature ?? row.sign ?? row.description ?? row.detail_description ?? '').trim()
              if (signature) lines.push(`- signature(签名): ${signature.slice(0, 200)}`)
            }
          } catch { /* noop */ }
          if (lines.length === 0) {
            const map = await this.getSessionMap()
            const session = map.get(username)
            if (session) {
              lines.push(`- ${sessionTypeLabel(username)}「${session.displayName || username}」 username=${username} 消息数≈${session.messageCountHint ?? '未知'}`)
            }
          }
          return lines.length > 0 ? lines.join('\n') : '未找到该联系人的资料（可能不在通讯录中）。'
        },
      },
      {
        name: 'get_group_members',
        description:
          'Get the member roster of a GROUP chat: total member count, each member\'s group nickname, remark, nickname and whether the member is the account owner. Use this to understand WHO is in a group (roles, circles, subgroups) before or while analyzing its messages.',
        parameters: {
          type: 'object',
          properties: {
            chatroomId: { type: 'string', description: 'The group chat id, ends with @chatroom' },
            limit: { type: 'integer', minimum: 10, maximum: 200, description: 'Max members to list with full profile (default 60)' },
          },
          required: ['chatroomId'],
        },
        friendly: (args) => `查看了群成员名单（${String(args.chatroomId || '').slice(0, 30)}）`,
        handler: async (args) => {
          const chatroomId = String(args.chatroomId || '').trim()
          if (!chatroomId.endsWith('@chatroom')) return '错误：chatroomId 必须是 @chatroom 结尾的群聊 id。'
          const limit = clampInt(args.limit, 10, 200, 60)
          const membersResult = await wcdbService.getGroupMembers(chatroomId)
          if (!membersResult.success || !Array.isArray(membersResult.members) || membersResult.members.length === 0) {
            return `无法读取群成员（${membersResult.error || '空成员表'}）。`
          }
          const members = membersResult.members as Array<{ username?: string; originalName?: string; avatarUrl?: string }>
          const usernames = members.map((m) => String(m.username || '').trim()).filter(Boolean)
          const nickResult = await wcdbService.getGroupNicknames(chatroomId)
          const groupNicknames: Record<string, string> =
            nickResult.success && nickResult.nicknames ? nickResult.nicknames : {}
          const displayResult = await wcdbService.getDisplayNames(usernames)
          const displayNames: Record<string, string> =
            displayResult.success && displayResult.map ? displayResult.map : {}
          const myWxid = String(this.configService.getMyWxidCleaned() || this.configService.get('myWxid') || '').trim()

          // 只为前 limit 个成员补充备注/昵称（并发 6，避免大量 RPC）
          const enrichTargets = usernames.slice(0, limit)
          const contactMap = new Map<string, { remark?: string; nickName?: string; alias?: string }>()
          const CONCURRENCY = 6
          for (let i = 0; i < enrichTargets.length; i += CONCURRENCY) {
            const chunk = enrichTargets.slice(i, i + CONCURRENCY)
            await Promise.all(
              chunk.map(async (u) => {
                try {
                  const contact = await chatService.getContact(u)
                  if (contact) {
                    contactMap.set(u, {
                      remark: contact.remark || '',
                      nickName: contact.nickName || '',
                      alias: contact.alias || '',
                    })
                  }
                } catch { /* noop */ }
              })
            )
          }

          const pickGroupNickname = (m: { username?: string; originalName?: string }): string => {
            const candidates = [m.username, m.originalName, displayNames[String(m.username || '')]]
            for (const candidate of candidates) {
              if (!candidate) continue
              const direct = groupNicknames[candidate]
              if (direct) return direct
            }
            return ''
          }

          const lines = members.map((m, index) => {
            const wxid = String(m.username || '').trim()
            const groupNickname = pickGroupNickname(m)
            const contact = contactMap.get(wxid)
            const displayName = displayNames[wxid] || wxid
            const parts: string[] = []
            if (groupNickname) parts.push(`群昵称「${groupNickname}」`)
            if (contact?.remark) parts.push(`备注 ${contact.remark}`)
            if (contact?.nickName) parts.push(`昵称 ${contact.nickName}`)
            if (contact?.alias) parts.push(`alias ${contact.alias}`)
            if (!parts.length && displayName && displayName !== wxid) parts.push(`显示名 ${displayName}`)
            const isMe = wxid === myWxid || String(m.originalName || '').trim() === myWxid
            return `- ${isMe ? '（我）' : ''}${parts.join(' · ') || wxid}`
          })
          const header = `群成员共 ${members.length} 人（列出 ${Math.min(limit, members.length)} 人：前 ${limit} 人带完整资料，其余仅显示名）：\n`
          return header + lines.slice(0, limit).join('\n') + (members.length > limit ? `\n…（另有 ${members.length - limit} 人未列出）` : '')
        },
      },
      {
        name: 'get_self_overview',
        description: 'Return the account being analyzed (my wxid), the data scope (db path), and global counts (private/group/official chats). Call once at the start of a big task.',
        parameters: { type: 'object', properties: {} },
        friendly: () => '获取了当前分析范围概览',
        handler: async () => {
          const myWxid = String(this.configService.get('myWxid') || '').trim()
          const dbPath = String(this.configService.get('dbPath') || '').trim()
          let countsText = ''
          try {
            const counts = await chatService.getContactTypeCounts()
            if (counts.success && counts.counts) {
              const c = counts.counts
              countsText = `私聊=${c.private ?? 0} 群聊=${c.group ?? 0} 公众号=${c.official ?? 0} 已删除好友=${c.former_friend ?? 0}`
            }
          } catch { /* noop */ }
          return `账号：${myWxid || '（未配置，请在连接页选择）'}\n数据目录：${dbPath || '—'}\n会话构成：${countsText || '未知'}`
        },
      },
      {
        name: 'list_notes',
        description:
          'List the Markdown files in your workspace: memory/ (shared long-term memory across all chats) and notes/ (current chat). Call at the start of every task and after writing notes.',
        parameters: { type: 'object', properties: {} },
        friendly: () => '浏览了工作区记忆与笔记',
        handler: async (_, ctx) => {
          const files = this.listWorkFiles(ctx.chatId)
          if (files.length === 0) return '工作区还没有文件（可用 write_note 创建 memory/ 或 notes/ 下的 .md）。'
          return `工作区文件（${files.length} 个）：\n` +
            files.map((f) => `- ${f.path} (${f.bytes} B, 更新于 ${formatTime(Math.floor(f.mtime / 1000))})`).join('\n')
        },
      },
      {
        name: 'read_note',
        description:
          'Read a bounded slice of a Markdown workspace file. Persistent memory is fallible background, not evidence. For memory files the default mode is tail so the newest appended corrections are visible; use query to retrieve matching lines plus context instead of rereading a whole file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path, e.g. memory/personality.md or notes/today.md' },
            mode: { type: 'string', enum: ['head', 'tail'], description: 'Read from start/end (memory defaults tail; notes default head)' },
            query: { type: 'string', description: 'Optional case-insensitive text filter; returns matching lines with adjacent context' },
            maxChars: { type: 'integer', minimum: 500, maximum: 12000, description: 'Maximum returned content characters (default 5000)' },
          },
          required: ['path'],
        },
        friendly: (args) => `读取了 ${String(args.path || '')}`,
        handler: async (args, ctx) => {
          const resolved = this.resolveWorkPath(ctx.chatId, String(args.path || ''))
          if (!resolved) return '错误：path 必须是工作区内的相对 .md 路径（例如 memory/personality.md 或 notes/foo.md）。'
          if (!existsSync(resolved.target)) return '该文件不存在（可先 list_notes 查看）。'
          try {
            const content = readFileSync(resolved.target, 'utf8')
            const maxChars = clampInt(args.maxChars, 500, 12000, 5000)
            const query = String(args.query || '').trim().toLowerCase()
            const mode = args.mode === 'head' || args.mode === 'tail'
              ? args.mode
              : resolved.scope === 'memory' ? 'tail' : 'head'
            let selected = ''
            let selection = mode
            if (query) {
              const lines = content.split(/\r?\n/)
              const indexes = lines
                .map((line, index) => line.toLowerCase().includes(query) ? index : -1)
                .filter((index) => index >= 0)
              const included = new Set<number>()
              for (const index of indexes) {
                for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 3); i += 1) included.add(i)
              }
              selected = Array.from(included).sort((a, b) => a - b).map((index) => lines[index]).join('\n')
              selection = `query=${query}`
            } else if (mode === 'tail') {
              selected = content.slice(-maxChars)
            } else {
              selected = content.slice(0, maxChars)
            }
            if (selected.length > maxChars) selected = selected.slice(0, maxChars)
            const omitted = Math.max(0, content.length - selected.length)
            return [
              `--- ${String(args.path)} (${content.length} chars; ${selection}; fallible reference, verify against chats) ---`,
              omitted > 0 ? `…（本次仅返回 ${selected.length} 字符，另有 ${omitted} 字符未载入；可改 query/mode）` : '',
              selected || '（没有匹配内容）',
            ].filter(Boolean).join('\n')
          } catch (e) {
            return `读取失败：${String(e)}`
          }
        },
      },
      {
        name: 'write_note',
        description:
          'Write a Markdown workspace file. Existing memory/* files are append-only regardless of append, so durable history cannot be erased; write dated evidence, confidence, source chat/time, and corrections. Existing notes/* may be replaced when append=false. This is the ONLY file-writing tool.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path, must end with .md: memory/xxx.md or notes/xxx.md' },
            content: { type: 'string', description: 'Markdown content. Keep it factual and evidence-backed.' },
            append: { type: 'boolean', description: 'Append instead of overwrite (default false)' },
          },
          required: ['path', 'content'],
        },
        friendly: (args) => `${args.append === true ? '追加了' : '更新了'} ${String(args.path || '')}`,
        handler: async (args, ctx) => {
          const resolved = this.resolveWorkPath(ctx.chatId, String(args.path || ''))
          if (!resolved) return '错误：path 必须是工作区内的相对 .md 路径（例如 memory/personality.md 或 notes/foo.md）。'
          const content = String(args.content ?? '')
          if (!content.trim()) return '错误：content 不能为空。'
          try {
            mkdirSync(dirname(resolved.target), { recursive: true })
            const existed = existsSync(resolved.target)
            const mustAppend = resolved.scope === 'memory' && existed
            const append = args.append === true || mustAppend
            if (append) {
              const sep = existed ? (readFileSync(resolved.target, 'utf8').endsWith('\n') ? '' : '\n') : ''
              writeFileSync(resolved.target, sep + content + '\n', { flag: existed ? 'a' : 'w' })
            } else {
              writeFileSync(resolved.target, content.endsWith('\n') ? content : content + '\n', 'utf8')
            }
            const st = statSync(resolved.target)
            const path = String(args.path)
            this.appendDebugLog({
              kind: 'memory_change',
              chatId: ctx.chatId,
              path,
              scope: resolved.scope,
              operation: append ? 'append' : existed ? 'replace' : 'create',
              addedChars: content.length,
              fileBytes: st.size,
            })
            return `${resolved.scope === 'memory' ? '长期记忆已更新（仅追加，旧内容保留）' : '笔记已写入'}：${path}（新增 ${content.length} chars / 当前 ${st.size} B）。`
          } catch (e) {
            return `写入失败：${String(e)}`
          }
        },
      },
    ]
  }

  private toOpenAiTools(definitions = this.buildTools()): OpenAiToolDef[] {
    return definitions
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: canonicalProviderValue(t.parameters) as Record<string, unknown>,
        },
      }))
      .sort((a, b) => a.function.name.localeCompare(b.function.name))
  }

  private createModelRequestShape(definitions: ToolDefinition[]): ModelRequestShape {
    const custom = String(this.configService.get('weportAiCustomPrompt') || '').trim()
    const systemContent = custom ? `${SYSTEM_PROMPT}\n\n## User-supplied instructions (always honored)\n${custom}` : SYSTEM_PROMPT
    const tools = this.toOpenAiTools(definitions)
    const hash = createHash('sha256')
      .update(JSON.stringify({ systemContent, tools }))
      .digest('hex')
      .slice(0, 16)
    return { systemContent, tools, hash }
  }

  /** 跨会话时间线（read_day_events / read_period_events 共用） */
  private async readPeriodEvents(
    label: string,
    startSec: number,
    endSec: number,
    maxMessages: number,
    focusSessions: unknown,
    include: string,
    ctx: ToolHandlerContext
  ): Promise<string> {
    const sessionMap = await this.getSessionMap()
    let ids = Array.from(sessionMap.values()).map((s) => s.username)
    if (Array.isArray(focusSessions) && focusSessions.length > 0) {
      ids = focusSessions.map(String).map((s) => s.trim()).filter(Boolean)
    }
    if (include === 'group') ids = ids.filter((id) => id.endsWith('@chatroom'))
    if (include === 'private') ids = ids.filter((id) => !id.endsWith('@chatroom'))
    if (ids.length === 0) return '没有符合条件的会话。'

    const batch = await wcdbService.getSessionMessageDateCountsBatch(ids)
    const activeIds: string[] = []
    if (batch.success && batch.data) {
      for (const sid of ids) {
        const counts = batch.data[sid]
        if (counts && countMatchesInRange(counts, startSec, endSec) > 0) activeIds.push(sid)
      }
    }
    if (activeIds.length === 0) return `时间窗口 ${label} 内没有任何消息。`

    const perSession = Math.max(10, Math.min(120, Math.floor(maxMessages / Math.max(1, activeIds.length))))
    const collected: Array<{ time: number; sid: string; line: string }> = []
    const truncatedSessions: string[] = []
    let totalTruncated = 0

    // 分批并发（每批 4 个）：宿主进程消息游标数量有限，避免并行打开过多游标
    const CONCURRENCY = 4
    for (let i = 0; i < activeIds.length; i += CONCURRENCY) {
      const chunk = activeIds.slice(i, i + CONCURRENCY)
      await Promise.all(
        chunk.map(async (sid) => {
          const name = ctx.getSessionName(sid)
          // Sample early/middle/recent thirds instead of returning only the
          // earliest messages from a long range. This makes distant history
          // visible and states coverage honestly when any bucket is truncated.
          const span = Math.max(1, endSec - startSec)
          const bucketLimit = Math.max(4, Math.ceil(perSession / 3))
          for (let bucket = 0; bucket < 3; bucket += 1) {
            const bucketStart = startSec + Math.floor((span * bucket) / 3)
            const bucketEnd = bucket === 2 ? endSec : startSec + Math.floor((span * (bucket + 1)) / 3)
            const result = await chatService.getMessages(sid, 0, bucketLimit, bucketStart * 1000, bucketEnd * 1000, true)
            if (!result.success || !Array.isArray(result.messages)) continue
            for (const m of result.messages) {
              collected.push({ time: Number(m.createTime) || 0, sid, line: formatMessageLine(m, name, ctx.myWxid, sid) })
            }
            if (result.hasMore) {
              truncatedSessions.push(name)
              totalTruncated += 1
            }
          }
        })
      )
    }

    collected.sort((a, b) => a.time - b.time)
    const slice = collected.slice(0, maxMessages)
    const header = `时间线 ${label}：${activeIds.length} 个会话有消息；按早/中/近三段分层读取 ${collected.length} 条，返回 ${slice.length} 条（按时间排序；代表性样本，不宣称全量）：\n`
    const truncNote =
      collected.length > slice.length
        ? `\n（输出截断：${collected.length - slice.length} 条未返回${truncatedSessions.length ? '；桶内仍有更多的会话：' + Array.from(new Set(truncatedSessions)).slice(0, 5).join('、') : ''}，可用更小窗口细分）`
        : totalTruncated > 0
          ? `\n（覆盖提示：${totalTruncated} 个会话时间桶仍有更多消息；本结果为分层样本，可缩小窗口复核。）`
          : ''
    return header + slice.map((x) => x.line).join('\n') + truncNote
  }

  // -------------------------------------------------------------------------
  // Agent loop
  // -------------------------------------------------------------------------

  isRunning(chatId: string): boolean {
    return this.running.has(chatId)
  }

  abort(chatId: string): void {
    const ctrl = this.running.get(chatId)
    if (ctrl) {
      try {
        ctrl.abort()
      } catch { /* noop */ }
    }
  }

  /** 触发一次完整的 agent run（异步，事件流经 emitter 派发） */
  async runChat(chatId: string, text: string): Promise<{ success: boolean; error?: string }> {
    if (this.running.has(chatId)) return { success: false, error: '该对话正在执行中' }
    const chat = this.loadChats().find((c) => c.id === chatId)
    if (!chat) return { success: false, error: '对话不存在' }
    const userText = String(text || '').trim()
    if (!userText) return { success: false, error: '消息为空' }

    const apiKey = String(this.configService.get('weportAiApiKey') || '').trim()
    if (!apiKey) return { success: false, error: '未配置 API 密钥，请在 WeportAI 设置中填写' }

    const ctrl = new AbortController()
    this.running.set(chatId, ctrl)
    this.emit({ type: 'status', chatId, running: true })
    this.emit({ type: 'error', chatId, message: '' })

    // 首次消息 → 立即生成对话标题（先文本截断兜底，再异步用 AI 提炼更贴切的标题）
    const stored = this.loadMessages(chatId)
    const firstTitle = chat.title === '新对话' && stored.messages.length === 0

    let messages = stored.messages
    let compressed = stored.compressed
    const userMessage: AiMessage = {
      id: randomUUID(),
      role: 'user',
      content: userText,
      createdAt: Date.now(),
    }
    messages.push(userMessage)
    if (firstTitle) {
      const fallbackTitle = this.fallbackTitleFromText(userText) || chat.title
      chat.title = fallbackTitle
      chat.titleVersion = 1
      chat.updatedAt = Date.now()
      this.persistChats()
      void this.generateAITitle(userText).then((t) => {
        if (!t) return
        const meta = this.loadChats().find((c) => c.id === chatId)
        // 用户未手动改名（titleVersion=2）时才覆盖（避免吞掉用户起的标题）
        if (!meta || meta.titleVersion === 2) return
        meta.title = t
        meta.titleVersion = 2
        meta.updatedAt = Date.now()
        this.persistChats()
        this.emit({ type: 'chat_title', chatId, title: t })
      })
    }

    // 上下文压缩：历史超出窗口时把最旧部分压缩为摘要（对话要点不丢失）
    const convoLimit = Number(this.configService.get('weportAiConversationLimit')) || 60
    const { kept, digest, dropped } = this.compressOverflow(messages, convoLimit)
    if (digest) {
      this.archiveMessages(chatId, dropped)
      messages = kept
      compressed = compressed ? `${compressed}\n\n${digest}` : digest
      this.persistMessages(chatId, messages, compressed)
    }

    let usage: AiRunUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, promptCacheHitTokens: 0 }
    let lastRequestTokens = 0
    let recentRates: number[] = []
    let aborted = false
    let error: string | null = null

    try {
      const maxSteps = Number(this.configService.get('weportAiMaxSteps')) || 24
      // Freeze every provider-visible prefix component for this run. Settings
      // or plugin/tool changes take effect on the next user turn, never midway
      // through an append-only cache epoch.
      const runToolDefinitions = this.buildTools()
      const runToolsByName = new Map(runToolDefinitions.map((tool) => [tool.name, tool]))
      const requestShape = this.createModelRequestShape(runToolDefinitions)
      const sessionMap = await this.getSessionMap()
      const ctx: ToolHandlerContext = {
        chatId,
        sessionsByName: sessionMap,
        myWxid: String(this.configService.getMyWxidCleaned() || this.configService.get('myWxid') || ''),
        emit: this.emit,
        getSessionName: (id: string) => {
          const s = sessionMap.get(id)
          return s?.displayName || id
        },
      }

      let loopCount = 0
      let finalAssistant: AiMessage | null = null

      while (loopCount < maxSteps) {
        if (ctrl.signal.aborted) {
          aborted = true
          break
        }
        loopCount += 1

        const stepResult = await this.callModel(chatId, messages, ctrl.signal, compressed, requestShape)
        if (!stepResult.ok) {
          error = stepResult.error || '模型调用失败'
          if (stepResult.httpStatus === 401) {
            error = 'API 密钥无效或已过期（401），请在 WeportAI 设置中更新'
          } else if (stepResult.httpStatus === 402) {
            error = 'API 余额不足（402），请充值后重试'
          } else if (stepResult.httpStatus === 429) {
            error = '请求过于频繁（429），请稍后再试'
          } else if (stepResult.httpStatus === 400) {
            error = `请求参数错误（400）：${stepResult.error || ''}`
          }
          break
        }

        usage.promptTokens += stepResult.usage?.promptTokens || 0
        usage.completionTokens += stepResult.usage?.completionTokens || 0
        usage.reasoningTokens += stepResult.usage?.reasoningTokens || 0
        usage.totalTokens += stepResult.usage?.totalTokens || 0
        usage.promptCacheHitTokens += stepResult.usage?.promptCacheHitTokens || 0

        // 上下文窗口/缓存命中率统计（底部双进度条）：
        // - 上下文条 = 最近一次请求的输入规模（真实窗口占用）
        // - 缓存命中条 = 最近三次请求的平均命中率；它能反映当前稳定态，
        //   同时不会让本轮开头不可避免的冷新增工具结果永久压低读数。
        if (stepResult.usage) {
          lastRequestTokens = stepResult.usage.promptTokens
          const rate =
            stepResult.usage.promptTokens > 0
              ? (stepResult.usage.promptCacheHitTokens / stepResult.usage.promptTokens) * 100
              : 0
          recentRates = [...recentRates.slice(-2), rate]
          this.emit({
            type: 'context',
            chatId,
            promptTokens: usage.promptTokens,
            cacheHitTokens: usage.promptCacheHitTokens,
            lastRequestTokens,
            recentRate: Math.round((recentRates.reduce((a, b) => a + b, 0) / recentRates.length) * 10) / 10,
            contextWindow: Number(this.configService.get('weportAiContextWindow')) || 1000000,
          })
        }

        const assistant: AiMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: stepResult.content || '',
          reasoning: stepResult.reasoning || '',
          toolCalls: stepResult.toolCalls || [],
          createdAt: Date.now(),
        }
        finalAssistant = assistant
        messages.push(assistant)

        const toolCalls = stepResult.toolCalls || []
        // Persist the provider decision before native/database tool execution.
        // If a host process exits unexpectedly, the exact pending calls remain
        // available for diagnosis instead of disappearing with in-memory state.
        if (toolCalls.length > 0) this.persistMessages(chatId, messages, compressed)
        if (toolCalls.length === 0) {
          // 最终回答
          this.persistMessages(chatId, messages, compressed)
          this.emit({ type: 'assistant_message', chatId, message: assistant })
          break
        }

        // 执行工具调用
        const configuredToolBudget = Number(this.configService.get('weportAiMaxToolChars')) || 12000
        // A stable prefix alone is insufficient: the next request misses on the
        // assistant reasoning plus every newly appended tool result. Keep that
        // fresh suffix near <= 1/21 of the reusable conversation (~95.5% target),
        // while retaining a small evidence floor for early investigation steps.
        const reusableChars = this.previousApiInput.get(chatId)?.length || 0
        const assistantTailChars =
          assistant.content.length +
          (assistant.reasoning?.length || 0) +
          toolCalls.reduce((sum, call) => sum + call.name.length + JSON.stringify(call.args || {}).length + 80, 0) +
          240
        const cacheAwareAllowance = Math.max(3200, Math.floor(reusableChars / 21) - assistantTailChars)
        const stepToolBudget = Math.max(1000, Math.min(configuredToolBudget, 6000, cacheAwareAllowance))
        let remainingToolBudget = stepToolBudget
        let stepToolChars = 0
        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
          const call = toolCalls[toolIndex]
          if (ctrl.signal.aborted) break
          const tool = runToolsByName.get(call.name)
          let ok = false
          let result = ''
          if (!tool) {
            result = `错误：未知工具 ${call.name}`
          } else {
            call.friendly = tool.friendly(call.args, ctx)
            this.emit({
              type: 'tool_start',
              chatId,
              callId: call.id,
              name: call.name,
              args: call.args,
              friendly: call.friendly,
            })
            try {
              result = await tool.handler(call.args, ctx)
              ok = true
            } catch (e) {
              result = `工具执行异常：${String((e as Error)?.message || e)}`
            }
          }
          // Strict aggregate budget, divided fairly across the calls that are
          // still pending. Short results return unused space to later calls.
          const callsRemaining = toolCalls.length - toolIndex
          const resultBudget = Math.max(0, Math.floor(remainingToolBudget / Math.max(1, callsRemaining)))
          if (result.length > resultBudget) {
            const omitted = result.length - resultBudget
            const suffix = `\n…（截断，剩余 ${omitted} 字符）`
            result = resultBudget > suffix.length
              ? result.slice(0, resultBudget - suffix.length) + suffix
              : result.slice(0, resultBudget)
          }
          stepToolChars += result.length
          remainingToolBudget = Math.max(0, remainingToolBudget - result.length)
          call.ok = ok
          call.result = result
          messages.push({
            id: randomUUID(),
            role: 'tool',
            content: result,
            toolCallId: call.id,
            toolName: call.name,
            createdAt: Date.now(),
          })
          this.emit({
            type: 'tool_result',
            chatId,
            callId: call.id,
            name: call.name,
            ok,
            summary: result.slice(0, 300) + (result.length > 300 ? '…' : ''),
            detail: result,
          })
        }

        this.appendDebugLog({
          kind: 'tool_batch',
          chatId,
          calls: toolCalls.length,
          configuredBudgetChars: configuredToolBudget,
          budgetChars: stepToolBudget,
          reusableChars,
          assistantTailChars,
          cacheAwareAllowance,
          actualChars: stepToolChars,
          remainingChars: remainingToolBudget,
          tools: toolCalls.map((call) => call.name),
        })

        this.persistMessages(chatId, messages, compressed)
        if (ctrl.signal.aborted) {
          aborted = true
          break
        }
      }

      if (loopCount >= maxSteps && !error) {
        error = finalAssistant?.toolCalls?.length
          ? `回答未完成：已超过最大执行步数（${maxSteps}）`
          : `已超过最大执行步数（${maxSteps}），请缩小问题范围后重试`
      }
    } catch (e) {
      if (ctrl.signal.aborted) {
        aborted = true
      } else {
        error = String((e as Error)?.message || e)
        console.warn('[WeportAI] run 异常:', e)
      }
    } finally {
      this.running.delete(chatId)
      if (!error && !aborted) {
        chat.updatedAt = Date.now()
        this.persistChats()
      }
      const contextForRun = {
        promptTokens: usage.promptTokens,
        cacheHitTokens: usage.promptCacheHitTokens,
        lastRequestTokens,
        recentRate: recentRates.length
          ? Math.round((recentRates.reduce((a, b) => a + b, 0) / recentRates.length) * 10) / 10
          : 0,
        contextWindow: Number(this.configService.get('weportAiContextWindow')) || 1000000,
      }
      // 每次运行结束都记录本会话的用量/命中统计（切换会话后仍显示各自的数据）
      this.persistMessages(chatId, messages, compressed, {
        usage: usage.totalTokens > 0 ? usage : undefined,
        context: contextForRun,
      })
      this.emit({
        type: 'done',
        chatId,
        usage: error ? undefined : usage,
        aborted,
        context: contextForRun,
      })
      this.emit({ type: 'status', chatId, running: false })
    }

    if (error) {
      this.emit({ type: 'error', chatId, message: error })
      return { success: false, error }
    }
    return { success: true, error: aborted ? '已中止' : undefined }
  }

  // -------------------------------------------------------------------------
  // 模型调用（OpenAI 兼容 / streaming）
  // -------------------------------------------------------------------------

  private buildApiMessages(history: AiMessage[], compressed: string | undefined, systemContent: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [{ role: 'system', content: systemContent }]
    if (compressed) {
      out.push({
        role: 'system',
        content: sanitizeForApi(
          normalizeIdentityName(
            `以下摘要来自本对话更早的轮次（原始消息已压缩以节省上下文，其中提到的工具结果不必再重读）：\n${compressed}`,
          ),
        ),
      })
    }

    // runChat already performs cache-aware compression before entering the
    // model/tool loop. Never apply a second moving `slice(-limit)` here: once
    // the loop grows past the limit, every request would discard a different
    // leading message and collapse DeepSeek's prefix hit to the static system
    // prompt. Keep the in-run transcript strictly append-only instead.
    for (const m of history) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: sanitizeForApi(normalizeIdentityName(m.content)) })
      } else if (m.role === 'assistant') {
        const item: Record<string, unknown> = { role: 'assistant', content: sanitizeForApi(normalizeIdentityName(m.content || '')) }
        // 思考模式约束：携带工具调用的轮次必须回传 reasoning_content
        if (m.reasoning) item.reasoning_content = sanitizeForApi(normalizeIdentityName(m.reasoning))
        if (m.toolCalls && m.toolCalls.length > 0) {
          item.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          }))
        }
        out.push(item)
      } else if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId || '', content: sanitizeForApi(m.content || '') })
      }
    }
    return out
  }

  private debugLogPath(): string {
    return join(app.getPath('userData'), 'weport-ai', 'debug.log')
  }

  /**
   * 用一次廉价请求把用户的首条请求总结成对话标题（非流式、关闭思考）。
   * v2：标题必须 ≤8 个汉字，概括「用户意图」（用户想做什么），而非复述问题原文。
   * 失败时返回 null，调用方回退到文本截断标题。
   */
  private async generateAITitle(userText: string): Promise<string | null> {
    try {
      const baseUrl = String(this.configService.get('weportAiBaseUrl') || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
      const model = String(this.configService.get('weportAiModel') || 'deepseek-v4-flash').trim()
      const apiKey = String(this.configService.get('weportAiApiKey') || '').trim()
      if (!apiKey) return null
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            {
              role: 'system',
              content:
                '你负责为对话生成标题。要求：1) 不超过 8 个汉字（英文不超过 16 字符）；2) 概括用户的意图（用户想做什么），而不是复述问题原文；3) 专业、简洁。示例：用户问「分析我是什么人」→「人格画像」；「8月8日发生了什么」→「8月8日复盘」；「我和小明的聊天关系怎么样」→「关系分析」；「找出所有提到搬家的话」→「搬家事件追查」。只输出标题本身，不要引号、不要标点、不要解释。',
            },
            { role: 'user', content: sanitizeForApi(String(userText || '').slice(0, 2000)) },
          ],
          max_tokens: 24,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!resp.ok) return null
      const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const title = String(j?.choices?.[0]?.message?.content || '')
        .trim()
        .replace(/["'“”『』]/g, '')
        .replace(/\s+/g, ' ')
      if (!title || title.length > 16) return null
      return title.slice(0, 12)
    } catch {
      return null
    }
  }

  /** 文本兜底标题：去掉常见请求前缀动词，截取前 8 个汉字 */
  private fallbackTitleFromText(text: string): string {
    const stripped = String(text || '')
      .trim()
      .replace(
        /^(请(你|帮我)?|帮我|我想|我想要|请你|麻烦你|可以|能不能|帮我分析|帮我看看|分析一下|总结一下|梳理一下|看看|查一下|找找|找出|整理一下|给我)\s*/,
        ''
      )
    const cleaned = stripped.replace(/\s+/g, ' ')
    return cleaned.slice(0, 8) || '新对话'
  }

  /** 打开会话时，把旧版（过长/复述原文）标题静默升级为 v2 意图标题 */
  private upgradeStaleTitle(chatId: string): void {
    if (this.titleUpgrading.has(chatId)) return
    const chat = this.loadChats().find((c) => c.id === chatId)
    if (!chat) return
    if (chat.titleVersion === 2) return
    if ((chat.title?.length || 0) <= 8) return
    const stored = this.loadMessages(chatId)
    const firstUser = stored.messages.find((m) => m.role === 'user')
    if (!firstUser?.content) return
    this.titleUpgrading.add(chatId)
    void this.generateAITitle(firstUser.content).then((t) => {
      this.titleUpgrading.delete(chatId)
      if (!t) return
      const meta = this.loadChats().find((c) => c.id === chatId)
      if (!meta || meta.titleVersion === 2) return
      meta.title = t
      meta.titleVersion = 2
      meta.updatedAt = Date.now()
      this.persistChats()
      this.emit({ type: 'chat_title', chatId, title: t })
    })
  }

  private appendDebugLog(entry: Record<string, unknown>): void {
    try {
      const { appendFileSync } = require('fs') as typeof import('fs')
      appendFileSync(this.debugLogPath(), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8')
    } catch { /* noop */ }
  }

  getDebugLog(limit = 300): string[] {
    try {
      const { readFileSync, existsSync } = require('fs') as typeof import('fs')
      if (!existsSync(this.debugLogPath())) return []
      const lines = readFileSync(this.debugLogPath(), 'utf8').split(/\r?\n/).filter(Boolean)
      return lines.slice(-Math.max(1, Math.min(5000, limit)))
    } catch {
      return []
    }
  }

  clearDebugLog(): boolean {
    try {
      const { rmSync } = require('fs') as typeof import('fs')
      rmSync(this.debugLogPath(), { force: true })
      return true
    } catch {
      return false
    }
  }

  private async callModel(
    chatId: string,
    history: AiMessage[],
    signal: AbortSignal,
    compressed: string | undefined,
    requestShape: ModelRequestShape
  ): Promise<{
    ok: boolean
    content?: string
    reasoning?: string
    toolCalls?: AiToolCall[]
    usage?: AiRunUsage
    error?: string
    httpStatus?: number
  }> {
    const baseUrl = String(this.configService.get('weportAiBaseUrl') || 'https://api.deepseek.com').trim().replace(/\/+$/, '')
    const model = String(this.configService.get('weportAiModel') || 'deepseek-v4-flash').trim()
    const apiKey = String(this.configService.get('weportAiApiKey') || '').trim()
    const maxTokens = Number(this.configService.get('weportAiMaxTokens')) || 8192
    const reasoningEffort = this.configService.get('weportAiReasoningEffort') || 'high'
    const url = `${baseUrl}/chat/completions`

    const apiMessages = this.buildApiMessages(history, compressed, requestShape.systemContent)
    const tools = requestShape.tools
    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      reasoning_effort: reasoningEffort,
    }

    const startedAt = Date.now()
    // Compare the provider-visible conversation stream without JSON array
    // closing syntax. An append-only message list is then an exact string
    // prefix; tool-schema stability is tracked independently by shape.hash.
    const serializedInput = apiMessages.map((message) => JSON.stringify(message)).join('\n')
    const previousInput = this.previousApiInput.get(chatId) || ''
    let commonPrefixChars = 0
    const commonLimit = Math.min(previousInput.length, serializedInput.length)
    while (
      commonPrefixChars < commonLimit &&
      previousInput.charCodeAt(commonPrefixChars) === serializedInput.charCodeAt(commonPrefixChars)
    ) {
      commonPrefixChars += 1
    }
    this.previousApiInput.set(chatId, serializedInput)
    const estChars = JSON.stringify(body).length
    const messagesChars = JSON.stringify(apiMessages).length
    const toolsChars = JSON.stringify(tools).length
    this.appendDebugLog({
      kind: 'request',
      chatId,
      model,
      url,
      messages: history.length,
      apiMessages: apiMessages.length,
      estChars,
      messagesChars,
      toolsChars,
      stablePrefixHash: requestShape.hash,
      previousInputChars: previousInput.length,
      commonPrefixChars,
      commonPrefixRate: previousInput.length > 0
        ? Math.round((commonPrefixChars / previousInput.length) * 10000) / 100
        : null,
      appendedChars: Math.max(0, serializedInput.length - commonPrefixChars),
      maxTokens,
      reasoningEffort,
    })

    // 看门狗：流中途长时间无新字节（代理/服务端挂起）时主动中止，避免无限等待。
    // 本地 AbortController 链到调用方 signal（AbortSignal.any 不可用时退化为原 signal），
    // 必须在 fetch 之前创建，否则中止无法传导到已发起的请求。
    const idleCtrl = new AbortController()
    let streamSignal: AbortSignal
    try {
      streamSignal = AbortSignal.any([signal, idleCtrl.signal])
    } catch {
      streamSignal = signal
    }

    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: streamSignal,
      })
    } catch (e) {
      if (signal.aborted) return { ok: false, error: '已中止' }
      if (idleCtrl.signal.aborted) return { ok: false, error: '请求超时（无响应）' }
      this.appendDebugLog({ kind: 'error', chatId, error: String((e as Error)?.message || e), durationMs: Date.now() - startedAt })
      return { ok: false, error: `网络请求失败：${String((e as Error)?.message || e)}` }
    }

    if (!resp.ok) {
      let detail = ''
      try {
        const j = (await resp.json()) as { error?: { message?: string } }
        detail = j?.error?.message || ''
      } catch { /* noop */ }
      this.appendDebugLog({
        kind: 'error',
        chatId,
        httpStatus: resp.status,
        error: detail || `HTTP ${resp.status}`,
        durationMs: Date.now() - startedAt,
        estChars,
      })
      return { ok: false, error: detail || `HTTP ${resp.status}`, httpStatus: resp.status }
    }

    if (!resp.body) return { ok: false, error: '响应流为空' }

    // 流式解析 SSE
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let content = ''
    let reasoning = ''
    const toolAccums = new Map<number, { id?: string; name?: string; args: string }>()
    let finishReason: string | null = null
    // 仅在 handleSseLine 闭包内赋值：声明后若不加 `!`，TS 会把 usage 收窄为
    // null 初始值，读取属性时报 never
    let usage!: AiRunUsage | null
    const SSE_IDLE_TIMEOUT_MS = 90_000
    let idleTimer: NodeJS.Timeout | null = null
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimer = null
        if (signal.aborted) return
        console.warn(`[WeportAI] SSE ${SSE_IDLE_TIMEOUT_MS}ms 无数据，判定服务端挂起，中止本次请求`)
        try { idleCtrl.abort() } catch { /* noop */ }
      }, SSE_IDLE_TIMEOUT_MS)
    }
    const disarmIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
    }

    const handleSseLine = (rawLine: string): void => {
      const line = rawLine.trim()
      if (!line || !line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      let chunk: any
      try {
        chunk = JSON.parse(data)
      } catch {
        return
      }
      if (chunk?.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens || 0,
          promptCacheHitTokens: chunk.usage.prompt_cache_hit_tokens || 0,
          completionTokens: chunk.usage.completion_tokens || 0,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0,
        }
      }
      const choice = chunk?.choices?.[0]
      if (!choice) {
        return
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta || {}
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content
        this.emit({ type: 'reasoning_delta', chatId, delta: delta.reasoning_content })
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        this.emit({ type: 'text_delta', chatId, delta: delta.content })
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = Number(tc.index ?? 0)
          const acc = toolAccums.get(index) || { args: '' }
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name = tc.function.name
          if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments
          toolAccums.set(index, acc)
        }
      }
    }

    try {
      for (;;) {
        armIdle()
        const { done, value } = await reader.read()
        disarmIdle()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          handleSseLine(line)
        }
      }
      // 流结束后缓冲区里可能残留未换行的最后一行，必须处理掉
      // （此前直接丢弃：内容以 tool_calls/usage 结尾时会丢失最后一次增量）
      if (buffer) {
        handleSseLine(buffer)
        buffer = ''
      }
    } catch (e) {
      if (signal.aborted) return { ok: false, error: '已中止' }
      if (idleCtrl.signal.aborted) return { ok: false, error: `流式响应超时（${SSE_IDLE_TIMEOUT_MS}ms 无数据）` }
      throw e
    } finally {
      disarmIdle()
    }

    const toolCalls = Array.from(toolAccums.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => {
        let args: Record<string, unknown> = {}
        try {
          args = acc.args ? JSON.parse(acc.args) : {}
        } catch {
          args = { _raw: acc.args }
        }
        return {
          id: acc.id || `call_${randomUUID()}`,
          name: acc.name || '',
          args,
          friendly: '',
        }
      })
      .filter((c) => c.name)

    this.appendDebugLog({
      kind: 'response',
      chatId,
      ok: true,
      contentChars: content.length,
      reasoningChars: reasoning.length,
      toolCalls: toolCalls.length,
      finishReason: finishReason || undefined,
      usage,
      promptCacheMissTokens: usage ? Math.max(0, usage.promptTokens - usage.promptCacheHitTokens) : 0,
      promptCacheHitRate: usage?.promptTokens
        ? Math.round((usage.promptCacheHitTokens / usage.promptTokens) * 10000) / 100
        : 0,
      durationMs: Date.now() - startedAt,
    })

    return { ok: true, content, reasoning, toolCalls, usage: usage || undefined }
  }
}

export const weportAiService = new WeportAiService()
