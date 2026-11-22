/**
 * 阅读器自动回复草稿（v1.3.3）—— 主进程侧的监听与生成。
 *
 * ## 为什么必须在主进程
 *
 * 用户选择的是"对方发来新消息就自动生成"。页面是 `React.lazy` + 条件渲染，
 * 切一个标签页就卸载；托盘隐藏会**销毁窗口**，最小化会 unload 页面。如果监听
 * 活在页面的 `useEffect` 里，用户切走的那一刻它就停了 —— 那正是铁律 3 要避免
 * 的"数据还在，但用户看不见 / 任务已经不在"。
 *
 * ## 边界（与既有草稿链路一致）
 *
 * - 只读：只发 SELECT，不写微信数据库；
 * - 不发送：生成的草稿只回到渲染层供人工审核、复制；
 * - 不落盘：草稿只存在主进程内存里，应用退出即消失；
 * - 显式开启：每次开启都要用户勾选同意；切换会话、切换账号、退出应用都会停止；
 * - 限流：一次只生成一条，消息突发时去抖，失败不自动重试（避免持续花钱）。
 *
 * ## 新消息从哪来
 *
 * 不复用 `messagePushService`：它按通知过滤规则（免打扰、黑白名单、@我）筛选，
 * 而且会丢掉"同步回填"的旧消息。自动草稿需要的是当前会话里**所有**新的对方
 * 消息，与通知设置无关。这里用 `chatService.getNewMessages` 直接轮询（它开自己的
 * 游标，不碰阅读器的分页游标），4 秒一次，开销很低。
 */

import { ConfigService } from './config'
import { chatService, type Message } from './chatService'
import { weCloneService } from './weCloneService'
import { taskStatusService, TASK_KEY } from './taskStatusService'
import { readerDraftSettingsService } from './readerDraftSettingsService'
import { cloneAccountIdentity, readerCloneGuardError } from '../../src/utils/readerCloneGuard'
import {
  READER_AUTO_DRAFT_MAX_CHARS,
  READER_AUTO_DRAFT_MAX_MESSAGES,
  READER_AUTO_DRAFT_MAX_SCAN_ROWS,
  READER_AUTO_DRAFT_STYLES,
  autoDraftRetrievalText,
  buildAutoDraftPrompt,
  buildReaderDraftSelection,
  type ReaderAutoDraftDraft,
  type ReaderAutoDraftSnapshot,
  type ReaderAutoDraftVariant,
  type ReaderAutoDraftVariantError,
  type ReaderDraftMessageKind,
  type ReaderDraftSourceMessage,
} from '../../src/utils/readerAutoDraft'
import {
  normalizeReaderDraftRange,
  readerDraftRangeStart,
  type ReaderDraftRange,
} from '../../src/utils/readerDraftSettings'
import { normalizeDraftText } from '../../src/utils/readerDraftFormat'
import { weCloneStyleOption } from '../../src/utils/weCloneStyle'

const POLL_INTERVAL_MS = 4_000
const DEBOUNCE_MS = 6_000
const MAX_DEBOUNCE_MS = 30_000
const MIN_GENERATION_INTERVAL_MS = 12_000
const NEW_MESSAGE_BATCH = 100
const MAX_BATCHES = 5
const ERROR_LOG_INTERVAL_MS = 30_000

export interface ReaderAutoDraftStartConfig {
  accountId: string
  sessionId: string
  sessionName?: string
  cloneId: string
  range: ReaderDraftRange | string
}

interface WatchState {
  config: { accountId: string; sessionId: string; sessionName?: string; cloneId: string; range: ReaderDraftRange }
  watching: boolean
  startedAt: number
  /** 开始监听时最后一条消息的时间（秒）；更早的消息一律视为历史回填 */
  baselineTs: number
  lastSeenTs: number
  seen: Set<string>
  pendingTarget?: Message
  /** 本次突发里第一条对方消息的到达时刻（毫秒），用于给去抖封顶 */
  firstPendingAt?: number
  lastIncomingDetectedAt: number
  lastIncomingMessage?: Message
  lastIncomingAt?: number
  lastOutgoingAt?: number
  repliedManually: boolean
  pollTimer: ReturnType<typeof setInterval> | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  polling: boolean
  generating: boolean
  abort: AbortController | null
  lastDraft?: ReaderAutoDraftDraft
  lastError?: string
  statusMessage: string
  lastGeneratedAt: number
  /** 失败退避 / 手动重试的最早时刻（毫秒） */
  nextAllowedAt: number
  lastErrorLoggedAt: number
}

export interface ReaderAutoDraftResult {
  success: boolean
  snapshot?: ReaderAutoDraftSnapshot
  error?: string
}

function secondsOf(message: Message): number {
  const value = Number(message.createTime || 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

function draftKindOf(message: Message): ReaderDraftMessageKind {
  const type = Number(message.localType || 0)
  if (type === 10000) return 'system'
  if (type === 10002) return 'revoked'
  if (message.quotedContent && String(message.parsedContent || '').trim()) return 'quote'
  if (type === 1) return 'text'
  if (type === 3) return 'image'
  if (type === 34) return 'voice'
  if (type === 43) return 'video'
  if (type === 47) return 'sticker'
  if (type === 42) return 'card'
  if (type === 48) return 'location'
  if (type === 49) {
    if (message.fileName) return 'file'
    if (message.linkTitle) return 'link'
    if (message.appMsgMusicUrl) return 'music'
    return 'other'
  }
  return String(message.parsedContent || '').trim() ? 'text' : 'other'
}

function draftTextOf(message: Message, kind: ReaderDraftMessageKind): string {
  const text = String(message.parsedContent || '').trim()
  switch (kind) {
    case 'text':
    case 'quote':
      return text || (kind === 'quote' ? '[引用]' : '')
    case 'image':
      return '[图片]'
    case 'video':
      return '[视频]'
    case 'voice': {
      const duration = Number(message.voiceDurationSeconds || 0)
      return duration > 0 ? `[语音 ${Math.round(duration)}s]` : '[语音]'
    }
    case 'sticker':
      return '[表情]'
    case 'file':
      return message.fileName ? `[文件] ${message.fileName}` : '[文件]'
    case 'link':
      return message.linkTitle ? `[链接] ${message.linkTitle}` : '[链接]'
    case 'location':
      return message.locationLabel ? `[位置] ${message.locationLabel}` : '[位置]'
    case 'card':
      return message.cardNickname ? `[名片] ${message.cardNickname}` : '[名片]'
    case 'music':
      return '[音乐]'
    default:
      return text || '[消息]'
  }
}

function toDraftSource(message: Message): ReaderDraftSourceMessage {
  const kind = draftKindOf(message)
  const senderName = Number(message.isSend) === 1
    ? 'Me'
    : String(message.senderDisplayName || message.senderUsername || '对方')
  const quoted = String(message.quotedContent || '').trim()
  return {
    key: String(message.messageKey || `${message.localId}-${message.createTime}`),
    ts: secondsOf(message) * 1000,
    isSend: Number(message.isSend) === 1,
    senderName,
    kind,
    text: draftTextOf(message, kind),
    ...(quoted ? { quote: { sender: String(message.quotedSender || '对方'), text: quoted } } : {}),
  }
}

function isSystemMessage(message: Message): boolean {
  const type = Number(message.localType || 0)
  return type === 10000 || type === 10002
}

export class ReaderAutoDraftService {
  /** 延迟到真正用到时再取：这个模块在 app ready 之前就被 appMain import。 */
  private get configService(): ConfigService {
    return ConfigService.getInstance()
  }

  private state: WatchState | null = null
  private emit: ((snapshot: ReaderAutoDraftSnapshot) => void) | null = null

  setEmitter(emitter: ((snapshot: ReaderAutoDraftSnapshot) => void) | null): void {
    this.emit = emitter
  }

  private publish(): void {
    const snapshot = this.snapshot()
    try {
      this.emit?.(snapshot)
    } catch {
      /* 渲染层已销毁不影响服务继续运行 */
    }
  }

  snapshot(): ReaderAutoDraftSnapshot {
    const state = this.state
    if (!state) {
      return {
        watching: false,
        accountId: '',
        sessionId: '',
        cloneId: '',
        range: 'today',
        generating: false,
        statusMessage: '未开始',
      }
    }
    return {
      watching: state.watching,
      accountId: state.config.accountId,
      sessionId: state.config.sessionId,
      sessionName: state.config.sessionName,
      cloneId: state.config.cloneId,
      range: state.config.range,
      startedAt: state.startedAt,
      generating: state.generating,
      statusMessage: state.statusMessage,
      lastError: state.lastError,
      lastIncomingAt: state.lastIncomingAt,
      lastOutgoingAt: state.lastOutgoingAt,
      repliedManually: state.repliedManually,
      lastDraft: state.lastDraft,
    }
  }

  private accountMatches(accountId: string): boolean {
    const active = String(this.configService.get('myWxid') || '').trim()
    return Boolean(active && accountId && cloneAccountIdentity(active) === cloneAccountIdentity(accountId))
  }

  /**
   * 开始监听当前会话。会先停掉已有的监听（一次只允许一个会话）。
   *
   * 开启时会把 cloneId / range 写进按会话设置，保留用户已有的补充提示词。
   */
  async start(config: ReaderAutoDraftStartConfig): Promise<ReaderAutoDraftResult> {
    const accountId = String(config.accountId || '').trim()
    const sessionId = String(config.sessionId || '').trim()
    const cloneId = String(config.cloneId || '').trim()
    const range = normalizeReaderDraftRange(config.range)
    if (!accountId || !sessionId) return { success: false, error: '请先选择账号和会话。' }
    if (!cloneId) return { success: false, error: '请明确选择用于草稿的本机分身。' }
    if (!this.accountMatches(accountId)) {
      return { success: false, error: '当前账号已改变，请返回阅读器重新选择会话。' }
    }
    if (!String(this.configService.get('decryptKey') || '').trim()) {
      return { success: false, error: '尚未连接微信数据库，请先在「连接微信」完成连接。' }
    }

    const listed = await weCloneService.getClones()
    if (!listed.success) return { success: false, error: listed.error || '无法读取本机分身。' }
    const clone = listed.clones.find((item) => item.id === cloneId)
    const guardError = readerCloneGuardError(
      { accountId, sessionId },
      String(this.configService.get('myWxid') || ''),
      cloneId,
      clone,
    )
    if (guardError) return { success: false, error: guardError }

    const latest = await chatService.getLatestMessages(sessionId, 10)
    if (!latest.success) {
      return { success: false, error: latest.error || '无法读取当前会话，请先在「连接微信」完成连接。' }
    }
    const messages = latest.messages || []
    const baselineTs = messages.reduce((max, message) => Math.max(max, secondsOf(message)), 0) || Math.floor(Date.now() / 1000)
    // 验证全部通过后才停掉旧监听：一次失败的 start 不应该打断正在工作的会话。
    this.stopInternal('重新开始监听', false)
    const state: WatchState = {
      config: { accountId, sessionId, sessionName: config.sessionName, cloneId, range },
      watching: true,
      startedAt: Date.now(),
      baselineTs,
      lastSeenTs: baselineTs,
      seen: new Set(messages.map((message) => String(message.messageKey || '')).filter(Boolean)),
      lastIncomingDetectedAt: 0,
      repliedManually: false,
      pollTimer: null,
      debounceTimer: null,
      polling: false,
      generating: false,
      abort: null,
      statusMessage: '正在监听新消息…',
      lastGeneratedAt: 0,
      nextAllowedAt: 0,
      lastErrorLoggedAt: 0,
    }
    this.state = state
    // 保存"这个会话用哪个分身、哪个时间范围"；note 不动。
    try {
      readerDraftSettingsService.set({ accountId, sessionId, cloneId, range })
    } catch {
      /* 设置落盘失败不影响本次监听 */
    }

    state.pollTimer = setInterval(() => { void this.tick() }, POLL_INTERVAL_MS)
    state.pollTimer.unref?.()
    taskStatusService.begin(TASK_KEY.readerAutoDraft, state.statusMessage, 'watching')
    this.publish()
    // 立刻跑一轮，把"开启之后、第一次轮询之前"到达的消息也接住。
    void this.tick()
    return { success: true, snapshot: this.snapshot() }
  }

  stop(reason = '已停止自动草稿'): ReaderAutoDraftResult {
    this.stopInternal(reason, true)
    return { success: true, snapshot: this.snapshot() }
  }

  private stopInternal(reason: string, publish: boolean): void {
    const state = this.state
    if (!state) return
    state.watching = false
    state.polling = false
    state.pendingTarget = undefined
    state.firstPendingAt = undefined
    if (state.pollTimer) clearInterval(state.pollTimer)
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.pollTimer = null
    state.debounceTimer = null
    try { state.abort?.abort() } catch { /* noop */ }
    state.abort = null
    state.generating = false
    state.statusMessage = reason
    taskStatusService.end(TASK_KEY.readerAutoDraft, 'done', { message: reason })
    if (publish) this.publish()
  }

  /** 手动"再生成一次"：使用最近一条对方消息，不再等新消息。 */
  async regenerate(): Promise<ReaderAutoDraftResult> {
    const state = this.state
    if (!state?.watching) return { success: false, error: '自动草稿未开启。' }
    let target = state.lastIncomingMessage
    if (!target) {
      const latest = await chatService.getLatestMessages(state.config.sessionId, 50)
      if (!latest.success) return { success: false, error: latest.error || '无法读取当前会话。' }
      for (let index = (latest.messages || []).length - 1; index >= 0; index -= 1) {
        const message = latest.messages![index]
        if (Number(message.isSend) === 1 || isSystemMessage(message)) continue
        target = message
        break
      }
    }
    if (!target) return { success: false, error: '这个会话里还没有对方发来的消息。' }
    state.pendingTarget = target
    state.firstPendingAt = Date.now()
    state.nextAllowedAt = 0
    state.lastError = undefined
    state.statusMessage = '正在重新生成草稿…'
    this.publish()
    void this.generate()
    return { success: true, snapshot: this.snapshot() }
  }

  private async tick(): Promise<void> {
    const state = this.state
    if (!state?.watching || state.polling) return
    if (!this.accountMatches(state.config.accountId)) {
      this.stopInternal('当前账号已改变，自动草稿已停止', true)
      return
    }
    state.polling = true
    try {
      let since = Math.max(0, state.lastSeenTs - 2)
      let newest = state.lastSeenTs
      let pollFailed = false
      for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        const result = await chatService.getNewMessages(state.config.sessionId, since, NEW_MESSAGE_BATCH)
        if (!result.success) {
          pollFailed = true
          this.noteError(result.error || '读取新消息失败')
          break
        }
        const messages = result.messages || []
        if (messages.length === 0) break
        for (const message of messages) this.handleMessage(state, message)
        const maxTs = messages.reduce((max, message) => Math.max(max, secondsOf(message)), since)
        newest = Math.max(newest, maxTs)
        if (maxTs <= since) break
        since = maxTs
        if (messages.length < NEW_MESSAGE_BATCH) break
      }
      state.lastSeenTs = Math.max(state.lastSeenTs, newest)
      // 轮询恢复后把临时的读取错误清掉；生成失败的错误保留给用户看。
      if (!pollFailed && state.statusMessage === '读取新消息失败，正在重试…') {
        state.lastError = undefined
        state.statusMessage = '正在监听新消息…'
        taskStatusService.progress(TASK_KEY.readerAutoDraft, {
          stage: 'watching',
          progress: 100,
          message: state.statusMessage,
          log: false,
        })
        this.publish()
      }
      if (state.pendingTarget) this.scheduleGeneration(state)
    } finally {
      state.polling = false
    }
  }

  private handleMessage(state: WatchState, message: Message): void {
    const key = String(message.messageKey || '').trim()
    if (!key || state.seen.has(key)) return
    state.seen.add(key)
    if (state.seen.size > 5_000) {
      // 只保留最近的键值，避免长时间监听无限增长。
      state.seen = new Set([...state.seen].slice(-2_000))
    }
    const createTime = secondsOf(message)
    if (createTime <= 0 || createTime < state.baselineTs) return
    if (isSystemMessage(message)) return

    if (Number(message.isSend) === 1) {
      state.lastOutgoingAt = createTime
      const targetTs = state.pendingTarget ? secondsOf(state.pendingTarget) : 0
      let changed = false
      if (state.pendingTarget && createTime >= targetTs) {
        state.pendingTarget = undefined
        state.firstPendingAt = undefined
        if (state.debounceTimer) clearTimeout(state.debounceTimer)
        state.debounceTimer = null
        state.repliedManually = true
        state.statusMessage = '你已在微信里手动回复，本次自动草稿已取消。'
        changed = true
      }
      // 即使已经没有待生成的草稿，用户手动回复后旧草稿也应标记为可能过期。
      if (state.lastDraft && !state.lastDraft.stale && state.lastDraft.targetTs / 1000 <= createTime) {
        state.lastDraft = { ...state.lastDraft, stale: true }
        changed = true
      }
      if (changed) this.publish()
      return
    }

    state.lastIncomingAt = createTime
    state.lastIncomingMessage = message
    state.pendingTarget = message
    state.firstPendingAt = state.firstPendingAt || Date.now()
    state.lastIncomingDetectedAt = Date.now()
    state.repliedManually = false
    state.statusMessage = '收到对方的新消息，准备生成草稿…'
    taskStatusService.progress(TASK_KEY.readerAutoDraft, {
      stage: 'watching',
      progress: 100,
      message: state.statusMessage,
      log: false,
    })
    this.publish()
    // 去抖安排在 tick 的所有批次处理完之后（见 tick 末尾）：一次积压几百条
    // 消息时，不应该每 100 条就生成一版草稿。
  }

  private scheduleGeneration(state: WatchState): void {
    if (!state.watching || !state.pendingTarget) return
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    const now = Date.now()
    const sinceFirst = state.firstPendingAt ? now - state.firstPendingAt : 0
    const capRemaining = Math.max(0, MAX_DEBOUNCE_MS - sinceFirst)
    const sinceDetected = Math.max(0, now - state.lastIncomingDetectedAt)
    const delay = Math.min(Math.max(0, DEBOUNCE_MS - sinceDetected), capRemaining)
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null
      void this.generate()
    }, delay)
    state.debounceTimer.unref?.()
  }

  private async generate(): Promise<void> {
    const state = this.state
    if (!state?.watching || state.generating) return
    const target = state.pendingTarget
    if (!target) return
    const now = Date.now()
    const wait = Math.max(
      state.nextAllowedAt - now,
      state.lastGeneratedAt + MIN_GENERATION_INTERVAL_MS - now,
    )
    if (wait > 0) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer)
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null
        void this.generate()
      }, wait)
      state.debounceTimer.unref?.()
      return
    }

    state.generating = true
    state.abort = new AbortController()
    state.statusMessage = `正在同时生成 ${READER_AUTO_DRAFT_STYLES.length} 个风格草稿…`
    taskStatusService.progress(TASK_KEY.readerAutoDraft, {
      stage: 'generating',
      progress: 100,
      message: state.statusMessage,
      log: false,
    })
    this.publish()

    const cloneId = state.config.cloneId
    const settings = readerDraftSettingsService.get(state.config.accountId, state.config.sessionId)
    const range = settings?.range || state.config.range
    const note = settings?.note || ''
    const targetTsMs = secondsOf(target) * 1000
    const endMs = targetTsMs + 1000
    const startMs = readerDraftRangeStart(range, now)

    try {
      const listed = await weCloneService.getClones()
      const clone = listed.clones.find((item) => item.id === cloneId)
      const guardError = readerCloneGuardError(
        { accountId: state.config.accountId, sessionId: state.config.sessionId },
        String(this.configService.get('myWxid') || ''),
        cloneId,
        clone,
      )
      if (guardError) throw new Error(`${guardError} 自动草稿已停止。`)

      const context = await chatService.getMessagesForReaderDraft(state.config.sessionId, {
        startTimeMs: startMs,
        endTimeMs: endMs,
        maxRows: READER_AUTO_DRAFT_MAX_SCAN_ROWS,
      })
      if (!context.success) throw new Error(context.error || '读取聊天上下文失败。')
      const rows = (context.messages || []).map(toDraftSource)
      if (rows.length === 0) throw new Error('所选时间范围内没有可用的聊天记录。')
      // 扫描上限到了但还没到区间起点：上下文本身是"最近 N 条"而不是完整区间。
      const scanLimited = context.reachedStart !== true &&
        context.exhausted !== true &&
        (context.scannedRows || 0) >= READER_AUTO_DRAFT_MAX_SCAN_ROWS
      const selection = buildReaderDraftSelection(rows, {
        targetKey: String(target.messageKey || ''),
        maxMessages: READER_AUTO_DRAFT_MAX_MESSAGES,
        maxChars: READER_AUTO_DRAFT_MAX_CHARS,
      })
      if (!selection.target || selection.rows.length === 0) {
        throw new Error('没有找到可以回复的对方消息。')
      }
      const prompt = buildAutoDraftPrompt(selection, { range, note, scanLimited })
      const retrievalText = autoDraftRetrievalText(selection)

      const signal = state.abort.signal
      // 同一条消息、同一段上下文，并发生成多个风格版本；用户在结果里挑一个。
      const variantResults = await Promise.allSettled(
        READER_AUTO_DRAFT_STYLES.map(async (variantStyle) => {
          const result = await weCloneService.chatWithClone({
            cloneId,
            message: prompt,
            readerGuard: { accountId: state.config.accountId, sessionId: state.config.sessionId },
            retrievalQuery: retrievalText,
            replyLanguageText: retrievalText,
            readerDraftMaxChars: 32_000,
            styleOverride: variantStyle,
            signal,
          })
          if (!result.success || !String(result.reply || '').trim()) {
            throw new Error([result.error || '模型没有生成回复。', result.hint].filter(Boolean).join(' '))
          }
          // 阅读器草稿是一段要直接粘贴的文本：去掉空行/换行并补正标点。
          const reply = normalizeDraftText(String(result.reply))
          if (!reply) throw new Error('模型返回的草稿为空。')
          return {
            style: variantStyle,
            label: weCloneStyleOption(variantStyle).label,
            reply,
            model: result.meta?.model,
            providerId: result.meta?.providerId,
          } satisfies ReaderAutoDraftVariant
        })
      )
      // 停止 / 切换会话之后，迟到的结果必须丢弃。
      if (this.state !== state || !state.watching) return
      const variants: ReaderAutoDraftVariant[] = []
      const errors: ReaderAutoDraftVariantError[] = []
      for (let index = 0; index < variantResults.length; index += 1) {
        const result = variantResults[index]
        const variantStyle = READER_AUTO_DRAFT_STYLES[index]
        if (result.status === 'fulfilled') {
          variants.push(result.value)
        } else {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
          errors.push({
            style: variantStyle,
            label: weCloneStyleOption(variantStyle).label,
            error: /abort/i.test(reason) ? '已取消' : reason,
          })
        }
      }
      if (variants.length === 0) {
        throw new Error(errors.length > 0
          ? `所有风格都生成失败：${errors.map((item) => `${item.label}：${item.error}`).join('；')}`
          : '模型没有生成回复。')
      }

      state.lastDraft = {
        variants,
        errors: errors.length > 0 ? errors : undefined,
        generatedAt: Date.now(),
        targetTs: targetTsMs,
        coverage: {
          range,
          eligibleCount: selection.eligibleCount,
          includedCount: selection.includedCount,
          charCount: selection.charCount,
          truncated: selection.truncated || scanLimited,
        },
        stale: false,
      }
      state.lastError = undefined
      // 只清掉"这次生成的那个目标"。生成期间又来了新消息时要保留它，
      // 否则 finally 里不会安排下一轮，用户会看到一条旧草稿而以为已经是最新。
      if (state.pendingTarget && String(state.pendingTarget.messageKey || '') === String(target.messageKey || '')) {
        state.pendingTarget = undefined
        state.firstPendingAt = undefined
      }
      state.lastGeneratedAt = Date.now()
      state.statusMessage = errors.length > 0
        ? `已生成 ${variants.length} 个风格（${errors.length} 个失败），继续监听…`
        : `已生成 ${variants.length} 个风格草稿，继续监听…`
      taskStatusService.progress(TASK_KEY.readerAutoDraft, {
        stage: 'watching',
        progress: 100,
        message: state.statusMessage,
        log: false,
      })
    } catch (error) {
      if (this.state !== state || !state.watching) return
      const message = (error as Error)?.message || String(error)
      // 用户主动停止会 abort，不把它报告成生成失败。
      state.lastError = /abort/i.test(message) ? undefined : message
      // 失败的目标不再自动重试（避免持续花钱）；但如果生成期间又来了新消息，
      // 保留新目标，让 finally 安排下一轮。
      if (state.pendingTarget && String(state.pendingTarget.messageKey || '') === String(target.messageKey || '')) {
        state.pendingTarget = undefined
        state.firstPendingAt = undefined
      }
      state.lastGeneratedAt = Date.now()
      state.statusMessage = state.lastError ? '生成失败，继续监听；可查看错误后手动重试。' : '已停止生成。'
      if (state.lastError) {
        taskStatusService.progress(TASK_KEY.readerAutoDraft, {
          stage: 'watching',
          progress: 100,
          message: state.statusMessage,
          log: false,
        })
        if (Date.now() - state.lastErrorLoggedAt > ERROR_LOG_INTERVAL_MS) {
          state.lastErrorLoggedAt = Date.now()
          console.warn('[ReaderAutoDraft] 生成失败:', message)
        }
      }
    } finally {
      if (this.state === state) {
        state.generating = false
        state.abort = null
        this.publish()
        if (state.watching && state.pendingTarget) this.scheduleGeneration(state)
      }
    }
  }

  private noteError(message: string): void {
    const state = this.state
    if (!state) return
    state.lastError = message
    state.statusMessage = '读取新消息失败，正在重试…'
    if (Date.now() - state.lastErrorLoggedAt > ERROR_LOG_INTERVAL_MS) {
      state.lastErrorLoggedAt = Date.now()
      console.warn('[ReaderAutoDraft] 轮询失败:', message)
    }
    taskStatusService.progress(TASK_KEY.readerAutoDraft, {
      stage: 'watching',
      progress: 100,
      message: state.statusMessage,
      log: false,
    })
    this.publish()
  }

  /** 应用退出：清定时器、取消在飞请求，不再向渲染层推送。 */
  dispose(): void {
    this.stopInternal('应用退出，自动草稿已停止', false)
  }
}

export const readerAutoDraftService = new ReaderAutoDraftService()
