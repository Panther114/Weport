import { useEffect, useState } from 'react'
import { exportDateRange } from '../../utils/exportDateRange'
import type { ReaderExportOptions as Options } from './readerExport'
import './readerExportOptions.css'

export function ReaderExportOptions({ busy, onExport, onClose }: {
  busy: boolean; onExport: (options: Options) => void; onClose: () => void
}) {
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [policy, setPolicy] = useState<NonNullable<Options['mediaPolicy']>>('best-available')
  const [error, setError] = useState('')
  const [edited, setEdited] = useState(false)
  useEffect(() => {
    let alive = true
    void window.electronAPI.config.get('exportMediaPolicy').then(value => {
      if (alive && !edited) setPolicy(value === 'original-only' ? 'original-only' : 'best-available')
    }).catch(() => {})
    return () => { alive = false }
  }, [edited])
  return <section className="reader-export-options" aria-label="本会话导出选项">
    <p className="reader-hint">格式、媒体种类和目录沿用导出页设置。以下范围仅用于本次导出；留空表示整个会话，不限于已加载的消息。</p>
    <div className="reader-export-fields">
      <label>导出开始时间<input type="datetime-local" step="1" value={start} disabled={busy} onChange={event => { setStart(event.target.value); setError('') }} /></label>
      <label>导出结束时间<input type="datetime-local" step="1" value={end} disabled={busy} onChange={event => { setEnd(event.target.value); setError('') }} /></label>
      <label>图片策略<select aria-label="阅读器导出图片策略" value={policy} disabled={busy} onChange={event => { setEdited(true); setPolicy(event.target.value as typeof policy) }}>
        <option value="best-available">优先原图，缺失时使用本地可用图片</option>
        <option value="original-only">仅原图，无法确认原图时不导出该图片</option>
      </select></label>
    </div>
    <p className="reader-hint">按本机时区解释，开始和结束均包含所选秒；仅原图不能恢复未下载或无法解密的附件。</p>
    {error && <p className="reader-gap-error" role="alert">{error}</p>}
    <div className="reader-export-actions">
    <button type="button" className="primary-btn" disabled={busy} onClick={() => {
      try { onExport({ mediaPolicy: policy, dateRange: exportDateRange(start, end) }); setError('') }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    }}>{busy ? '正在导出…' : '按以上设置导出本会话'}</button>
    <button type="button" className="ghost-btn" onClick={onClose}>收起导出设置</button>
    </div>
  </section>
}
