/**
 * 主进程侧的长任务状态快照（v1.0.1）。
 *
 * ## 为什么状态要放在主进程
 *
 * v1.0.3 起，托盘隐藏会**销毁**主窗口（省 ~300 MB），最小化会把页面 unload。
 * 长任务本身跑在主进程里（克隆生成、导出、连库），渲染进程只是它的显示器 ——
 * 显示器的生命周期不该决定"还能不能看到进度"。
 *
 * 之前没有这一层，于是窗口一重建，进度面板就回到初始值：任务还在跑，界面上
 * 什么都看不见。用户报的「切换到别的面板就看不到克隆进度了」是同一个缺陷的
 * 轻量版（切标签只是卸载组件，销毁窗口是卸载整个文档）。
 *
 * ## 约定
 *
 * - **终态必须显式写入**（`end()`）。不靠"进度到 100 了"推断 —— 一次生成会
 *   分三个阶段，每个阶段的百分比都可能到 100，而任务并没有结束。
 * - `logs` 在这里也保留一份（环形上限 200 行），窗口重建后日志能一起回来。
 * - 快照里**不放**任何个人数据：只有阶段、百分比、文案、时间。日志文案来自
 *   各服务自己推的进度消息（"扫描会话 12/189"），本来就会显示在界面上。
 */

export type TaskStatusValue = 'idle' | 'running' | 'done' | 'failed' | 'aborted'

export interface TaskSnapshot {
  status: TaskStatusValue
  stage?: string
  /** 0-100 */
  progress: number
  message: string
  logs: string[]
  startedAt?: number
  finishedAt?: number
  error?: string
  detail?: Record<string, unknown>
}

/** 日志环形上限：生成一次会推上千条进度，主进程也不该无限长 */
const MAX_LOGS = 200

function idle(): TaskSnapshot {
  return { status: 'idle', progress: 0, message: '', logs: [] }
}

export class TaskStatusService {
  private tasks = new Map<string, TaskSnapshot>()

  private snapshot(key: string): TaskSnapshot {
    let task = this.tasks.get(key)
    if (!task) {
      task = idle()
      this.tasks.set(key, task)
    }
    return task
  }

  get(key: string): TaskSnapshot {
    return { ...this.snapshot(key) }
  }

  /** 全部任务的快照 —— 渲染进程重建时一次拿回所有进度 */
  all(): Record<string, TaskSnapshot> {
    const out: Record<string, TaskSnapshot> = {}
    for (const [key, value] of this.tasks) out[key] = { ...value, logs: [...value.logs] }
    return out
  }

  /** 一轮任务开始：日志与进度清零，状态置 running */
  begin(key: string, message = '', stage?: string): void {
    this.tasks.set(key, {
      status: 'running',
      stage,
      progress: 0,
      message,
      logs: message ? [message] : [],
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
      detail: undefined,
    })
  }

  progress(
    key: string,
    patch: { stage?: string; progress?: number; message?: string; detail?: Record<string, unknown>; log?: boolean }
  ): void {
    const task = this.snapshot(key)
    if (patch.stage !== undefined) task.stage = patch.stage
    if (patch.progress !== undefined) {
      // 阶段切换时百分比会回跳（扫描 100% → 生成 0%），存**单调不减**的值，
      // 否则界面上的数字会往回走，看起来像卡住又重来。
      task.progress = Math.max(task.progress, Math.max(0, Math.min(100, Math.round(patch.progress))))
    }
    if (patch.message !== undefined) {
      task.message = patch.message
      if (patch.log !== false && patch.message) {
        const last = task.logs[task.logs.length - 1]
        if (last !== patch.message) {
          task.logs = [...task.logs, patch.message]
          if (task.logs.length > MAX_LOGS) task.logs = task.logs.slice(task.logs.length - MAX_LOGS)
        }
      }
    }
    if (patch.detail) task.detail = { ...task.detail, ...patch.detail }
    if (task.status === 'idle') task.status = 'running'
  }

  /** 终态。显式写入，绝不从进度推断。 */
  end(
    key: string,
    status: Exclude<TaskStatusValue, 'idle' | 'running'>,
    options?: { error?: string; message?: string; detail?: Record<string, unknown> }
  ): void {
    const task = this.snapshot(key)
    task.status = status
    if (options?.message !== undefined) task.message = options.message
    if (options?.error !== undefined) task.error = options.error
    if (options?.detail) task.detail = { ...task.detail, ...options.detail }
    if (status === 'done') task.progress = 100
    task.finishedAt = Date.now()
    if (options?.message) {
      task.logs = [...task.logs, options.message]
      if (task.logs.length > MAX_LOGS) task.logs = task.logs.slice(task.logs.length - MAX_LOGS)
    }
  }

  reset(key: string): void {
    this.tasks.set(key, idle())
  }
}

/** 任务 key —— 渲染层用同一组常量（`src/utils/liveTask.ts` 的 LIVE_TASK） */
export const TASK_KEY = {
  wecloneGenerate: 'weclone.generate',
  export: 'export',
  connect: 'chat.connect',
} as const

export const taskStatusService = new TaskStatusService()
