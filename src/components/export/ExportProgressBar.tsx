import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { JSX } from 'react'
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
 * 光隔离重渲染还不够：`.exp-progress-session` 用 `flex: 0 1 auto`，内容一变
 * 宽度就变，右侧进度轨道会跟着伸缩、「取消导出」按钮左右横跳。这里给会话名
 * 一个**固定基准宽度**（`flex-basis`），让它只负责溢出省略、不再参与宽度争夺；
 * 整行高度也钉死，避免总数为 0 时清空计数文本引起的高度抖动。
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

const ExportProgressBar = forwardRef<ExportProgressBarHandle, ExportProgressBarProps>(function ExportProgressBar(
  { api, busy }: ExportProgressBarProps,
  ref,
): JSX.Element | null {
  const [progress, setProgress] = useState<ProgressPayload | null>(null)
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
      setProgress(payload)
      if (payload.taskId) setTaskId(payload.taskId)
    })
  }, [api])

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
      phase === 'complete' ? '导出完成' : phase === 'preparing' ? '正在准备导出' : phase === 'cancelled' ? '导出已取消' : '正在导出会话',
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
        setProgress((p) => {
          const total = Number(p?.total || 0) || 1
          return { current: total, total, phase: 'complete', currentSession: '' }
        })
      },
      reset: () => {
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
  // 完成态认两个信号：显式的 phase，以及"计数已满"。后者是兜底 —— 某些格式的
  // 收尾路径不一定带 phase=complete，但 current 到 total 是**事实**。只看 phase
  // 会留下一条永远停在 99% 的进度条。
  const complete = phase === 'complete' || (total > 0 && current >= total)
  const pct = total > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : complete ? 100 : 0
  const indeterminate = phase === 'preparing' || (!total && !complete)
  // 完成态不显示会话名：那一步已经没有"正在导出的会话"了，留着只会显示上一条
  // 会话名或占位文案。失败/取消走 phase 分支，同样不留旧文案。
  const sessionLabel = complete ? '导出完成' : (progress?.currentSession || '准备中…')

  return (
    <div
      className={`exp-progress-bar phase-${complete ? 'complete' : phase}`}
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
      <span className="exp-progress-session" title={progress?.currentSession || ''}>
        {sessionLabel}
      </span>
      {/* 计数始终占位：total 未知时留空而不是消失，否则右侧「取消导出」会左右横跳 */}
      <span className="exp-progress-count">{total > 0 ? `${Math.min(current, total).toFixed(0)} / ${total}` : ''}</span>
      {busy && !complete && (
        <button className="ghost-btn exp-progress-cancel" type="button" disabled={!taskId} onClick={cancel}>
          取消导出
        </button>
      )}
    </div>
  )
})

export default ExportProgressBar
