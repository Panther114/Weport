import { useEffect, useState } from 'react'

export default function NotificationCaptureSetting() {
  const [mode, setMode] = useState('compatible')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.electronAPI.config.get('notificationCaptureMode').then(value => {
      if (active) setMode(value === 'live-glass' ? 'live-glass' : 'compatible')
    }).catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [])
  async function change(value: string) {
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.config.set('notificationCaptureMode', value)
      if (result?.success === false) throw new Error(result.error || '保存失败')
      setMode(value)
    } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  return <>
    <div className="setting-row">
      <div className="setting-label"><div><strong>录屏兼容</strong><span className="hint">兼容模式保留卡片外观，不采集桌面，也不设置录屏保护；实时玻璃可能影响 NVIDIA 即时重放。</span></div></div>
      <select className="notification-select" aria-label="通知录屏兼容" value={mode} disabled={busy} onChange={event => void change(event.target.value)}>
        <option value="compatible">兼容模式（默认）</option>
        <option value="live-glass">实时桌面玻璃</option>
      </select>
    </div>
    {error ? <p role="alert" className="wp-error">{error}</p> : null}
  </>
}
