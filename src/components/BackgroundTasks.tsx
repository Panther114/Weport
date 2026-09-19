import { useEffect, useState } from 'react'
import { ArrowRight, Clock, DatabaseBackup, Download, Fingerprint, Loader2, PlugZap, X } from 'lucide-react'
import { useLiveTask } from '../hooks/useLiveTask'
import { LIVE_TASK, type LiveTaskState } from '../utils/liveTask'

/**
 * 全局长任务指示器（v1.0.1）。
 *
 * ## 为什么需要它
 *
 * 用户的原话是「如果用户在过程中切到别的面板，会产生很奇怪的问题」，而且他
 * 点名了三个场景：连接微信、导出记录、生成克隆。三条链路的根因是同一个 ——
 * **进度只活在它自己那个页面的 state 里**，切页就卸载，于是：
 *
 * - 生成克隆时切走再切回来，进度面板整块消失（看起来什么都没发生）；
 * - 导出时切走，进度条回到"准备中 0/0"，连取消按钮都没了；
 * - 连接微信时切走，连完之后没有任何地方告诉你连上了。
 *
 * 修法分两层，缺一不可：
 *   1. 数据层：进度搬进模块级 store + 主进程快照（见 `utils/liveTaskWiring.ts`），
 *      组件卸载不再等于状态消失；
 *   2. **可见层：这个组件**。数据还在但用户看不见，等于没修 —— 它挂在 App 上、
 *      在任何标签页都显示，所以"我点了开始"和"它还在跑"之间永远不会断线。
 *
 * ## 设计取舍
 *
 * - **只在真有任务在跑时出现**。空闲时它一个像素都不占 —— 一个常驻的"没有任务"
 *   面板比没有面板更烦人。
 * - **显示已用时间并且自己走秒**。主进程两次进度事件之间可能隔几分钟（一次分片
 *   提炼就是一个长请求），静止的数字会被读成"卡死了"。
 * - **可点跳转**。看到"导出 62%"想去看一眼，点一下就到那个页面，不用自己回忆
 *   它在哪个标签下。
 * - **不抢焦点、不遮挡**：贴左下角、`pointer-events` 只在卡片上生效，
 *   不然会挡住下面的内容。
 */
interface TaskRow {
  key: string
  label: string
  icon: typeof Download
  /** 点一下跳过去的标签页 id（与 App 的 Tab 类型一致） */
  tab: 'connect' | 'export' | 'weclone' | 'settings'
  cancellable: boolean
  /**
   * 这个任务没有百分比可报（备份接口只有成功/失败）。
   * 有进度条却一直停在 0% 比没有进度条更像"卡死了"。
   */
  indeterminate?: boolean
}

const ROWS: TaskRow[] = [
  { key: LIVE_TASK.connect, label: '连接微信', icon: PlugZap, tab: 'connect', cancellable: false },
  { key: LIVE_TASK.export, label: '导出聊天记录', icon: Download, tab: 'export', cancellable: true },
  { key: LIVE_TASK.wecloneGenerate, label: '生成 WeClone', icon: Fingerprint, tab: 'weclone', cancellable: true },
  { key: LIVE_TASK.backup, label: '数据备份', icon: DatabaseBackup, tab: 'settings', cancellable: false, indeterminate: true },
]

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds}s`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

interface Props {
  /** 跳到某个标签页 */
  onOpen: (tab: 'connect' | 'export' | 'weclone' | 'settings') => void
  /** 取消一个可取消的任务 */
  onCancel: (key: string) => void
}

export default function BackgroundTasks({ onOpen, onCancel }: Props) {
  const connect = useLiveTask(LIVE_TASK.connect)
  const exportTask = useLiveTask(LIVE_TASK.export)
  const clone = useLiveTask(LIVE_TASK.wecloneGenerate)
  const backup = useLiveTask(LIVE_TASK.backup)
  const states: Record<string, LiveTaskState> = {
    [LIVE_TASK.connect]: connect,
    [LIVE_TASK.export]: exportTask,
    [LIVE_TASK.wecloneGenerate]: clone,
    [LIVE_TASK.backup]: backup,
  }

  const running = ROWS.filter((row) => states[row.key]?.status === 'running')
  /**
   * 自己走秒。
   *
   * 只在真的有任务在跑时开定时器 —— 空闲时不该有一个每秒唤醒一次渲染进程的
   * 东西常驻。依赖数组是"有几个在跑"，所以任务增减时定时器会重建。
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (running.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running.length])

  if (running.length === 0) return null

  return (
    <div className="bg-tasks" role="status" aria-live="polite">
      {running.map((row) => {
        const state = states[row.key]
        const Icon = row.icon
        const pct = Math.max(0, Math.min(100, Number(state.progress) || 0))
        const elapsed = state.startedAt ? formatElapsed(now - state.startedAt) : ''
        return (
          <div className="bg-task" key={row.key}>
            <span className="bg-task-icon" aria-hidden>
              <Icon size={13} />
            </span>
            <div className="bg-task-main">
              <div className="bg-task-head">
                <strong>{row.label}</strong>
                <span className="bg-task-elapsed">
                  <Clock size={10} />
                  {elapsed}
                </span>
              </div>
              <div className="bg-task-msg" title={state.message}>
                <Loader2 size={10} className="spin" />
                <span>{state.message || '进行中…'}</span>
                {!row.indeterminate && pct > 0 && <b>{Math.round(pct)}%</b>}
              </div>
              <div className="bg-task-track">
                <div
                  className={`bg-task-fill${row.indeterminate ? ' indeterminate' : ''}`}
                  style={row.indeterminate ? undefined : { width: `${pct}%` }}
                />
              </div>
            </div>
            <button
              className="bg-task-open"
              type="button"
              title={`前往「${row.label}」查看详情`}
              onClick={() => onOpen(row.tab)}
            >
              <ArrowRight size={13} />
            </button>
            {row.cancellable && (
              <button className="bg-task-cancel" type="button" title="取消" onClick={() => onCancel(row.key)}>
                <X size={12} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
