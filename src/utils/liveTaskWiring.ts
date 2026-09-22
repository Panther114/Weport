/**
 * 长任务接线的唯一入口（v1.0.1）。
 *
 * 由 `main.tsx` 在**应用启动时**调用一次 —— 早于任何页面挂载，也早于任何标签页
 * 切换。这是这个文件存在的理由：进度订阅必须比页面活得久。
 *
 * 三条链路（克隆生成 / 导出 / 连接微信）在这里做同一件事：
 *   1. 把主进程推来的增量事件写进模块级 `LiveTask`；
 *   2. 挂载时、以及任务进行中，周期性向主进程要一次**状态快照**
 *      （`task:status`），用它补上渲染进程错过的事件。
 *
 * 第 2 条不是多余的保险：托盘隐藏会销毁窗口、最小化会 unload 页面，渲染进程
 * 可能整个重建。重建期间主进程推的所有事件都没人收 —— 只有快照能把它们补回来。
 */
import { LIVE_TASK, liveTask, type LiveTaskState } from './liveTask'

/** 终态快照的有效期：更早的终态当作"上一次的事"，不要糊在界面上 */
const TERMINAL_SNAPSHOT_TTL_MS = 3 * 60_000

/** 运行中时的轮询间隔。一次 IPC 只回一个小对象，1.2s 完全无感。 */
const POLL_INTERVAL_MS = 1200

/**
 * 哪些任务值得为它开轮询。
 *
 * 只有**主进程会写状态快照**的任务才轮询 —— 轮询的目的就是"用快照纠正错过
 * 的事件"。`backup` 不在其中：主进程的备份接口只有成功/失败，没有状态通道，
 * 轮询它只会每 1.2 秒问一次永远不会变的答案，而且任务卡住时会一直问下去。
 *
 * 代价说清楚：备份期间窗口被销毁重建的话，左下角那条会消失（状态只在渲染进程
 * 里）。这是已知限制，换来的是不给自己留一个无限轮询。
 */
const POLLED_TASKS: readonly string[] = [LIVE_TASK.wecloneGenerate, LIVE_TASK.export, LIVE_TASK.connect]

let installed = false
let pollTimer: ReturnType<typeof setInterval> | null = null

interface RawSnapshot {
  status?: string
  stage?: string
  progress?: number
  message?: string
  logs?: string[]
  startedAt?: number
  finishedAt?: number
  error?: string
  detail?: Record<string, unknown>
}

function toState(snapshot: RawSnapshot): Partial<LiveTaskState> {
  const status = snapshot.status
  return {
    status: status === 'running' || status === 'done' || status === 'failed' || status === 'aborted' ? status : 'idle',
    stage: snapshot.stage,
    progress: Number(snapshot.progress) || 0,
    message: String(snapshot.message || ''),
    logs: Array.isArray(snapshot.logs) ? snapshot.logs.map(String) : [],
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    error: snapshot.error,
    detail: snapshot.detail,
  }
}

/**
 * 把主进程快照灌进 store。
 *
 * 一条规矩：**过期的终态不灌**。窗口重建后如果主进程里躺着一个三天前的
 * "生成完成"，界面上就会冒出一张属于上个世纪的完成卡片。运行中的快照永远灌
 * （那正是要找回来的东西）。
 */
export function hydrateFromSnapshots(all: Record<string, RawSnapshot> | null | undefined, now = Date.now()): void {
  if (!all || typeof all !== 'object') return
  for (const key of Object.values(LIVE_TASK)) {
    const snapshot = all[key]
    if (!snapshot) continue
    const state = toState(snapshot)
    const terminal = state.status === 'done' || state.status === 'failed' || state.status === 'aborted'
    if (terminal) {
      const finishedAt = Number(state.finishedAt) || 0
      if (!finishedAt || now - finishedAt > TERMINAL_SNAPSHOT_TTL_MS) continue
    }
    if (state.status === 'idle') continue
    liveTask(key).hydrate(state)
  }
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function anyRunning(): boolean {
  return POLLED_TASKS.some((key) => liveTask(key).getState().status === 'running')
}

async function refreshFromMain(): Promise<void> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!api?.task?.status) return
  try {
    hydrateFromSnapshots(await api.task.status())
  } catch {
    /* 主进程不可用（退出中）时静默：这不是需要打扰用户的错误 */
  }
}

/**
 * 只在真的有任务在跑的时候轮询，跑完自己停 —— 空闲时零开销。
 * 每次刷新后再判断一次，所以不需要别的地方去启停它。
 */
function ensurePolling(): void {
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    if (!anyRunning()) {
      stopPolling()
      return
    }
    void refreshFromMain()
  }, POLL_INTERVAL_MS)
}

export function installLiveTaskWiring(): void {
  if (installed) return
  installed = true
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!api) return

  // ---- 1. WeClone 生成 -----------------------------------------------------
  api.weclone?.onProgress?.((payload: any) => {
    const task = liveTask(LIVE_TASK.wecloneGenerate)
    const stage = String(payload?.stage || 'scan')
    const message = String(payload?.message || '')
    task.update({
      status: 'running',
      stage,
      progress: Number(payload?.progress) || 0,
      message,
      log: message,
      detail: payload?.detail,
    })
    // 主进程的进度事件里 'done' 既表示成功也表示失败（失败也是用 done 阶段收尾
    // 并带一句"生成失败：…"），所以**不在这里推断终态** —— 终态只认 task:status。
    ensurePolling()
    void refreshFromMain()
  })

  // ---- 2. 导出 -------------------------------------------------------------
  api.export?.onProgress?.((payload: any) => {
    const task = liveTask(LIVE_TASK.export)
    const total = Number(payload?.total) || 0
    const current = Number(payload?.current) || 0
    const complete = String(payload?.phase || '') === 'complete' || (total > 0 && current >= total)
    task.update({
      status: complete ? 'done' : 'running',
      stage: String(payload?.phase || ''),
      progress: total > 0 ? (current / total) * 100 : 0,
      message: complete ? '导出完成' : String(payload?.phaseLabel || payload?.currentSession || '导出中…'),
      detail: {
        taskId: payload?.taskId ? String(payload.taskId) : undefined,
        current,
        total,
        phase: String(payload?.phase || ''),
        phaseLabel: String(payload?.phaseLabel || ''),
        currentSession: String(payload?.currentSession || ''),
      },
    })
    /**
     * **取消 / 失败的导出在这里推不出终态**。
     *
     * 导出的进度负载只有 `preparing / exporting / … / complete` 六种阶段 ——
     * 取消和失败根本不发事件（用户点取消之后服务只是停下来）。所以终态只能从
     * 主进程快照拿（`taskStatusService.end(..., 'aborted' | 'failed')`）。
     *
     * 这不只是"状态不精确"：本地状态会永远停在 running，左下角的任务条就会
     * 一直挂着一条不存在的导出。轮询在 1.2 秒内会用快照把它纠正过来。
     */
    ensurePolling()
    if (complete) void refreshFromMain()
  })

  // ---- 3. 启动时先补一次，然后按需轮询 ------------------------------------
  //
  // 补完还要再问一次"有没有在跑"：窗口被销毁重建时任务可能已经跑了一半，
  // 而重建后的渲染进程不会再收到**之前**的事件 —— 只有轮询能继续喂它。
  void refreshFromMain().then(() => ensurePolling())
}
