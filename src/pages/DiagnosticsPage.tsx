import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FileArchive, FolderOpen, Loader2, RefreshCw, Stethoscope } from 'lucide-react'
import DiagnosticCheckList from '../components/diagnostics/DiagnosticCheckList'
import LogTailPanel from '../components/diagnostics/LogTailPanel'
import ErrorCodeHandbook from '../components/diagnostics/ErrorCodeHandbook'
import SnapshotPanel from '../components/diagnostics/SnapshotPanel'
import { formatBytes, parentDirOf } from '../utils/diagnosticsFormat'
import '../styles/diagnostics.scss'

/**
 * 诊断页（v1.2 §5 / D17：**只做本地诊断包导出**，不自动上传、不生成 Issue 正文）。
 *
 * 这一页要回答一个具体的问题：**"为什么读不到我的聊天记录"**。它过去有十几个互不
 * 相同的原因（微信没装/没开/3.x 代际/目录选错/库被占用/密钥过期/宿主起不来/磁盘满/
 * 没权限），而共同的表现只有一句失败提示。所以这里把每条原因逐条测出来，每条带一行
 * 能照做的动作，并允许把结果打成包发出去。
 *
 * 三个不能违反的性质（与 §5.2 验收对应）：
 *   - **不联网**：整页没有任何网络请求，包只落本地；
 *   - **不解密**：密钥只以指纹（`ab12…cd34`）出现，`safe:` 密文只报计数；
 *   - **不碰微信数据目录的写路径**：全部探测是只读的（可写性用 userData/导出目录上的
 *     1 字节探针文件判定）。
 *
 * 空态、加载态、错误态都如实呈现：拿不到结论时明说拿不到（以及为什么），
 * 不给一句"请重试"就算完。
 */

/** 导出结果 */
interface BundleResult {
  success: boolean
  path?: string
  sizeBytes?: number
  error?: string
}

type DiagnosticMonitorSnapshot = Awaited<ReturnType<Window['electronAPI']['diagnostics']['monitorSnapshot']>>

export default function DiagnosticsPage() {
  const api = window.electronAPI?.diagnostics
  const monitorApi = api?.monitorSnapshot

  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [full, setFull] = useState(false)
  const [error, setError] = useState('')
  const [bundle, setBundle] = useState<BundleResult | null>(null)
  const [exporting, setExporting] = useState(false)
  const [revealNote, setRevealNote] = useState('')
  const [copiedAll, setCopiedAll] = useState(false)
  const [monitor, setMonitor] = useState<DiagnosticMonitorSnapshot | null>(null)
  const [monitorError, setMonitorError] = useState('')
  /** "已复制"的复位定时器：切页/卸载时必须清掉，否则到点会回调一个已经卸载的组件。 */
  const copyAllTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (copyAllTimer.current !== null) window.clearTimeout(copyAllTimer.current)
  }, [])

  useEffect(() => {
    let alive = true
    let busy = false
    const refresh = async () => {
      if (busy) return
      if (typeof monitorApi !== 'function') {
        setMonitorError('当前运行形态尚未提供实时文件监控通道。')
        return
      }
      busy = true
      try {
        const next = await monitorApi()
        if (alive) {
          setMonitor(next)
          setMonitorError('')
        }
      } catch (err) {
        if (alive) setMonitorError(`实时快照失败：${String((err as Error)?.message || err)}`)
      } finally {
        busy = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [monitorApi])

  const collect = useCallback(
    async (options: { full?: boolean } = {}) => {
      if (typeof api?.collect !== 'function') {
        setError('当前运行形态没有提供 diagnostics.collect 接口，无法检测。安装版与开发版都支持。')
        return
      }
      setBusy(true)
      setError('')
      try {
        const next = await api.collect({ full: options.full === true })
        if (!next?.supported) {
          setError('后端报告当前平台不支持跨平台诊断（supported=false）。这一条不该出现，请把日志发给维护者。')
          setReport(null)
          return
        }
        setReport(next)
      } catch (err) {
        // 失败就是失败：原文照给，不美化、不吞掉
        setError(`检测失败：${String((err as Error)?.message || err)}`)
      } finally {
        setBusy(false)
      }
    },
    [api],
  )

  useEffect(() => {
    void collect({ full: false })
    // 只在挂载时跑一次；重新检测是显式动作
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const counts = useMemo(() => {
    const base = { ok: 0, warn: 0, fail: 0, unknown: 0 }
    for (const check of report?.checks ?? []) base[check.state] += 1
    return base
  }, [report])

  async function exportBundle(): Promise<void> {
    if (typeof api?.exportBundle !== 'function') {
      setBundle({ success: false, error: '当前运行形态没有提供 diagnostics.exportBundle 接口。' })
      return
    }
    setExporting(true)
    setBundle(null)
    setRevealNote('')
    try {
      const result = await api.exportBundle({})
      setBundle(result)
    } catch (err) {
      setBundle({ success: false, error: String((err as Error)?.message || err) })
    } finally {
      setExporting(false)
    }
  }

  async function revealBundle(): Promise<void> {
    const target = bundle?.path
    if (!target) return
    const openPath = window.electronAPI?.shell?.openPath
    if (typeof openPath !== 'function') {
      setRevealNote('当前运行形态没有 shell.openPath 接口。')
      return
    }
    try {
      // 先试目录（用户要的是"在文件夹里看到它"）；目录打不开再退回打开文件本身。
      const dirError = await openPath(parentDirOf(target))
      if (!dirError) {
        setRevealNote('已打开所在文件夹。')
        return
      }
      const fileError = await openPath(target)
      setRevealNote(fileError ? `打开失败：${fileError}` : '已用系统默认程序打开诊断包。')
    } catch (err) {
      setRevealNote(`打开失败：${String((err as Error)?.message || err)}`)
    }
  }

  async function copyAll(): Promise<void> {
    if (!report) return
    try {
      await navigator.clipboard.writeText(report.summary)
      setCopiedAll(true)
      if (copyAllTimer.current !== null) window.clearTimeout(copyAllTimer.current)
      copyAllTimer.current = window.setTimeout(() => setCopiedAll(false), 1800)
    } catch {
      setCopiedAll(false)
    }
  }

  const collectedLabel = report ? new Date(report.collectedAt).toLocaleString('zh-CN') : ''

  return (
    <div className="v09-page dx-page">
      <div className="v09-toolbar dx-head">
        <div className="dx-head-main">
          <div className="v09-toolbar-title">
            <Stethoscope size={18} strokeWidth={1.8} aria-hidden="true" />
            <h2 style={{ margin: 0, fontSize: 16 }}>诊断</h2>
            <span className="v09-sub">
              连接与数据健康自检 · 全部在本地完成 · 报告与诊断包都不会自动上传
            </span>
          </div>
          {report ? (
            <div className="dx-counts" role="status" aria-live="polite">
              <span className="dx-count" data-state="ok">正常 {counts.ok}</span>
              <span className="dx-count" data-state="warn">注意 {counts.warn}</span>
              <span className="dx-count" data-state="fail">异常 {counts.fail}</span>
              <span className="dx-count">未知 {counts.unknown}</span>
              <span className="dx-note">采集于 {collectedLabel}</span>
            </div>
          ) : null}
        </div>

        <div className="dx-head-actions">
          <label className="dx-toggle" title="完整模式会逐个库校验首页 HMAC（更慢，但能确认每一把密钥）">
            <input
              type="checkbox"
              checked={full}
              disabled={busy}
              onChange={(event) => setFull(event.target.checked)}
            />
            完整检测
          </label>
          <button
            type="button"
            className="ghost-btn compact"
            disabled={busy || !report}
            onClick={() => void copyAll()}
          >
            {copiedAll ? '已复制' : '复制结论'}
          </button>
          <button
            type="button"
            className="ghost-btn compact"
            disabled={busy}
            onClick={() => void collect({ full })}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            重新检测
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={exporting}
            onClick={() => void exportBundle()}
            title="把检查结果与日志尾巴打成一个本地 zip（不含密钥与聊天内容）"
          >
            {exporting ? <Loader2 size={14} className="spin" /> : <FileArchive size={14} />}
            导出诊断包
          </button>
        </div>
      </div>

      {bundle ? (
        <div className="dx-result" data-kind={bundle.success ? 'ok' : 'error'}>
          {bundle.success ? (
            <>
              <FileArchive size={15} strokeWidth={1.8} aria-hidden="true" />
              <span className="dx-note">
                已生成诊断包（{formatBytes(bundle.sizeBytes)}）：
              </span>
              <span className="dx-result-path">{bundle.path}</span>
              <button type="button" className="ghost-btn compact" onClick={() => void revealBundle()}>
                <FolderOpen size={14} />
                在文件夹中显示
              </button>
            </>
          ) : (
            <>
              <AlertTriangle size={15} strokeWidth={1.8} aria-hidden="true" />
              <span className="dx-note">导出失败：{bundle.error || '未知原因'}</span>
            </>
          )}
          {revealNote ? <span className="dx-note">{revealNote}</span> : null}
        </div>
      ) : null}

      {error ? (
        <div className="dx-result" data-kind="error">
          <AlertTriangle size={15} strokeWidth={1.8} aria-hidden="true" />
          <span className="dx-note" style={{ flex: 1 }}>
            {error}
          </span>
          <button type="button" className="ghost-btn compact" onClick={() => void collect({ full })}>
            再试一次
          </button>
        </div>
      ) : null}

      {busy && !report ? (
        <div className="v09-panel">
          <div className="page-loading">
            <Loader2 size={22} className="spin" />
            <span className="hint">正在逐项检测（微信进程、数据目录、动态库、磁盘与权限）…</span>
          </div>
        </div>
      ) : null}

      {!busy && !report && !error ? (
        <div className="v09-panel">
          <div className="dx-state-block">
            <Stethoscope size={30} strokeWidth={1.3} />
            <span>还没有检测结果。</span>
            <span className="dx-note">点右上角「重新检测」开始；整个过程只读，不会修改你的数据。</span>
          </div>
        </div>
      ) : null}

      {report ? (
        <>
          {report.checks.filter((check) => check.state === 'fail').length > 0 ? (
            <div className="dx-result" data-kind="error">
              <AlertTriangle size={15} strokeWidth={1.8} aria-hidden="true" />
              <span className="dx-note" style={{ flex: 1 }}>
                有 {counts.fail} 项异常：先看「数据库与密钥」和「权限」两组里标红的检查，
                每条结论后面都写了下一步该做什么。
              </span>
            </div>
          ) : null}
          <DiagnosticCheckList checks={report.checks} busy={busy} />
        </>
      ) : null}

      <section className="dx-monitor" aria-label="实时数据与运行监控">
        <div className="dx-monitor-head">
          <div>
            <h3>实时监控</h3>
            <p>每 5 秒只读采样数据库、任务与 Weport 主进程状态；文件增长按大小差值估算，同大小写入无法检测。</p>
          </div>
          {monitor ? <span className="dx-monitor-time">更新于 {new Date(monitor.collectedAt).toLocaleTimeString('zh-CN')}</span> : null}
        </div>
        {monitorError ? <p className="dx-monitor-error" role="status">{monitorError}</p> : null}
        {monitor ? (
          <>
            <div className="dx-monitor-cards">
              <div><span>Weport RSS</span><b>{formatBytes(monitor.runtime.rssBytes)}</b></div>
              <div><span>JS 堆内存</span><b>{formatBytes(monitor.runtime.heapUsedBytes)}</b></div>
              <div><span>CPU</span><b>{monitor.runtime.cpuPercent === null ? '采样中…' : `${monitor.runtime.cpuPercent.toFixed(1)}%`}</b></div>
              <div><span>数据库文件</span><b>{monitor.totals.files} 个 · {formatBytes(monitor.totals.bytes)}</b></div>
              <div><span>文件大小增长</span><b>{monitor.totals.sizeGrowthBytesPerSecond === null ? '采样中…' : `${formatBytes(monitor.totals.sizeGrowthBytesPerSecond)}/s`}</b></div>
              <div><span>后台任务</span><b>{monitor.tasks.filter((task) => task.status === 'running').length} 个运行中</b></div>
            </div>
            <div className="dx-monitor-subsystems">
              <span data-state={monitor.subsystems.wcdbReady === null ? 'unknown' : monitor.subsystems.wcdbReady ? 'ok' : 'fail'}>WCDB 宿主 {monitor.subsystems.wcdbReady === null ? '未知' : monitor.subsystems.wcdbReady ? '就绪' : '未就绪'}</span>
              <span data-state={monitor.subsystems.databaseConnected === null ? 'unknown' : monitor.subsystems.databaseConnected ? 'ok' : 'warn'}>数据库 {monitor.subsystems.databaseConnected === null ? '未知' : monitor.subsystems.databaseConnected ? '已连接' : '未连接'}</span>
              <span data-state={monitor.subsystems.imageKeyConfigured === null ? 'unknown' : monitor.subsystems.imageKeyConfigured ? 'ok' : 'warn'}>图片密钥 {monitor.subsystems.imageKeyConfigured === null ? '未知' : monitor.subsystems.imageKeyConfigured ? '已配置' : '未配置'}</span>
            </div>
            {monitor.files.length > 0 ? (
              <div className="dx-monitor-files" aria-label="数据库文件大小变化">
                {monitor.files.slice().sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 18).map((file) => (
                  <div className="dx-monitor-file" key={`${file.name}:${file.kind}`}>
                    <code>{file.name}</code>
                    <span data-kind={file.kind}>{file.kind}</span>
                    <span>{formatBytes(file.sizeBytes)}</span>
                    <time>{new Date(file.modifiedAt).toLocaleTimeString('zh-CN')}</time>
                    <span>{file.sizeGrowthBytesPerSecond === null ? '—' : `${formatBytes(file.sizeGrowthBytesPerSecond)}/s`}</span>
                  </div>
                ))}
              </div>
            ) : <p className="dx-note">尚未找到当前账号的数据库文件；选择数据目录并连接账号后会显示 db / WAL / SHM 变化。</p>}
            {monitor.tasks.length > 0 ? (
              <div className="dx-monitor-tasks">
                {monitor.tasks.filter((task) => task.status === 'running').map((task) => (
                  <div key={task.key}><b>{task.key}</b><span>{task.stage || task.message} · {task.progress}%</span></div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <SnapshotPanel />

      <ErrorCodeHandbook />

      <LogTailPanel />

      <p className="dx-note">
        「导出诊断包」生成的是一个本地 zip（diagnostics.json / checks.md / 日志尾巴 /
        脱敏后的配置）。配置只按**白名单**收录，白名单外的键只保留键名；
        任何密钥或令牌形状的字符串都会被替换成 <code>«redacted:sha256:first8»</code>。
        包不会自动上传，也不会自动发给任何人。
      </p>
    </div>
  )
}
