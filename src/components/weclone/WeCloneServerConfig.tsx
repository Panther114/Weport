import { useEffect, useState } from 'react'
import { Copy, ExternalLink, Eye, EyeOff, Loader2 } from 'lucide-react'
import type { WeCloneServerStatusInfo } from '../../types/weclone'

const FIXED_URL = 'https://weport.up.railway.app'

interface WeCloneServerConfigProps {
  /** 测试/保存后把最新状态回传给页面（工具栏指示灯使用） */
  onStatusUpdate: (status: WeCloneServerStatusInfo) => void
  /** 配置保存成功后回调（页面据此刷新克隆列表以合并远端条目） */
  onSaved: () => void
  notify: (kind: 'ok' | 'err' | 'info', title: string, body?: string) => void
}

/** 服务地址已固定为 weport.up.railway.app；仅 token 可配置 */
export default function WeCloneServerConfig({ onStatusUpdate, onSaved, notify }: WeCloneServerConfigProps) {
  const [token, setToken] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<WeCloneServerStatusInfo | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const t = await window.electronAPI.config.get('weCloneServerToken')
        if (cancelled) return
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
      await window.electronAPI.config.set('weCloneServerUrl', FIXED_URL)
      await window.electronAPI.config.set('weCloneServerToken', token.trim())
      const status = await testConnection()
      if (status) {
        notify(
          'ok',
          '配置已保存',
          status.online ? `服务在线${status.version ? ` · v${status.version}` : ''}` : '已保存，但当前无法连通服务'
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
    if (testing) return
    setTesting(true)
    const status = await testConnection()
    setTesting(false)
    if (status) {
      if (status.online) notify('ok', '服务在线', `${status.baseUrl}${status.version ? ` · v${status.version}` : ''}`)
      else notify('err', '服务无法连通', status.error || status.baseUrl)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(FIXED_URL)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      notify('err', '复制失败', FIXED_URL)
    }
  }

  function handleOpen() {
    void window.electronAPI.shell.openExternal(FIXED_URL)
  }

  return (
    <div className="exp-section weclone-exp">
      <div className="weclone-server-grid">
        <div className="field">
          <label>服务地址 · 已固定为 weport.up.railway.app</label>
          <div className="path-row">
            <input
              className="path-input"
              value={FIXED_URL}
              readOnly
              spellCheck={false}
              autoComplete="off"
              aria-label="服务地址 (固定)"
              title={FIXED_URL}
              style={{ opacity: 0.9 }}
            />
            <button
              className="ghost-btn icon-btn-sm"
              type="button"
              onClick={() => void handleCopy()}
              title="复制地址"
              aria-label="复制地址"
            >
              <Copy size={14} />
            </button>
            <button
              className="ghost-btn icon-btn-sm"
              type="button"
              onClick={handleOpen}
              title="在浏览器中打开"
              aria-label="在浏览器中打开"
            >
              <ExternalLink size={14} />
            </button>
          </div>
          {copied && <span className="hint ok" style={{ fontSize: 12 }}>已复制</span>}
        </div>
        <div className="field">
          <label htmlFor="wcServerToken">访问令牌（可选）</label>
          <div className="path-row">
            <input
              id="wcServerToken"
              className="path-input"
              type={showToken ? 'text' : 'password'}
              value={token}
              placeholder="服务端启用鉴权时填写，否则留空"
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
        <button className="secondary-btn" type="button" disabled={testing} onClick={() => void handleTest()}>
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

      <p className="weclone-server-note">服务已固定为 weport.up.railway.app，无需手动配置地址；访问令牌仅在服务端启用鉴权时需要填写。</p>
    </div>
  )
}
