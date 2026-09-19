import { useEffect, useRef, useState } from 'react'
import { Check, Clock, Loader2, XCircle } from 'lucide-react'
import { WECLONE_TERMINAL_STAGES } from '../../types/weclone'
import type { WeCloneProgressInfo, WeCloneStage } from '../../types/weclone'

/**
 * 步骤条。
 *
 * `depth` 是 v1.0.1 新增的第 2 步：生成不再是"采样一次、写五份 MD"，而是
 * **逐段提炼 + 归并**。用户看不到主进程，只能靠这几格判断"它到底在干什么"、
 * "还要多久" —— 一个跑到一半突然卡十分钟的进度条会让人以为死了。
 */
const STAGES: Array<{ key: WeCloneStage; label: string; hint: string }> = [
  { key: 'scan', label: '扫描与脱敏', hint: '逐会话读完整聊天记录，边读边分块' },
  { key: 'generate', label: '分段提炼', hint: '按时间切段，每段单独交给 AI 提炼后归并' },
  { key: 'filter', label: '隐私审查', hint: '复核生成出的档案里有没有漏掉的敏感信息' },
]

interface WeCloneProgressProps {
  running: boolean
  progress: WeCloneProgressInfo | null
  logs: string[]
  /** 本轮开始时间（毫秒）。用于显示"已经跑了多久" */
  startedAt?: number
  /**
   * store 里的终态（`done` / `failed` / `aborted`）。
   *
   * **必须有这个入参。** 主进程成功与失败都用 `stage: 'done'` 收尾，只看 stage
   * 会把一次失败写成「生成完成」—— 实测撞上过：卡在 relationships.md 之后报
   * "生成完成"，而磁盘上的 metadata 还是上一版。终态要以显式写入的 status 为准。
   */
  status?: 'idle' | 'running' | 'done' | 'failed' | 'aborted'
  onCancel: () => void
  onDismiss: () => void
}

/** 毫秒 → 「3 分 12 秒」，只显示分/秒，小时级也用分钟表示（生成不会那么久） */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds} 秒`
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
}

export default function WeCloneProgress({
  running,
  progress,
  logs,
  startedAt,
  status,
  onCancel,
  onDismiss,
}: WeCloneProgressProps) {
  const logRef = useRef<HTMLDivElement | null>(null)
  /**
   * 已用时间自己走秒。
   *
   * 主进程只在阶段推进时推事件，两个事件之间可能隔好几分钟（一次分片提炼就是
   * 一个长请求）。界面上的计时器必须自己动 —— 一个静止的"已用 12 秒"会让用户
   * 以为进程挂了，而它其实正在跑一个 40 秒的模型调用。
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  // 新日志到达时滚到底部（生成日志是追加式的）
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const stage = progress?.stage
  const foundIdx = STAGES.findIndex((s) => s.key === stage)
  /**
   * 终态判定：**store 的 status 优先**，stage 只作为兜底。
   *
   * `status` 由渲染层与主进程各自显式写入；`stage` 则被主进程两个方向共用
   * （成功/失败都发 `done`），单独用它会骗人。
   */
  const terminalFromStatus = status === 'done' || status === 'failed' || status === 'aborted'
  const terminal = terminalFromStatus || (stage !== undefined && WECLONE_TERMINAL_STAGES.includes(stage))
  const succeeded = status ? status === 'done' : stage === 'done'
  const aborted = status ? status === 'aborted' : stage === 'aborted'
  const activeIdx = succeeded || terminal ? STAGES.length : Math.max(0, foundIdx)
  const pct = succeeded ? 100 : Math.max(0, Math.min(100, Number(progress?.progress) || 0))
  // 终态文案优先于主进程的最后一条消息：那条消息通常还停在"正在生成…"，
  // 留着它会让人以为流程还在跑（用户报的"结束后仍显示准备中"就是这个味道）。
  const terminalMessage = succeeded ? '生成完成' : aborted ? '已取消' : '生成失败'
  const message = terminal ? terminalMessage : progress?.message || (running ? '准备中…' : '已结束')
  const elapsed = running && startedAt ? formatElapsed(now - startedAt) : ''
  /**
   * 失败时把**真实原因**摆出来。
   *
   * 面板原来只写"生成失败"，而原因（模型报错、上下文超限、网络断了）只出现在
   * 下面那行滚动日志里 —— 用户看到的是一个没有任何下一步的"失败"。
   */
  const failureReason = !succeeded && !aborted && terminal ? progress?.message || '' : ''

  return (
    <section className="v09-panel weclone-progress" aria-live="polite">
      <div className="weclone-progress-head">
        <h3>
          {!succeeded && terminal ? (
            <XCircle size={13} />
          ) : succeeded ? (
            <Check size={13} />
          ) : (
            <Loader2 size={13} className={running ? 'spin' : undefined} />
          )}
          克隆生成进度
        </h3>
        <span className="hint">全程在本机完成，档案与语料不会离开这台电脑</span>
        {running && elapsed && (
          <span className="weclone-progress-clock" title="已用时间（主进程在跑，切页面或最小化都不会中断）">
            <Clock size={11} />
            {elapsed}
          </span>
        )}
        {!running && (
          <button className="ghost-btn compact" type="button" onClick={onDismiss}>
            收起
          </button>
        )}
      </div>

      <div className="weclone-stages">
        {STAGES.map((s, i) => {
          const done = succeeded || i < activeIdx
          const active = i === activeIdx && !terminal
          const isFailedHere = !succeeded && terminal && i === Math.max(0, foundIdx)
          return (
            <span
              key={s.key}
              className={`weclone-stage${active ? ' active' : ''}${done ? ' done' : ''}${isFailedHere ? ' failed' : ''}`}
              title={s.hint}
            >
              {done ? (
                <Check size={11} strokeWidth={2.4} />
              ) : isFailedHere ? (
                <XCircle size={11} strokeWidth={2.4} />
              ) : active ? (
                <Loader2 size={11} className="spin" />
              ) : (
                <span className="weclone-stage-idx">{String(i + 1).padStart(2, '0')}</span>
              )}
              {s.label}
            </span>
          )
        })}
      </div>

      <div className="progress-track">
        <div
          className={`progress-fill${running && !terminal && pct === 0 ? ' indeterminate' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="weclone-progress-msg">
        <strong title={message}>{message}</strong>
        <span>{String(pct).padStart(3, '0')}%</span>
      </div>

      {failureReason && (
        <p className="weclone-progress-error">
          <XCircle size={12} />
          <span>{failureReason}</span>
        </p>
      )}

      {logs.length > 0 && (
        <div className="weclone-log" ref={logRef}>
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {running && (
        <div className="weclone-progress-foot">
          <button className="danger-btn" type="button" onClick={onCancel}>
            <XCircle size={13} />
            取消生成
          </button>
          <span className="hint">
            这一段是逐段提炼，每一段都是一次完整的模型调用，所以整体可能持续十几分钟；
            中间不推进是正常的，可以随时取消。
          </span>
        </div>
      )}
    </section>
  )
}
