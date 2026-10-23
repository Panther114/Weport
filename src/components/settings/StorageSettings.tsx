import '../v13Controls.css'
import { useCallback, useEffect, useState } from 'react'
import { useLiveTask } from '../../hooks/useLiveTask'
import { ChevronDown, HardDrive } from 'lucide-react'
import './settingsManagement.css'
type Status = Awaited<ReturnType<Window['electronAPI']['storage']['status']>>
const LABELS: Record<string, string> = { cache: '应用缓存', 'search-index': '搜索索引', 'archive-library': '归档库索引与任务', 'ai-data': 'AI 会话与证据', 'ai-workspace': 'AI 记忆与笔记', 'model-cache': '模型信息缓存', media: '媒体与 OCR 缓存', exports: '导出与归档文件' }
export default function StorageSettings({ open = false, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const task = useLiveTask('storage.relocation')
  const [status, setStatus] = useState<Status | null>(null)
  const [usage, setUsage] = useState<Record<string, { files: number; bytes: number }>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reload = useCallback(() => window.electronAPI.storage.status().then(setStatus), [])
  useEffect(() => { void reload().catch(error => setError(String(error))) }, [reload, task.status])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action(); await reload() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="panel storage-settings v13-controls settings-management">
    <details className="settings-disclosure settings-disclosure-main" open={open} onToggle={event => onOpenChange?.(event.currentTarget.open)}>
    <summary><HardDrive size={15} /><span><strong>存储位置与迁移</strong><small>查看目录与占用，按需迁移或清理缓存</small></span><ChevronDown size={15} className="settings-disclosure-chevron" /></summary>
    <div className="settings-disclosure-body">
    <p className="hint">聊天原数据库不会移动。迁移先复制并逐文件校验，重启后再次校验才切换位置，原目录和失败副本保留。</p>
    {error ? <p role="alert">{error}</p> : null}
    {task.status === 'running' ? <p role="status">{task.message}</p> : null}
    {status?.entries.map(entry => <details className="settings-storage-entry settings-disclosure" key={entry.kind}>
      <summary><span><strong>{LABELS[entry.kind]}</strong><small>{entry.path || '尚未选择导出目录'}</small></span><ChevronDown size={14} className="settings-disclosure-chevron" /></summary>
      <div className="settings-disclosure-body">
      <p className="hint">{entry.retention === 'user-managed' ? '含用户保存内容，不会自动删除。' : '派生数据，可重建；迁移保留完整副本。'}{usage[entry.kind] ? ` ${usage[entry.kind].files} 个文件 · ${(usage[entry.kind].bytes / 1048576).toFixed(1)} MiB` : ''}</p>
      <div className="settings-action-row">
        <button type="button" className="secondary-btn" disabled={busy || !entry.path} onClick={() => void run(async () => { const error = await window.electronAPI.storage.open(entry.kind); if (error) throw Error(error) })}>打开目录</button>
        <button type="button" className="ghost-btn" disabled={busy || !entry.path} onClick={() => void run(async () => { const value = await window.electronAPI.storage.usage(entry.kind); setUsage(previous => ({ ...previous, [entry.kind]: value })) })}>计算占用</button>
      </div>
      <details className="settings-disclosure settings-storage-maintenance">
        <summary>迁移与清理</summary>
        <p className="hint">选择新目录后准备迁移，重启后生效。原目录中的文件保留。</p>
        <div className="settings-action-row">
          <button type="button" className="secondary-btn" disabled={busy || !entry.path || task.status === 'running' || status.relocation?.state === 'ready' || status.cleanup?.state === 'ready'} onClick={() => void run(async () => { await window.electronAPI.storage.prepare(entry.kind) })}>选择目录并准备迁移</button>
          {entry.retention === 'derived-rebuildable' ? <button type="button" className="ghost-btn danger" disabled={busy || task.status === 'running' || status.relocation?.state === 'ready' || status.cleanup?.state === 'ready'} onClick={() => void run(async () => { await window.electronAPI.storage.clearDerived(entry.kind as 'search-index' | 'model-cache') })}>准备清理缓存</button> : null}
        </div>
      </details>
      </div>
    </details>)}
    {status?.relocation ? <div className="settings-task-state" role="status"><p>迁移状态：{status.relocation.state} {status.relocation.error || ''}</p><div className="settings-action-row">
      {status.relocation.state === 'ready' ? <button type="button" className="primary-btn" disabled={busy} onClick={() => void run(() => window.electronAPI.storage.restart())}>重启并验证切换</button> : null}
      {status.relocation.state !== 'applied' ? <button type="button" className="ghost-btn" disabled={busy} onClick={() => void run(() => window.electronAPI.storage.discard())}>放弃此迁移（保留文件）</button> : null}
      {['applied', 'ready', 'failed'].includes(status.relocation.state) ? <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(async () => { await window.electronAPI.storage.cleanup(status.relocation!.state === 'applied' ? 'original' : 'prepared'); setUsage({}) })}>{status.relocation.state === 'applied' ? '校验并清理原目录重复文件' : '校验并清理未启用副本'}</button> : null}
    </div>
    </div> : null}
    {status?.cleanup ? <div className="settings-task-state" role="status"><p>派生缓存清理：{status.cleanup.state} {status.cleanup.error || ''}</p>{status.cleanup.state === 'ready' ? <div className="settings-action-row"><button type="button" className="primary-btn" disabled={busy} onClick={() => void run(() => window.electronAPI.storage.restart())}>重启并清理派生缓存</button><button type="button" className="ghost-btn" disabled={busy} onClick={() => void run(() => window.electronAPI.storage.discardCleanup())}>取消清理</button></div> : null}</div> : null}
    <details className="settings-disclosure"><summary>迁移与保留说明</summary>
      <p className="hint">新安装默认将媒体缓存放在应用数据目录；旧缓存和手动指定目录保留原位。本地目录可能被 iCloud、OneDrive 等工具同步，请按需选择。</p>
      <p className="hint">媒体、导出、OCR 与 AI 记忆不会自动清理。清理重复副本会再次校验两边文件，新增或变更内容保留，空目录保留。归档仅按手动启用的计划回收已被完整覆盖的旧副本，唯一消息、媒体、书签及用户变更受到保护。</p>
    </details>
    </div>
    </details>
  </section>
}
