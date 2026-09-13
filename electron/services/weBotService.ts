import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  collectDueRuns,
  nextRunAfter,
  type WeBotCatchUp,
  type WeBotSchedule,
} from './weBotSchedule'

/** 会话引用（与渲染层 utils/mentionTrigger 的 ChatReference 同形）。 */
export interface WeBotReference {
  id: string
  label: string
  kind: 'group' | 'private' | 'official'
}

export interface WeBotTask {
  id: string
  title: string
  description: string
  schedule: WeBotSchedule
  catchUp: WeBotCatchUp
  enabled: boolean
  references: WeBotReference[]
  /** 同一时刻多个任务到期时是否允许并发（默认串行，见 dispatch）。 */
  allowParallel: boolean
  createdAt: number
  updatedAt: number
  /** 下一次**计划**时间；调度推进以它为准，避免重复触发同一时刻。 */
  nextRunAt: number | null
  lastRunAt: number | null
}

export type WeBotRunStatus = 'running' | 'ok' | 'error' | 'skipped'

export interface WeBotRun {
  id: string
  taskId: string
  taskTitle: string
  scheduledAt: number
  startedAt: number
  finishedAt?: number
  status: WeBotRunStatus
  error?: string
  noteId?: string
  durationMs?: number
}

/**
 * 一次运行留给用户的笔记。
 *
 * 这是 WeBot 真正的输出面：任务跑完不是把整段对话倒给用户，而是在笔记板上
 * 留下一张短的、结构化的卡片。字段刻意保持稳定（见 `version`），因为
 * 它同时通过 HTTP API 与 MCP 对外暴露给第三方集成。
 */
export interface WeBotNote {
  version: 1
  id: string
  taskId: string
  taskTitle: string
  runId: string
  createdAt: number
  title: string
  summary: string
  status: 'ok' | 'error'
  references: WeBotReference[]
  read: boolean
  pinned: boolean
}

export interface WeBotDispatchRequest {
  task: WeBotTask
  run: WeBotRun
}

export interface WeBotDispatchResult {
  /** 简洁的笔记正文（几百字以内），不是完整回答。 */
  summary: string
  title?: string
  /** 本次运行消耗的 token（可选，用于展示）。 */
  tokens?: number
}

export interface WeBotServiceOptions {
  /** 数据目录（通常 {userData}/webot）。 */
  dataDir: string
  /** 派发一次运行。由 appMain 注入，避免本模块直接依赖 agent harness。 */
  dispatch: (request: WeBotDispatchRequest, signal: AbortSignal) => Promise<WeBotDispatchResult>
  /** 通知回调（任务完成/失败时弹窗）。 */
  notify?: (note: WeBotNote) => void
  /** 调度 tick 间隔，测试可调小。 */
  tickMs?: number
  /** 运行历史保留条数（默认 400）。 */
  maxRuns?: number
  /** 笔记保留条数（默认 500，置顶的不参与淘汰）。 */
  maxNotes?: number
  now?: () => number
}

interface PersistedState {
  version: 1
  tasks: WeBotTask[]
  runs: WeBotRun[]
  notes: WeBotNote[]
}

const EMPTY_STATE: PersistedState = { version: 1, tasks: [], runs: [], notes: [] }
const MAX_RUNS = 400
const MAX_NOTES = 500

/**
 * WeBot：应用内定时任务调度器。
 *
 * 三条设计约束（都来自产品约束，不是实现偏好）：
 *
 * 1. **串行派发**。多个任务同时到期时默认一个接一个跑。并发的 agent 会同时
 *    抢占同一个 WCDB 宿主与同一份模型配额，结果是全部都变慢甚至互相失败；
 *    需要并发的任务可以单独勾选。
 * 2. **不写微信**。任务只能读聊天记录、只能写自己的笔记 —— 与 Weport 整体的
 *    只读定位一致。
 * 3. **调度状态可恢复**。`nextRunAt` 与运行历史都落盘，进程重启后不会重复
 *    执行也不会漏掉（补偿策略见 weBotSchedule.ts）。
 */
export class WeBotService {
  private readonly dataDir: string
  private readonly dispatchFn: WeBotServiceOptions['dispatch']
  private readonly notifyFn?: (note: WeBotNote) => void
  private readonly tickMs: number
  private readonly maxRuns: number
  private readonly maxNotes: number
  private readonly nowFn: () => number

  private state: PersistedState = { ...EMPTY_STATE, tasks: [], runs: [], notes: [] }
  private loaded = false
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly running = new Map<string, AbortController>()

  constructor(options: WeBotServiceOptions) {
    this.dataDir = options.dataDir
    this.dispatchFn = options.dispatch
    this.notifyFn = options.notify
    this.tickMs = Math.max(5_000, options.tickMs ?? 30_000)
    this.maxRuns = Math.max(1, options.maxRuns ?? MAX_RUNS)
    this.maxNotes = Math.max(1, options.maxNotes ?? MAX_NOTES)
    this.nowFn = options.now ?? (() => Date.now())
  }

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

  private statePath(): string {
    return join(this.dataDir, 'webot.json')
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.statePath())) return
      const parsed = JSON.parse(readFileSync(this.statePath(), 'utf8')) as Partial<PersistedState>
      if (!parsed || parsed.version !== 1) return
      this.state = {
        version: 1,
        tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as WeBotTask[]) : [],
        runs: Array.isArray(parsed.runs) ? (parsed.runs as WeBotRun[]) : [],
        notes: Array.isArray(parsed.notes) ? (parsed.notes as WeBotNote[]) : [],
      }
    } catch (error) {
      // 损坏的状态文件不能让整个功能崩掉：留空并继续，旧文件保留在磁盘上。
      console.warn('[WeBot] 状态文件无法解析，已从空状态启动:', error)
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.statePath()), { recursive: true })
      const tmp = `${this.statePath()}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(tmp, this.statePath())
    } catch (error) {
      console.warn('[WeBot] 状态写入失败:', error)
    }
  }

  // -------------------------------------------------------------------------
  // 调度循环
  // -------------------------------------------------------------------------

  start(): void {
    this.load()
    if (this.timer) return
    // 启动时立刻跑一次：把休眠/未运行期间错过的任务按补偿策略补上。
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }

  /**
   * 一次调度检查。
   *
   * 重入保护是必须的：dispatch 可能跑几分钟，下一个 tick 不能在上一次还没
   * 结束时再发一批 —— 否则一个长任务会和自己叠加。
   */
  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.nowFn()
      const due: Array<{ task: WeBotTask; scheduledAt: number }> = []

      for (const task of this.state.tasks) {
        if (!task.enabled) continue
        const dueRuns = collectDueRuns(task.schedule, {
          nowMs: now,
          nextDueMs: task.nextRunAt ?? undefined,
          catchUp: task.catchUp,
          maxRuns: 5,
        })
        // 无论是否补跑，计划点都必须推进到现在之后 —— 否则同一时刻会被
        // 每个 tick 重复判定为「到期」。
        const advanced = nextRunAfter(task.schedule, now)
        if (task.nextRunAt !== advanced) {
          task.nextRunAt = advanced
          task.updatedAt = now
        }
        for (const scheduledAt of dueRuns) due.push({ task, scheduledAt })
      }

      if (due.length > 0) this.persist()

      if (due.length > 0) {
        // 串行执行（除非该任务显式要求并发）：见类注释第 1 条。
        const parallel = due.filter((entry) => entry.task.allowParallel)
        const serial = due.filter((entry) => !entry.task.allowParallel)
        if (parallel.length > 0) await Promise.all(parallel.map((entry) => this.runTask(entry.task, entry.scheduledAt)))
        for (const entry of serial) await this.runTask(entry.task, entry.scheduledAt)
      }
    } catch (error) {
      console.warn('[WeBot] 调度 tick 失败:', error)
    } finally {
      this.ticking = false
    }
  }

  /** 立即执行一次（手动「立即运行」按钮走这条路径）。 */
  async runNow(taskId: string): Promise<{ success: boolean; error?: string }> {
    this.load()
    const task = this.state.tasks.find((item) => item.id === taskId)
    if (!task) return { success: false, error: '任务不存在' }
    await this.runTask(task, this.nowFn())
    return { success: true }
  }

  private async runTask(task: WeBotTask, scheduledAt: number): Promise<void> {
    const startedAt = this.nowFn()
    const run: WeBotRun = {
      id: `run-${randomUUID()}`,
      taskId: task.id,
      taskTitle: task.title,
      scheduledAt,
      startedAt,
      status: 'running',
    }
    this.state.runs.unshift(run)
    task.lastRunAt = startedAt
    this.trim()
    this.persist()

    const controller = new AbortController()
    this.running.set(run.id, controller)

    try {
      const result = await this.dispatchFn({ task, run }, controller.signal)
      run.status = 'ok'
      run.finishedAt = this.nowFn()
      run.durationMs = run.finishedAt - startedAt
      const note = this.appendNote(task, run, {
        title: result.title || task.title,
        summary: String(result.summary || '').trim() || '（本次运行没有产出内容）',
        status: 'ok',
      })
      run.noteId = note.id
      this.notifyFn?.(note)
    } catch (error) {
      run.status = controller.signal.aborted ? 'skipped' : 'error'
      run.finishedAt = this.nowFn()
      run.durationMs = run.finishedAt - startedAt
      run.error = String((error as Error)?.message || error).slice(0, 500)
      // 失败也要留笔记：否则用户只在弹窗里瞥一眼错误，之后无从复盘。
      const note = this.appendNote(task, run, {
        title: `${task.title}（失败）`,
        summary: run.error || '运行失败',
        status: 'error',
      })
      run.noteId = note.id
      this.notifyFn?.(note)
    } finally {
      this.running.delete(run.id)
      this.trim()
      this.persist()
    }
  }

  private appendNote(
    task: WeBotTask,
    run: WeBotRun,
    content: { title: string; summary: string; status: 'ok' | 'error' }
  ): WeBotNote {
    const note: WeBotNote = {
      version: 1,
      id: `note-${randomUUID()}`,
      taskId: task.id,
      taskTitle: task.title,
      runId: run.id,
      createdAt: this.nowFn(),
      title: content.title.slice(0, 120),
      summary: content.summary.slice(0, 4000),
      status: content.status,
      references: task.references.map((reference) => ({ ...reference })),
      read: false,
      pinned: false,
    }
    this.state.notes.unshift(note)
    return note
  }

  private trim(): void {
    if (this.state.runs.length > this.maxRuns) this.state.runs = this.state.runs.slice(0, this.maxRuns)
    // 置顶的笔记不参与淘汰。
    if (this.state.notes.length > this.maxNotes) {
      const pinned = this.state.notes.filter((note) => note.pinned)
      const rest = this.state.notes.filter((note) => !note.pinned).slice(0, Math.max(0, this.maxNotes - pinned.length))
      this.state.notes = [...pinned, ...rest].sort((a, b) => b.createdAt - a.createdAt)
    }
  }

  // -------------------------------------------------------------------------
  // 任务 CRUD
  // -------------------------------------------------------------------------

  listTasks(): WeBotTask[] {
    this.load()
    return this.state.tasks.map((task) => ({ ...task, references: task.references.map((r) => ({ ...r })) }))
  }

  createTask(input: Partial<WeBotTask> & { title: string; schedule: WeBotSchedule }): WeBotTask {
    this.load()
    const now = this.nowFn()
    const task: WeBotTask = {
      id: `task-${randomUUID()}`,
      title: String(input.title).trim().slice(0, 80) || '未命名任务',
      description: String(input.description || '').trim().slice(0, 4000),
      schedule: input.schedule,
      catchUp: input.catchUp || 'once',
      enabled: input.enabled !== false,
      references: Array.isArray(input.references) ? input.references.slice(0, 20) : [],
      allowParallel: input.allowParallel === true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: nextRunAfter(input.schedule, now),
      lastRunAt: null,
    }
    this.state.tasks.push(task)
    this.persist()
    return { ...task }
  }

  updateTask(id: string, patch: Partial<WeBotTask>): WeBotTask | null {
    this.load()
    const task = this.state.tasks.find((item) => item.id === id)
    if (!task) return null
    const scheduleChanged = patch.schedule !== undefined
    Object.assign(task, patch, { id: task.id, updatedAt: this.nowFn() })
    if (scheduleChanged) task.nextRunAt = nextRunAfter(task.schedule, this.nowFn())
    if (!task.enabled) task.nextRunAt = null
    else if (task.nextRunAt === null) task.nextRunAt = nextRunAfter(task.schedule, this.nowFn())
    this.persist()
    return { ...task }
  }

  deleteTask(id: string): boolean {
    this.load()
    const before = this.state.tasks.length
    this.state.tasks = this.state.tasks.filter((task) => task.id !== id)
    if (this.state.tasks.length === before) return false
    // 笔记刻意不随任务删除：用户可能把某次结果当作记录长期保留。
    this.persist()
    return true
  }

  /** 有启用中的任务时，退出前应提醒用户（托盘「退出」会停止调度）。 */
  hasEnabledTasks(): boolean {
    this.load()
    return this.state.tasks.some((task) => task.enabled)
  }

  // -------------------------------------------------------------------------
  // 运行历史与笔记（笔记同时是对外暴露的读面）
  // -------------------------------------------------------------------------

  listRuns(taskId?: string, limit = 100): WeBotRun[] {
    this.load()
    const runs = taskId ? this.state.runs.filter((run) => run.taskId === taskId) : this.state.runs
    return runs.slice(0, Math.max(1, Math.min(500, limit))).map((run) => ({ ...run }))
  }

  listNotes(options: { taskId?: string; unreadOnly?: boolean; limit?: number } = {}): WeBotNote[] {
    this.load()
    let notes = this.state.notes
    if (options.taskId) notes = notes.filter((note) => note.taskId === options.taskId)
    if (options.unreadOnly) notes = notes.filter((note) => !note.read)
    return notes.slice(0, Math.max(1, Math.min(500, options.limit ?? 200))).map((note) => ({ ...note }))
  }

  getNote(id: string): WeBotNote | null {
    this.load()
    const note = this.state.notes.find((item) => item.id === id)
    return note ? { ...note } : null
  }

  updateNote(id: string, patch: { read?: boolean; pinned?: boolean }): WeBotNote | null {
    this.load()
    const note = this.state.notes.find((item) => item.id === id)
    if (!note) return null
    if (patch.read !== undefined) note.read = patch.read === true
    if (patch.pinned !== undefined) note.pinned = patch.pinned === true
    this.persist()
    return { ...note }
  }

  unreadNoteCount(): number {
    this.load()
    return this.state.notes.filter((note) => !note.read).length
  }

  clearNotes(): number {
    this.load()
    const removed = this.state.notes.length
    this.state.notes = []
    this.persist()
    return removed
  }
}
