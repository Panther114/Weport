import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react'
import { formatBytes } from '../../utils/diagnosticsFormat'

type SnapshotApi = Window['electronAPI']['snapshot']
type SnapshotListResult = Awaited<ReturnType<SnapshotApi['list']>>
type SnapshotItem = SnapshotListResult['snapshots'][number]

const REASON_LABELS: Record<string, string> = {
  'anti-revoke-install': '安装防撤回前',
  'anti-revoke-uninstall': '卸载防撤回前',
  'sns-block-delete': '屏蔽朋友圈删除前',
  'sns-delete': '删除朋友圈前',
  'session-read-status': '修改会话状态前',
  manual: '手动快照',
}

interface SnapshotFeedback {
  kind: 'ok' | 'error'
  text: string
}

/** Local snapshot list, integrity check, and explicitly confirmed recovery. */
export default function SnapshotPanel() {
  const api = window.electronAPI?.snapshot
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [pending, setPending] = useState<{ id: string; action: 'verify' | 'restore' } | null>(null)
  const [feedback, setFeedback] = useState<SnapshotFeedback | null>(null)

  const refresh = useCallback(async () => {
    if (typeof api?.list !== 'function') {
      setLoadError('当前运行形态未提供快照列表通道。')
      setSnapshots([])
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      const result = await api.list()
      setSnapshots(Array.isArray(result?.snapshots) ? result.snapshots : [])
    } catch (error) {
      setLoadError(`读取快照失败：${String((error as Error)?.message || error)}`)
      setSnapshots([])
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = useCallback(async (snapshot: SnapshotItem, action: 'verify' | 'restore') => {
    if (pending) return
    if (typeof api?.restore !== 'function') {
      setFeedback({ kind: 'error', text: '当前运行形态未提供快照恢复通道。' })
      return
    }
    if (action === 'restore') {
      const label = REASON_LABELS[snapshot.reason] || snapshot.reason || '本地快照'
      const confirmed = window.confirm(
        `将使用“${label}”覆盖匹配的微信数据库文件。程序会先校验快照并备份当前文件。请先退出微信。确认恢复？`,
      )
      if (!confirmed) return
    }

    setPending({ id: snapshot.id, action })
    setFeedback(null)
    try {
      const result = action === 'verify'
        ? await api.restore({ id: snapshot.id, verifyOnly: true })
        : await api.restore({ id: snapshot.id, confirm: true })
      if (!result?.success) {
        setFeedback({ kind: 'error', text: result?.error || (action === 'verify' ? '快照校验失败。' : '恢复失败。') })
        return
      }
      if (action === 'verify') {
        setFeedback({ kind: 'ok', text: `校验通过：${snapshot.files} 个快照文件完整。` })
      } else {
        setFeedback({ kind: 'ok', text: '恢复完成。当前数据库已按快照恢复。' })
        await refresh()
      }
    } catch (error) {
      setFeedback({ kind: 'error', text: `${action === 'verify' ? '校验' : '恢复'}失败：${String((error as Error)?.message || error)}` })
    } finally {
      setPending(null)
    }
  }, [api, pending, refresh])

  return (
    <section className="dx-snapshot dx-monitor" aria-label="写前快照">
      <div className="dx-monitor-head">
        <div>
          <h3>写前快照</h3>
          <p>本地列出写入前保存的数据库快照。恢复前会校验文件，并在恢复前保存当前现场。</p>
        </div>
        <button type="button" className="ghost-btn compact" disabled={loading || pending !== null} onClick={() => void refresh()}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          刷新
        </button>
      </div>

      {loadError ? <p className="dx-snapshot-state" data-kind="error" role="alert"><AlertTriangle size={14} />{loadError}</p> : null}
      {feedback ? (
        <p className="dx-snapshot-state" data-kind={feedback.kind} role="status">
          {feedback.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {feedback.text}
        </p>
      ) : null}

      {snapshots.length > 0 ? (
        <div className="dx-snapshot-list">
          {snapshots.map((snapshot) => {
            const isPending = pending?.id === snapshot.id
            return (
              <article className="dx-snapshot-row" key={snapshot.id}>
                <div className="dx-snapshot-info">
                  <strong>{REASON_LABELS[snapshot.reason] || snapshot.reason || '本地快照'}</strong>
                  <time dateTime={new Date(snapshot.createdAt).toISOString()}>{new Date(snapshot.createdAt).toLocaleString('zh-CN')}</time>
                  <span>{snapshot.files} 个文件 · {formatBytes(snapshot.bytes)}</span>
                </div>
                <div className="dx-snapshot-actions">
                  <button
                    type="button"
                    className="ghost-btn compact"
                    disabled={loading || pending !== null}
                    onClick={() => void runAction(snapshot, 'verify')}
                    aria-label={`校验快照 ${snapshot.id}`}
                  >
                    {isPending && pending?.action === 'verify' ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
                    校验
                  </button>
                  <button
                    type="button"
                    className="ghost-btn compact"
                    disabled={loading || pending !== null}
                    onClick={() => void runAction(snapshot, 'restore')}
                    aria-label={`恢复快照 ${snapshot.id}`}
                  >
                    {isPending && pending?.action === 'restore' ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />}
                    恢复…
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      ) : !loading && !loadError ? (
        <p className="dx-snapshot-empty">暂无可用快照。启用相关写入功能后，快照会自动保存在本机。</p>
      ) : null}
    </section>
  )
}
