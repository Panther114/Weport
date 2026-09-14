import { useEffect, useRef } from 'react'
import { Check, Loader2, XCircle } from 'lucide-react'
import { WECLONE_TERMINAL_STAGES } from '../../types/weclone'
import type { WeCloneProgressInfo, WeCloneStage } from '../../types/weclone'

const STAGES: Array<{ key: WeCloneStage; label: string }> = [
  { key: 'scan', label: '扫描与脱敏' },
  { key: 'generate', label: '生成人格 MD' },
  { key: 'filter', label: '隐私二审' },
  { key: 'upload', label: '上传服务器' },
]

interface WeCloneProgressProps {
  running: boolean
  progress: WeCloneProgressInfo | null
  logs: string[]
  serverConfigured: boolean
  onCancel: () => void
  onDismiss: () => void
}

export default function WeCloneProgress({ running, progress, logs, serverConfigured, onCancel, onDismiss }: WeCloneProgressProps) {
  const logRef = useRef<HTMLDivElement | null>(null)

  // 新日志到达时滚到底部（生成日志是追加式的）
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const stage = progress?.stage
  const foundIdx = STAGES.findIndex((s) => s.key === stage)
  // 终态（完成 / 失败 / 取消）下**没有任何步骤是 active**。原来只认 'done'，
  // 于是失败时最后那个中途阶段永远在转圈：一个已经结束的流程看起来还在跑。
  const terminal = stage !== undefined && WECLONE_TERMINAL_STAGES.includes(stage)
  const activeIdx = stage === 'done' || terminal ? STAGES.length : Math.max(0, foundIdx)
  const pct = stage === 'done' ? 100 : Math.max(0, Math.min(100, Number(progress?.progress) || 0))
  // 终态文案优先于主进程的最后一条消息：那条消息通常还停在"正在生成…"，
  // 留着它会让人以为流程还在跑（用户报的"结束后仍显示准备中"就是这个味道）。
  const terminalMessage = stage === 'done' ? '生成完成' : stage === 'aborted' ? '已取消' : '生成失败'
  const message = terminal ? terminalMessage : progress?.message || (running ? '准备中…' : '已结束')

  return (
    <section className="v09-panel weclone-progress" aria-live="polite">
      <div className="weclone-progress-head">
        <h3>
          {stage === 'failed' ? (
            <XCircle size={13} />
          ) : stage === 'done' ? (
            <Check size={13} />
          ) : (
            <Loader2 size={13} className={running ? 'spin' : undefined} />
          )}
          克隆生成进度
        </h3>
        <span className="hint">
          {serverConfigured ? '完成后将上传到私有服务器' : '未配置私有服务器 · 结果仅保存在本地'}
        </span>
        {!running && (
          <button className="ghost-btn compact" type="button" onClick={onDismiss}>
            收起
          </button>
        )}
      </div>

      <div className="weclone-stages">
        {STAGES.map((s, i) => {
          const done = i < activeIdx || stage === 'done'
          const active = i === activeIdx && !terminal
          const isFailedHere = stage === 'failed' && i === Math.max(0, foundIdx)
          return (
            <span
              key={s.key}
              className={`weclone-stage${active ? ' active' : ''}${done ? ' done' : ''}${isFailedHere ? ' failed' : ''}`}
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
          <span className="hint">首次生成需扫描全部会话并逐份生成档案，可能持续几分钟；可随时取消</span>
        </div>
      )}
    </section>
  )
}
