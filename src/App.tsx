import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PlugZap, Download, ShieldCheck, Bell, Eye, EyeOff } from 'lucide-react'

type Tab = 'connect' | 'export' | 'antirecall' | 'notifications'
type Format = 'txt' | 'json'
type ToastKind = 'ok' | 'err' | 'info'
type Toast = { id: number; kind: ToastKind; title: string; body?: string }

type Account = {
  wxid: string
  modifiedTime: number
  nickname?: string
  avatarUrl?: string
}

type ExportLogInfo = {
  path: string
  txt: string | null
  json: string | null
  exists: boolean
}

type AntiRevokeSession = {
  username: string
  displayName?: string
  type?: number
  avatarUrl?: string
}

const DEFAULT_DB_HINT = String.raw`C:\Users\<you>\Documents\xwechat_files`
let toastSeq = 1

const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ size?: number | string; strokeWidth?: number | string }> }> = [
  { id: 'connect', label: '连接微信', icon: PlugZap },
  { id: 'export', label: '导出数据', icon: Download },
  { id: 'antirecall', label: '防撤回', icon: ShieldCheck },
  { id: 'notifications', label: '消息通知', icon: Bell },
]

const FEATURE_LOCK_TIP = '请先获取解密密钥后再使用'

function MarkIcon() {
  // 顶栏品牌图标：真实应用图标（唯一来源 assets/branding/weport-icon.jpg
  // → assets/icons/icon.png → public/icon.png）
  return <img className="mark-img" src="icon.png" alt="Weport" draggable={false} />
}

export default function App() {
  const [version, setVersion] = useState('')
  const [tab, setTab] = useState<Tab>('connect')
  const [dbPath, setDbPath] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [format, setFormat] = useState<Format>('txt')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedWxid, setSelectedWxid] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyStatus, setKeyStatus] = useState('')
  const [keyHookReady, setKeyHookReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState('')
  const [progress, setProgress] = useState<any | null>(null)
  const [exportLog, setExportLog] = useState<ExportLogInfo | null>(null)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [startupSupported, setStartupSupported] = useState(true)
  const [startupReason, setStartupReason] = useState<string | undefined>()
  const [silentStartup, setSilentStartup] = useState(false)
  const [closeToTray, setCloseToTray] = useState(true)
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body?: string } | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastTimers = useRef<Map<number, number>>(new Map())
  const [antiRevokeSessions, setAntiRevokeSessions] = useState<AntiRevokeSession[]>([])
  const [antiRevokeInstalled, setAntiRevokeInstalled] = useState<Record<string, boolean>>({})
  const [antiRevokeBusy, setAntiRevokeBusy] = useState(false)
  const [notifyListening, setNotifyListening] = useState(false)

  const api = window.electronAPI

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

  const persist = useCallback((patch: { dbPath?: string; decryptKey?: string; exportPath?: string; wxid?: string; format?: Format }) => {
    if (patch.dbPath !== undefined) void api.config.set('dbPath', patch.dbPath)
    if (patch.decryptKey !== undefined) void api.config.set('decryptKey', patch.decryptKey)
    if (patch.exportPath !== undefined) void api.config.set('exportPath', patch.exportPath)
    if (patch.wxid !== undefined) void api.config.set('myWxid', patch.wxid)
    if (patch.format !== undefined) void api.config.set('exportFormat', patch.format)
  }, [api])

  const refreshExportLog = useCallback(async (path: string) => {
    if (!path.trim()) {
      setExportLog(null)
      return
    }
    try {
      setExportLog(await api.export.getExportLog(path.trim()))
    } catch {
      setExportLog(null)
    }
  }, [api])

  const refreshAccounts = useCallback(async (path: string) => {
    if (!path.trim()) {
      setAccounts([])
      setSelectedWxid('')
      return
    }
    try {
      const list = await api.dbPath.scanWxids(path.trim())
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
  }, [api, pushToast])

  const detectDb = useCallback(async () => {
    setBusy(true)
    setBusyLabel('正在扫描微信数据目录…')
    try {
      const result = await api.dbPath.autoDetect()
      if (result.success && result.path) {
        setDbPath(result.path)
        void persist({ dbPath: result.path })
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
  }, [api, pushToast, refreshAccounts, persist])

  const loadAccountKey = useCallback(async (wxid: string) => {
    if (!wxid) {
      setDecryptKey('')
      return
    }
    try {
      const wxidConfigs = (await api.config.get('wxidConfigs')) || {}
      const cfg = wxidConfigs[wxid]
      setDecryptKey(typeof cfg?.decryptKey === 'string' ? cfg.decryptKey : '')
    } catch {
      setDecryptKey('')
    }
  }, [api])

  const saveAccountKey = useCallback(async (wxid: string, key: string) => {
    if (!wxid || !key) return
    try {
      const wxidConfigs = (await api.config.get('wxidConfigs')) || {}
      wxidConfigs[wxid] = { decryptKey: key, updatedAt: Date.now() }
      void api.config.set('wxidConfigs', wxidConfigs)
    } catch { /* noop */ }
  }, [api])

  const selectAccount = useCallback((wxid: string) => {
    setSelectedWxid(wxid)
    void persist({ wxid })
    void loadAccountKey(wxid)
  }, [persist, loadAccountKey])

  useEffect(() => {
    void api.app.getVersion().then(setVersion).catch(() => undefined)

    ;(async () => {
      try {
        const last = await api.config.get('lastTab')
        if (TABS.some((t) => t.id === last)) setTab(last)
      } catch { /* noop */ }
      try {
        const db = await api.config.get('dbPath')
        if (typeof db === 'string' && db) setDbPath(db)
        const out = await api.config.get('exportPath')
        if (typeof out === 'string' && out) {
          setExportPath(out)
          await refreshExportLog(out)
        }
        const wxid = await api.config.get('myWxid')
        if (typeof wxid === 'string' && wxid) setSelectedWxid(wxid)
        const fmt = await api.config.get('exportFormat')
        if (fmt === 'json' || fmt === 'txt') setFormat(fmt)
        const notif = await api.config.get('notificationEnabled')
        setNotificationsEnabled(notif === true)
        const silent = await api.config.get('silentStartup')
        setSilentStartup(silent === true)
        const close = await api.config.get('windowCloseBehavior')
        setCloseToTray(close !== 'quit')
        if (db) {
          await refreshAccounts(String(db))
          await loadAccountKey(String(wxid || ''))
        } else {
          await detectDb()
        }
      } catch {
        await detectDb()
      }
    })()

    const unsubs = [
      api.key.onDbKeyStatus((payload) => {
        setKeyStatus(payload.message)
        if (payload.message.includes('已准备就绪') || payload.message.includes('可以登录') || payload.message.includes('Hook安装成功')) {
          setKeyHookReady(true)
        }
        if (payload.message.includes('密钥获取成功')) {
          setKeyHookReady(false)
        }
      }),
      api.export.onProgress((payload) => {
        setProgress(payload)
        const label = payload.phaseLabel || payload.phase || '导出中'
        const session = payload.currentSession || ''
        setBusyLabel(session ? `${label} · ${session}` : label)
      }),
      api.app.onUpdateAvailable((info) => {
        setUpdateInfo({ version: info.version, body: info.releaseNotes || undefined })
        pushToast('info', `发现新版本 v${info.version}`, '可在顶部横幅更新')
      })
    ]

    void api.app.getLaunchAtStartupStatus().then((s) => {
      setLaunchAtStartup(s.enabled)
      setStartupSupported(s.supported)
      setStartupReason(s.reason)
    }).catch(() => undefined)

    return () => {
      unsubs.forEach((u) => u())
      toastTimers.current.forEach((t) => window.clearTimeout(t))
    }
  }, [api, detectDb, refreshAccounts, refreshExportLog, loadAccountKey, pushToast])

  useEffect(() => {
    void refreshExportLog(exportPath)
  }, [exportPath, refreshExportLog])

  const keyOk = decryptKey.trim().length === 64
  const dbReady = dbPath.trim().length > 0
  const accountReady = selectedWxid.length > 0
  const allReady = dbReady && accountReady && keyOk

  async function pickDbFolder() {
    const selected = await api.dialog.openDirectory({ title: '选择微信数据目录 (xwechat_files)' })
    if (selected) {
      setDbPath(selected)
      void persist({ dbPath: selected })
      await refreshAccounts(selected)
    }
  }

  async function pickExportFolder() {
    const selected = await api.dialog.openDirectory({ title: '选择导出输出文件夹' })
    if (selected) {
      setExportPath(selected)
      void persist({ exportPath: selected })
      await refreshExportLog(selected)
    }
  }

  async function extractKey() {
    if (!dbPath.trim()) {
      pushToast('err', '请先选择微信数据目录')
      return
    }
    setBusy(true)
    setKeyHookReady(false)
    setBusyLabel('正在连接微信进程…')
    pushToast('info', '开始提取密钥', '密钥在登录瞬间捕获。请关闭微信「自动登录」，等待「已准备就绪」后重新登录。', 7000)
    try {
      const result = await api.key.autoGetDbKey()
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setKeyHookReady(false)
        void persist({ decryptKey: result.key })
        void saveAccountKey(selectedWxid, result.key)
        pushToast('ok', '密钥提取成功', '可以开始导出全部聊天记录')
      } else {
        pushToast('err', '密钥提取失败', result.error || '请按左侧说明重试', 10000)
      }
    } catch (e) {
      pushToast('err', '密钥提取失败', String(e), 10000)
    } finally {
      setBusy(false)
      setBusyLabel('')
      setKeyStatus('')
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
    if (!keyOk) {
      pushToast('err', '请先提取或粘贴 64 位解密密钥')
      return
    }

    setBusy(true)
    setProgress({ current: 0, total: 0, phaseLabel: '准备中' })
    setBusyLabel('开始导出全部会话…')

    try {
      const result = await api.export.exportSessions(exportPath.trim(), format)
      await refreshExportLog(exportPath.trim())
      if (result.success) {
        pushToast('ok', '导出完成', `成功 ${result.successCount ?? 0} 个会话 → ${result.formatFolder}/（已覆盖同名文件）`, 7000)
        setProgress((p: any) => (p ? { ...p, current: p.total || p.current, phaseLabel: '完成', phase: 'complete' } : { current: 1, total: 1, phaseLabel: '完成', phase: 'complete' }))
      } else {
        pushToast('err', '导出未完全成功', result.error || `成功 ${result.successCount ?? 0} / 失败 ${result.failCount ?? 0}`, 12000)
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
      const result = await api.export.clearLibrary(exportPath.trim())
      await refreshExportLog(exportPath.trim())
      pushToast('ok', result.success ? '已清空导出库' : '清空失败', result.removed?.length ? `已删除 ${result.removed.length} 项` : result.error)
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
      const result = await api.app.checkForUpdates()
      if (!result.hasUpdate) {
        pushToast('ok', '已是最新版本', `当前 v${version}`)
        setUpdateInfo(null)
        void fromAbout
        return
      }
      setUpdateInfo({ version: result.version || '', body: result.releaseNotes || undefined })
      pushToast('info', `发现新版本 v${result.version}`, '点击更新横幅或下方按钮安装')
    } catch (e) {
      pushToast('err', '检查更新失败', String(e))
    } finally {
      setUpdateBusy(false)
    }
  }

  async function installUpdate() {
    setUpdateBusy(true)
    try {
      const result = await api.app.downloadAndInstall()
      if (result.success) {
        pushToast('ok', '更新已下载', '重启应用完成安装')
      } else {
        pushToast('err', '更新失败', result.error || '未知错误', 10000)
      }
    } catch (e) {
      pushToast('err', '更新失败', String(e), 10000)
    } finally {
      setUpdateBusy(false)
    }
  }

  async function toggleNotifications(on: boolean) {
    setNotificationsEnabled(on)
    await api.config.set('notificationEnabled', on)
    await api.config.set('messagePushEnabled', on)
    if (on) {
      if (!dbReady || !accountReady || !keyOk) {
        pushToast('info', '消息提醒已开启', '完成上面的准备条件后开始监听')
      } else {
        const result = await api.chat.connect()
        setNotifyListening(result.success)
        pushToast(result.success ? 'ok' : 'err', result.success ? '正在监听新消息' : '监听启动失败', result.error)
      }
    } else {
      setNotifyListening(false)
    }
  }

  async function toggleLaunchAtStartup(on: boolean) {
    setLaunchAtStartup(on)
    const result = await api.app.setLaunchAtStartup(on)
    if (!result.success && result.error) pushToast('err', '开机自启设置失败', result.error)
  }

  async function toggleSilentStartup(on: boolean) {
    setSilentStartup(on)
    await api.config.set('silentStartup', on)
    if (launchAtStartup) {
      // 重新写入 Run 键（带/不带 --background）
      await api.app.setLaunchAtStartup(true)
    }
  }

  async function toggleCloseToTray(on: boolean) {
    setCloseToTray(on)
    await api.config.set('windowCloseBehavior', on ? 'tray' : 'quit')
  }

  useEffect(() => {
    // 打开防撤回页时自动加载状态
    if (tab === 'antirecall' && allReady && antiRevokeSessions.length === 0 && !antiRevokeBusy) {
      void refreshAntiRevoke()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, allReady])

  async function refreshAntiRevoke() {
    setAntiRevokeBusy(true)
    try {
      const sessionsResult = await api.chat.getAntiRevokeSessions()
      const sessions: AntiRevokeSession[] = sessionsResult.sessions || []
      setAntiRevokeSessions(sessions)
      if (sessions.length > 0) {
        const ids = sessions.map((s) => s.username)
        const check = await api.chat.checkAntiRevokeTriggers(ids)
        const installed: Record<string, boolean> = {}
        for (const row of check.rows || []) {
          if (row.success) installed[row.sessionId] = row.installed === true
        }
        setAntiRevokeInstalled(installed)
      } else {
        setAntiRevokeInstalled({})
      }
    } catch (e) {
      pushToast('err', '防撤回状态刷新失败', String(e))
    } finally {
      setAntiRevokeBusy(false)
    }
  }

  async function installAntiRevoke(ids: string[]) {
    if (!ids.length) return
    setAntiRevokeBusy(true)
    try {
      const result = await api.chat.installAntiRevokeTriggers(ids)
      const ok = result.rows?.filter((r) => r.success).length || 0
      const failed = result.rows?.filter((r) => !r.success).length || 0
      pushToast(ok > 0 ? 'ok' : 'err', `防撤回安装完成`, `成功 ${ok}${failed ? ` / 失败 ${failed}` : ''}`)
      await refreshAntiRevoke()
    } catch (e) {
      pushToast('err', '防撤回安装失败', String(e))
      setAntiRevokeBusy(false)
    }
  }

  async function uninstallAntiRevoke(ids: string[]) {
    if (!ids.length) return
    setAntiRevokeBusy(true)
    try {
      const result = await api.chat.uninstallAntiRevokeTriggers(ids)
      const ok = result.rows?.filter((r) => r.success).length || 0
      pushToast(ok > 0 ? 'ok' : 'err', `防撤回已还原`, `成功 ${ok}`)
      await refreshAntiRevoke()
    } catch (e) {
      pushToast('err', '防撤回还原失败', String(e))
      setAntiRevokeBusy(false)
    }
  }

  const progressPct = useMemo(() => {
    if (!progress || !progress.total) return progress?.phase === 'complete' ? 100 : 0
    return Math.max(0, Math.min(100, (progress.current / progress.total) * 100))
  }, [progress])

  const formatFolder = format === 'json' ? 'JSON' : 'TXT'
  const installedCount = Object.values(antiRevokeInstalled).filter(Boolean).length
  const isExporting = busy && tab === 'export' && !!progress && progress.phase !== 'complete'

  function switchTab(next: Tab) {
    setTab(next)
    void api.config.set('lastTab', next)
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div
          className="brand"
          role="button"
          tabIndex={0}
          title="关于与更新"
          onClick={() => setAboutOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setAboutOpen(true)
            }
          }}
        >
          <div className="mark" aria-hidden>
            <MarkIcon />
          </div>
          <div className="brand-text">
            <h1>Weport</h1>
            <p>
              微信工具箱 · v{version}
              {busyLabel ? ` · ${busyLabel}` : ''}
            </p>
          </div>
        </div>
        <nav className="tabs" role="tablist" aria-label="功能">
          {TABS.map((t) => {
            const Icon = t.icon
            const locked = t.id !== 'connect' && !allReady
            const button = (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className="tab"
                data-active={tab === t.id}
                disabled={locked}
                onClick={() => switchTab(t.id)}
              >
                <Icon size={15} strokeWidth={1.8} />
                <span>{t.label}</span>
              </button>
            )
            // disabled 按钮不触发原生 title 提示，用外层包裹实现悬停提示
            return locked ? (
              <span key={t.id} className="tab-tip" title={FEATURE_LOCK_TIP} aria-disabled="true">
                {button}
              </span>
            ) : (
              button
            )
          })}
        </nav>
        <div className="top-actions" />
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
        {tab === 'connect' && (
          <div className="two-col">
            <section className="panel connect-loc">
              <div className="panel-head">
                <h2>微信聊天记录数据位置</h2>
                <span className={dbReady ? 'st-ok' : undefined}>{dbReady ? '已连接' : '未选择'}</span>
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
                    onBlur={() => {
                      if (dbPath.trim()) void persist({ dbPath: dbPath.trim() })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && dbPath.trim()) {
                        void persist({ dbPath: dbPath.trim() })
                        void refreshAccounts(dbPath.trim())
                      }
                    }}
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

            <section className="panel connect-key">
              <div className="panel-head">
                <h2>解密密钥</h2>
                <span className={keyOk ? 'st-ok' : 'st-warn'}>{keyOk ? '已就绪' : '待提取'}</span>
              </div>
              <ol className="steps">
                <li>
                  <span className="step-num">1</span>
                  <span>
                    打开微信电脑版，在「设置 → 通用」里<strong>关闭「自动登录」</strong>，
                    然后退出当前登录（或完全退出微信）
                  </span>
                </li>
                <li>
                  <span className="step-num">2</span>
                  <span>
                    点击下方<strong>「提取密钥」</strong>，等待出现「已准备就绪」提示——
                    此时 Weport 已挂接微信进程，正在等待登录
                  </span>
                </li>
                <li>
                  <span className="step-num">3</span>
                  <span>
                    用手机<strong>扫码登录微信</strong>（登录成功的瞬间密钥会被自动捕获并填入）
                  </span>
                </li>
                <li>
                  <span className="step-num">4</span>
                  <span>也可直接粘贴已有的 64 位十六进制密钥（从旧版本或其他工具获取）</span>
                </li>
              </ol>

              {keyHookReady && busy && (
                <div className="callout ready" role="status">
                  Hook 已就绪 — 请现在登录微信，或退出账号后重新登录（可在手机上确认）。
                </div>
              )}
              {keyStatus && (
                <p className="hint" style={{ marginTop: 8 }}>
                  {keyStatus}
                </p>
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
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      setDecryptKey(v)
                      if (v.length === 64) {
                        void persist({ decryptKey: v })
                        void saveAccountKey(selectedWxid, v)
                      }
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                  />
                  <button
                    className="ghost-btn icon-btn-sm"
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    disabled={busy}
                    title={showKey ? '隐藏密钥' : '显示密钥'}
                    aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              <div className="btn-row">
                <button className="primary-btn" type="button" onClick={() => void extractKey()} disabled={busy}>
                  {busy && !progress ? '提取中…' : '提取密钥'}
                </button>
              </div>
              <p className="hint">
                {keyOk ? '密钥已就绪，可在右侧开始导出。' : '密钥在登录瞬间捕获，不是从已登录会话直接读取。'}
              </p>
            </section>

            <section className="panel connect-acc">
              <div className="panel-head">
                <h2>微信账号</h2>
                <span className={accounts.length ? 'st-ok' : undefined}>
                  {accounts.length ? `${accounts.length} 个` : '未选择'}
                </span>
              </div>
              {accounts.length === 0 ? (
                <div className="empty">选择或扫描数据目录后显示账号</div>
              ) : (
                <div className="account-list account-list-row" role="listbox" aria-label="微信账号">
                  {accounts.map((account) => (
                    <button
                      key={account.wxid}
                      type="button"
                      className="account-item"
                      data-active={account.wxid === selectedWxid}
                      role="option"
                      aria-selected={account.wxid === selectedWxid}
                      onClick={() => selectAccount(account.wxid)}
                      disabled={busy}
                    >
                      {account.avatarUrl ? (
                        <img
                          className="account-avatar"
                          src={account.avatarUrl}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            ;(e.target as HTMLImageElement).style.display = 'none'
                          }}
                        />
                      ) : (
                        <span className="account-avatar fallback">
                          {(account.nickname || account.wxid).charAt(0).toUpperCase()}
                        </span>
                      )}
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
          </div>
        )}

        {tab === 'export' && (
          <section className="panel panel-fill">
            <div className="panel-head">
              <h2>导出数据</h2>
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
                  onClick={() => {
                    setFormat('txt')
                    void persist({ format: 'txt' })
                  }}
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
                  onClick={() => {
                    setFormat('json')
                    void persist({ format: 'json' })
                  }}
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
                  onBlur={() => {
                    if (exportPath.trim()) void persist({ exportPath: exportPath.trim() })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && exportPath.trim()) {
                      void persist({ exportPath: exportPath.trim() })
                      void refreshExportLog(exportPath.trim())
                    }
                  }}
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
                  <div
                    className={`progress-fill${!progress.total || progress.phase === 'preparing' ? ' indeterminate' : ''}`}
                    style={progress.total ? { width: `${progressPct}%` } : undefined}
                  />
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
        )}

        {tab === 'antirecall' && (
          <div className="single-col">
            <section className="panel">
              <div className="panel-head">
                <h2>防撤回</h2>
                <span>会话级 WCDB 触发器（安装后无需保持 Weport 运行）</span>
              </div>
              <p className="hint">
                对选中的会话安装防撤回触发器后，对方撤回的消息在微信本地仍会保留可见。
                安装/卸载针对具体会话，微信升级后一般无需重装。
              </p>
              <div className="btn-row">
                <button className="secondary-btn" type="button" disabled={!allReady || antiRevokeBusy} onClick={() => void refreshAntiRevoke()}>
                  {antiRevokeBusy ? '刷新中…' : '刷新状态'}
                </button>
                <button
                  className="primary-btn"
                  type="button"
                  disabled={!allReady || antiRevokeBusy || antiRevokeSessions.length === 0}
                  onClick={() => void installAntiRevoke(antiRevokeSessions.map((s) => s.username))}
                >
                  全部安装 ({installedCount}/{antiRevokeSessions.length})
                </button>
                <button
                  className="danger-btn"
                  type="button"
                  disabled={!allReady || antiRevokeBusy || installedCount === 0}
                  onClick={() => void uninstallAntiRevoke(Object.keys(antiRevokeInstalled).filter((id) => antiRevokeInstalled[id]))}
                >
                  全部还原
                </button>
              </div>
              {!allReady && (
                <p className="hint" style={{ marginTop: 8 }}>
                  完成「连接」页的数据目录 / 账号 / 密钥后即可使用。
                </p>
              )}
              {allReady && antiRevokeSessions.length === 0 && !antiRevokeBusy && (
                <div className="empty" style={{ marginTop: 12 }}>
                  未找到可安装防撤回的会话（联系人或群聊）。点击「刷新状态」重试。
                </div>
              )}
              {antiRevokeSessions.length > 0 && (
                <div className="account-list anti-revoke-list" role="listbox" aria-label="防撤回会话">
                  {antiRevokeSessions.map((s) => {
                    const installed = antiRevokeInstalled[s.username] === true
                    return (
                      <div key={s.username} className="account-item static anti-revoke" data-active={installed}>
                        <span className="ar-name" title={s.username}>{s.displayName || s.username}</span>
                        <span className="ar-id">{s.username}</span>
                        <span className={`badge ${installed ? 'ok' : ''}`}>{installed ? '已安装' : '未安装'}</span>
                        <button
                          className="ghost-btn"
                          type="button"
                          disabled={antiRevokeBusy}
                          onClick={() => (installed ? void uninstallAntiRevoke([s.username]) : void installAntiRevoke([s.username]))}
                        >
                          {installed ? '还原' : '安装'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )}

        {tab === 'notifications' && (
          <div className="single-col">
            <section className="panel">
              <div className="panel-head">
                <h2>消息通知</h2>
                <span>独立置顶弹窗 · 不抢占焦点</span>
              </div>
              <div className="btn-row" style={{ alignItems: 'center' }}>
                <label className="switch-label">
                  <input
                    type="checkbox"
                    checked={notificationsEnabled}
                    onChange={(e) => void toggleNotifications(e.target.checked)}
                  />
                  <span>启用消息提醒</span>
                </label>
                <button className="ghost-btn" type="button" onClick={() => void api.notification.showTest()}>
                  测试通知弹窗
                </button>
              </div>

              <div className="checklist">
                <div className="checklist-title">提醒的前置条件</div>
                {[
                  ['微信数据目录', dbReady, dbReady ? '已连接' : '未选择'],
                  ['微信账号', accountReady, accountReady ? '已选择' : '未选择'],
                  ['解密密钥', keyOk, keyOk ? '已就绪' : '待提取'],
                ].map(([label, ok, detail]) => (
                  <div className="check-row" key={label as string}>
                    <span className={ok ? 'check ok' : 'check'}>{ok ? '✓' : '—'}</span>
                    <span>{label as string}</span>
                    <span className={ok ? 'detail ok' : 'detail'}>{detail as string}</span>
                  </div>
                ))}
              </div>

              <p className="hint">
                {!notificationsEnabled ? (
                  '消息提醒已关闭'
                ) : !allReady ? (
                  '已开启，完成上面的准备条件后开始监听'
                ) : notifyListening ? (
                  <>
                    <span className="status-dot listening" />
                    正在监听当前账号的新消息和撤回事件
                  </>
                ) : (
                  '已开启，连接数据库后开始监听'
                )}
              </p>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>设置</h2>
                <span>启动与后台行为</span>
              </div>
              <div className="setting-row">
                <div>
                  <strong>开机自启</strong>
                  <span className="hint">
                    {startupSupported ? '登录 Windows 后自动启动 Weport' : startupReason || '当前环境不支持'}
                  </span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={launchAtStartup}
                    disabled={!startupSupported}
                    onChange={(e) => void toggleLaunchAtStartup(e.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
              <div className="setting-row">
                <div>
                  <strong>启动时隐藏到托盘</strong>
                  <span className="hint">开机自启时以托盘模式启动，不显示主窗口</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={silentStartup}
                    disabled={!startupSupported}
                    onChange={(e) => void toggleSilentStartup(e.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
              <div className="setting-row">
                <div>
                  <strong>关闭窗口时最小化到托盘而不是退出</strong>
                  <span className="hint">关闭后从系统托盘恢复（托盘菜单「退出」才会完全退出）</span>
                </div>
                <label className="switch">
                  <input type="checkbox" checked={closeToTray} onChange={(e) => void toggleCloseToTray(e.target.checked)} />
                  <span className="track" />
                </label>
              </div>
            </section>
          </div>
        )}
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
          <div className="modal danger" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="clear-title">
            <h3 id="clear-title">清空导出库？</h3>
            <p>将删除下列内容（不可恢复）：</p>
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
            <p>轻量微信聊天记录导出工具。读取本机微信 4.x 数据，导出全部私聊与群聊为 TXT / JSON。</p>
            <p style={{ marginTop: 8 }}>
              导出写入 <code>TXT/</code> 与 <code>JSON/</code> 子目录；根目录 <code>export_log.txt</code> 记录上次导出时间。
            </p>
            <p style={{ marginTop: 8 }}>数据仅在本地处理。路径与密钥会保存在本机，关闭应用后自动恢复。</p>
            <p
              style={{
                marginTop: 10,
                fontSize: 11.5,
                color: 'var(--text-faint)',
                lineHeight: 1.6,
                borderTop: '1px solid var(--line)',
                paddingTop: 10,
              }}
            >
              免责声明：本工具仅供个人学习与本地数据归档使用。使用前请遵守微信《软件许可及服务协议》
              及所在国家/地区的法律法规，且仅允许处理本人账号的本地数据。因不当使用（包括但不限于
              侵犯他人隐私、违反微信服务条款、用于商业用途等）造成的一切后果由使用者自行承担，作者
              不对任何滥用行为负责。
            </p>
            <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-faint)' }}>更新源：GitHub Releases (Panther114/Weport)</p>
            <div className="modal-actions">
              <button className="secondary-btn" type="button" disabled={updateBusy} onClick={() => void checkForUpdates(true)}>
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
