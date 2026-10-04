import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useLiveTask } from '../../hooks/useLiveTask'
import { LIVE_TASK } from '../../utils/liveTask'
import { isExportCompletionAuthoritative, normalizeExportProgressPhase } from '../../utils/exportProgress'
/**
 * 导出进度条（吸顶块里的第二行）。
 *
 * ## 为什么单独成一个组件
 *
 * 进度事件原本由 `App` 自己订阅、写进 `App` 的 state。导出期间主进程按
 * `MIN_PROGRESS_EMIT_INTERVAL_MS`(400ms) 的节奏持续推帧，而每一条都让 **App
 * 整棵树**重新渲染一遍 —— App 是 4000 多行、包含全部页面的组件，于是导出时
 * 每几百毫秒就有一次全量 reconciliation + layout；界面表现为"一堆东西在互相
 * 推挤、整体发抖"。用户报的「导出时一直 glitch」就是这个。
 *
 * 现在进度事件**只**驱动这一个组件：App 不再因为进度变化而重渲染，页面上其它
 * 元素在整场导出里一个像素都不会动。
 *
 * ## 尺寸必须恒定
 *
 * `.exp-progress-session` 用固定 flex-basis + 单行省略，文字更新不会改变轨道宽度。
 * 外层行高固定为 34px，取消按钮固定为 22px；progress event 更新文本时不会改变
 * 吸顶块或下面页面的几何尺寸。
 *
 * 依赖注入（api / busy / taskId）而不是直接在组件里读全局：这个组件在测试里
 * 可以脱离 Electron 环境单独渲染。
 */
export interface ExportProgressApi {
  onProgress: (callback: (payload: any) => void) => () => void
  cancelTask: (taskId: string) => Promise<{ success: boolean }>
}

export interface ExportProgressBarProps {
  api: ExportProgressApi
  /** 导出进行中（App 的 busy）。完成态由进度负载里的 phase 决定。 */
  busy: boolean
}

/** 外层在导出结束时调用 `complete()`：进度条自己收尾成 100%。 */
export interface ExportProgressBarHandle {
  complete: () => void
  /** 开始新一次导出：清掉上一次的完成态，回到"准备中"。 */
  reset: () => void
}

/** 一次导出期间会用到的字段，其余负载字段这里不关心。 */
type ProgressPayload = {
  current?: number
  total?: number
  phase?: string
  phaseLabel?: string
  currentSession?: string
  taskId?: string
}

function normalizeProgressPayload(payload: ProgressPayload): ProgressPayload {
  const total = Math.max(0, Number(payload.total) || 0)
  const current = Math.max(0, Number(payload.current) || 0)
  return {
    ...payload,
    current,
    total,
    phase: normalizeExportProgressPhase(payload.phase, current, total),
  }
}

const ExportProgressBar = forwardRef<ExportProgressBarHandle, ExportProgressBarProps>(function ExportProgressBar(
  { api, busy }: ExportProgressBarProps,
  ref,
): JSX.Element | null {
  const [progress, setProgress] = useState<ProgressPayload | null>(null)
  const [confirmedComplete, setConfirmedComplete] = useState(false)
  /**
   * 任务 id **在这里**从进度负载里取。
   *
   * 原来 App 自己订阅一条 `onProgress` 只为拿 taskId —— 那等于每帧进度都让 App
   * 重渲染一次，隔离就白做了。取消所需的 id 本来就在负载里，进度条自己存即可。
   */
  const [taskId, setTaskId] = useState<string | null>(null)

  useEffect(() => {
    return api.onProgress((payload: ProgressPayload) => {
      if (!payload || typeof payload !== 'object') {
        setProgress(null)
        return
      }
      setConfirmedComplete(false)
      setProgress(normalizeProgressPayload(payload))
      if (payload.taskId) setTaskId(payload.taskId)
    })
  }, [api])

  /**
   * 切页面回来时的**恢复**（v1.0.1）。
   *
   * 进度事件由主进程按 ~400ms 一条推，而这个组件随导出页一起被卸载 —— 切到
   * 「连接微信」再切回来，`progress` 是 null，进度条回到"准备中 0/0"，用户会
   * 以为导出没在跑（它其实一直在跑）。
   *
   * 恢复源是模块级的 `LiveTask`（`utils/liveTaskWiring.ts` 在应用启动时就接好了
   * IPC，比任何页面都活得久），里面有主进程快照里的 current / total / taskId。
   * 只在本地还没有任何进度时恢复一次，之后交给实时事件 —— 否则每次快照更新都
   * 会把界面拽回几百毫秒前的状态。
   */
  const live = useLiveTask(LIVE_TASK.export)
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current || progress !== null) return
    const detail = live.detail
    if (!detail) return
    const total = Number(detail.total) || 0
    const taskIdFromSnapshot = detail.taskId ? String(detail.taskId) : undefined
    // 快照里既没有总数也没有 taskId，说明这一轮根本没开始过 —— 不要凭空造一条进度
    if (!total && !taskIdFromSnapshot) return
    restoredRef.current = true
    setConfirmedComplete(false)
    setProgress(normalizeProgressPayload({
      current: Number(detail.current) || 0,
      total,
      phase: String(detail.phase || ''),
      phaseLabel: String(detail.phaseLabel || ''),
      currentSession: String(detail.currentSession || ''),
      taskId: taskIdFromSnapshot,
    }))
    if (taskIdFromSnapshot) setTaskId(taskIdFromSnapshot)
  }, [live.detail, progress])

  // 进度条本身**不能**是 aria-live：导出期间每秒 2-3 条进度事件，读屏会把
  // 「准备中…」「收集消息 1200…」逐条念出来，把用户彻底淹没。改成只播报
  // **阶段变化**（准备 → 导出 → 完成），这才是读屏真正需要听到的信息。
  const [announcement, setAnnouncement] = useState('')
  const lastAnnouncedRef = useRef('')
  useEffect(() => {
    if (!progress) return
    const phase = progress.phase || 'running'
    if (lastAnnouncedRef.current === phase) return
    lastAnnouncedRef.current = phase
    setAnnouncement(
      phase === 'complete' ? '导出完成' : phase === 'preparing' ? '正在准备导出' : phase === 'verifying' ? '正在校验导出结果' : phase === 'cancelled' ? '导出已取消' : '正在导出会话',
    )
  }, [progress])

  useImperativeHandle(
    ref,
    () => ({
      /**
       * 导出收尾：进度条自己定格成完成态。
       *
       * 这里**必须**把会话名一起换掉。原来只改 phase，于是完成后面板上留着
       * `准备中…  189 / 189` —— 数字满了、文字还停在准备阶段。会话名是从
       * 主进程的进度负载里来的，最后一条负载通常没有 currentSession（收尾事件
       * 不带会话），拿它做兜底就会一直显示占位文案。
       */
      complete: () => {
        // App calls this only after the export IPC result confirms success.
        setConfirmedComplete(true)
        setProgress((p) => {
          const total = Number(p?.total || 0) || 1
          return { current: total, total, phase: 'complete', currentSession: '' }
        })
      },
      reset: () => {
        setConfirmedComplete(false)
        setProgress({ current: 0, total: 0, phase: 'preparing' })
        setTaskId(null)
      },
    }),
    [],
  )

  const cancel = useCallback(() => {
    if (!taskId) return
    void api.cancelTask(taskId)
  }, [api, taskId])

  /**
   * 没有进度时**仍然占位**，只是把内容藏起来。
   *
   * 这是"偶尔抖一下"的真正来源：进度条原来在无进度时 `return null`，于是导出
   * 一开始，吸顶块从"只有页头"变成"页头 + 进度行"，高度多了 30px —— 它下面的
   * 整个 `.export-layout` 被整体推下去一次。浏览器把这个判定为布局偏移，实测
   * CLS 0.0158（`PerformanceObserver` 抓到的唯一一条真实偏移）。
   *
   * 保留一个固定高度的空行就没有这次位移。空行本身用 visibility 隐藏（不是
   * display: none —— 那会让高度归零，等于没占位）。
   */
  const idle = progress === null
  const total = Number(progress?.total || 0)
  const current = Number(progress?.current || 0)
  const phase = progress?.phase || 'running'
  // Session-complete events and 100% counters are not task completion: manifest
  // writing and integrity verification still follow. Only the IPC result or an
  // authoritative task snapshot may finish the bar.
  const complete = isExportCompletionAuthoritative({
    busy,
    taskStatus: live.status,
    confirmedByResult: confirmedComplete,
  })
  const failed = live.status === 'failed'
  const aborted = live.status === 'aborted'
  const terminal = complete || failed || aborted
  const pct = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : complete ? 100 : 0
  const indeterminate = phase === 'preparing' || (!total && !complete)
  // 完成态不显示会话名：那一步已经没有"正在导出的会话"了，留着只会显示上一条
  // 会话名或占位文案。失败/取消走 phase 分支，同样不留旧文案。
  const sessionLabel = complete
    ? '导出完成'
    : failed
      ? '导出失败'
      : aborted
        ? '导出已取消'
        : progress?.currentSession || (phase === 'verifying' ? '正在校验导出结果…' : '准备中…')
  /**
   * "还在跑"的口径 = App 的 busy **或** 主进程快照里的 running。
   *
   * 后者是 v1.0.1 加的：窗口被销毁重建之后 App 的 `busy` 会回到 false，而导出
   * 其实还在主进程里跑 —— 只看 `busy` 的话，界面上连「取消导出」都不给，
   * 用户只能干等。
   */
  const active = busy || live.status === 'running'

  return (
    <div
      className={`exp-progress-bar phase-${complete ? 'complete' : failed ? 'failed' : aborted ? 'cancelled' : phase}`}
      // idle：占位但不可见。`visibility` 而不是 `display` —— 后者高度归零，
      // 吸顶块照样会变高，等于没占位。
      data-idle={idle ? 'true' : undefined}
      aria-hidden={idle || undefined}
    >
      {/* 只播报阶段变化的读屏专用区域（见上面的注释） */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <div className="progress-track">
        <div className={`progress-fill${indeterminate ? ' indeterminate' : ''}`} style={total ? { width: `${pct}%` } : undefined} />
      </div>
      {/* 会话名**不带 title**。
          它每 400ms 换一次，而 `title` 一变，Chromium 的原生提示框就会重新弹出
          （鼠标恰好停在进度行上时尤其明显）—— 表现是"偶尔抖一下"的另一个来源。
          名字本身在主进程侧已经封顶（见 appMain 的 boundProgressSessionLabel），
          要看全名请到「选择会话」列表里看，那里是完整且稳定的。 */}
      <span className="exp-progress-session">
        {sessionLabel}
      </span>
      {/* 计数始终占位：total 未知时留空而不是消失，否则右侧「取消导出」会左右横跳 */}
      <span className="exp-progress-count">{total > 0 ? `${Math.min(current, total).toFixed(0)} / ${total}` : ''}</span>
      <button
        className="ghost-btn exp-progress-cancel"
        type="button"
        data-hidden={active && !terminal ? undefined : 'true'}
        aria-hidden={active && !terminal ? undefined : true}
        tabIndex={active && !terminal ? undefined : -1}
        disabled={!active || terminal || !taskId}
        onClick={cancel}
      >
        取消导出
      </button>
    </div>
  )
})

export default ExportProgressBar
