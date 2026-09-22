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
import { connectorsService } from './connectors/connectorsService'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import type { ChatSession, Message } from './chatService'
import { getProviderAdapter, makeDefaultProfile } from './ai/providerAdapters'
import { getProviderCatalog, getProviderCatalogEntry, invalidateCatalogOverride, normalizeProviderId } from './ai/providerCatalog'
import { ProviderProfileService } from './ai/providerProfiles'
import { getModelRegistry, resolvedProfileCache } from './ai/registryRuntime'
import { extractModelIds, isChatCapable, normalizeModelRecord, resolveModelMetadata } from './ai/modelRegistry'
import type { ModelRecord, ResolvedModel } from './ai/modelRegistry'
import type { ProviderProfile } from './ai/providerTypes'
import {
  CHARS_PER_TOKEN,
  COMPACT_RETAIN_RATIO,
  COMPACT_TRIGGER_RATIO,
  buildPrefixFrame,
  comparePrefixFrames,
  compressOverflow as compressOverflowPure,
  mergeDigest,
  type CompressibleMessage,
  type PrefixChange,
  type PrefixFrame,
} from './ai/prefixCache'
import type { ProviderConsumer, ProviderProfileInput, ProviderProfileSummary, ProviderStreamResult } from './ai/providerTypes'
import { buildFallbackTitle, hasCjk, normaliseTitle, titleEchoesSource } from './ai/chatTitle'
import { describeNetworkFailure } from './ai/netError'
import { imagePartFromBase64, type AiImagePart } from './ai/imageParts'
import { runToolBatch } from './ai/toolSchedule'
export type { AiImagePart } from './ai/imageParts'

/**
 * 运行失败时留给用户看的错误文本。
 *
 * `fetch failed` 是唯一一种**消息本身完全没有信息量**的错误（undici 把 errno
 * 藏在 `cause` 里），而它恰好是最常见的失败之一：WeBot 笔记里那句
 * 「上次失败：fetch failed」就是它。这里做最后一次兜底展开 —— 适配层已经
 * 翻译过一遍，但异常也可能从别的路径冒出来。
 */
function readRunError(error: unknown): string {
  const message = String((error as Error)?.message || error || '').trim()
  if (!message || /^fetch failed$/i.test(message)) return describeNetworkFailure(error)
  return message
}

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

/**
 * 一次模型调用的解码计时，和 DSH 用的是同一套口径：
 *
 *   ttftMs   = 首个 token 到达 − 发出请求
 *   decodeMs = 生成结束 − 首个 token 到达
 *   TPS      = outputTokens / (decodeMs / 1000)
 *
 * 关键是**把首 token 等待从解码时间里扣掉**。用「总耗时」算出来的速度会把
 * TTFT（长前缀下往往是几秒）算进分子分母，读出来的数字比真实解码速度低一个
 * 量级，且前缀越长越显得慢 —— 那是延迟，不是吞吐。
 */
export interface AiStepTiming {
  ttftMs: number
  decodeMs: number
  outputTokens: number
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  reasoning?: string
  toolCalls?: AiToolCall[]
  toolCallId?: string
  toolName?: string
  /** 这条结果附带了几张图（图片本体不落盘，张数留作证据标记） */
  imageCount?: number
  createdAt: number
  /** 本轮解码计时，用于消息尾部的 `N tok/s` 读数 */
  timing?: AiStepTiming
  /**
   * 随这条工具结果**附给模型看**的图片（base64，不含 `data:` 前缀）。
   *
   * 为什么挂在消息上而不是塞进文本：视觉模型的图片是独立的内容块
   * （OpenAI 的 `image_url` / Anthropic 的 `image` / Gemini 的 `inlineData`），
   * 把它编码成文本等于让模型去"读"一段 base64。
   *
   * 只存在于内存里：`persistMessages` 落盘时会把 base64 去掉（见那里的说明），
   * 否则一次「看作业」就会让会话文件涨几 MB。
   */
  images?: AiImagePart[]
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
  reasoningEffort: 'low' | 'high' | 'max'
  /** 图片输入开关（默认开）：关掉后 `read_chat_images` 不再把图片本体交给模型 */
  imageInputs: boolean
  customPrompt: string
  workspaceRoot: string
  exportPath: string
  dbReady: boolean
  disabledTools: string[]
  activeProfileId: string
  profiles: ProviderProfileSummary[]
  catalog: ReturnType<typeof getProviderCatalog>
  // 定价（modelCosts）在 v1.0.1 移除：它建立在 models.dev 那张覆盖不全的定价表上，
  // 面板显示的多是「未定价」，有值时也只是估算。token 用量照常下发。
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
  /**
   * 批量 delta（50ms 窗口聚合）。逐 delta 送 IPC 会让渲染层每 token 重渲染
   * 一整段 markdown —— O(n²) 的解析白白拖慢流式跟读；聚合成批后每秒 ≤20 次
   * 状态更新，事件顺序仍在任何非 delta 事件之前 flush。
   */
  | { type: 'deltas'; chatId: string; items: Array<{ kind: 'text' | 'reasoning'; delta: string }> }
  | { type: 'tool_start'; chatId: string; callId: string; name: string; args: Record<string, unknown>; friendly: string }
  | { type: 'tool_result'; chatId: string; callId: string; name: string; ok: boolean; summary: string; detail?: string; imageCount?: number }
  | { type: 'assistant_message'; chatId: string; message: AiMessage; timing?: AiStepTiming }
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
  /**
   * 把图片附到**这次工具调用**的结果上，交给视觉模型看。
   *
   * 用回调而不是让 handler 返回结构化结果：现有的工具契约是「返回一段文本」，
   * 改成联合类型会牵动所有二十多个工具；而图片本来就是旁路信息（文本里仍然
   * 要写清楚附了什么）。超出上限的部分会被拒绝（见调用点）。
   */
  attachImages: (images: AiImagePart[]) => void
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

/**
 * Model-discovery budget.
 *
 * 30 s + one retry because `opencode.ai/zen/v1/models` is intermittently slow:
 * live probes timed out at 20 s and 60 s, then answered in 0.8 s on the next
 * attempt. The previous fixed 15 s with no retry reported a working endpoint as
 * a permissions problem.
 */
const MODEL_DISCOVERY_TIMEOUT_MS = 30000
const MODEL_DISCOVERY_ATTEMPTS = 2

/** Gateway profiles that get the identification header and the empty-list retry. */
const OPENCODE_GATEWAYS = new Set(['opencode-zen', 'opencode-go'])

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

const SYSTEM_PROMPT = `You are WeportAI (exactly this spelling: capital W, "Weport", capital A, "AI" — never "WreportAI", "WepoortAI", "Weport Ai" or any other variant), a meticulous WeChat chat-history analyst agent running inside the Weport harness. Always refer to yourself and to this product exactly as "WeportAI"; if you ever encounter a misspelled variant of the name — in the conversation, in notes, or in memory — silently correct it to "WeportAI" and never repeat the variant. The user gives you analysis tasks about their own WeChat history; you explore it with the provided tools, reason objectively, and deliver rigorous, evidence-grounded Markdown answers. Reply in the language the user used (Chinese by default).

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
8. CACHE-EFFICIENT INVESTIGATION. Prefer compact survey/stratified tools over repeatedly dumping large raw windows. Keep tool-planning reasoning concise. Fetch raw detail only for claims that will affect the answer, and use cursors/focused time windows rather than repeating overlapping reads. Batch UP TO 4 **independent** evidence-heavy calls (read/session/sample/search/period) in one assistant step — independent reads execute in parallel, so batching saves whole round trips — but keep each call focused (tight windows, small limits) so every result stays useful within the per-step budget. Sequence dependent calls (step 2 needs step 1's ids) with separate steps instead.
9. ASSUME YOUR CHAT DATA IS STALE — AND MAKE IT FRESH. You read the local WeChat database directly, but the *account owner keeps chatting while you work*: messages arrive continuously, and both this conversation and any WeBot task (a scheduled run, a note, a summary you produced earlier) can be holding a snapshot that is minutes or hours old. Two consequences you must apply:
   - Anything you read earlier in THIS conversation is a snapshot, not the current state. Before any claim that depends on "now / today / latest / 最近 / 刚刚 / 有没有新消息", call sync_chat_history first (it drops the cached cursors, statistics and message snapshots) and re-read the chat with read_session_messages. Never answer a "what's new" question from an earlier tool result.
   - Your own memory files and the notes you (or a WeBot task) wrote earlier are even older. Date-stamp freshness when you rely on them ("截至 <时间>"), and re-verify before repeating them as current fact.

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
- Is my view of the chats still current / force a re-read of one chat or all chats → sync_chat_history (ALWAYS before "最新/今天/有没有新消息" claims)
- What happened across ALL chats on a day or range → read_day_events / read_period_events (ALWAYS for "what happened" questions)
- Deep dive one chat's messages → read_session_messages with startTime/endTime slices
- What a PICTURE shows (homework photo, screenshot, receipt, timetable) → read_chat_images (the image itself is attached to the tool result; text tools cannot see inside a picture). Ask for 1-3 images only.
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

/**
 * 一次工具调用最多附几张图给模型。
 *
 * 每张图按分辨率不同要花几百到上千 token，而且**每一步都会重发整段前缀**：
 * 附 10 张图等于把后面每一步的输入都变大一个量级。3 张足够回答"这张作业照片
 * 是什么/群里的图说了什么"，再多应该让它分几次看。
 */
const MAX_TOOL_IMAGES = 3

/**
 * 会改状态的工具 —— DSH 的「exclusive barrier」分类（`dsh-tools/README.md`：
 * "safe calls run concurrently; mutating calls run alone, in submission order"）。
 * 这些调用在一批里单独顺序执行；其余（纯读）进有界并发池。
 */
const EXCLUSIVE_TOOLS = new Set(['write_note', 'sync_chat_history', 'create_connector_task'])

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
  private providerProfiles: ProviderProfileService
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
  /**
   * 前缀稳定性探针的上一帧（见 {@link probePrefixChange}）。
   * 内存帧是热路径；磁盘帧（`prefix-probe.json`）让**重启后**的第一次请求也能
   * 和上一次进程的帧逐字节比较 —— 否则每次重启都记成 `first`，跨重启的
   * system/tools/route 变化（真正的全量缓存失效）永远看不见。
   */
  private prefixProbe = new Map<string, PrefixFrame>()
  private prefixProbeDisk: Map<string, PrefixFrame> | null = null
  private emitter: EventEmitter | null = null
  /** 待 flush 的 delta 批（见 {@link emit}） */
  private deltaBuffer: Array<{ kind: 'text' | 'reasoning'; delta: string }> = []
  private deltaChatId = ''
  private deltaTimer: ReturnType<typeof setTimeout> | null = null
  private sessionListCache: { at: number; sessions: ChatSession[] } = { at: 0, sessions: [] }
  private titleUpgrading = new Set<string>()
  /** 标题生成的追踪开关（WEPORT_TITLE_PROBE=1 时把结果写进 debug.log） */
  private titleProbe: boolean | undefined
  /** 见 {@link applyProbeOverride}：仅在 `WEPORT_AI_PROBE_MODEL` 进程里非空。 */
  private probeModel = String(process.env.WEPORT_AI_PROBE_MODEL || '').trim()

  constructor() {
    this.configService = ConfigService.getInstance()
    this.providerProfiles = new ProviderProfileService(this.configService)
  }

  /**
   * 诊断用的模型覆盖（`WEPORT_AI_PROBE_MODEL`）。
   *
   * 存在的理由：网关按 **模型** 而不是按 profile 决定协议，而"配置里存着某个
   * 模型"不等于"这台机器、这把钥匙真的能调用它"（OpenCode Go 对部分模型会回
   * `This model is not available in your country.`）。想知道某个模型 id 是否可用，
   * 就得能拿同一个 profile 换模型试一次，而不是去改用户配置或建一个持久化 profile。
   *
   * 只在探针进程里生效，且只改内存里的这一份副本，绝不落盘。
   */
  private applyProbeOverride(profile: ProviderProfile): ProviderProfile {
    if (!this.probeModel) return profile
    const baseUrl = String(process.env.WEPORT_AI_PROBE_BASE_URL || '').trim().replace(/\/+$/, '')
    const providerId = String(process.env.WEPORT_AI_PROBE_PROVIDER || '').trim()
    return {
      ...profile,
      model: this.probeModel,
      ...(baseUrl ? { baseUrl } : {}),
      ...(providerId ? { providerId } : {}),
    }
  }

  /** 探针模式的只读状态（供 `WEPORT_AI_PROBE` 打印，便于确认覆盖是否生效）。 */
  probeOverrideState(): { model: string; baseUrl: string; providerId: string } {
    return {
      model: this.probeModel,
      baseUrl: String(process.env.WEPORT_AI_PROBE_BASE_URL || '').trim(),
      providerId: String(process.env.WEPORT_AI_PROBE_PROVIDER || '').trim(),
    }
  }

  // -------------------------------------------------------------------------
  // 基础设施
  // -------------------------------------------------------------------------

  setEventEmitter(emitter: EventEmitter): void {
    this.emitter = emitter
  }

  private emit(event: AiEvent): void {
    // Delta 聚合：文本/思考增量攒 50ms 一批再派发（渲染层一次状态更新吃一批）。
    // 任何非 delta 事件都先 flush —— 事件顺序（delta → assistant_message → done）
    // 必须保持，否则面板会把上一步的尾巴画进下一步的气泡里。
    if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
      if (this.deltaTimer && this.deltaChatId !== event.chatId) this.flushDeltas()
      this.deltaChatId = event.chatId
      this.deltaBuffer.push({ kind: event.type === 'text_delta' ? 'text' : 'reasoning', delta: event.delta })
      if (!this.deltaTimer) {
        this.deltaTimer = setTimeout(() => this.flushDeltas(), 50)
        ;(this.deltaTimer as { unref?: () => void }).unref?.()
      }
      return
    }
    this.flushDeltas()
    try {
      this.emitter?.(event)
    } catch (e) {
      console.warn('[WeportAI] 事件派发失败:', e)
    }
  }

  private flushDeltas(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer)
      this.deltaTimer = null
    }
    if (this.deltaBuffer.length === 0) return
    const items = this.deltaBuffer
    const chatId = this.deltaChatId
    this.deltaBuffer = []
    try {
      this.emitter?.({ type: 'deltas', chatId, items })
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

  /**
   * 压缩预算。`trigger` 用 DSH 的比例（0.8 触发 / 0.16 保留），自动触发和
   * 手动 `/compact` 共用同一个函数 —— 两套阈值必然漂移，然后「手动压缩之后
   * 下一轮又自动压一次」。
   */
  private compactBudgetFor(contextWindow: number, trigger = COMPACT_TRIGGER_RATIO, retain = COMPACT_RETAIN_RATIO) {
    return {
      maxChars: Math.floor(contextWindow * CHARS_PER_TOKEN * trigger),
      retainChars: Math.floor(contextWindow * CHARS_PER_TOKEN * retain),
    }
  }

  /**
   * 手动压缩：把历史收进摘要，保留最近一段原文。
   *
   * 这是 Harness 的显式入口（CLI `ai.compact`、面板上的「压缩上下文」），
   * 与 runChat 里那次自动压缩走同一套代码：`compressOverflow` + 单份摘要 +
   * 归档。手动指定更低的触发比例，是因为用户主动要求压缩时，通常是要**腾出**
   * 空间继续长任务，而不是等到 0.8 才动手。
   *
   * 返回 `changed: false` 且 `reason: 'below-threshold'` 表示当前历史还没到
   * 该压的程度 —— 调用方不该谎报"已压缩"，那会让用户以为腾出了空间。
   */
  compactChat(chatId: string, options?: { consumer?: ProviderConsumer; trigger?: number; retain?: number }): {
    success: boolean
    changed: boolean
    reason?: 'below-threshold' | 'not-found'
    dropped?: number
    kept?: number
    digestChars?: number
    error?: string
  } {
    try {
      const chat = this.loadChats().find((c) => c.id === chatId)
      if (!chat) return { success: false, changed: false, reason: 'not-found', error: '会话不存在' }
      const stored = this.loadMessages(chatId)
      const consumer = options?.consumer || 'chat'
      const contextWindow = this.resolveContextWindow(consumer, this.providerProfiles.getForConsumer(consumer))
      const budget = this.compactBudgetFor(contextWindow, options?.trigger ?? COMPACT_TRIGGER_RATIO * 0.75, options?.retain ?? COMPACT_RETAIN_RATIO)
      const { kept, digest, dropped } = this.compressOverflow(stored.messages, budget)
      if (!digest || dropped.length === 0) {
        return { success: true, changed: false, reason: 'below-threshold', dropped: 0, kept: stored.messages.length }
      }
      this.archiveMessages(chatId, dropped)
      this.persistMessages(chatId, kept, this.mergeDigest(stored.compressed, digest))
      return { success: true, changed: true, dropped: dropped.length, kept: kept.length, digestChars: digest.length }
    } catch (e) {
      return { success: false, changed: false, error: String(e) }
    }
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
        // 图片本体只活在内存里：base64 落盘会让一个「看作业照片」的会话文件涨几
        // MB，而且**每一步都要重发整段前缀**，等于把后续所有请求的输入都撑大一个
        // 量级。这里只去掉像素，**绝不改 content 的字节** —— 改了正文就等于把
        // 上一次真实发出去的前缀偷偷改掉，下一次运行必然从这条消息起全量 miss。
        // 代价是明知的：跨运行重放到这条消息会触发一次 head-rewrite，持久化探针
        // （prefix-probe.json）会把它如实记成 `head-rewrite` 而不是装作没发生。
        // 张数记在 `imageCount` 字段上：buildApiMessages 逐字段构造 wire 消息，
        // 多余字段不上线，不参与任何字节比较。
        JSON.stringify({
          chatId,
          messages: messages.map((message) =>
            message.images?.length
              ? { ...message, images: undefined, imageCount: message.images.length }
              : message
          ),
          compressed,
          lastRun: lastRun || undefined,
        }, null, 2),
        'utf8'
      )
      renameSync(tmp, target)
    } catch (e) {
      console.warn('[WeportAI] 写入会话消息失败:', e)
    }
  }

  /**
   * 上下文压缩（DSH 式「append-only projection」；架构依据见
   * `docs/reference/dsh-cache-architecture.md`）。
   *
   * 三条不变量：
   *
   * 1. **只在用户回合边界压缩**。agent loop 内部严格 append-only —— 丢掉历史
   *    头部会改变 token 0，直接摧毁提供商的 prefix-cache 匹配。
   * 2. **触发必须罕见且大**。按真实上下文窗口的 token 压力触发（默认 0.8），
   *    而不是「消息条数 > 40」。后者几乎每一轮都触发，等于每一轮都把整段前缀
   *    缓存清零 —— 这是命中率被钉在 95% 附近的主要原因。
   * 3. **摘要只有一份，永不链式增长**。调用方必须用 {@link mergeDigest} 把它
   *    合并进旧摘要，而不是追加。旧实现是
   *    `compressed = compressed + '\n\n' + digest`，既让摘要无限膨胀，又让每轮
   *    都改写前缀头部。
   *
   * 代价是明知的、有界的：一次压缩 = 一次完整的 prefix miss。把它做得罕见且
   * 足够大，这一次 miss 就会被之后几十轮的高命中摊薄。
   */
  private compressOverflow(
    messages: AiMessage[],
    options: { maxChars: number; retainChars: number }
  ): { kept: AiMessage[]; digest: string; dropped: AiMessage[] } {
    // 纯函数实现见 ai/prefixCache.ts —— 抽出去是为了能脱离 electron 直接单测，
    // 这些不变量（边界落在 user 消息、摘要单份且有界、不压缩时原样返回）
    // 是命中率的根因，必须有回归测试兜着。
    return compressOverflowPure<AiMessage & CompressibleMessage>(messages, options)
  }

  /**
   * 把「上一份摘要」与「本轮新摘要」合并成**唯一一份**有界摘要。
   * 实现见 ai/prefixCache.ts。
   */
  private mergeDigest(previous: string, incoming: string, maxChars?: number): string {
    return mergeDigest(previous, incoming, maxChars)
  }

  /**
   * 当前模型真实的上下文窗口（token）。
   *
   * 这是压缩触发线与「上下文占用」指示器的**唯一真源**。旧实现直接在两个
   * 调用点写死 `weportAiContextWindow`（默认 100 万），于是 128k/200k 的模型
   * 也会显示成「用了 4%」，而且永远不会触发压缩。provider 层带回 per-model
   * 元数据后优先使用它，config 只作为未知时的兜底。
   */
  private resolveContextWindow(consumer: ProviderConsumer = 'chat', resolved?: ProviderProfile | null): number {
    const profile = resolved || this.providerProfiles.getForConsumer(consumer)
    const perModel = Number(profile?.modelContextWindow)
    if (Number.isFinite(perModel) && perModel > 0) return perModel
    const configured = Number(this.configService.get('weportAiContextWindow'))
    return Number.isFinite(configured) && configured > 0 ? configured : 1000000
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
    this.dropPrefixProbe(chatId)
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

  // -------------------------------------------------------------------------
  // 模型元数据（provider 层）
  // -------------------------------------------------------------------------

  /**
   * 从一次 `GET {base}/models` 的真实返回里解析出**模型记录**。
   *
   * 这一步是 per-model 协议的唯一真源：网关按模型挑协议，而 /models 是唯一
   * 能告诉我们「这个模型存在」的本地证据。registry（models.dev）随后补上协议、
   * 上下文窗口和价格。
   */
  private liveModelRecords(providerId: string, envelope: unknown): ModelRecord[] {
    const registryEntry = getModelRegistry().getProviderEntry(this.registryProviderIdFor(providerId))
    const npmDefault = registryEntry?.npmDefault
    const objects = Array.isArray(envelope)
      ? envelope
      : envelope && typeof envelope === 'object'
        ? ['data', 'models', 'result']
            .map((key) => (envelope as Record<string, unknown>)[key])
            .find((value) => Array.isArray(value)) || []
        : []

    // The provider id stamped onto each record is the REGISTRY id (opencode-go,
    // not opencode-go's app alias) so provenance and lookups stay comparable.
    const registryProviderId = registryEntry?.providerId || normalizeProviderId(providerId)
    const records: ModelRecord[] = []
    for (const item of objects as unknown[]) {
      // The bare-array providers (Together AI, Mistral) return plain strings.
      const raw = typeof item === 'string' ? { id: item } : item
      const record = normalizeModelRecord(registryProviderId, raw, npmDefault, 'live')
      if (record) records.push(record)
    }

    // Some gateways answer `{data:{...}}` instead of `{data:[...]}`: fall back to
    // the tolerant id extraction so those still reach the picker.
    if (records.length === 0) {
      for (const id of extractModelIds(envelope)) {
        const record = normalizeModelRecord(registryProviderId, { id }, npmDefault, 'live')
        if (record) records.push(record)
      }
    }
    return records
  }

  /** 解析 profile 的 provider 在 models.dev 里的键；catalog 没声明就按同 id 尝试。 */
  private registryProviderIdFor(providerId: string): string {
    const entry = getProviderCatalogEntry(providerId)
    return entry?.registryProviderId || normalizeProviderId(providerId)
  }

  /**
   * 把「本地已知的元数据」合并成这条 profile 的解析结果（纯本地，不发请求）。
   *
   * 参数只取解析真正需要的四个字段，这样 `getSetup()` 能直接用
   * `ProviderProfileSummary` 调它，不必为了拿完整 profile 再读一次配置。
   */
  private resolveProfileModel(
    profile: { id: string; providerId: string; protocol: ProviderProfile['protocol']; model: string },
    live?: ModelRecord
  ): ResolvedModel {
    return resolveModelMetadata({
      registry: getModelRegistry(),
      registryProviderId: this.registryProviderIdFor(profile.providerId),
      defaultProtocol: getProviderCatalogEntry(profile.providerId)?.protocol,
      profile,
      modelId: profile.model,
      live,
    })
  }

  /**
   * 把解析出的元数据写回 profile。
   *
   * 只在**真的变了**时写：这个方法会在主调用路径上被调用，而每次调用都写一遍
   * 配置（disk + safeStorage）是不必要的写放大。
   */
  private persistResolvedModelMetadata(profile: ProviderProfile, resolved: ResolvedModel): void {
    const next = resolvedProfileCache(resolved)
    const changed =
      profile.modelContextWindow !== next.modelContextWindow ||
      profile.modelMaxOutputTokens !== next.modelMaxOutputTokens ||
      profile.modelProtocol !== next.modelProtocol ||
      JSON.stringify(profile.modelCost ?? null) !== JSON.stringify(next.modelCost ?? null) ||
      profile.modelMetadataSource !== next.modelMetadataSource
    if (!changed) return
    this.providerProfiles.setModelMetadata(profile.id, {
      contextWindow: next.modelContextWindow,
      maxOutputTokens: next.modelMaxOutputTokens,
      protocol: next.modelProtocol,
      cost: next.modelCost,
      capabilities: next.modelCapabilities,
      reasoningOptions: next.modelReasoningOptions,
      source: next.modelMetadataSource,
    })
    profile.modelContextWindow = next.modelContextWindow
    profile.modelMaxOutputTokens = next.modelMaxOutputTokens
    profile.modelProtocol = next.modelProtocol
    profile.modelCost = next.modelCost
    profile.modelCapabilities = next.modelCapabilities
    profile.modelReasoningOptions = next.modelReasoningOptions
    profile.modelMetadataSource = next.modelMetadataSource
    profile.modelMetadataUpdatedAt = next.modelMetadataUpdatedAt
  }

  /** 把 registry 的解析结果刷新到 profile 上（纯本地）。返回解析结果，供调用链复用。 */
  private refreshModelMetadata(profileId: string, live?: ModelRecord): ResolvedModel | null {
    const profile = this.providerProfiles.getById(profileId)
    if (!profile || !profile.model) return null
    const resolved = this.resolveProfileModel(profile, live)
    this.persistResolvedModelMetadata(profile, resolved)
    return resolved
  }

  /**
   * OpenCode 网关要求的标识头。
   *
   * 只在这两个网关上加，别家不给陌生 header 面子；用户自定义的同名 header 优先
   * （合并顺序在 `authHeaders` 里保证）。
   */
  private withGatewayHeaders(profile: ProviderProfile): ProviderProfile {
    if (!OPENCODE_GATEWAYS.has(profile.providerId)) return profile
    return { ...profile, headers: { 'x-opencode-session': profile.id, ...(profile.headers || {}) } }
  }

  /**
   * 模型发现：30s 超时 + 1 次重试。
   *
   * opencode.ai 的 `/models` 间歇性变慢（实测两次分别在 20s 与 60s 超时，随后
   * 0.8s 成功），固定 15s 无重试会把一次可用请求报成失败，并让 UI 反过来指责
   * 用户「服务商、地址或权限」有问题。
   *
   * 只有这两个网关在**空列表**时也重试：别家返回空列表通常是真的没有模型
   * （或没权限），重试只是让失败慢 30 秒。
   */
  private async listModelsWithRetry(profile: ProviderProfile): Promise<string[]> {
    const effective = this.withGatewayHeaders(profile)
    const retryOnEmpty = OPENCODE_GATEWAYS.has(profile.providerId)
    const attempts = retryOnEmpty ? MODEL_DISCOVERY_ATTEMPTS : 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const envelope = await getProviderAdapter(effective).listModelsWithEnvelope(effective, AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS))
        const live = this.liveModelRecords(profile.providerId, envelope)
        const ids = live.filter(isChatCapable).map((record) => record.id)
        if (ids.length > 0) {
          // 合并进 catalog override（不是整体替换）：一次会话里可能有多条 profile
          // 各自发现过模型，覆盖整张表会把别人的列表抹掉。
          invalidateCatalogOverride(profile.providerId, ids)
          return ids
        }
        lastError = new Error('EMPTY_MODEL_LIST')
      } catch (error) {
        lastError = error
      }
    }
    if (String((lastError as Error)?.message || lastError) === 'EMPTY_MODEL_LIST') return []
    throw lastError
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
    const active = this.providerProfiles.getActive()
    // 本地（无网络）解析一次元数据，让「上下文窗口 / 能力」面板在首屏就有真值：
    // registry 磁盘缓存 + bundled snapshot 已经足够，不必等一次发现请求。
    // 这里刻意不再每条 getById()——那是 N 次「读配置 + 解析 JSON」。
    const profiles = this.providerProfiles.list().map((item) =>
      item.model
        ? { ...item, ...resolvedProfileCache(this.resolveProfileModel({ id: item.id, providerId: item.providerId, protocol: item.protocol, model: item.model })) }
        : item
    )

    return {
      hasApiKey: Boolean(active?.apiKey) || Boolean(active && getProviderCatalogEntry(active.providerId)?.apiKeyOptional),
      baseUrl: String(active?.baseUrl || this.configService.get('weportAiBaseUrl') || 'https://api.deepseek.com').trim(),
      baseUrlError: String(this.configService.get('weportAiBaseUrlError') || '').trim(),
      model: String(active?.model || this.configService.get('weportAiModel') || 'deepseek-v4-flash').trim(),
      reasoningEffort: this.configService.get('weportAiReasoningEffort') || 'high',
      imageInputs: this.configService.get('weportAiImageInputs') !== false,
      customPrompt: String(this.configService.get('weportAiCustomPrompt') || ''),
      workspaceRoot: this.getWorkspaceRoot(),
      exportPath: String(this.configService.get('exportPath') || ''),
      dbReady: String(this.configService.get('dbPath') || '').trim().length > 0,
      disabledTools: Array.isArray(this.configService.get('weportAiDisabledTools'))
        ? (this.configService.get('weportAiDisabledTools') as string[])
        : [],
      activeProfileId: active?.id || '',
      profiles,
      catalog: getProviderCatalog(),
    }
  }

  listProviders() {
    return getProviderCatalog()
  }

  async fetchProviderModels(input: {
    providerId: string
    protocol?: ProviderProfileInput['protocol']
    baseUrl?: string
    apiKey?: string
  }): Promise<{ success: boolean; models?: string[]; error?: string; status?: number }> {
    const catalog = getProviderCatalogEntry(String(input.providerId || ''))
    const profile = makeDefaultProfile({
      providerId: String(input.providerId || 'custom'),
      protocol: input.protocol,
      baseUrl: input.baseUrl || catalog?.baseUrl,
      apiKey: String(input.apiKey || '').trim(),
    })
    if (!profile.baseUrl) return { success: false, error: '请先填写接口地址' }
    if (!profile.apiKey && !catalog?.apiKeyOptional) return { success: false, error: '请先填写 API key' }
    // 模型列表与 registry 元数据一起刷新：协议是按模型决定的，缺了 registry 就
    // 只能猜；这里顺手把刷新挂上，失败也只是降级到缓存。
    void getModelRegistry().refresh().catch(() => undefined)
    try {
      const models = await this.listModelsWithRetry(profile)
      if (models.length === 0) {
        // 不再把「空列表」一律算成用户的配置错误：Together/Mistral 这类裸数组
        // 服务商以前会被解析成空列表并收到同一句指责；现在解析已修好，剩下来的
        // 空列表就如实说明，并指出手填模型 id 这条永久可用的退路。
        return {
          success: false,
          models: [],
          error: '接口未返回可用对话模型。若该服务商的模型列表接口不可用，请直接在 Model 输入框手动填写模型 id',
        }
      }
      return { success: true, models }
    } catch (error) {
      const status = Number((error as { status?: number })?.status) || undefined
      const detail = String((error as Error)?.message || '').trim()
      const suffix = status === 401
        ? 'API key 无效或已过期'
        : status === 403
          ? '当前 API key 没有模型列表权限'
          : status === 429
            ? '请求过于频繁，请稍后重试'
            : /abort|timeout/i.test(detail)
              ? '请求超时，请检查网络或接口地址'
              : detail || '模型获取失败，请检查服务商配置'
      return { success: false, error: suffix, status }
    }
  }

  saveProviderProfile(input: ProviderProfileInput): { success: boolean; profile?: ProviderProfileSummary; error?: string } {
    try {
      const saved = this.providerProfiles.save(input)
      // 保存后立刻用本地 registry 解析一次协议 / 窗口 / 价格，这样新 profile 从
      // 第一次调用起就带正确的 maxOutputTokens 和上下文窗口。
      this.refreshModelMetadata(saved.id)
      const enriched = this.providerProfiles.list().find((item) => item.id === saved.id) || saved
      return { success: true, profile: enriched }
    } catch (error) {
      return { success: false, error: String((error as Error)?.message || error) }
    }
  }

  activateProviderProfile(id: string): { success: boolean; error?: string } {
    return this.providerProfiles.activate(String(id || '').trim())
      ? { success: true }
      : { success: false, error: '找不到要启用的 AI 配置' }
  }

  /** 「设置 → AI 服务」用：三个功能面各自指向哪个服务。 */
  getConsumerAssignments() {
    return this.providerProfiles.consumerAssignments()
  }

  /**
   * 拉一次某个服务的 `/models` 清单（探针/诊断用）。
   *
   * 这里是**只读**的包装：`discoverProfileModels` 会把结果写回 profile 的
   * discovery 字段（设置页要显示），诊断场景不应该产生这种副作用。
   */
  async discoverModelsForProfile(profileId: string): Promise<{ models: string[]; error: string }> {
    const profile = this.providerProfiles.getById(String(profileId || '').trim()) || this.providerProfiles.getActive()
    if (!profile) return { models: [], error: '找不到 AI 服务配置' }
    try {
      const models = await this.listModelsWithRetry(profile)
      return { models, error: '' }
    } catch (error) {
      const status = Number((error as { status?: number })?.status)
      const detail = String((error as Error)?.message || error).trim()
      return { models: [], error: `${status ? `HTTP ${status}：` : ''}${detail || '模型发现失败'}` }
    }
  }

  /** 已配置的服务清单（带已解析的模型元数据），设置页直接渲染它。 */
  listProviderProfiles() {
    return this.providerProfiles.list().map((item) =>
      item.model
        ? { ...item, ...resolvedProfileCache(this.resolveProfileModel({ id: item.id, providerId: item.providerId, protocol: item.protocol, model: item.model })) }
        : item
    )
  }

  getActiveProfileId(): string {
    return this.providerProfiles.getActive()?.id || ''
  }

  assignConsumerProfile(consumer: string, profileId: string): { success: boolean; error?: string } {
    const allowed: ProviderConsumer[] = ['chat', 'weclone', 'webot']
    if (!allowed.includes(consumer as ProviderConsumer)) return { success: false, error: `未知的功能面: ${consumer}` }
    const ok = this.providerProfiles.assign(consumer as ProviderConsumer, profileId)
    return ok ? { success: true } : { success: false, error: '指定的服务不存在' }
  }

  deleteProviderProfile(id: string): { success: boolean; error?: string } {
    return this.providerProfiles.remove(String(id || '').trim())
      ? { success: true }
      : { success: false, error: '找不到要删除的 AI 配置' }
  }

  updateSetup(patch: {
    reasoningEffort?: string
    imageInputs?: boolean
    customPrompt?: string
    workspaceRoot?: string
    disabledTools?: string[]
    profile?: ProviderProfileInput
    activeProfileId?: string
    deleteProfileId?: string
    discoverProfileId?: string
  }): void {
    if (patch.profile) {
      try {
        this.providerProfiles.save(patch.profile)
        this.configService.set('weportAiBaseUrlError', '')
      } catch (error) {
        this.configService.set('weportAiBaseUrlError', String((error as Error)?.message || error))
      }
    }
    if (patch.activeProfileId) this.providerProfiles.activate(String(patch.activeProfileId))
    if (patch.deleteProfileId) this.providerProfiles.remove(String(patch.deleteProfileId))
    if (patch.discoverProfileId) void this.discoverProfileModels(String(patch.discoverProfileId))

    if (patch.reasoningEffort === 'low' || patch.reasoningEffort === 'high' || patch.reasoningEffort === 'max') {
      this.configService.set('weportAiReasoningEffort', patch.reasoningEffort)
    }
    if (typeof patch.imageInputs === 'boolean') {
      this.configService.set('weportAiImageInputs', patch.imageInputs)
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
  }

  private async discoverProfileModels(profileId: string): Promise<void> {
    const profile = this.providerProfiles.getById(profileId)
    if (!profile) return
    try {
      const models = await this.listModelsWithRetry(profile)
      this.providerProfiles.recordDiscovery(profileId, models)
    } catch (error) {
      const status = Number((error as { status?: number })?.status)
      const detail = String((error as Error)?.message || error).trim()
      this.providerProfiles.recordDiscovery(profileId, [], `${status ? `HTTP ${status}：` : ''}${detail || '模型发现失败'}`)
    }
    // 发现完之后无论成败都刷新一次本地元数据：即使 /models 失败，registry 里
    // 往往也已经知道这个模型的协议和上下文窗口。
    this.refreshModelMetadata(profileId)
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
        name: 'sync_chat_history',
        description:
          'Force a FRESH read of WeChat history: drops the message cursors, cached statistics and cached session list, then re-reads from the local database and reports what is actually there right now (latest message per requested chat). Call this BEFORE any claim that depends on the newest data ("最新", "今天", "有没有新消息", "现在怎么样了") — a previous tool result in this very conversation is a snapshot from minutes ago, and the account owner keeps sending messages while you work. Cheap and safe: it only invalidates caches, it never writes to WeChat.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Chat id to refresh. Omit to refresh every chat (session list + all cached message state).' },
            recentLimit: { type: 'integer', minimum: 1, maximum: 20, description: 'When refreshing all chats, how many of the most recently active chats to list (default 8).' },
          },
        },
        friendly: (args, ctx) => {
          const id = String(args.sessionId || '').trim()
          return id ? `同步了「${ctx.getSessionName(id)}」的最新聊天数据` : '同步了全部会话的最新数据'
        },
        handler: async (args) => {
          const sessionId = String(args.sessionId || '').trim()
          const recentLimit = clampInt(args.recentLimit, 1, 20, 8)
          const invalidated = await chatService.invalidateDerivedCaches(sessionId || undefined)
          // 会话列表缓存（15s）也要一起丢：否则「哪个会话最近活跃」还是旧视图。
          this.sessionListCache = { at: 0, sessions: [] }
          const sessions = await this.loadSessionsFresh()
          if (sessions.length === 0) {
            return '同步完成，但读不到会话列表 —— 微信可能没在运行，或数据库尚未连接。'
          }

          if (sessionId) {
            const session = sessions.find((s) => s.username === sessionId)
            // 真正"最新"的定义是数据库里的最后一条消息，而不是会话表里的 lastTimestamp：
            // 游标重建后按时间倒序取 1 条，读到的就是这一秒的事实。
            const latest = await chatService.getMessages(sessionId, 0, 1, 0, 0, false)
            const newest = latest.success ? latest.messages?.[0] : undefined
            const name = session?.displayName || sessionId
            const lines = [
              `已强制重读「${name}」（${sessionId}）：丢弃游标 ${invalidated.cursors} 个、统计与首屏快照各 1 份。`,
              newest
                ? `最后一条消息：${formatTime(Number(newest.createTime || 0))} 由 ${String((newest as { senderName?: string }).senderName || (newest.isSend ? '我' : '对方'))} 发出 —— 时间戳 ${Number(newest.createTime || 0)}。`
                : `这个会话在当前窗口里读不到消息（可能是空会话，或该会话的消息被过滤）。`,
              session
                ? `会话表记录的最近活跃：${session.lastTimestamp ? formatTime(Number(session.lastTimestamp)) : '未知'}；消息数≈${session.messageCountHint ?? '未知'}。`
                : '会话列表里没有这个 id —— 确认它来自 list_sessions 的返回。',
            ]
            return lines.join('\n')
          }

          const recentlyActive = sessions
            .filter((s) => Number(s.lastTimestamp || 0) > 0)
            .sort((a, b) => Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
            .slice(0, recentLimit)
          const lines = recentlyActive.map((s) => {
            const last = Number(s.lastTimestamp || 0)
            return `- ${sessionTypeLabel(s.username)}「${s.displayName || s.username}」 id=${s.username} 最近活跃=${last ? formatTime(last) : '未知'}`
          })
          return (
            `已强制重读全部会话：丢弃游标 ${invalidated.cursors} 个，并清掉全部统计与首屏快照缓存。\n` +
            `当前共 ${sessions.length} 个会话，最近活跃的 ${recentlyActive.length} 个（实时读出）：\n` +
            lines.join('\n') +
            `\n要对某个会话读最新内容，直接用 read_session_messages（它的第一次读取现在必然是新开的游标）。`
          )
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
        name: 'read_chat_images',
        description:
          'Look at actual PICTURES posted in one chat (homework photos, screenshots, receipts, schedules). Use this whenever the answer depends on what an image shows — text search cannot see inside a picture. Returns the images themselves to a vision-capable model, plus who sent each one and when. Pairs with read_session_messages: use that to find the time window, then this to actually look.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'The chat username/id from list_sessions' },
            startTime: { type: 'string', description: 'Optional window start: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" (default: beginning)' },
            endTime: { type: 'string', description: 'Optional window end: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS" (default: now)' },
            limit: { type: 'integer', minimum: 1, maximum: 3, description: `How many pictures to actually look at (default 2, max ${MAX_TOOL_IMAGES}). Each one costs tokens, so ask for what you need.` },
          },
          required: ['sessionId'],
        },
        friendly: (args, ctx) => {
          const name = ctx.getSessionName(String(args.sessionId || ''))
          const range = args.startTime ? `（${String(args.startTime)} 起）` : ''
          return `看了「${name}」里的图片${range}`
        },
        handler: async (args, ctx) => {
          const sessionId = String(args.sessionId || '').trim()
          if (!sessionId) return '错误：缺少 sessionId。'
          const limit = clampInt(args.limit, 1, MAX_TOOL_IMAGES, 2)
          const startSec = normalizeTimeSec(args.startTime)
          const endSec = normalizeTimeSec(args.endTime)
          const name = ctx.getSessionName(sessionId)
          // 不需要显式 connect：`getMessages` / `getImageData` 各自都有
          // ensureConnected，多调一次只是多一个往返。

          // 先在窗口里找图片消息。**必须重读一次消息表**：图片消息的 localId 只
          // 存在于库里，文本工具的返回值给不出它。
          const scanLimit = 500
          const hasWindow = startSec > 0 && endSec > 0
          const listed = await chatService.getMessages(
            sessionId,
            0,
            scanLimit,
            startSec > 0 ? startSec * 1000 : 0,
            endSec > 0 ? endSec * 1000 : 0,
            // 有完整窗口时按时间正序扫，取窗口内**最近**的（下面的 slice(-limit)）。
            hasWindow
          )
          if (!listed.success) return `读取失败：${listed.error || '未知错误'}`
          const scanned = listed.messages || []
          const images = scanned.filter(
            (m) => Number((m as { localType?: number }).localType) === 3 || Boolean(m.imageMd5) || Boolean(m.imageDatName)
          )
          if (images.length === 0) {
            const range = startSec > 0 || endSec > 0
              ? `${startSec ? formatTime(startSec) : '起点'} ~ ${endSec ? formatTime(endSec) : '现在'}`
              : '全部历史'
            return `「${name}」在 ${range} 内没有图片消息（已扫描 ${scanned.length} 条）。`
          }

          const picked = images.slice(-limit)
          const lines: string[] = []
          let attached = 0
          for (const message of picked) {
            const when = formatTime(Number(message.createTime) || 0)
            const sender = message.isSend === 1
              ? '我'
              : String(message.senderDisplayName || message.senderUsername || name || '')
            const localId = Number((message as { localId?: number }).localId)
            if (!Number.isFinite(localId)) {
              lines.push(`- [${when}] ${sender}：图片（缺少 localId，无法解密）`)
              continue
            }
            const decoded = await chatService.getImageData(sessionId, String(localId))
            if (!decoded.success || !decoded.data) {
              // 失败原因是可执行的指引：多半是图片密钥没取。原样说出来，
              // 不要让模型猜（"看不了"和"没有这张图"是两件事）。
              lines.push(`- [${when}] ${sender}：图片无法读取（${decoded.error || '未知原因'}）`)
              continue
            }
            const { part, reason } = imagePartFromBase64(decoded.data)
            if (part && attached < MAX_TOOL_IMAGES && this.configService.get('weportAiImageInputs') !== false) {
              attached += 1
              ctx.attachImages([part])
              lines.push(`- [${when}] ${sender}：图片 #${attached}（见附件，请直接看图回答）`)
            } else if (part && attached < MAX_TOOL_IMAGES) {
              // 图片输入被用户关掉（设置 → WeportAI → 图片输入）：不解码成附件，只留
              // 文字线索 —— 不支持视觉的模型/网关收到 image_url 会直接报错。
              lines.push(`- [${when}] ${sender}：图片（图片输入已关闭，只能给文字线索）`)
            } else {
              lines.push(`- [${when}] ${sender}：图片未附上（${reason || '超过本次上限'}）`)
            }
          }

          const header = attached > 0
            ? `「${name}」（${sessionTypeLabel(sessionId)}）窗口内共 ${images.length} 张图片，已附上最近 ${attached} 张给你看：`
            : `「${name}」（${sessionTypeLabel(sessionId)}）窗口内共 ${images.length} 张图片，但一张都没能附上：`
          const hint = attached > 0
            ? '\n\n请基于你看到的画面回答。若附件对你的模型不可用（返回了图片相关错误），请说明并改用文字线索。'
            : '\n\n请把无法读取的原因如实告诉用户（常见原因：图片密钥未获取、原图已被清理），不要凭猜测描述图片内容。'
          return `${header}\n${lines.join('\n')}${hint}`
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
      ...this.connectorTools(),
    ]
  }

  /**
   * 连接器工具（Todoist 等）。
   *
   * 只在「确实连上了」的时候才挂进工具表：没连上的账号里出现一个 todoist_add_task
   * 只会浪费一轮上下文，还会让模型去猜一个不存在的连接。工具清单在 run 开始时
   * 冻结，所以在设置页连接/断开连接器只影响下一轮，不会中途改写前缀缓存。
   *
   * 写入默认开启（`connectorsAllowAgent`），关掉之后只保留只读的目标列表工具。
   */
  private connectorTools(): ToolDefinition[] {
    const connected = connectorsService.listConnectedIds()
    if (connected.length === 0) return []
    const allowWrite = connectorsService.agentWriteAllowed()
    const tools: ToolDefinition[] = [
      {
        name: 'list_connector_targets',
        description:
          'List the places a task can be filed in a connected third-party service (Todoist projects, labels, inbox). Call this before creating a task when you need a project or label id; omit the target to file into the Inbox.',
        parameters: {
          type: 'object',
          properties: {
            connector: { type: 'string', enum: connected, description: 'Connected service id (default the first connected one)' },
          },
        },
        friendly: (args) => `查看了 ${String(args.connector || 'todoist')} 的目标列表`,
        handler: async (args) => {
          const id = String(args.connector || connected[0])
          const result = await connectorsService.listTargets(id)
          if (!result.success) return `获取失败：${result.error}`
          const targets = result.data || []
          if (targets.length === 0) return '没有可用的目标（该项目/标签列表为空）。'
          return targets.map((target) => `${target.kind === 'inbox' ? '（默认收件箱）' : `${target.id}`}\t${target.kind}\t${target.name}`).join('\n')
        },
      },
    ]
    if (!allowWrite) return tools
    tools.push({
      name: 'create_connector_task',
      description:
        'Create a task in a connected third-party service (Todoist). Use it when the user asks you to record a follow-up, reminder, or to-do outside Weport. Write the task content in the same language the user speaks, keep it one actionable line, and put supporting detail in `description`. The due date accepts natural language ("tomorrow at 5pm", "next Monday", "每周一") — pass it through as `due_text` instead of computing a date yourself.',
      parameters: {
        type: 'object',
        properties: {
          connector: { type: 'string', enum: connected, description: 'Connected service id (default the first connected one)' },
          content: { type: 'string', description: 'One-line task title, imperative and specific' },
          description: { type: 'string', description: 'Optional Markdown notes, evidence, or context' },
          due_text: { type: 'string', description: 'Natural-language due date, e.g. "tomorrow at 17:00", "in 3 days", "每周一"' },
          due_date: { type: 'string', description: 'Exact due date YYYY-MM-DD (prefer due_text when the user was vague)' },
          priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'], description: 'Task priority (default none)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach' },
          target_id: { type: 'string', description: 'Project/label id from list_connector_targets; omit for the Inbox' },
        },
        required: ['content'],
      },
      friendly: (args) => `新建待办「${String(args.content || '').slice(0, 24)}」`,
      handler: async (args) => {
        const id = String(args.connector || connected[0])
        const result = await connectorsService.createTask(id, {
          content: String(args.content || ''),
          description: args.description ? String(args.description) : undefined,
          dueText: args.due_text ? String(args.due_text) : undefined,
          dueDate: args.due_date ? String(args.due_date) : undefined,
          priority: String(args.priority || 'none') as never,
          labels: Array.isArray(args.labels) ? (args.labels as string[]).map(String) : undefined,
          targetId: args.target_id ? String(args.target_id) : undefined,
        })
        if (!result.success) return `创建失败：${result.error}`
        const task = result.data
        return `已创建待办：${task?.content || String(args.content)}${task?.dueText ? `（${task.dueText}）` : ''}${task?.url ? `\n${task.url}` : ''}`
      },
    })
    return tools
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
  async runChat(chatId: string, text: string, options?: { consumer?: ProviderConsumer }): Promise<{ success: boolean; error?: string }> {
    if (this.running.has(chatId)) return { success: false, error: '该对话正在执行中' }
    const chat = this.loadChats().find((c) => c.id === chatId)
    if (!chat) return { success: false, error: '对话不存在' }
    const userText = String(text || '').trim()
    if (!userText) return { success: false, error: '消息为空' }

    const consumer = options?.consumer || 'chat'
    const activeProfile = this.providerProfiles.getForConsumer(consumer)
    if (!activeProfile?.apiKey && !getProviderCatalogEntry(activeProfile?.providerId || '')?.apiKeyOptional) return { success: false, error: '未配置 AI API Key，请在「设置 → AI 服务」中添加服务配置' }

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

    // 上下文压缩：只在用户回合边界，且只在真正接近窗口上限时触发。
    //
    // 触发条件由「条数 > weportAiConversationLimit」改为「体积 > 0.8 × 模型
    // 窗口」。条数触发几乎每轮都会命中，等于每轮都把整段前缀缓存清零 —— 这是
    // 命中率被钉在 95% 的直接原因。压缩做得罕见且足够大，这一次 prefix miss
    // 才能被之后几十轮的高命中摊薄。
    const contextWindow = this.resolveContextWindow(consumer, activeProfile)
    const compactBudget = this.compactBudgetFor(contextWindow)
    const { kept, digest, dropped } = this.compressOverflow(messages, compactBudget)
    if (digest) {
      this.archiveMessages(chatId, dropped)
      messages = kept
      // 唯一一份摘要：合并而不是追加。旧实现是
      // `compressed = compressed + '\n\n' + digest`，既让摘要无界增长，
      // 又让每一轮都改写前缀头部。
      compressed = this.mergeDigest(compressed, digest)
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
        // 绑定到实例：emit 现在要碰 delta 缓冲区，裸方法引用会在调用时丢 `this`。
        emit: (event) => this.emit(event),
        getSessionName: (id: string) => {
          const s = sessionMap.get(id)
          return s?.displayName || id
        },
        // 每次工具调用都会用带 `attachImages` 的副本覆盖这一项（见下面的循环）。
        // 这里给一个空的实现，避免任何直接调用 ctx 的路径炸掉。
        attachImages: () => undefined,
      }

      let loopCount = 0
      let finalAssistant: AiMessage | null = null

      while (loopCount < maxSteps) {
        if (ctrl.signal.aborted) {
          aborted = true
          break
        }
        loopCount += 1

        const stepResult = await this.callModel(chatId, messages, ctrl.signal, compressed, requestShape, consumer, activeProfile)
        if (!stepResult.ok) {
          error = stepResult.error || '模型调用失败'
          // 保留网关的原文：映射后的中文只是提示，真正定位问题的是 provider 的
          // 那一句话（例如 OpenCode Go 的「This model is not available in your
          // country.」在旧代码里会被 401 掩盖成「密钥无效」，误导排查方向）。
          const upstream = String(stepResult.error || '').trim().slice(0, 300)
          if (stepResult.httpStatus === 401) {
            error = `API 密钥无效或已过期（401），请在 WeportAI 设置中更新${upstream ? `：${upstream}` : ''}`
          } else if (stepResult.httpStatus === 402) {
            error = 'API 余额不足（402），请充值后重试'
          } else if (stepResult.httpStatus === 429) {
            error = '请求过于频繁（429），请稍后再试'
          } else if (stepResult.httpStatus === 400) {
            error = `请求参数错误（400）：${stepResult.error || ''}`
          } else if (stepResult.httpStatus && stepResult.httpStatus >= 500) {
            error = `模型服务端错误（${stepResult.httpStatus}）：${stepResult.error || '请稍后重试'}`
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
            contextWindow,
          })
        }

        const assistant: AiMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: stepResult.content || '',
          reasoning: stepResult.reasoning || '',
          toolCalls: stepResult.toolCalls || [],
          createdAt: Date.now(),
          timing: stepResult.timing,
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
          this.emit({ type: 'assistant_message', chatId, message: assistant, timing: stepResult.timing })
          break
        }

        // 执行工具调用 —— DSH 式调度（`dsh-agent-loop` tool-calls）：
        // 并行安全的调用共享一个有界并发池，会改状态的调用（EXCLUSIVE_TOOLS）
        // 单独成顺序屏障；结果一律按**提交顺序**回填，无论谁先跑完，wire 上的
        // 消息数组逐字节不变（前缀缓存的必要条件）。这同时把一批工具的墙钟时间
        // 从「Σ每个工具」压到「最慢的那个」。
        const configuredToolBudget = Number(this.configService.get('weportAiMaxToolChars')) || 12000
        const stepToolBudget = Math.max(1000, configuredToolBudget)
        // 默认 4 而不是 DSH 的 10：这里的工具打的是**同一个 WCDB FFI 宿主**，
        // 消息游标是有限资源（readPeriodEvents 内部就按 4 分批）。可配置。
        const maxParallelTools = Math.max(1, Number(this.configService.get('weportAiMaxParallelToolCalls')) || 4)
        const callImagesByIndex: AiImagePart[][] = toolCalls.map(() => [])

        const batchStartedAt = Date.now()
        const outcomes = await runToolBatch<{ ok: boolean; result: string }>(
          toolCalls.map((call) => ({ name: call.name })),
          { maxParallel: maxParallelTools, isExclusive: (name) => EXCLUSIVE_TOOLS.has(name) },
          async (index) => {
            const call = toolCalls[index]
            const tool = runToolsByName.get(call.name)
            if (!tool) return { ok: false, result: `错误：未知工具 ${call.name}` }
            const callImages = callImagesByIndex[index]
            try {
              const result = await tool.handler(call.args, {
                ...ctx,
                attachImages: (images) => {
                  for (const image of images) {
                    if (callImages.length >= MAX_TOOL_IMAGES) break
                    if (image?.data && image?.mimeType) callImages.push(image)
                  }
                },
              })
              return { ok: true, result }
            } catch (e) {
              return { ok: false, result: `工具执行异常：${String((e as Error)?.message || e)}` }
            }
          },
          {
            onStart: (index) => {
              const call = toolCalls[index]
              const tool = runToolsByName.get(call.name)
              if (!tool) return
              try {
                call.friendly = tool.friendly(call.args, ctx)
              } catch {
                call.friendly = call.name
              }
              this.emit({
                type: 'tool_start',
                chatId,
                callId: call.id,
                name: call.name,
                args: call.args,
                friendly: call.friendly,
              })
            },
            shouldAbort: () => ctrl.signal.aborted,
          },
        )

        // Strict aggregate budget, divided fairly across the calls that are
        // still pending. Short results return unused space to later calls —
        // identical to the old serial semantics because this loop runs in
        // submission order regardless of completion order.
        let remainingToolBudget = stepToolBudget
        let stepToolChars = 0
        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
          const call = toolCalls[toolIndex]
          const outcome = outcomes[toolIndex]
          const ok = Boolean(outcome?.started && outcome.result?.ok)
          let result: string
          if (!outcome || !outcome.started) {
            // 中止时未启动的调用也要占位：assistant.tool_calls 必须配对完整，
            // 否则下一次运行会把整轮从 wire 上丢掉（前缀被悄悄改掉 + 证据丢失）。
            result = '（本次运行已中止，该调用未执行）'
          } else if (outcome.error) {
            result = `工具执行异常：${String((outcome.error as Error)?.message || outcome.error)}`
          } else {
            result = outcome.result?.result ?? ''
          }
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
          const callImages = callImagesByIndex[toolIndex]
          messages.push({
            id: randomUUID(),
            role: 'tool',
            content: result,
            toolCallId: call.id,
            toolName: call.name,
            createdAt: Date.now(),
            images: callImages.length > 0 ? callImages : undefined,
            imageCount: callImages.length || undefined,
          })
          this.emit({
            type: 'tool_result',
            chatId,
            callId: call.id,
            name: call.name,
            ok,
            summary: result.slice(0, 300) + (result.length > 300 ? '…' : ''),
            detail: result,
            imageCount: callImages.length || undefined,
          })
        }

        this.appendDebugLog({
          kind: 'tool_batch',
          chatId,
          calls: toolCalls.length,
          maxParallel: maxParallelTools,
          exclusive: toolCalls.filter((call) => EXCLUSIVE_TOOLS.has(call.name)).length,
          // 并行的直接证据：串行实现里 batchMs ≈ Σ每个工具耗时，并行后 ≈ 最慢的那个。
          batchMs: Date.now() - batchStartedAt,
          configuredBudgetChars: configuredToolBudget,
          budgetChars: stepToolBudget,
          actualChars: stepToolChars,
          remainingChars: remainingToolBudget,
          tools: toolCalls.map((call) => call.name),
        })

        this.persistMessages(chatId, messages, compressed)
        // 每个工具轮次也在完成后立刻进 transcript：面板据此把这一轮的思考/工具卡
        // 追加进历史并开一个**全新的** live 气泡。三个症状一起解决：工具卡不再
        // 整轮堆在一个气泡顶部；实时 TPS 的时间窗回到「这一步」（不含工具执行与
        // 下一次 TTFT）；中间步骤的计时读数也不再被丢掉。
        this.emit({ type: 'assistant_message', chatId, message: assistant, timing: stepResult.timing })
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
        error = readRunError(e)
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
        contextWindow,
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

  private buildApiMessages(
    history: AiMessage[],
    compressed: string | undefined,
    systemContent: string,
    options: { preserveReasoning?: boolean } = {},
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [{ role: 'system', content: systemContent }]
    const completeAssistantIndexes = new Set<number>()
    const completeToolCallIds = new Set<string>()

    // A crash can persist an assistant tool-call message before its tool
    // results. Never send a partial tool turn: strict providers reject orphan
    // tool calls/results with HTTP 400.
    for (let i = 0; i < history.length; i += 1) {
      const message = history[i]
      if (message.role !== 'assistant' || !Array.isArray(message.toolCalls) || message.toolCalls.length === 0) continue
      const calls = message.toolCalls
      if (!calls.every((call) => String(call.id || '').trim() && String(call.name || '').trim())) continue
      const resultIds = new Set<string>()
      for (let j = i + 1; j < history.length && history[j]?.role === 'tool'; j += 1) {
        const id = String(history[j]?.toolCallId || '').trim()
        if (id) resultIds.add(id)
      }
      if (!calls.every((call) => resultIds.has(String(call.id).trim()))) continue
      completeAssistantIndexes.add(i)
      for (const call of calls) completeToolCallIds.add(String(call.id).trim())
    }

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
    for (let index = 0; index < history.length; index += 1) {
      const m = history[index]
      if (m.role === 'user') {
        out.push({ role: 'user', content: sanitizeForApi(normalizeIdentityName(m.content)) })
      } else if (m.role === 'assistant') {
        const item: Record<string, unknown> = { role: 'assistant', content: sanitizeForApi(normalizeIdentityName(m.content || '')) }
        const completeToolTurn = completeAssistantIndexes.has(index)
        if (options.preserveReasoning && m.reasoning && (completeToolTurn || !m.toolCalls?.length)) {
          // DeepSeek requires the original reasoning_content for tool turns;
          // do not rewrite it as display text during provider replay.
          item.reasoning_content = sanitizeForApi(m.reasoning)
        }
        if (completeToolTurn && m.toolCalls) {
          item.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          }))
        }
        if (!item.content && !item.tool_calls && !item.reasoning_content) continue
        out.push(item)
      } else if (m.role === 'tool') {
        const toolCallId = String(m.toolCallId || '').trim()
        if (toolCallId && completeToolCallIds.has(toolCallId)) {
          const item: Record<string, unknown> = { role: 'tool', tool_call_id: toolCallId, content: sanitizeForApi(m.content || '') }
          // 图片交给各适配器转成自己的内容块（见 providerAdapters 里的说明）：
          // 这里保持中立形状，不预先拼成某一家协议的 JSON。
          if (m.images?.length) item.images = m.images
          out.push(item)
        }
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
  /**
   * 生成 AI 标题。纯逻辑（规整 / 判重 / 兜底）在 `ai/chatTitle.ts`，那里可单测。
   *
   * 返回 `null` 覆盖三种情况：模型不可用、输出是噪声、输出只是原话的截断。
   * 第三种是关键 —— 抄回原话的"标题"必须当作失败，否则列表里显示的就是
   * 用户消息的前几个字，也就是用户报的那个 bug。
   *
   * 重要：`reasoning_effort: 'low'` 并不代表快。实测 `deepseek-v4.1-flash` 为
   * 一句「用一句话说明你能做什么」生成标题时，completion 用了 399 个 token，
   * 其中 **395 个是 reasoning**，可正文只有 4 个字。也就是说延迟几乎全在思考上，
   * 而思考时间跟输入长度基本无关。原先 15s 的超时经常在正文回来之前就中止，
   * 于是标题静默停在兜底值上 —— 界面看起来就是"标题功能没生效"。
   */
  private async generateAITitle(userText: string): Promise<string | null> {
    if (this.titleProbe === undefined) this.titleProbe = process.env.WEPORT_TITLE_PROBE === '1'
    const trace = (detail: Record<string, unknown>) => {
      if (!this.titleProbe) return
      this.appendDebugLog({ kind: 'title', ...detail })
    }
    try {
      const profile = this.applyProbeOverride(this.providerProfiles.getActive() || ({} as ProviderProfile))
      if (!profile || (!profile.apiKey && !getProviderCatalogEntry(profile.providerId)?.apiKeyOptional)) {
        trace({ outcome: 'no-profile', providerId: profile?.providerId, hasKey: Boolean(profile?.apiKey) })
        return null
      }
      // 标题请求也必须按**模型**挑协议：网关按模型路由（`gpt-5.6-luna` 走
      // `/responses`，`deepseek-v4.1-flash` 走 `/chat/completions`），用
      // profile 级别的 protocol 会把模型发到错的端点，标题就悄悄失败。
      const resolved = this.resolveProfileModel(profile)
      // **必须**过 `withGatewayHeaders`：OpenCode 系网关要求 `x-opencode-session`，
      // 缺了会直接 400（"Request is missing x-opencode-session"）。主调用路径一直
      // 带这个头，标题请求却漏了 —— 于是标题静默失败、永远停在兜底截断上，而
      // 界面上完全看不出发生过什么（就是用户报的「标题是前几个字」）。
      const adaptive = getProviderAdapter({ ...this.withGatewayHeaders(profile), modelProtocol: resolved.protocol })
      const startedAt = Date.now()
      const result = await adaptive.stream({
        profile: this.withGatewayHeaders(profile),
        messages: [
          {
            role: 'system',
            content:
              '你是对话标题生成器。用 2-4 个词概括用户这条消息的**主题**（做了什么 / 关于什么），' +
              '不要复述原话，也不要把原话的前半句当标题。只输出标题本身：不要引号、不要标点、' +
              '不要「标题：」前缀、不要解释。中文不超过 12 个字，英文不超过 4 个词。',
          },
          { role: 'user', content: sanitizeForApi(String(userText || '').slice(0, 2000)) },
        ],
        tools: [],
        reasoningEffort: 'low',
        signal: AbortSignal.timeout(45000),
        onReasoning: () => undefined,
        onText: () => undefined,
      })
      const raw = String(result.content || '')
      const title = normaliseTitle(raw)
      if (!title) {
        trace({ outcome: 'empty-or-noise', raw: raw.slice(0, 120), durationMs: Date.now() - startedAt, completionTokens: result.usage?.completionTokens })
        return null
      }
      // 抄回原话的标题虽然不理想（那正是用户报的「标题就是前几个字」），但它
      // 至少是一句完整的话，比兜底截断更像标题。所以**接受**它并标注出来，
      // 不要静默丢弃 —— 丢弃会让标题永远停在兜底值，而调用方看不出发生过什么。
      // 从 `upgradeStaleTitle` 的角度看，这条标题也不该被当成"已经升级过"。
      const echoes = titleEchoesSource(title, userText)
      trace({ outcome: echoes ? 'accepted-echo' : 'ok', title, durationMs: Date.now() - startedAt, completionTokens: result.usage?.completionTokens })
      return title
    } catch (e) {
      trace({ outcome: 'threw', error: String((e as Error)?.message || e).slice(0, 200) })
      return null
    }
  }

  private fallbackTitleFromText(text: string): string {
    return buildFallbackTitle(text)
  }

  /**
   * 打开会话时，把旧版「原话截断」标题静默升级为真正的 AI 标题。
   *
   * 判定条件是**这条标题是否只是用户原话的截断**，而不是它的长度。旧实现用
   * `title.length > 8` 当门槛，恰好放过了最难看的那些：8 个字以内的原话截断
   * （「帮我分析一下我和」「8月8日发生了」）永远不会被升级，用户看到的就一直是
   * 半句话。反过来，长度超过 8 的**真正标题**又会白白重写一次。
   */
  private upgradeStaleTitle(chatId: string): void {
    if (this.titleUpgrading.has(chatId)) return
    const chat = this.loadChats().find((c) => c.id === chatId)
    if (!chat) return
    if (chat.titleVersion === 2) return
    const stored = this.loadMessages(chatId)
    const firstUser = stored.messages.find((m) => m.role === 'user')
    if (!firstUser?.content) return
    const looksTruncated = titleEchoesSource(chat.title || '', firstUser.content)
    if (!looksTruncated && (chat.title?.length || 0) <= 8) return
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

  /**
   * 前缀稳定性探针（逐字节，含跨重启）。
   *
   * 每次请求都把「系统提示 + 工具定义 + 模型路由 + 完整请求数组」与前一次请求
   * 逐条对比，并给出**为什么**前缀变了：
   *
   * - `first`        本会话（连磁盘也没有帧）的第一条请求；
   * - `append`       上一次请求是本次请求的逐字节前缀 —— 唯一健康的形态；
   * - `system`       系统提示变了 —— 整段前缀失效；
   * - `tools`        工具定义变了 —— 整段前缀失效；
   * - `route`        provider/model/protocol 换了 —— 换缓存域，全量重算；
   * - `head-rewrite` 历史中段被改写（压缩，或丢弃了历史头部）—— 从分歧点起失效。
   *
   * 这是把「命中率莫名掉到 95%」变成可定位问题的关键工具。DSH 正是靠
   * 442/442 全为 `append` 来证明其设计成立
   * （见 docs/reference/dsh-cache-architecture.md §D.3）。
   *
   * 期望的健康形态：一整轮里全是 `append`；一次压缩对应**恰好一次**
   * `head-rewrite`，位置就等于保留窗口的起点；重启后的第一条请求是带
   * `restored: true` 的 `append`（或如实报出 `system`/`tools`/`route`）。
   */
  private probePrefixChange(
    chatId: string,
    systemContent: string,
    tools: unknown,
    route: string,
    apiMessages: Array<Record<string, unknown>>
  ): PrefixChange {
    const frame = buildPrefixFrame(systemContent, tools, apiMessages, route)
    const inMemory = this.prefixProbe.get(chatId)
    const previous = inMemory || this.loadPrefixProbeDisk().get(chatId)
    const change = comparePrefixFrames(previous, frame)
    if (!inMemory && previous) change.restored = true
    this.prefixProbe.set(chatId, frame)
    this.savePrefixProbeDisk(chatId, frame)
    return change
  }

  private prefixProbePath(): string {
    this.ensureDirs()
    return join(this.dataDir, 'prefix-probe.json')
  }

  /** 每帧只有哈希，没有正文 —— 这个文件多大都不会泄露对话内容。 */
  private loadPrefixProbeDisk(): Map<string, PrefixFrame> {
    if (this.prefixProbeDisk) return this.prefixProbeDisk
    const loaded = new Map<string, PrefixFrame>()
    try {
      const path = this.prefixProbePath()
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, PrefixFrame>
        for (const [key, frame] of Object.entries(raw)) {
          if (frame && Array.isArray(frame.wireHashes)) loaded.set(key, frame)
        }
      }
    } catch { /* 坏文件当成没有帧 —— 最多退回 `first` */ }
    this.prefixProbeDisk = loaded
    return loaded
  }

  private savePrefixProbeDisk(chatId: string, frame: PrefixFrame): void {
    try {
      const disk = this.loadPrefixProbeDisk()
      disk.set(chatId, frame)
      const path = this.prefixProbePath()
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(disk)), 'utf8')
      renameSync(tmp, path)
    } catch { /* 诊断文件写不进去不能影响对话 */ }
  }

  private dropPrefixProbe(chatId: string): void {
    this.prefixProbe.delete(chatId)
    const disk = this.prefixProbeDisk
    if (disk && disk.has(chatId)) {
      disk.delete(chatId)
      try {
        const path = this.prefixProbePath()
        const tmp = `${path}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(disk)), 'utf8')
        renameSync(tmp, path)
      } catch { /* noop */ }
    }
  }

  private async callModel(
    chatId: string,
    history: AiMessage[],
    signal: AbortSignal,
    compressed: string | undefined,
    requestShape: ModelRequestShape,
    consumer: ProviderConsumer = 'chat',
    resolvedProfile?: ProviderProfile | null
  ): Promise<{
    ok: boolean
    content?: string
    reasoning?: string
    toolCalls?: AiToolCall[]
    usage?: AiRunUsage
    timing?: AiStepTiming
    error?: string
    httpStatus?: number
  }> {
    // 功能面指定的服务优先于「默认服务」：WeClone / WeBot 可以在设置里各自指向
    // 另一个 profile，而这里以前读的是 getActive()，于是三处配置里有两处是
    // 摆设（选了也不生效），请求实际打到默认服务上。
    const base = resolvedProfile || this.providerProfiles.getForConsumer(consumer)
    const profile = base ? this.applyProbeOverride(base) : null
    if (!profile?.apiKey && !getProviderCatalogEntry(profile?.providerId || '')?.apiKeyOptional) return { ok: false, error: '未配置 AI API Key，请在 WeportAI 设置中添加服务配置' }
    if (!profile?.baseUrl) return { ok: false, error: '未配置 AI 服务地址，请在 WeportAI 设置中完善服务配置' }
    const apiMessages = this.buildApiMessages(history, compressed, requestShape.systemContent, { preserveReasoning: profile.providerId === 'deepseek' })
    // 按模型解析协议 / 输出上限（纯本地：registry 缓存 + bundled snapshot）。
    // 网关是按模型挑协议的，用 profile.protocol 一个值兜所有模型会把
    // `grok-4.6` 这类模型发到错误的端点。必须在探针之前解析：路由本身就是
    // 前缀身份的一部分（换模型 = 换缓存域）。
    const resolved = this.resolveProfileModel(profile)
    this.persistResolvedModelMetadata(profile, resolved)
    // 逐字节前缀稳定性探针（跨重启）：把「为什么这次请求没命中缓存」变成可查的
    // 日志事实，而不是靠猜。健康状态是一整轮全为 append，一次压缩只有一次
    // head-rewrite，重启后的第一条是 restored append。
    const route = `${profile.providerId}|${profile.model}|${resolved.protocol}`
    const prefixChange = this.probePrefixChange(chatId, requestShape.systemContent, requestShape.tools, route, apiMessages)
    this.appendDebugLog({
      kind: 'prefix',
      chatId,
      change: prefixChange.change,
      divergedAt: prefixChange.divergedAt,
      previousLength: prefixChange.previousLength,
      messages: apiMessages.length,
      prefixHash: requestShape.hash,
      route,
      ...(prefixChange.restored ? { restored: true } : {}),
    })
    const startedAt = Date.now()
    const callProfile: ProviderProfile = { ...this.withGatewayHeaders(profile), modelProtocol: resolved.protocol }
    try {
      // 解码计时：首个 delta（思考或正文）到达即认为开始解码，和 DSH 的
      // `firstTokenTime` 一致。之前这里只记 startedAt 与结束时间，算出来的
      // 「速度」把首 token 等待也摊进去了。
      let firstTokenAt: number | null = null
      const markFirstToken = () => {
        if (firstTokenAt === null) firstTokenAt = Date.now()
      }
      const result: ProviderStreamResult = await getProviderAdapter(callProfile).stream({
        profile: callProfile,
        messages: apiMessages,
        tools: requestShape.tools,
        // Main path: send the model's own output limit. Before this it was
        // declared on `ProviderStreamInput` but never set here, so the Anthropic
        // adapter fell back to its hard-coded 32768 regardless of the model.
        maxOutputTokens: profile.modelMaxOutputTokens,
        reasoningEffort: String(this.configService.get('weportAiReasoningEffort') || 'high'),
        signal,
        onReasoning: (delta) => {
          markFirstToken()
          this.emit({ type: 'reasoning_delta', chatId, delta })
        },
        onText: (delta) => {
          markFirstToken()
          this.emit({ type: 'text_delta', chatId, delta })
        },
        // tool-only 步骤也要有「首 token」：参数流的第一个增量就是解码的开始，
        // 否则这类步骤 decodeMs=0、整段时间被错记成 TTFT、速度徽标直接不显示。
        onToolArgs: () => {
          markFirstToken()
        },
      })
      const finishedAt = Date.now()
      const decodeStartedAt = firstTokenAt ?? finishedAt
      const timing: AiStepTiming = {
        ttftMs: Math.max(0, decodeStartedAt - startedAt),
        decodeMs: Math.max(0, finishedAt - decodeStartedAt),
        outputTokens: Math.max(0, result.usage?.completionTokens || 0),
      }
      // 每步用量落日志：真实命中率的地面真值。旧版本只记了时长，命中率只能靠
      // UI 实时读数看一眼、无法回放分析（Reasonix `cache_shape.go` 每请求都记
      // hit/miss/tools-hash —— 这里对齐它）。
      const promptTokens = result.usage?.promptTokens || 0
      const cacheHitTokens = result.usage?.promptCacheHitTokens || 0
      this.appendDebugLog({
        kind: 'request',
        chatId,
        model: profile.model,
        provider: profile.providerId,
        protocol: resolved.protocol,
        prefixChange: prefixChange.change,
        messages: history.length,
        tools: requestShape.tools.length,
        durationMs: Date.now() - startedAt,
        ttftMs: timing.ttftMs,
        decodeMs: timing.decodeMs,
        promptTokens,
        cacheHitTokens,
        promptCacheMissTokens: Math.max(0, promptTokens - cacheHitTokens),
        promptCacheHitRate: promptTokens > 0 ? Math.round((cacheHitTokens / promptTokens) * 10000) / 100 : null,
        completionTokens: result.usage?.completionTokens || 0,
        reasoningTokens: result.usage?.reasoningTokens || 0,
      })
      return {
        ok: true,
        content: result.content,
        reasoning: result.reasoning,
        toolCalls: result.toolCalls.map((call) => ({ id: call.id, name: call.name, args: call.args, friendly: '' })),
        usage: result.usage,
        timing,
      }
    } catch (error) {
      if (signal.aborted) return { ok: false, error: '已中止' }
      const status = Number((error as { status?: number })?.status)
      const detail = String((error as Error)?.message || error).trim()
      this.appendDebugLog({ kind: 'error', chatId, provider: profile.providerId, protocol: resolved.protocol, httpStatus: status || undefined, error: detail, durationMs: Date.now() - startedAt })
      return { ok: false, error: detail || '模型调用失败', httpStatus: status || undefined }
    }
  }
}

export const weportAiService = new WeportAiService()

export const __BUNDLE_MARKER_PROBE = 'ZZ_BUNDLE_MARKER_9911'

