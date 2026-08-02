import { useCallback, useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

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
  message?: string
}

type StatusKind = 'idle' | 'busy' | 'ok' | 'err'

type Format = 'txt' | 'json'

const DEFAULT_DB_HINT = String.raw`C:\Users\<you>\Documents\xwechat_files`

export default function App() {
  const [version, setVersion] = useState('0.0.1')
  const [dbPath, setDbPath] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [format, setFormat] = useState<Format>('txt')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selectedWxid, setSelectedWxid] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [keyReady, setKeyReady] = useState(false)
  const [status, setStatus] = useState('就绪 — 将自动扫描微信数据目录')
  const [statusKind, setStatusKind] = useState<StatusKind>('idle')
  const [busy, setBusy] = useState(false)
  const [keyHelpOpen, setKeyHelpOpen] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [updateInfo, setUpdateInfo] = useState<{ version: string; body?: string } | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.wxid === selectedWxid) || null,
    [accounts, selectedWxid]
  )

  const setBusyStatus = useCallback((message: string) => {
    setStatus(message)
    setStatusKind('busy')
  }, [])

  const setOkStatus = useCallback((message: string) => {
    setStatus(message)
    setStatusKind('ok')
  }, [])

  const setErrStatus = useCallback((message: string) => {
    setStatus(message)
    setStatusKind('err')
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
          setOkStatus(`找到 ${list.length} 个账号`)
        } else {
          setSelectedWxid('')
          setStatus('未在该目录下找到微信账号')
          setStatusKind('idle')
        }
      } catch (e) {
        setAccounts([])
        setSelectedWxid('')
        setErrStatus(String(e))
      }
    },
    [setErrStatus, setOkStatus]
  )

  const detectDb = useCallback(async () => {
    setBusy(true)
    setBusyStatus('正在扫描默认微信数据目录…')
    try {
      const result = await invoke<{ success: boolean; path?: string; error?: string }>('detect_db_path')
      if (result.success && result.path) {
        setDbPath(result.path)
        await refreshAccounts(result.path)
        setOkStatus(`已定位数据目录`)
      } else {
        setStatus(result.error || '未能自动检测，请手动选择目录')
        setStatusKind('idle')
      }
    } catch (e) {
      setErrStatus(String(e))
    } finally {
      setBusy(false)
    }
  }, [refreshAccounts, setBusyStatus, setErrStatus, setOkStatus])

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined)
    void detectDb()

    const unsubs = [
      listen<ExportProgress>('export-progress', (event) => {
        setProgress(event.payload)
        const label = event.payload.phaseLabel || event.payload.phase || '导出中'
        const session = event.payload.currentSession || ''
        setBusyStatus(session ? `${label} · ${session}` : label)
      }),
      listen<string>('engine-status', (event) => {
        const msg = event.payload
        setBusyStatus(msg)
        if (
          msg.includes('已准备就绪') ||
          msg.includes('可以登录') ||
          msg.includes('Hook安装成功') ||
          msg.includes('现在登录')
        ) {
          setKeyReady(true)
        }
      }),
      listen<string>('key-status', (event) => {
        const msg = event.payload
        setBusyStatus(msg)
        if (msg.includes('已准备就绪') || msg.includes('可以登录') || msg.includes('Hook安装成功')) {
          setKeyReady(true)
        }
      })
    ]

    return () => {
      unsubs.forEach((p) => void p.then((u) => u()))
    }
  }, [detectDb, setBusyStatus])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const update = await check()
        if (!cancelled && update) {
          setUpdateInfo({ version: update.version, body: update.body || undefined })
        }
      } catch {
        // updater optional in dev / unsigned builds
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
    }
  }

  async function extractKey() {
    if (!dbPath.trim()) {
      setErrStatus('请先选择微信数据目录')
      return
    }
    setBusy(true)
    setKeyReady(false)
    setKeyHelpOpen(true)
    setBusyStatus('正在连接微信进程…（密钥在登录瞬间捕获，请先关闭微信自动登录）')
    try {
      const result = await invoke<{ success: boolean; key?: string; error?: string }>('extract_db_key', {
        dbPath: dbPath.trim(),
        wxid: selectedWxid || ''
      })
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setKeyReady(false)
        setKeyHelpOpen(false)
        setOkStatus('密钥提取成功')
      } else {
        setErrStatus(result.error || '密钥提取失败')
        setKeyHelpOpen(true)
      }
    } catch (e) {
      setErrStatus(String(e))
      setKeyHelpOpen(true)
    } finally {
      setBusy(false)
    }
  }

  async function runExport() {
    if (!dbPath.trim()) {
      setErrStatus('请选择微信数据目录')
      return
    }
    if (!selectedWxid) {
      setErrStatus('请选择要导出的账号')
      return
    }
    if (!exportPath.trim()) {
      setErrStatus('请选择导出输出文件夹')
      return
    }

    setBusy(true)
    setProgress({ current: 0, total: 0, phaseLabel: '准备中' })
    setBusyStatus('开始导出全部会话…')

    try {
      let key = decryptKey.trim()
      if (!key || key.length !== 64) {
        setKeyReady(false)
        setKeyHelpOpen(true)
        setBusyStatus('未检测到密钥，开始自动提取…关闭微信自动登录，就绪后重新登录')
        const keyResult = await invoke<{ success: boolean; key?: string; error?: string }>('extract_db_key', {
          dbPath: dbPath.trim(),
          wxid: selectedWxid
        })
        if (!keyResult.success || !keyResult.key) {
          throw new Error(
            keyResult.error ||
              '密钥提取失败。密钥需在登录瞬间捕获：关闭自动登录 → 提取密钥 → 提示就绪后重新登录微信。'
          )
        }
        key = keyResult.key
        setDecryptKey(key)
        setKeyHelpOpen(false)
      }

      const result = await invoke<{
        success: boolean
        successCount?: number
        failCount?: number
        error?: string
      }>('export_all', {
        dbPath: dbPath.trim(),
        wxid: selectedWxid,
        decryptKey: key,
        outputDir: exportPath.trim(),
        format
      })

      if (result.success) {
        setOkStatus(`导出完成：成功 ${result.successCount ?? 0} 个会话`)
        setProgress((p) =>
          p
            ? { ...p, current: p.total || p.current, phaseLabel: '完成', phase: 'complete' }
            : { current: 1, total: 1, phaseLabel: '完成', phase: 'complete' }
        )
      } else {
        setErrStatus(result.error || `导出部分失败（成功 ${result.successCount ?? 0} / 失败 ${result.failCount ?? 0}）`)
      }
    } catch (e) {
      setErrStatus(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function installUpdate() {
    setUpdateBusy(true)
    try {
      const update = await check()
      if (!update) {
        setOkStatus('已是最新版本')
        setUpdateInfo(null)
        return
      }
      setBusyStatus(`正在下载 v${update.version}…`)
      await update.downloadAndInstall()
      setOkStatus('更新已安装，即将重启…')
      await relaunch()
    } catch (e) {
      setErrStatus(`更新失败：${String(e)}`)
    } finally {
      setUpdateBusy(false)
    }
  }

  const progressPct = useMemo(() => {
    if (!progress || !progress.total) return progress?.phase === 'complete' ? 100 : 0
    return Math.max(0, Math.min(100, (progress.current / progress.total) * 100))
  }, [progress])

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <div className="mark" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M4 7h16M4 12h10M4 17h14" strokeLinecap="round" />
              <circle cx="18.5" cy="12" r="2.2" fill="currentColor" stroke="none" />
            </svg>
          </div>
          <div className="brand-text">
            <h1>Weport</h1>
            <p>微信聊天记录导出 · v{version}</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="icon-btn" title="关于" onClick={() => setAboutOpen(true)} type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v6" strokeLinecap="round" />
              <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
      </header>

      <main className="main">
        {updateInfo && (
          <div className="update-banner">
            <div>
              <h3>发现新版本 v{updateInfo.version}</h3>
              <p>{updateInfo.body || '建议更新以获得修复与改进。'}</p>
            </div>
            <button className="primary-btn" type="button" disabled={updateBusy} onClick={() => void installUpdate()}>
              {updateBusy ? '更新中…' : '立即更新'}
            </button>
          </div>
        )}

        <section className="panel">
          <div className="panel-head">
            <h2>微信数据目录</h2>
            <span>默认自动扫描</span>
          </div>
          <div className="field">
            <label htmlFor="dbPath">数据文件夹</label>
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
          <div className="path-row" style={{ marginTop: 10 }}>
            <button className="secondary-btn" type="button" onClick={() => void detectDb()} disabled={busy}>
              重新扫描
            </button>
            <button className="secondary-btn" type="button" onClick={() => void extractKey()} disabled={busy}>
              提取密钥
            </button>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="decryptKey">数据库密钥（64 位十六进制，可手动粘贴）</label>
            <input
              id="decryptKey"
              className="path-input"
              value={decryptKey}
              placeholder="自动提取或粘贴已有密钥…"
              onChange={(e) => setDecryptKey(e.target.value.trim())}
              spellCheck={false}
              disabled={busy}
            />
          </div>
          {decryptKey.length === 64 ? (
            <p className="hint ok">数据库密钥已就绪</p>
          ) : (
            <p className="hint">
              密钥在<strong>登录瞬间</strong>捕获（与 WeFlow 相同）。请关闭微信「自动登录」，点击提取密钥，状态变为就绪后重新登录微信。
            </p>
          )}
          {keyReady && busy && (
            <p className="hint ok" role="status">
              Hook 已就绪 — 请现在登录或退出后重新登录微信（手机确认登录）。
            </p>
          )}
          {keyHelpOpen && !decryptKey && !busy && (
            <p className="hint err">
              若一直停在登录相关提示：退出微信账号 → 关闭自动登录 → 再点「提取密钥」→ 看到就绪后再登录。
            </p>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>账号</h2>
            <span>{accounts.length ? `${accounts.length} 个` : '—'}</span>
          </div>
          {accounts.length === 0 ? (
            <div className="empty-accounts">选择或扫描数据目录后显示账号列表</div>
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
                  }}
                  disabled={busy}
                >
                  <div>
                    <strong>{account.nickname || account.wxid}</strong>
                    <span>{account.wxid}</span>
                  </div>
                  {account.wxid === selectedWxid ? <span className="badge ok">当前</span> : <span className="badge">选择</span>}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>导出设置</h2>
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
                placeholder="选择导出目录…"
                onChange={(e) => setExportPath(e.target.value)}
                spellCheck={false}
              />
              <button className="ghost-btn" type="button" onClick={() => void pickExportFolder()} disabled={busy}>
                浏览
              </button>
            </div>
          </div>

          <p className="hint">
            文件命名：<code>群聊_名称.{format}</code> / <code>私聊_名称.{format}</code>
            {selectedAccount ? ` · 账号 ${selectedAccount.nickname || selectedAccount.wxid}` : ''}
          </p>

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
        </section>
      </main>

      <footer className="footer">
        <div className="status-line" role="status">
          <span className={`dot ${statusKind === 'busy' ? 'busy' : statusKind === 'ok' ? 'ok' : statusKind === 'err' ? 'err' : ''}`} />
          <span>{status}</span>
        </div>
        <button className="primary-btn" type="button" disabled={busy} onClick={() => void runExport()}>
          {busy ? '导出中…' : '导出全部'}
        </button>
      </footer>

      {aboutOpen && (
        <div className="modal-backdrop" onClick={() => setAboutOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="about-title">
            <h3 id="about-title">Weport v{version}</h3>
            <p>
              轻量微信聊天记录导出工具。读取本机微信 4.x 数据目录，导出全部私聊与群聊为 TXT 或 JSON。
              支持 CLI 与 GUI，内置自动更新。
            </p>
            <p style={{ marginTop: 8 }}>数据仅在本地处理，不会上传。</p>
            <div className="modal-actions">
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
