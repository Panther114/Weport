import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, Terminal } from 'lucide-react'

/**
 * 日志尾巴面板（v1.2 §5）。
 *
 * 三条刻意的设计：
 *   1. **不自动轮询**。日志是"我怀疑刚出了问题"时才看的东西，定时刷新只会白烧
 *     CPU 与磁盘（而且用户正在读的那一屏会被换掉）。刷新是显式动作。
 *   2. **尾巴行数可选**，默认 200 行 —— 够看清一次失败，又不会让 DOM 里塞进几万行。
 *   3. **错误行独立高亮**：日志里 95% 是噪声，用户要找的是那几行 `-1006` / `error`。
 */

const TAIL_OPTIONS = [100, 200, 500, 1000] as const
const ERROR_HINT = /(\berror\b|\bfail(ed|ure)?\b|\bexception\b|错误|失败|异常|-1006|-3001|-3002|-3003)/i

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

export default function LogTailPanel() {
  const [files, setFiles] = useState<Array<{ name: string; bytes: number; mtime: number }>>([])
  const [selected, setSelected] = useState('')
  const [tailLines, setTailLines] = useState<number>(200)
  /** 读日志的请求序号 + 存活标记（慢的旧请求不能覆盖新内容，卸载后不再 setState）。 */
  const tailSeqRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      tailSeqRef.current += 1
    }
  }, [])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadedAt, setLoadedAt] = useState(0)

  const api = window.electronAPI?.diagnostics
  const supported = typeof api?.listLogs === 'function' && typeof api?.readLog === 'function'

  const loadList = useCallback(async () => {
    if (!supported) return
    try {
      const result = await api.listLogs()
      const list = Array.isArray(result?.files) ? result.files : []
      setFiles(list)
      setSelected((current) => {
        if (current && list.some((file) => file.name === current)) return current
        return list[0]?.name ?? ''
      })
    } catch (err) {
      setError(String((err as Error)?.message || err))
    }
  }, [api, supported])

  const loadTail = useCallback(
    async (name: string, lines: number) => {
      if (!supported || !name) return
      // 请求序号：快速切换日志文件/行数时，慢的旧请求可能后到，把新内容覆盖成旧的
      // （"我刚点的那一份"却显示成上一份，而且不报错）。卸载也作废。
      const seq = (tailSeqRef.current += 1)
      const stale = () => seq !== tailSeqRef.current || !aliveRef.current
      setLoading(true)
      setError('')
      try {
        const result = await api.readLog({ name, tailLines: lines })
        if (stale()) return
        setContent(String(result?.content ?? ''))
        setLoadedAt(Date.now())
      } catch (err) {
        if (stale()) return
        setError(String((err as Error)?.message || err))
        setContent('')
      } finally {
        if (!stale()) setLoading(false)
      }
    },
    [api, supported],
  )

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (selected) void loadTail(selected, tailLines)
    // tailLines 变化也重取：用户选的既是行数，也是"我要看更多"的意图
  }, [selected, tailLines, loadTail])

  const currentMeta = files.find((file) => file.name === selected)
  const lines = content ? content.split('\n') : []
  const errorLines = lines.filter((line) => ERROR_HINT.test(line)).length

  if (!supported) {
    return (
      <section className="dx-group" aria-label="日志尾巴">
        <div className="dx-group-head">
          <h3>日志尾巴</h3>
        </div>
        <div className="dx-state-block">
          <AlertTriangle size={22} strokeWidth={1.4} />
          <span>当前运行形态没有提供 diagnostics.readLog 接口，读不到日志。</span>
          <span className="dx-note">安装版与开发版都支持；若你看到这一条，说明前端跑在别的宿主里。</span>
        </div>
      </section>
    )
  }

  return (
    <section className="dx-group" aria-label="日志尾巴">
      <div className="dx-log-head">
        <Terminal size={15} strokeWidth={1.8} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>日志尾巴</h3>
        <label className="dx-note" htmlFor="dx-log-file" style={{ margin: 0 }}>
          日志文件
        </label>
        <select
          id="dx-log-file"
          className="dx-log-select"
          aria-label="选择日志文件"
          value={selected}
          disabled={files.length === 0 || loading}
          onChange={(event) => setSelected(event.target.value)}
        >
          {files.length === 0 ? <option value="">（没有日志文件）</option> : null}
          {files.map((file) => (
            <option key={file.name} value={file.name}>
              {file.name} · {formatBytes(file.bytes)}
            </option>
          ))}
        </select>
        <select
          className="dx-log-select"
          aria-label="显示行数"
          value={tailLines}
          disabled={loading}
          onChange={(event) => setTailLines(Number(event.target.value) || 200)}
        >
          {TAIL_OPTIONS.map((option) => (
            <option key={option} value={option}>
              末尾 {option} 行
            </option>
          ))}
        </select>
        {currentMeta ? (
          <span className="dx-log-meta">
            {formatBytes(currentMeta.bytes)} · 最后写入 {new Date(currentMeta.mtime).toLocaleString('zh-CN')}
          </span>
        ) : null}
        <span className="dx-log-actions">
          <button
            type="button"
            className="ghost-btn compact"
            disabled={loading}
            onClick={() => {
              void loadList().then(() => {
                if (selected) void loadTail(selected, tailLines)
              })
            }}
          >
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            刷新
          </button>
        </span>
      </div>

      {error ? (
        <div className="dx-state-block">
          <AlertTriangle size={20} strokeWidth={1.5} />
          <span>读日志失败：{error}</span>
          <button
            type="button"
            className="ghost-btn compact"
            onClick={() => selected && void loadTail(selected, tailLines)}
          >
            再试一次
          </button>
        </div>
      ) : files.length === 0 ? (
        <div className="dx-state-block">
          <span>日志目录里还没有 .log 文件。</span>
          <span className="dx-note">刚启动应用时是正常的；发生过一次报错后就会有内容。</span>
        </div>
      ) : content ? (
        <pre className="dx-log-body">{content}</pre>
      ) : (
        <div className="dx-state-block">
          <span>{loading ? '正在读取…' : '这个日志文件是空的。'}</span>
        </div>
      )}

      <div className="dx-log-hint">
        只显示末尾行，不会自动轮询（避免一边看一边被换掉）；点「刷新」取最新。
        {lines.length > 0 ? ` 本次 ${lines.length} 行${errorLines > 0 ? `，其中 ${errorLines} 行像错误` : '，没有错误行'}` : ''}
        {loadedAt ? ` · 读取于 ${new Date(loadedAt).toLocaleTimeString('zh-CN')}` : ''}
      </div>
    </section>
  )
}
