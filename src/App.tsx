import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import './styles.css'

type Account = {
  wxid: string
  nickname?: string
  avatarUrl?: string
  modifiedTime?: number
}

type ExportProgress = {
  current: number
  total: number
  currentSession?: string
  phase?: string
  phaseLabel?: string
}

type Format = 'txt' | 'json'
type ToastKind = 'ok' | 'err' | 'info'
type Toast = { id: number; kind: ToastKind; title: string; body?: string }

type ExportLogInfo = {
  path?: string
  txt?: string | null
  json?: string | null
  exists?: boolean
}

const DEFAULT_DB_HINT = String.raw`C:\Users\<you>\Documents\xwechat_files`

let toastSeq = 1

function MarkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M4 12h11M4 17h14" stroke="currentColor" strokeWidth="1.6" />
      <rect x="17" y="10.5" width="3" height="3" fill="currentColor" />
    </svg>
  )
}

export default function App() {
  const [version, setVersion] = useState('0.6.5')
  const [dbPath, setDbPath] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [format, setFormat] = useState<Format>('txt')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedWxid, setSelectedWxid] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyReady, setKeyReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body?: string } | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [exportLog, setExportLog] = useState<ExportLogInfo | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastTimers = useRef<Map<number, number>>(new Map())

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.wxid === selectedWxid) || null,
    [accounts, selectedWxid]
  )

  const formatFolder = format === 'json' ? 'JSON' : 'TXT'

  const pushToast = useCallback((kind: ToastKind, title: string, body?: string, ms = 5200) => {
    const id = toastSeq++
    setToasts((prev) => [...prev.slice(-4), { id, kind, title, body }])
    const t = window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id))
      toastTimers.current.delete(id)
    }, ms)
    toastTimers.current.set(id, t)
  }, [])

  const dismissToast = useCallback((id: number) => {
    const t = toastTimers.current.get(id)
    if (t) window.clearTimeout(t)
    toastTimers.current.delete(id)
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const refreshExportLog = useCallback(async (path: string) => {
    if (!path.trim()) {
      setExportLog(null)
      return
    }
    try {
      const log = await invoke<ExportLogInfo>('get_export_log', { outputDir: path.trim() })
      setExportLog(log)
    } catch {
      setExportLog(null)
    }
  }, [])

  const refreshAccounts = useCallback(
    async (path: string) => {
      if (!path.trim()) {
        setAccounts([])
        setSelectedWxid('')
        return
      }
      try {
        const list = await invoke<Account[]>('scan_accounts', { dbPath: path.trim() })
        setAccounts(list || [])
        if (list?.length) {
          setSelectedWxid((prev) => (list.some((a) => a.wxid === prev) ? prev : list[0].wxid))
          pushToast('ok', `找到 ${list.length} 个账号`, path.trim(), 3200)
        } else {
          setSelectedWxid('')
          pushToast('info', '未找到账号目录', '请确认选择的是 xwechat_files 根目录')
        }
      } catch (e) {
        setAccounts([])
        setSelectedWxid('')
        pushToast('err', '扫描账号失败', String(e))
      }
    },
    [pushToast]
  )

  const detectDb = useCallback(async () => {
    setBusy(true)
    setBusyLabel('正在扫描微信数据目录…')
    try {
      const result = await invoke<{ success: boolean; path?: string; error?: string }>('detect_db_path')
      if (result.success && result.path) {
        setDbPath(result.path)
        await refreshAccounts(result.path)
        pushToast('ok', '已定位数据目录', result.path)
      } else {
        pushToast('info', '未能自动检测', result.error || '请手动选择 xwechat_files 文件夹')
      }
    } catch (e) {
      pushToast('err', '扫描失败', String(e))
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }, [pushToast, refreshAccounts])

  const persist = useCallback(
    (patch: Partial<{ dbPath: string; decryptKey: string; exportPath: string; selectedWxid: string; format: Format }>) => {
      const next = {
        dbPath: patch.dbPath ?? dbPath,
        decryptKey: patch.decryptKey ?? decryptKey,
        exportPath: patch.exportPath ?? exportPath,
        selectedWxid: patch.selectedWxid ?? selectedWxid,
        format: patch.format ?? format
      }
      void invoke('set_settings', {
        settings: {
          dbPath: next.dbPath,
          decryptKey: next.decryptKey,
          exportPath: next.exportPath,
          selectedWxid: next.selectedWxid,
          format: next.format
        }
      }).catch(() => undefined)
    },
    [dbPath, decryptKey, exportPath, selectedWxid, format]
  )

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined)

    ;(async () => {
      try {
        const s = await invoke<{
          dbPath?: string
          decryptKey?: string
          exportPath?: string
          selectedWxid?: string
          format?: string
        }>('get_settings')
        if (s.dbPath) setDbPath(s.dbPath)
        if (s.decryptKey) setDecryptKey(s.decryptKey)
        if (s.exportPath) {
          setExportPath(s.exportPath)
          await refreshExportLog(s.exportPath)
        }
        if (s.selectedWxid) setSelectedWxid(s.selectedWxid)
        if (s.format === 'json' || s.format === 'txt') setFormat(s.format)
        if (s.dbPath) {
          await refreshAccounts(s.dbPath)
          if (s.selectedWxid) setSelectedWxid(s.selectedWxid)
        } else {
          await detectDb()
        }
      } catch {
        await detectDb()
      }
    })()

    const unsubs = [
      listen<ExportProgress>('export-progress', (event) => {
        setProgress(event.payload)
        const label = event.payload.phaseLabel || event.payload.phase || '导出中'
        const session = event.payload.currentSession || ''
        setBusyLabel(session ? `${label} · ${session}` : label)
      }),
      listen<string>('engine-status', (event) => {
        const msg = event.payload
        setBusyLabel(msg)
        if (msg.includes('已准备就绪') || msg.includes('可以登录') || msg.includes('Hook安装成功')) {
          setKeyReady(true)
          pushToast('info', '密钥 Hook 已就绪', '请现在登录微信，或退出后重新登录（关闭自动登录）', 8000)
        }
        if (msg.includes('密钥获取成功')) {
          pushToast('ok', '密钥获取成功')
        }
      }),
      listen<string>('key-status', (event) => {
        const msg = event.payload
        setBusyLabel(msg)
        if (msg.includes('已准备就绪') || msg.includes('可以登录') || msg.includes('Hook安装成功')) {
          setKeyReady(true)
        }
      })
    ]

    return () => {
      unsubs.forEach((p) => void p.then((u) => u()))
      toastTimers.current.forEach((t) => window.clearTimeout(t))
    }
  }, [detectDb, pushToast, refreshAccounts, refreshExportLog])

  useEffect(() => {
    if (!dbPath && !decryptKey && !exportPath) return
    const t = window.setTimeout(() => {
      persist({})
    }, 400)
    return () => window.clearTimeout(t)
  }, [dbPath, decryptKey, exportPath, selectedWxid, format, persist])

  useEffect(() => {
    void refreshExportLog(exportPath)
  }, [exportPath, refreshExportLog])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const update = await check()
        if (!cancelled && update) {
          setUpdateInfo({ version: update.version, body: update.body || undefined })
          pushToast('info', `发现新版本 v${update.version}`, '可在顶部横幅更新')
        }
      } catch {
        // optional in dev
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pushToast])

  async function pickDbFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择微信数据目录 (xwechat_files)'
    })
    if (typeof selected === 'string' && selected) {
      setDbPath(selected)
      await refreshAccounts(selected)
    }
  }

  async function pickExportFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择导出输出文件夹'
    })
    if (typeof selected === 'string' && selected) {
      setExportPath(selected)
      await refreshExportLog(selected)
    }
  }

  async function extractKey() {
    if (!dbPath.trim()) {
      pushToast('err', '请先选择微信数据目录')
      return
    }
    setBusy(true)
    setKeyReady(false)
    setBusyLabel('正在连接微信进程…')
    pushToast(
      'info',
      '开始提取密钥',
      '密钥在登录瞬间捕获。请关闭微信「自动登录」，等待「已准备就绪」后重新登录。',
      7000
    )
    try {
      const result = await invoke<{ success: boolean; key?: string; error?: string }>('extract_db_key', {
        dbPath: dbPath.trim(),
        wxid: selectedWxid || ''
      })
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setKeyReady(false)
        pushToast('ok', '密钥提取成功', '可以开始导出全部聊天记录')
      } else {
        pushToast('err', '密钥提取失败', result.error || '请按左侧说明重试', 10000)
      }
    } catch (e) {
      pushToast('err', '密钥提取失败', String(e), 10000)
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  async function runExport() {
    if (!dbPath.trim()) {
      pushToast('err', '请选择微信数据目录')
      return
    }
    if (!selectedWxid) {
      pushToast('err', '请选择要导出的账号')
      return
    }
    if (!exportPath.trim()) {
      pushToast('err', '请选择导出输出文件夹')
      return
    }

    setBusy(true)
    setProgress({ current: 0, total: 0, phaseLabel: '准备中' })
    setBusyLabel('开始导出全部会话…')

    try {
      let key = decryptKey.trim()
      if (!key || key.length !== 64) {
        setKeyReady(false)
        pushToast('info', '自动提取密钥', '导出前需要密钥，将启动提取流程…')
        setBusyLabel('未检测到密钥，开始自动提取…')
        const keyResult = await invoke<{ success: boolean; key?: string; error?: string }>('extract_db_key', {
          dbPath: dbPath.trim(),
          wxid: selectedWxid
        })
        if (!keyResult.success || !keyResult.key) {
          throw new Error(
            keyResult.error ||
              '密钥提取失败。关闭自动登录 → 提取密钥 → 提示就绪后重新登录微信。'
          )
        }
        key = keyResult.key
        setDecryptKey(key)
      }

      const result = await invoke<{
        success: boolean
        successCount?: number
        failCount?: number
        formatFolder?: string
        formatDir?: string
        error?: string
      }>('export_all', {
        dbPath: dbPath.trim(),
        wxid: selectedWxid,
        decryptKey: key,
        outputDir: exportPath.trim(),
        format
      })

      await refreshExportLog(exportPath.trim())

      if (result.success) {
        const folder = result.formatFolder || formatFolder
        pushToast(
          'ok',
          '导出完成',
          `成功 ${result.successCount ?? 0} 个会话 → ${folder}/（已覆盖同名文件）`,
          7000
        )
        setProgress((p) =>
          p
            ? { ...p, current: p.total || p.current, phaseLabel: '完成', phase: 'complete' }
            : { current: 1, total: 1, phaseLabel: '完成', phase: 'complete' }
        )
      } else {
        pushToast(
          'err',
          '导出未完全成功',
          result.error || `成功 ${result.successCount ?? 0} / 失败 ${result.failCount ?? 0}`,
          12000
        )
      }
    } catch (e) {
      pushToast('err', '导出失败', String(e), 12000)
    } finally {
      setBusy(false)
      setBusyLabel('')
    }
  }

  async function confirmClearLibrary() {
    if (!exportPath.trim()) {
      pushToast('err', '请先选择输出文件夹')
      setClearOpen(false)
      return
    }
    setBusy(true)
    setBusyLabel('正在清空导出库…')
    try {
      const result = await invoke<{ success: boolean; message?: string; removed?: string[] }>(
        'clear_export_library',
        { outputDir: exportPath.trim() }
      )
      await refreshExportLog(exportPath.trim())
      pushToast(
        'ok',
        result.message || '已清空导出库',
        result.removed?.length ? `已删除 ${result.removed.length} 项` : undefined
      )
    } catch (e) {
      pushToast('err', '清空失败', String(e), 10000)
    } finally {
      setBusy(false)
      setBusyLabel('')
      setClearOpen(false)
    }
  }

  async function checkForUpdates(fromAbout = false) {
    setUpdateBusy(true)
    try {
      const update = await check()
      if (!update) {
        pushToast('ok', '已是最新版本', `当前 v${version}`)
        setUpdateInfo(null)
        if (fromAbout) {
          // keep about open
        }
        return
      }
      setUpdateInfo({ version: update.version, body: update.body || undefined })
      pushToast('info', `发现新版本 v${update.version}`, '点击更新横幅或下方按钮安装')
    } catch (e) {
      pushToast('err', '检查更新失败', String(e))
    } finally {
      setUpdateBusy(false)
    }
  }

  async function installUpdate() {
    setUpdateBusy(true)
    try {
      const update = await check()
      if (!update) {
        pushToast('ok', '已是最新版本')
        setUpdateInfo(null)
        return
      }
      pushToast('info', `正在下载 v${update.version}…`, '下载完成后将自动安装并重启', 8000)
      await update.downloadAndInstall()
      pushToast('ok', '更新已安装', '正在重启…')
      await relaunch()
    } catch (e) {
      pushToast('err', '更新失败', String(e), 10000)
    } finally {
      setUpdateBusy(false)
      setBusyLabel('')
    }
  }

  const progressPct = useMemo(() => {
    if (!progress || !progress.total) return progress?.phase === 'complete' ? 100 : 0
    return Math.max(0, Math.min(100, (progress.current / progress.total) * 100))
  }, [progress])

  const keyOk = decryptKey.trim().length === 64

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="mark" aria-hidden>
            <MarkIcon />
          </div>
          <div className="brand-text">
            <h1>Weport</h1>
            <p>
              WeChat export · v{version}
              {busyLabel ? ` · ${busyLabel}` : ''}
            </p>
          </div>
        </div>
        <div className="top-actions">
          <button className="icon-btn" title="关于与更新" type="button" onClick={() => setAboutOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v6" strokeLinecap="round" />
              <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
      </header>

      {updateInfo && (
        <div className="update-banner">
          <div>
            <h2>发现新版本 v{updateInfo.version}</h2>
            <p className="hint" style={{ marginTop: 4 }}>
              {updateInfo.body || '建议更新以获得修复与改进。'}
            </p>
          </div>
          <button className="primary-btn" type="button" disabled={updateBusy} onClick={() => void installUpdate()}>
            {updateBusy ? '更新中…' : '立即更新'}
          </button>
        </div>
      )}

      <div className="workspace">
        <div className="column">
          <section className="panel">
            <div className="panel-head">
              <h2>数据位置</h2>
              <span>xwechat_files</span>
            </div>
            <div className="field">
              <label htmlFor="dbPath">微信数据文件夹</label>
              <div className="path-row">
                <input
                  id="dbPath"
                  className="path-input"
                  value={dbPath}
                  placeholder={DEFAULT_DB_HINT}
                  onChange={(e) => setDbPath(e.target.value)}
                  onBlur={() => void refreshAccounts(dbPath)}
                  spellCheck={false}
                />
                <button className="ghost-btn" type="button" onClick={() => void pickDbFolder()} disabled={busy}>
                  浏览
                </button>
              </div>
            </div>
            <div className="btn-row">
              <button className="secondary-btn" type="button" onClick={() => void detectDb()} disabled={busy}>
                重新扫描
              </button>
              <button
                className="secondary-btn"
                type="button"
                onClick={() => void refreshAccounts(dbPath)}
                disabled={busy || !dbPath.trim()}
              >
                刷新账号
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>账号</h2>
              <span>{accounts.length ? `${accounts.length} 个` : '—'}</span>
            </div>
            {accounts.length === 0 ? (
              <div className="empty">选择或扫描数据目录后显示账号</div>
            ) : (
              <div className="account-list" role="listbox" aria-label="微信账号">
                {accounts.map((account) => (
                  <button
                    key={account.wxid}
                    type="button"
                    className="account-item"
                    data-active={account.wxid === selectedWxid}
                    role="option"
                    aria-selected={account.wxid === selectedWxid}
                    onClick={() => {
                      setSelectedWxid(account.wxid)
                      setDecryptKey('')
                      setKeyReady(false)
                    }}
                    disabled={busy}
                  >
                    <div>
                      <strong>{account.nickname || account.wxid}</strong>
                      <span>{account.wxid}</span>
                    </div>
                    {account.wxid === selectedWxid ? (
                      <span className="badge ok">当前</span>
                    ) : (
                      <span className="badge">选择</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>解密密钥</h2>
              <span>{keyOk ? '已就绪' : '待提取'}</span>
            </div>

            <ol className="steps">
              <li>
                <span className="step-num">1</span>
                <span>
                  打开微信，并<strong>关闭「自动登录」</strong>
                </span>
              </li>
              <li>
                <span className="step-num">2</span>
                <span>
                  点击下方<strong>提取密钥</strong>（保持 Weport 在前台）
                </span>
              </li>
              <li>
                <span className="step-num">3</span>
                <span>
                  出现<strong>已准备就绪</strong>后，登录或退出再重新登录微信
                </span>
              </li>
              <li>
                <span className="step-num">4</span>
                <span>密钥自动填入；也可粘贴已有 64 位十六进制密钥</span>
              </li>
            </ol>

            {keyReady && busy && (
              <div className="callout ready" role="status">
                Hook 已就绪 — 请现在登录微信，或退出账号后重新登录（可在手机上确认）。
              </div>
            )}

            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="decryptKey">数据库密钥</label>
              <div className="path-row">
                <input
                  id="decryptKey"
                  className="path-input"
                  type={showKey ? 'text' : 'password'}
                  value={decryptKey}
                  placeholder="64 位十六进制密钥…"
                  onChange={(e) => setDecryptKey(e.target.value.trim())}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                />
                <button
                  className="ghost-btn"
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  disabled={busy}
                  title={showKey ? '隐藏密钥' : '显示密钥'}
                  aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <div className="btn-row">
              <button className="primary-btn" type="button" onClick={() => void extractKey()} disabled={busy}>
                {busy && !progress ? '提取中…' : '提取密钥'}
              </button>
            </div>

            {keyOk ? (
              <p className="hint ok">密钥已就绪，可在右侧开始导出。</p>
            ) : (
              <p className="hint">密钥在登录瞬间捕获（与 WeFlow 相同），不是从已登录会话直接读取。</p>
            )}
          </section>
        </div>

        <div className="column">
          <section className="panel panel-fill">
            <div className="panel-head">
              <h2>导出</h2>
              <span>全部联系人 + 群聊</span>
            </div>

            <div className="field">
              <label>格式</label>
              <div className="chip-row" role="radiogroup" aria-label="导出格式">
                <button
                  type="button"
                  className="chip"
                  data-active={format === 'txt'}
                  role="radio"
                  aria-checked={format === 'txt'}
                  onClick={() => setFormat('txt')}
                  disabled={busy}
                >
                  TXT
                </button>
                <button
                  type="button"
                  className="chip"
                  data-active={format === 'json'}
                  role="radio"
                  aria-checked={format === 'json'}
                  onClick={() => setFormat('json')}
                  disabled={busy}
                >
                  JSON
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="exportPath">输出文件夹</label>
              <div className="path-row">
                <input
                  id="exportPath"
                  className="path-input"
                  value={exportPath}
                  placeholder="选择导出根目录…"
                  onChange={(e) => setExportPath(e.target.value)}
                  spellCheck={false}
                />
                <button className="ghost-btn" type="button" onClick={() => void pickExportFolder()} disabled={busy}>
                  浏览
                </button>
              </div>
            </div>

            <p className="hint">
              导出写入 <code>{formatFolder}/</code>，同名文件<strong>直接覆盖</strong>。
              命名：<code>群聊_名称.{format}</code> / <code>私聊_名称.{format}</code>
              {selectedAccount ? ` · ${selectedAccount.nickname || selectedAccount.wxid}` : ''}
            </p>

            <div className="export-meta" aria-live="polite">
              <div className="row">
                <span>上次 TXT</span>
                <strong className={exportLog?.txt ? undefined : 'muted'}>{exportLog?.txt || '尚未导出'}</strong>
              </div>
              <div className="row">
                <span>上次 JSON</span>
                <strong className={exportLog?.json ? undefined : 'muted'}>{exportLog?.json || '尚未导出'}</strong>
              </div>
              <div className="row">
                <span>日志文件</span>
                <span className="muted">export_log.txt</span>
              </div>
            </div>

            {progress && (
              <div className="progress" aria-live="polite">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="progress-meta">
                  <strong>{progress.currentSession || progress.phaseLabel || '…'}</strong>
                  <span>
                    {progress.total > 0
                      ? `${Math.min(progress.current, progress.total).toFixed(0)} / ${progress.total}`
                      : progress.phaseLabel || ''}
                  </span>
                </div>
              </div>
            )}

            <div className="export-actions">
              <button className="primary-btn block" type="button" disabled={busy} onClick={() => void runExport()}>
                {busy && progress ? '导出中…' : '导出全部聊天记录'}
              </button>
              <div className="btn-row">
                <button
                  className="danger-btn"
                  type="button"
                  disabled={busy || !exportPath.trim()}
                  onClick={() => setClearOpen(true)}
                >
                  清空导出库
                </button>
              </div>
              <p className="hint">
                清空会删除输出目录下的 <code>TXT/</code>、<code>JSON/</code> 与 <code>export_log.txt</code>
                ，不会删除你选的根文件夹。数据仅在本地处理。
              </p>
            </div>
          </section>
        </div>
      </div>

      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-kind={t.kind}>
            <div>
              <h4>{t.title}</h4>
              {t.body ? <p>{t.body}</p> : null}
            </div>
            <button className="toast-close" type="button" aria-label="关闭" onClick={() => dismissToast(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>

      {clearOpen && (
        <div className="modal-backdrop" onClick={() => !busy && setClearOpen(false)}>
          <div
            className="modal danger"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-title"
          >
            <h3 id="clear-title">清空导出库？</h3>
            <p>
              将删除下列内容（不可恢复）：
            </p>
            <p style={{ marginTop: 8 }}>
              <code>TXT/</code>、<code>JSON/</code>、<code>export_log.txt</code>
              {exportPath ? (
                <>
                  <br />
                  根目录：{exportPath}
                </>
              ) : null}
            </p>
            <div className="modal-actions">
              <button className="secondary-btn" type="button" disabled={busy} onClick={() => setClearOpen(false)}>
                取消
              </button>
              <button className="danger-btn" type="button" disabled={busy} onClick={() => void confirmClearLibrary()}>
                {busy ? '清空中…' : '确认清空'}
              </button>
            </div>
          </div>
        </div>
      )}

      {aboutOpen && (
        <div className="modal-backdrop" onClick={() => setAboutOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3>Weport v{version}</h3>
            <p>
              轻量纯 Tauri 微信聊天记录导出工具。读取本机微信 4.x 数据，导出全部私聊与群聊为 TXT / JSON。
            </p>
            <p style={{ marginTop: 8 }}>
              导出写入 <code>TXT/</code> 与 <code>JSON/</code> 子目录；根目录 <code>export_log.txt</code> 记录上次导出时间。
            </p>
            <p style={{ marginTop: 8 }}>数据仅在本地处理。路径与密钥会保存在本机，关闭应用后自动恢复。</p>
            <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-faint)' }}>
              更新源：GitHub Releases (Panther114/Weport)
            </p>
            <div className="modal-actions">
              <button
                className="secondary-btn"
                type="button"
                disabled={updateBusy}
                onClick={() => void checkForUpdates(true)}
              >
                {updateBusy ? '检查中…' : '检查更新'}
              </button>
              {updateInfo && (
                <button className="primary-btn" type="button" disabled={updateBusy} onClick={() => void installUpdate()}>
                  安装 v{updateInfo.version}
                </button>
              )}
              <button className="secondary-btn" type="button" onClick={() => setAboutOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
