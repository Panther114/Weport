/**
 * 长任务的进度存储（v1.0.1）。
 *
 * ## 它解决的问题
 *
 * 之前每个页面自己订阅进度事件、自己存 state：
 *
 * ```
 * useEffect(() => api.weclone.onProgress(setProgress), [])
 * ```
 *
 * 这段代码有一个致命前提 —— **组件不能卸载**。而 Weport 的页面是
 * `React.lazy` + 条件渲染，切一个标签页就卸载了。于是：
 *
 * - 生成克隆时切到「导出」，再切回来：`generating` 是 false、`progress` 是 null，
 *   进度面板整块消失，看起来像什么都没发生 —— 而主进程还在老老实实跑；
 * - 导出时切页：进度条回到"准备中"，取消按钮给不出 taskId；
 * - 连接微信时切页：连上之后没有任何地方知道这件事已经结束。
 *
 * 更狠的一层：v1.0.3 起托盘隐藏会**销毁窗口**（省 ~300 MB），最小化会把页面
 * unload。也就是说渲染进程可能整个重建 —— 任何只活在 React state 里的进度都会
 * 消失，而任务在主进程里还活着。所以恢复分两级：
 *
 * 1. **组件级**：模块作用域的 store 活得比页面久，切页回来直接读最新值；
 * 2. **进程级**：挂载时向主进程要一次 `status`（见 `fetchStatus`），
 *    窗口被重建后也能把当前进度、日志、开始时间原样恢复。
 *
 * ## 为什么不用 Context
 *
 * Context 仍然挂在组件树上：Provider 卸载，状态就没了。这个 store 是普通的
 * 模块级对象，`useSyncExternalStore` 订阅它 —— 和页面生命周期完全解耦。
 *
 * 设计约束（都是为了"不骗人"）：
 * - **终态必须显式落地**：`done` / `failed` / `aborted` 由调用方明确设置，
 *   绝不靠"进度到了 100"推断。AGENTS.md 里记着的那次"导出完成后仍显示准备中"
 *   就是漏了这一步。
 * - **日志有上限**（默认 300 行，环形丢弃最旧的）：生成一次可能推上千条进度，
 *   无上限的数组会一路吃内存。
 * - **进度只增不减**，除非显式重置：主进程的分阶段百分比会在阶段切换时回跳
 *   （扫描 100% → 生成 0%），卡片上的数字跟着往回走看起来像卡住了。这里用
 *   `max()` 抹平，同时保留 `stage` 让步骤条正确高亮。
 */

export type LiveTaskStatus = 'idle' | 'running' | 'done' | 'failed' | 'aborted'

export interface LiveTaskState {
  status: LiveTaskStatus
  /** 阶段标识（各功能自定义：scan / generate / …） */
  stage?: string
  /** 0-100，单调不减 */
  progress: number
  message: string
  /** 追加式日志（带本地时间前缀），最多保留 `maxLogs` 行 */
  logs: string[]
  startedAt?: number
  finishedAt?: number
  error?: string
  /** 附加结果（例如生成的克隆 id） */
  detail?: Record<string, unknown>
}

const IDLE: LiveTaskState = { status: 'idle', progress: 0, message: '', logs: [] }

/** 日志上限：一次生成可能推上千条，无上限会一路吃内存 */
const DEFAULT_MAX_LOGS = 300

export interface LiveTaskPatch {
  status?: LiveTaskStatus
  stage?: string
  progress?: number
  message?: string
  /** 追加一行日志（自动加时间前缀，重复行合并计数，见 `appendLog`） */
  log?: string
  startedAt?: number
  finishedAt?: number
  error?: string
  detail?: Record<string, unknown>
  /** 丢弃已有日志（开始新一轮任务时用） */
  reset?: boolean
  /** 把 progress 拉回 0（重置用） */
  resetProgress?: boolean
}

/**
 * 本机时间（HH:MM:SS）。日志用它而不是 ISO 串：进度面板里的日志是给人扫的，
 * 日期在同一个任务里没有信息量。
 */
function stamp(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/**
 * 追加一行日志。
 *
 * 连续的**同一条**消息会被折叠成 `消息 ×N`：生成扫描阶段每条进度都是
 * "扫描会话 N/M（K 条消息）"，但重试/回落时会推同样的消息；折叠掉能让
 * "哪一步真的重复了"一眼可见，也省下几百行滚动。
 */
export function appendLog(logs: string[], message: string, maxLogs = DEFAULT_MAX_LOGS): string[] {
  const line = `${stamp()} ${message}`
  const last = logs[logs.length - 1]
  if (last) {
    const folded = /^(.*) ×(\d+)$/.exec(last)
    const base = folded ? folded[1] : last
    // 折叠时不比较时间戳部分之外的整行 —— 同一条消息在不同秒到达也算重复
    const baseBody = base.slice(9)
    if (baseBody === message) {
      const count = folded ? Number(folded[2]) + 1 : 2
      return [...logs.slice(0, -1), `${base} ×${count}`]
    }
  }
  const next = [...logs, line]
  return next.length > maxLogs ? next.slice(next.length - maxLogs) : next
}

export class LiveTask {
  private state: LiveTaskState = IDLE
  private listeners = new Set<() => void>()
  private maxLogs: number

  constructor(maxLogs = DEFAULT_MAX_LOGS) {
    this.maxLogs = maxLogs
  }

  getState = (): LiveTaskState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* 单个订阅者出错不影响其它订阅者 */
      }
    }
  }

  update(patch: LiveTaskPatch): void {
    const prev = this.state
    let logs = prev.logs
    if (patch.reset) logs = []
    if (patch.log) logs = appendLog(logs, patch.log, this.maxLogs)

    const rawProgress = patch.resetProgress ? 0 : patch.progress
    // 进度单调不回退（阶段切换时主进程的百分比会从 100 掉回 0）
    const progress =
      rawProgress === undefined
        ? patch.reset
          ? 0
          : prev.progress
        : Math.max(0, Math.min(100, Math.round(rawProgress)))

    const status = patch.status ?? prev.status
    const next: LiveTaskState = {
      status,
      stage: patch.stage ?? prev.stage,
      progress: patch.resetProgress ? progress : Math.max(prev.progress, progress),
      message: patch.message ?? prev.message,
      logs,
      startedAt: patch.startedAt ?? (status === 'running' && !prev.startedAt ? Date.now() : prev.startedAt),
      finishedAt:
        patch.finishedAt ??
        (status === 'done' || status === 'failed' || status === 'aborted' ? prev.finishedAt ?? Date.now() : undefined),
      error: patch.error ?? (status === 'running' ? undefined : prev.error),
      detail: patch.detail ?? prev.detail,
    }
    if (
      next.status === prev.status &&
      next.stage === prev.stage &&
      next.progress === prev.progress &&
      next.message === prev.message &&
      next.logs === prev.logs &&
      next.error === prev.error &&
      next.detail === prev.detail &&
      next.startedAt === prev.startedAt &&
      next.finishedAt === prev.finishedAt
    ) {
      return
    }
    this.state = next
    this.emit()
  }

  /** 一轮任务开始：清空日志与进度，状态置 running */
  start(message = ''): void {
    this.update({ status: 'running', reset: true, resetProgress: true, progress: 0, message, error: undefined, detail: undefined, finishedAt: undefined, startedAt: Date.now() })
  }

  /** 主进程汇报的当前状态（窗口重建后恢复用）—— 整体替换，不叠加 */
  hydrate(snapshot: Partial<LiveTaskState>): void {
    const prev = this.state
    // 本地更新的更"新"时不要被旧快照盖回去：快照只在一个方向上补信息 ——
    // 本地还是 idle，或者快照的终态比本地更明确。
    if (prev.status !== 'idle' && snapshot.status === 'running') return
    this.state = {
      status: snapshot.status ?? prev.status,
      stage: snapshot.stage ?? prev.stage,
      progress: Math.max(prev.progress, Math.max(0, Math.min(100, Number(snapshot.progress) || 0))),
      message: snapshot.message ?? prev.message,
      logs: snapshot.logs && snapshot.logs.length > 0 ? snapshot.logs.slice(-this.maxLogs) : prev.logs,
      startedAt: snapshot.startedAt ?? prev.startedAt,
      finishedAt: snapshot.finishedAt ?? prev.finishedAt,
      error: snapshot.error ?? prev.error,
      detail: snapshot.detail ?? prev.detail,
    }
    this.emit()
  }

  reset(): void {
    this.state = IDLE
    this.emit()
  }
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

const registry = new Map<string, LiveTask>()

/** 取（或建）某个任务名的 store。同一个 key 全应用只有一个实例。 */
export function liveTask(key: string): LiveTask {
  let task = registry.get(key)
  if (!task) {
    task = new LiveTask()
    registry.set(key, task)
  }
  return task
}

/** 测试用：把所有 store 清回 idle */
export function resetAllLiveTasks(): void {
  for (const task of registry.values()) task.reset()
}

/**
 * 任务名。集中在这里是为了"同一件事只有一个 key" —— 拼错字符串会导致
 * 订阅者和发布者各写一份互不相干的状态，而且完全不报错。
 */
export const LIVE_TASK = {
  /** WeClone 生成 */
  wecloneGenerate: 'weclone.generate',
  /** 聊天记录导出 */
  export: 'export',
  /** 连接微信（取密钥 / 建连接） */
  connect: 'chat.connect',
  /**
   * 数据备份 / 恢复。
   *
   * 没有百分比可报（主进程的备份接口只有成功/失败），所以在角标里是无进度条
   * 的"进行中"。有它比没有强：含附件的备份可能跑十几分钟，而它的按钮在
   * 「设置 → 数据备份」里，用户切走之后原来是什么都看不到的。
   */
  backup: 'backup',
} as const
