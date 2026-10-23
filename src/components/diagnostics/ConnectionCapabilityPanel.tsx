import { useState } from 'react'
import './connectionCapability.css'

export default function ConnectionCapabilityPanel() {
  const [report, setReport] = useState<KeyHealthReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inspect = async () => {
    setBusy(true); setError('')
    try { setReport(await window.electronAPI.keyHealth.get()) } catch (err) { setError(String((err as Error).message || err)) } finally { setBusy(false) }
  }
  const c = report?.capabilities
  return <section className="dx-monitor dx-capability" aria-label="连接能力与平台验收">
    <div className="dx-monitor-head">
      <div><h3>连接能力与平台验收</h3><p>逐库认证、媒体文件和实时通知分别检查。单个密钥命中不代表完整历史可用。</p></div>
      <button type="button" className="ghost-btn compact" disabled={busy} onClick={() => void inspect()}>{busy ? '正在校验…' : '检查账号能力'}</button>
    </div>
    {error ? <p className="dx-capability-error" role="alert">{error}</p> : null}
    {c ? <div className="dx-capability-body">
      <p>当前平台：{c.platform}。已有密钥历史覆盖：{c.existingKey.verified}/{c.existingKey.required}，{c.existingKey.complete ? '逐库认证完整，连接仍需原生开库验证' : '尚不完整'}。</p>
      <p>免登录扫描：{c.scan.productionEnabled ? '验收门已开放' : '生产验收门未开放'}。扫描来源覆盖：{c.scan.verified}/{c.scan.required}；{c.scan.available ? '具备只读快照准备条件' : '不可用，禁止用部分覆盖建立连接'}。</p>
      {c.scan.missing.length ? <details><summary>扫描缺少认证的数据库</summary><ul>{c.scan.missing.map(row => <li key={row.id}>{row.id} · {row.status}</li>)}</ul></details> : null}
      <p>媒体密钥：{c.media.authenticated}/{c.media.required}；本地附件是否下载尚未检查。只读快照不提供实时通知或源库写入。</p>
      <p>实时通知：{c.liveNotifications === 'original-key-eligible-not-verified' ? '已有账号密钥具备连接条件，实时投递尚需独立验证' : '不可用'}。macOS/Linux 的真实账号获取、导出与签名验收需在对应设备完成；打包成功不能代替这些验收。</p>
    </div> : report ? <p className="dx-capability-body">当前运行版本尚未提供能力报告。</p> : null}
  </section>
}
