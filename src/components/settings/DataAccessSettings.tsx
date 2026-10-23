import '../v13Controls.css'
import { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import './settingsManagement.css'

type Grant = Awaited<ReturnType<Window['electronAPI']['dataAccess']['list']>>[number]
export default function DataAccessSettings() {
  const [grants, setGrants] = useState<Grant[]>([])
  const [sessions, setSessions] = useState<Array<{ username: string; displayName?: string }>>([])
  const [account, setAccount] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let disposed = false
    void Promise.all([window.electronAPI.dataAccess.list(), window.electronAPI.dataAccess.currentAccount(), window.electronAPI.chat.getSessions()]).then(([rows, id, chats]) => {
      if (disposed) return
      setGrants(rows); setAccount(String(id || '')); setSessions(chats.sessions || [])
    }).catch(error => { if (!disposed) setError(String(error)) })
    return () => { disposed = true }
  }, [])
  const create = async () => {
    setBusy(true); setError(''); setToken('')
    try {
      const result = await window.electronAPI.dataAccess.create({ name, accountId: account, sessionIds: selected,
        from: new Date(`${from}T00:00:00`).getTime(), to: new Date(`${to}T23:59:59.999`).getTime(), expiresAt: Date.now() + 30 * 86400_000 })
      setToken(result.token); setGrants(await window.electronAPI.dataAccess.list())
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const filteredSessions = sessions.filter(session => `${session.displayName || ''} ${session.username}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <section className="panel v13-controls settings-management">
    <div className="panel-head"><h2><KeyRound size={15} />外部客户端数据范围</h2></div>
    <p className="hint">为 MCP / HTTP 客户端分别授权账号、会话和日期范围。令牌 30 天后到期，撤销立即生效。</p>
    {grants.length ? <ul className="settings-grant-list">{grants.map(grant => <li key={grant.id}>
      <div><strong>{grant.name}</strong><span>{grant.sessionIds.length} 个会话 · {new Date(grant.from).toLocaleDateString()} – {new Date(grant.to).toLocaleDateString()}<br />{new Date(grant.expiresAt).toLocaleDateString()} 到期</span></div>
      <button type="button" className="ghost-btn danger" disabled={busy} aria-label={`撤销 ${grant.name} 的授权`} onClick={() => {
        setBusy(true); setError('')
        void window.electronAPI.dataAccess.revoke(grant.id).then(() => window.electronAPI.dataAccess.list()).then(setGrants).catch(error => setError(String(error))).finally(() => setBusy(false))
      }}>撤销</button>
    </li>)}</ul> : <p className="hint">尚未创建客户端授权。</p>}
    <details className="settings-disclosure">
      <summary>添加客户端授权</summary>
      <div className="settings-disclosure-body">
        <p className="hint">管理员令牌可读取当前账号全部数据；这里生成的令牌仅允许指定范围。受限 HTTP 客户端支持会话、消息和搜索接口。</p>
        <label>客户端名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：本地研究助手" /></label>
        <div className="settings-field-pair">
          <label>开始日期<input type="date" max={to || undefined} value={from} onChange={event => setFrom(event.target.value)} /></label>
          <label>结束日期<input type="date" min={from || undefined} value={to} onChange={event => setTo(event.target.value)} /></label>
        </div>
        <fieldset className="settings-session-scope">
          <legend>授权会话 · 已选 {selected.length} 个</legend>
          <input type="search" aria-label="搜索授权会话" placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)} />
          <div className="settings-session-list">
            {filteredSessions.map(session => <label key={session.username}><input type="checkbox" checked={selected.includes(session.username)} onChange={event => setSelected(previous => event.target.checked ? [...previous, session.username] : previous.filter(id => id !== session.username))} /><span>{session.displayName || session.username}</span></label>)}
            {!filteredSessions.length ? <p className="hint">{sessions.length ? '没有匹配的会话' : '当前账号暂无可授权会话'}</p> : null}
          </div>
        </fieldset>
        <div className="settings-action-row"><button type="button" className="primary-btn" disabled={busy || !account || !name.trim() || !from || !to || from > to || !selected.length} onClick={() => void create()}>{busy ? '正在处理…' : '生成受限令牌'}</button></div>
      </div>
    </details>
    {token ? <div className="settings-task-state" role="status"><p>令牌仅在这里显示一次，请交给指定客户端。</p><input aria-label="新客户端令牌" readOnly value={token} onFocus={event => event.target.select()} /><div className="settings-action-row"><button type="button" className="ghost-btn" onClick={() => setToken('')}>隐藏令牌</button></div></div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
