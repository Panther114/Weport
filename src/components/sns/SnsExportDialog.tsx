import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, CalendarRange, Download, FileCode, FileJson, FileText, FolderOpen, Square, X } from 'lucide-react'
import { useEscape } from '../../utils/useEscape'

export type SnsExportFormat = 'json' | 'html' | 'arkmejson' | 'markdown'

interface SnsExportDialogProps {
  open: boolean
  usernames?: string[]
  keyword?: string
  onClose: () => void
  onDone: (summary: string) => void
}

type DatePreset = 'all' | 'month' | 'year' | 'custom'

const FORMAT_OPTIONS: Array<{ value: SnsExportFormat; label: string; icon: React.ComponentType<{ size?: number | string }> }> = [
  { value: 'json', label: 'JSON', icon: Braces },
  { value: 'html', label: 'HTML', icon: FileCode },
  { value: 'arkmejson', label: 'ARKME JSON', icon: FileJson },
  { value: 'markdown', label: 'Markdown', icon: FileText },
]

const toDayStart = (d: Date) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return Math.floor(x.getTime() / 1000)
}

const toDayEnd = (d: Date) => {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return Math.floor(x.getTime() / 1000)
}

export const SnsExportDialog: React.FC<SnsExportDialogProps> = ({ open, usernames, keyword, onClose, onDone }) => {
  const [format, setFormat] = useState<SnsExportFormat>('json')
  const [preset, setPreset] = useState<DatePreset>('all')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [exportMedia, setExportMedia] = useState(false)
  const [exportImages, setExportImages] = useState(true)
  const [exportLivePhotos, setExportLivePhotos] = useState(true)
  const [exportVideos, setExportVideos] = useState(true)
  const [outputDir, setOutputDir] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number; status: string } | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const taskIdRef = useRef(`sns-export-${Date.now()}`)

  useEffect(() => {
    if (!open) return
    setRunning(false)
    setProgress(null)
    setResult(null)
    setError(null)
    taskIdRef.current = `sns-export-${Date.now()}`
    void window.electronAPI.sns
      .getExportStatsFast()
      .then((r) => {
        if (r.success && r.data) {
          setExportMedia(r.data.totalPosts > 2000)
        }
      })
      .catch(() => undefined)
  }, [open])

  const resolveRange = (): { start?: number; end?: number } => {
    const now = new Date()
    if (preset === 'month') {
      const start = new Date(now)
      start.setDate(start.getDate() - 30)
      return { start: toDayStart(start), end: toDayEnd(now) }
    }
    if (preset === 'year') {
      const start = new Date(now)
      start.setFullYear(start.getFullYear() - 1)
      return { start: toDayStart(start), end: toDayEnd(now) }
    }
    if (preset === 'custom') {
      const s = customStart ? toDayStart(new Date(customStart)) : undefined
      const e = customEnd ? toDayEnd(new Date(customEnd)) : undefined
      return { start: s, end: e }
    }
    return {}
  }

  const pickDir = async () => {
    const res = await window.electronAPI.sns.selectExportDir()
    if (!res.canceled && res.filePath) setOutputDir(res.filePath)
  }

  const startExport = async () => {
    if (!outputDir.trim() || running) return
    const range = resolveRange()
    if (preset === 'custom' && (!range.start || !range.end)) {
      setError('请选择完整的自定义时间范围')
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    setProgress({ current: 0, total: 0, status: '准备中…' })

    let lastPayload: { current: number; total: number; status: string } | null = null
    const off = window.electronAPI.sns.onExportProgress((p) => {
      lastPayload = p
      setProgress(p)
    })

    try {
      const r = await window.electronAPI.sns.exportTimeline({
        taskId: taskIdRef.current,
        outputDir: outputDir.trim(),
        format,
        usernames,
        keyword,
        exportMedia,
        exportImages,
        exportLivePhotos,
        exportVideos,
        ...range,
      })
      if (r.success) {
        const dir = r.filePath || outputDir
        const count = r.postCount ?? 0
        const mediaCount = r.mediaCount ?? 0
        onDone(`已导出 ${count} 条动态${mediaCount > 0 ? `、${mediaCount} 个媒体` : ''}`)
        setResult(`${dir}\n${count} 条动态${mediaCount > 0 ? `，${mediaCount} 个媒体` : ''}`)
      } else {
        setError(r.error || '导出失败')
      }
    } finally {
      off()
      setRunning(false)
    }
  }

  const cancelExport = () => {
    void window.electronAPI.export.cancelTask(taskIdRef.current)
  }

  const cancelExportRef = useRef(cancelExport)
  cancelExportRef.current = cancelExport

  useEscape(onClose, open && !running)

  if (!open) return null

  return createPortal(
    <div className="wp-overlay" onClick={onClose}>
      <div className="wp-dialog export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="wp-dialog-head">
          <h3>
            <Download size={16} />
            导出朋友圈
          </h3>
          <button className="icon-btn-ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {result ? (
          <div className="export-dialog-result">
            <div className="export-result-icon">
              <Download size={22} />
            </div>
            <p className="export-result-text">{result}</p>
            <button
              className="primary-btn"
              onClick={() => {
                void window.electronAPI.shell.openPath(outputDir)
              }}
            >
              <FolderOpen size={14} />
              打开导出目录
            </button>
          </div>
        ) : (
          <div className="export-dialog-body">
            <div className="export-section">
              <label>格式</label>
              <div className="chip-row">
                {FORMAT_OPTIONS.map((f) => {
                  const Icon = f.icon
                  return (
                    <button
                      key={f.value}
                      type="button"
                      className={`chip ${format === f.value ? 'chip-active' : ''}`}
                      onClick={() => setFormat(f.value)}
                    >
                      <Icon size={14} />
                      {f.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="export-section">
              <label>
                <CalendarRange size={13} />
                时间范围
              </label>
              <div className="chip-row">
                {(
                  [
                    { value: 'all', label: '全部时间' },
                    { value: 'month', label: '最近 30 天' },
                    { value: 'year', label: '最近一年' },
                    { value: 'custom', label: '自定义' },
                  ] as Array<{ value: DatePreset; label: string }>
                ).map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={`chip ${preset === p.value ? 'chip-active' : ''}`}
                    onClick={() => setPreset(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {preset === 'custom' && (
                <div className="date-range-inputs">
                  <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                  <span>至</span>
                  <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                </div>
              )}
            </div>

            <div className="export-section">
              <label>媒体</label>
              <label className="switch-row">
                <input type="checkbox" checked={exportMedia} onChange={(e) => setExportMedia(e.target.checked)} />
                <span>导出媒体文件（图片 / 实况 / 视频）</span>
              </label>
              {exportMedia && (
                <div className="chip-row">
                  {(
                    [
                      { key: 'images', label: '图片', value: exportImages, set: setExportImages },
                      { key: 'live', label: '实况照片', value: exportLivePhotos, set: setExportLivePhotos },
                      { key: 'videos', label: '视频', value: exportVideos, set: setExportVideos },
                    ] as Array<{ key: string; label: string; value: boolean; set: (v: boolean) => void }>
                  ).map((m) => (
                    <button key={m.key} type="button" className={`chip ${m.value ? 'chip-active' : ''}`} onClick={() => m.set(!m.value)}>
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="export-section">
              <label>输出目录</label>
              <div className="path-row">
                <input
                  className="path-input"
                  value={outputDir}
                  placeholder="选择导出目录…"
                  readOnly
                  onClick={pickDir}
                />
                <button className="ghost-btn" onClick={pickDir}>
                  <FolderOpen size={14} />
                  选择
                </button>
              </div>
            </div>

            {usernames && usernames.length > 0 && (
              <div className="export-scope-hint">仅导出当前筛选的 {usernames.length} 位发布者</div>
            )}
            {keyword && <div className="export-scope-hint">关键词：{keyword}</div>}

            {running && progress && (
              <div className="export-progress-block">
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: progress.total > 0 ? `${Math.min(100, (progress.current / progress.total) * 100)}%` : '8%',
                    }}
                  />
                </div>
                <span className="progress-status">
                  {progress.status} {progress.total > 0 ? `(${progress.current}/${progress.total})` : ''}
                </span>
              </div>
            )}

            {error && <div className="wp-error">{error}</div>}

            <div className="wp-dialog-actions">
              {running ? (
                <button className="danger-btn" onClick={cancelExportRef.current}>
                  <Square size={13} fill="currentColor" />
                  取消导出
                </button>
              ) : (
                <button className="primary-btn" disabled={!outputDir.trim()} onClick={() => void startExport()}>
                  开始导出
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
