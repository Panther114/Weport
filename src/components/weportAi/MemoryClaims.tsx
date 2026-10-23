import '../v13Controls.css'
import { useEffect, useState } from 'react'
import AiMarkdown from './AiMarkdown'

type Claim = Awaited<ReturnType<Window['electronAPI']['ai']['listMemoryClaims']>>[number]
export default function MemoryClaims({ chatId }: { chatId: string }) {
  const [claims, setClaims] = useState<Claim[]>([])
  const [selected, setSelected] = useState('')
  const [statement, setStatement] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const reload = () => window.electronAPI.ai.listMemoryClaims().then(setClaims).catch(error => setError(String(error)))
  useEffect(() => {
    let disposed = false
    void window.electronAPI.ai.listMemoryClaims().then(rows => { if (!disposed) setClaims(rows) }).catch(error => { if (!disposed) setError(String(error)) })
    return () => { disposed = true }
  }, [chatId])
  return <details className="ai-memory-claims v13-controls">
    <summary>有据记忆 · {claims.filter(claim => claim.status !== 'superseded').length}</summary>
    <p>记忆属于当前账号；推断和更正都保留日期及原始记录。</p>
    <button className="secondary-btn" onClick={() => void reload()}>刷新记忆</button>
    {error ? <p role="alert">{error}</p> : null}
    {claims.map(claim => <article key={claim.id}>
      <p><strong>{claim.status === 'superseded' ? '已更正' : claim.kind === 'interpretation' ? '待核实推断' : '有据观察'}</strong> · {new Date(claim.asOf).toLocaleString()}</p>
      <p>{claim.statement}</p>
      {claim.correction ? <p>更正说明：{claim.correction}</p> : null}
      <AiMarkdown text={claim.evidenceIds.map((id, index) => `[证据 ${index + 1}](weport-evidence:${id})`).join(' · ')} />
      {claim.counterEvidenceIds.length ? <AiMarkdown text={'反证 / 需重新核实：' + claim.counterEvidenceIds.map((id, index) => `[来源 ${index + 1}](weport-evidence:${id})`).join(' · ')} /> : null}
      {claim.status !== 'superseded' ? <button className="secondary-btn" onClick={() => { setSelected(claim.id); setStatement(claim.statement); setReason('') }}>更正这条记忆</button> : null}
    </article>)}
    {selected ? <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { await window.electronAPI.ai.correctMemoryClaim({ id: selected, statement, correction: reason }); setSelected(''); await reload() }
      catch (error) { setError(error instanceof Error ? error.message : String(error)) }
      finally { setBusy(false) }
    }}>
      <label>更正后的说法<textarea value={statement} onChange={event => setStatement(event.target.value)} required /></label>
      <label>更正原因<textarea value={reason} onChange={event => setReason(event.target.value)} required /></label>
      <p>手动更正会标为待核实，后续可补充消息证据。</p>
      <button className="primary-btn" disabled={busy || !statement.trim() || !reason.trim()}>保存更正</button>
      <button type="button" className="secondary-btn" onClick={() => setSelected('')}>取消</button>
    </form> : null}
  </details>
}
