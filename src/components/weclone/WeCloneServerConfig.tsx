import { useEffect, useState } from 'react'
import { Eye, EyeOff, Loader2, Server } from 'lucide-react'
import type { WeCloneServerStatusInfo } from '../../types/weclone'

interface WeCloneServerConfigProps {
  /** 测试/保存后把最新状态回传给页面（工具栏指示灯使用） */
  onStatusUpdate: (status: WeCloneServerStatusInfo) => void
  /** 配置保存成功后回调（页面据此刷新克隆列表以合并远端条目） */
  onSaved: () => void
  notify: (kind: 'ok' | 'err' | 'info', title: string, body?: string) => void
}

/** 私有服务器配置（仅 url / token；强制 Provider API Key 见 WeCloneForcedKey） */
export default function WeCloneServerConfig({ onStatusUpdate, onSaved, notify }: WeCloneServerConfigProps) {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<WeCloneServerStatusInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [u, t] = await Promise.all([
          window.electronAPI.config.get('weCloneServerUrl'),
          window.electronAPI.config.get('weCloneServerToken'),
        ])
        if (cancelled) return
        setUrl(typeof u === 'string' ? u : '')
        setToken(typeof t === 'string' ? t : '')
      } catch {
        /* 保持默认空值 */
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function testConnection(): Promise<WeCloneServerStatusInfo | null> {
    try {
      const status = await window.electronAPI.weclone.getServerStatus()
      setTestResult(status)
      onStatusUpdate(status)
      return status
    } catch (e) {
      notify('err', '连接测试失败', String(e))
      return null
    }
  }

  async function handleSave() {
    if (saving) return
    setSaving(true)
    try {
      await window.electronAPI.config.set('weCloneServerUrl', url.trim().replace(/\/+$/, ''))
      await window.electronAPI.config.set('weCloneServerToken', token.trim())
      const status = await testConnection()
      if (status) {
        notify(
          'ok',
          '服务器配置已保存',
          status.online ? `连接正常${status.version ? ` · v${status.version}` : ''}` : '已保存，但当前无法连通服务端'
        )
      }
      onSaved()
    } catch (e) {
      notify('err', '保存失败', String(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleTest() {
    if (testing || !url.trim()) return
    setTesting(true)
    const status = await testConnection()
    setTesting(false)
    if (status) {
      if (status.online) notify('ok', '服务器在线', `${status.baseUrl}${status.version ? ` · v${status.version}` : ''}`)
      else notify('err', '服务器无法连通', status.error || status.baseUrl)
    }
  }

  return (
    <div className="exp-section weclone-exp">
      <div className="weclone-exp-head">
        <span className="weclone-exp-title">
          <Server size={13} />
          私有服务器（可选）
        </span>
        <span className="weclone-exp-sub">不配置时克隆仅保存在本机，无法分享或远程对话</span>
      </div>

      <div className="weclone-server-grid">
        <div className="field">
          <label htmlFor="wcServerUrl">服务地址</label>
          <input
            id="wcServerUrl"
            className="path-input"
            value={url}
            placeholder="https://your-weclone.up.railway.app"
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="wcServerToken">访问令牌（Bearer Token）</label>
          <div className="path-row">
            <input
              id="wcServerToken"
              className="path-input"
              type={showToken ? 'text' : 'password'}
              value={token}
              placeholder="服务端设置的鉴权令牌，留空表示无鉴权"
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="ghost-btn icon-btn-sm"
              type="button"
              onClick={() => setShowToken((v) => !v)}
              title={showToken ? '隐藏令牌' : '显示令牌'}
              aria-label={showToken ? '隐藏令牌' : '显示令牌'}
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>

      <div className="weclone-server-foot">
        <button className="primary-btn" type="button" disabled={!loaded || saving} onClick={() => void handleSave()}>
          {saving ? <Loader2 size={12} className="spin" /> : null}
          {saving ? '保存中…' : '保存并测试'}
        </button>
        <button className="secondary-btn" type="button" disabled={!url.trim() || testing} onClick={() => void handleTest()}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        {testResult && (
          <span className={`hint${testResult.online ? ' ok' : ''}`}>
            {testResult.configured
              ? testResult.online
                ? `● 在线${testResult.version ? ` · v${testResult.version}` : ''}`
                : `● 无法连通${testResult.error ? `（${testResult.error}）` : ''}`
              : '● 未配置服务地址'}
          </span>
        )}
      </div>

      <p className="weclone-server-note">
        部署说明：在 Railway 或自己的服务器上部署 WeClone 服务后，把形如{' '}
        <code>https://xxx.up.railway.app</code> 的地址填入上方（不带末尾斜杠）。上传的人格档案、
        可见性与删除操作都会同步到该服务；留空则一切数据仅保存在本地。
      </p>
    </div>
  )
}
