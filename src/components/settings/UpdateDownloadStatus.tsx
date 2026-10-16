import { useLiveTask } from '../../hooks/useLiveTask'
import { LIVE_TASK } from '../../utils/liveTask'

export function UpdateDownloadLabel({ idleLabel, checking = false }: { idleLabel: string; checking?: boolean }) {
  const task = useLiveTask(LIVE_TASK.updateDownload)
  if (checking) return <>检查中…</>
  if (task.status !== 'running') return <>{idleLabel}</>
  return <>{task.stage === 'installing' ? '正在安装并重启…' : `下载中 ${Math.round(task.progress)}%`}</>
}

export function UpdateDownloadProgress() {
  const task = useLiveTask(LIVE_TASK.updateDownload)
  if (task.status === 'failed') return <p className="hint" style={{ color: 'var(--danger)' }}>{task.error || task.message}</p>
  if (task.status !== 'running' || task.stage === 'installing') return null
  const percent = Math.max(0, Math.min(100, task.progress))
  return <div className="update-progress">
    <div className="progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
    <span>{Math.round(percent)}%</span>
  </div>
}
