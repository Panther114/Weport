import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, Plug, RefreshCw, Trash2 } from 'lucide-react'

/**
 * Connectors panel — the connect flow for third-party tools.
 *
 * The panel is deliberately one-card-per-service instead of a wizard: there is
 * exactly one credential field, the verification result is shown inline, and the
 * token input is cleared on success. Credentials never travel back from the main
 * process, so the card shows a mask (`····9f2c`) once connected — re-typing is the
 * only way to replace one, which is also how it stays out of screenshots.
 */
export default function ConnectorsPanel() {
  const [connectors, setConnectors] = useState<ConnectorView[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>('')
  const [message, setMessage] = useState<{ id: string; kind: 'ok' | 'error'; text: string } | null>(null)
  const [targets, setTargets] = useState<Record<string, ConnectorTarget[]>>({})
  const [allowAgentWrite, setAllowAgentWrite] = useState(true)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const [list, agentSettings] = await Promise.all([
        window.electronAPI.connectors.list(),
        window.electronAPI.connectors.getAgentSettings(),
      ])
      setConnectors(Array.isArray(list) ? list : [])
      setAllowAgentWrite(agentSettings?.allowAgentWrite !== false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const connect = async (id: string) => {
    const token = String(drafts[id] || '').trim()
    if (!token) {
      setMessage({ id, kind: 'error', text: '请先粘贴 API 令牌' })
      return
    }
    setBusy(id)
    setMessage(null)
    try {
      const result = await window.electronAPI.connectors.connect(id, token)
      if (!result.success) {
        setMessage({ id, kind: 'error', text: result.error || '连接失败' })
        return
      }
      setDrafts((prev) => ({ ...prev, [id]: '' }))
      setMessage({ id, kind: 'ok', text: '连接成功，令牌已验证并加密存储' })
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const verify = async (id: string) => {
    setBusy(id)
    setMessage(null)
    try {
      const result = await window.electronAPI.connectors.verify(id)
      setMessage({ id, kind: result.success ? 'ok' : 'error', text: result.success ? '令牌仍然有效' : result.error || '验证失败' })
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const disconnect = async (id: string) => {
    setBusy(id)
    setMessage(null)
    try {
      await window.electronAPI.connectors.disconnect(id)
      setTargets((prev) => ({ ...prev, [id]: [] }))
      setMessage({ id, kind: 'ok', text: '已断开，令牌已从本机删除' })
      await refresh()
    } finally {
      setBusy('')
    }
  }

  const loadTargets = async (id: string) => {
    setBusy(id)
    setMessage(null)
    try {
      const result = await window.electronAPI.connectors.listTargets(id)
      if (!result.success) {
        setMessage({ id, kind: 'error', text: result.error || '读取失败' })
        return
      }
      setTargets((prev) => ({ ...prev, [id]: result.data || [] }))
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="panel connectors-panel">
      <div className="panel-head">
        <h2>
          <Plug size={15} />
          连接器
        </h2>
        <span className="status-bar-note">让 Weport 把整理结果写进你在用的第三方工具</span>
      </div>

      {loading ? (
        <p className="hint">正在读取连接状态…</p>
      ) : (
        connectors.map((connector) => {
          const { descriptor, connected } = connector
          const failed = connected && connector.lastCheck?.ok === false
          return (
            <div className="connector-card" key={connector.id} data-connected={connected}>
              <div className="connector-head">
                <div className="connector-title">
                  <strong>{descriptor.name}</strong>
                  <span className="connector-state" data-state={failed ? 'error' : connected ? 'ok' : 'idle'}>
                    {failed ? (
                      <>
                        <AlertCircle size={13} /> 令牌失效
                      </>
                    ) : connected ? (
                      <>
                        <CheckCircle2 size={13} /> 已连接 {connector.credentialHint}
                      </>
                    ) : (
                      '未连接'
                    )}
                  </span>
                </div>
                <p className="connector-desc">{descriptor.description}</p>
              </div>

              {failed && connector.lastCheck?.error ? (
                <p className="connector-error">
                  <AlertCircle size={13} /> {connector.lastCheck.error}
                </p>
              ) : null}

              {!connected ? (
                <>
                  <ol className="connector-help">
                    {descriptor.credentialHelp.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <div className="connector-field">
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={descriptor.credentialPlaceholder}
                      value={drafts[connector.id] || ''}
                      onChange={(event) => setDrafts((prev) => ({ ...prev, [connector.id]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void connect(connector.id)
                      }}
                    />
                    <button className="primary-btn" type="button" disabled={busy === connector.id} onClick={() => void connect(connector.id)}>
                      {busy === connector.id ? '正在验证…' : '保存并连接'}
                    </button>
                  </div>
                  <button
                    className="link-btn"
                    type="button"
                    onClick={() => void window.electronAPI.shell.openExternal(descriptor.credentialUrl)}
                  >
                    <ExternalLink size={13} /> 打开 {descriptor.name} 开发者设置
                  </button>
                </>
              ) : (
                <div className="connector-actions">
                  <button className="secondary-btn" type="button" disabled={busy === connector.id} onClick={() => void verify(connector.id)}>
                    <RefreshCw size={13} /> 重新验证
                  </button>
                  {descriptor.capabilities.hasTargets ? (
                    <button className="secondary-btn" type="button" disabled={busy === connector.id} onClick={() => void loadTargets(connector.id)}>
                      查看可写入的目标
                    </button>
                  ) : null}
                  <button className="secondary-btn danger" type="button" disabled={busy === connector.id} onClick={() => void disconnect(connector.id)}>
                    <Trash2 size={13} /> 断开
                  </button>
                </div>
              )}

              {(targets[connector.id] || []).length > 0 ? (
                <ul className="connector-targets">
                  {(targets[connector.id] || []).slice(0, 24).map((target) => (
                    <li key={`${connector.id}-${target.id}`}>
                      <span className="connector-target-name">{target.name}</span>
                      <em>{target.kind === 'inbox' ? '默认' : target.kind === 'label' ? '标签' : '项目'}</em>
                    </li>
                  ))}
                  {(targets[connector.id] || []).length > 24 ? <li className="hint">仅显示前 24 个…</li> : null}
                </ul>
              ) : null}

              {message?.id === connector.id ? (
                <p className="connector-message" data-kind={message.kind}>
                  {message.kind === 'ok' ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />} {message.text}
                </p>
              ) : null}
            </div>
          )
        })
      )}

      <div className="setting-row connector-agent-row">
        <div className="setting-label">
          <AlertCircle size={14} />
          <div>
            <strong>允许 WeportAI 与定时代理创建待办</strong>
            <span className="hint">
              关闭后，AI 只能读取项目/标签列表，不能写入。定时代理（WeBot）通过同一开关受控。
            </span>
          </div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={allowAgentWrite}
            onChange={(event) => {
              const next = event.target.checked
              setAllowAgentWrite(next)
              void window.electronAPI.connectors.setAgentSettings({ allowAgentWrite: next })
            }}
          />
          <span className="track" />
        </label>
      </div>
    </section>
  )
}
