import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TelemetryStatus } from '../../../electron/services/telemetryService'
import './telemetryPreferences.css'

/** Mounted once above lazy pages: upgrade notice is independent of DB connection. */
export default function TelemetryPreferences({ settings = false }: { settings?: boolean }) {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const savingRef = useRef(false)
  useEffect(() => {
    let alive = true
    void window.electronAPI.telemetry.status().then(value => { if (alive) setStatus(value) }).catch(() => {})
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const dialog = dialogRef.current
    if (!settings && status?.noticeRequired && dialog && !dialog.open) dialog.showModal()
    return () => { dialog?.close() }
  }, [settings, status?.noticeRequired])
  const decide = async (enabled: boolean) => {
    if (savingRef.current) return
    savingRef.current = true
    const previous = status
    setSaving(true)
    setError('')
    setStatus(value => value ? { ...value, diagnosticsEnabled: enabled } : value)
    try { setStatus(await window.electronAPI.telemetry.decide(enabled)) }
    catch { setStatus(previous); setError('设置保存失败，请重试。') }
    finally { savingRef.current = false; setSaving(false) }
  }
  if (!status || (!settings && !status.noticeRequired)) return null
  const disclosure = <>
    <p>Weport 自动统计安装数量，仅上传随机安装标识和系统平台（Windows、macOS 或 Linux）。此项始终启用，不收集账号、聊天记录、设备名称或文件数据。</p>
    <p>错误报告默认关闭，可自行开启并随时停用。报告仅包含错误类型、错误码、发生次数、应用及运行时版本和代码位置，不含原始日志、消息、联系人、密钥、路径或账号标识。</p>
    {!status.receiverConfigured && <p className="hint">当前版本尚未配置接收服务，不会上传任何数据。</p>}
    {error && <p role="alert">{error}</p>}
  </>
  if (settings) return <section className="panel telemetry-settings">
    <div className="panel-head"><h2>隐私</h2></div>
    <div className="telemetry-preference"><div><strong>安装统计</strong><p className="hint">仅上传随机安装标识和系统平台。</p></div><span className="telemetry-status">始终启用</span></div>
    <label className="telemetry-preference"><div><strong>上传错误报告</strong><p className="hint">默认关闭，可随时停用。</p></div>
      <input type="checkbox" aria-label="上传错误报告" checked={status.diagnosticsEnabled} disabled={saving} onChange={event => void decide(event.target.checked)} />
    </label>
    <details className="telemetry-details"><summary>数据收集说明</summary>{disclosure}</details>
    {error && <p role="alert">{error}</p>}
  </section>
  return createPortal(<dialog ref={dialogRef} className="telemetry-notice" aria-labelledby="telemetry-notice-title" onCancel={event => event.preventDefault()}>
    <h2 id="telemetry-notice-title">Weport 1.2.1：安装统计与错误报告</h2>
    {disclosure}
    <div className="telemetry-actions">
      <button className="secondary-btn" disabled={saving} onClick={() => void decide(false)}>暂不开启</button>
      <button className="primary-btn" disabled={saving} onClick={() => void decide(true)}>开启错误报告</button>
    </div>
  </dialog>, document.body)
}
