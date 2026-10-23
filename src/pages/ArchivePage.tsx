import { exportDateRange } from '../utils/exportDateRange'
import '../components/v13Controls.css'
import { useCallback, useEffect, useState } from 'react'
import type { ArchiveAnnotations, ArchiveEntry, ArchiveManifest, ArchiveMessage, ArchiveRequest, ArchiveJob, ArchiveSchedule } from '../../electron/services/archive/types'
import { useLiveTask } from '../hooks/useLiveTask'
import './archive.css'

const mediaStatusLabel: Record<string, string> = { original: '原图', display: '显示版', thumbnail: '缩略图', available: '本地文件', 'missing-locally': '本地未下载', 'decryption-failed': '解密失败', unsupported: '暂不支持', 'original-unavailable': '原图不可用', 'not-requested': '未请求媒体' }
const api = () => window.electronAPI.archive
function unwrap<T>(reply: { success: boolean; data?: T; error?: string }): T {
  if (!reply.success) throw Error(reply.error || '归档操作失败')
  return reply.data as T
}
export default function ArchivePage({ accountId }: { accountId: string }) {
  const task = useLiveTask('archive')
  const [entries, setEntries] = useState<ArchiveEntry[]>([])
  const [jobs, setJobs] = useState<ArchiveJob[]>([])
  const [schedules, setSchedules] = useState<ArchiveSchedule[]>([])
  const [sessions, setSessions] = useState<Array<{ username: string; displayName?: string }>>([])
  const [selected, setSelected] = useState<string[]>([])
  const [destination, setDestination] = useState('')
  const [includeMedia, setIncludeMedia] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [mediaPolicy, setMediaPolicy] = useState<ArchiveRequest['mediaPolicy']>('best-available')
  const [opened, setOpened] = useState<{ entry: ArchiveEntry; manifest: ArchiveManifest; annotations: ArchiveAnnotations } | null>(null)
  const [targetIdentity, setTargetIdentity] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [messages, setMessages] = useState<ArchiveMessage[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [media, setMedia] = useState<Record<string, string>>({})
  const [everyMinutes, setEveryMinutes] = useState(1440)
  const [keep, setKeep] = useState(7)
  const reload = useCallback(async () => {
    const status = unwrap(await api().status())
    setEntries(status.entries); setJobs(status.jobs); setSchedules(status.schedules)
  }, [])
  useEffect(() => { void reload().catch(error => setError(String(error))) }, [reload, task.status])
  useEffect(() => {
    let disposed = false
    setSelected([])
    void window.electronAPI.chat.getSessions().then(result => { if (!disposed) setSessions(result.sessions || []) }).catch(() => { if (!disposed) setSessions([]) })
    return () => { disposed = true }
  }, [accountId])
  useEffect(() => {
    if (!opened || !sessionId) return
    let disposed = false
    setMessages([]); setOffset(0); setMedia({}); setHasMore(false)
    const read = targetIdentity ? api().evidence(opened.entry.archiveId, sessionId, targetIdentity).then(reply => {
      const evidence = unwrap(reply)
      return { success: true, data: { messages: [evidence.message], nextOffset: 0, hasMore: false, total: 1 } }
    }) : api().page(opened.entry.archiveId, sessionId, 0, 80, query)
    void read.then(reply => {
      if (disposed) return
      const page = unwrap(reply); setMessages(page.messages); setOffset(page.nextOffset); setHasMore(page.hasMore)
    }).catch(error => { if (!disposed) setError(String(error)) })
    return () => { disposed = true }
  }, [opened, sessionId, query, targetIdentity])
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await run(); await reload() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const request = (): ArchiveRequest => {
    const dateRange = exportDateRange(startDate, endDate)
    return { accountId, destination, sessionIds: selected, includeMedia, mediaPolicy, ...(dateRange ? { dateRange } : {}) }
  }
  const openArchive = async (id: string) => {
    const data = unwrap(await api().open(id)); setOpened(data); setTargetIdentity(''); setSessionId(data.manifest.sessions[0]?.id || '')
  }
  return <div className="archive-page v13-controls">
    <header><h1>归档库</h1><p>归档可在断开微信后独立打开；文件完整性、媒体画质与缺失状态均保留在清单中。</p></header>
    {error ? <p role="alert" className="archive-error">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {task.status === 'running' ? <section className="panel"><p role="status">{task.message} · {Math.round(task.progress)}%</p><progress max={100} value={task.progress} /><button className="secondary-btn" onClick={() => void action(async () => { unwrap(await api().cancel()) })}>取消归档</button></section> : null}
    <section className="panel archive-controls">
      <h2>新建归档</h2>
      <div className="archive-create-grid">
      <label className="archive-session-picker">会话<select multiple size={5} value={selected} onChange={event => setSelected(Array.from(event.target.selectedOptions, option => option.value))}>{sessions.map(row => <option value={row.username} key={row.username}>{row.displayName || row.username}</option>)}</select></label>
      <div className="archive-destination"><span className="archive-field-label">保存位置</span><div className="archive-inline-actions"><span className="archive-path" title={destination}>{destination || '尚未选择目录'}</span><button className="secondary-btn" disabled={busy} onClick={() => void action(async () => { const folder = unwrap(await api().chooseDirectory()); if (folder) setDestination(folder) })}>{destination ? '更改目录' : '选择目录'}</button></div></div>
      <div className="archive-date-fields">
      <label>开始时间（可选）<input type="datetime-local" step="1" value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
      <label>结束时间（可选）<input type="datetime-local" step="1" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
      </div>
      <p className="archive-field-note">使用本地时间，精确到秒，包含起止时刻；留空表示不限。</p>
      <div className="archive-media-fields">
      <label className="archive-checkbox"><input type="checkbox" checked={includeMedia} onChange={event => setIncludeMedia(event.target.checked)} />保存本地媒体</label>
      <label>图片画质<select disabled={!includeMedia} value={mediaPolicy} onChange={event => setMediaPolicy(event.target.value as ArchiveRequest['mediaPolicy'])}><option value="best-available">本地最佳画质（明确标注缩略图）</option><option value="original-only">仅原图（无法证明为原图时标记缺失）</option></select></label>
      </div>
      </div>
      <div className="archive-create-actions">
      <button className="primary-btn" disabled={busy || task.status === 'running' || !accountId || !selected.length || !destination} onClick={() => void action(async () => {
        const preflight = unwrap(await api().preflight(request()))
        if (!preflight.ok) throw Error(preflight.errors.join('；'))
        setNotice(preflight.warnings.join('；'))
        const entry = unwrap(await api().create(request())); await openArchive(entry.archiveId)
      })}>检查并创建归档</button>
      <span className="archive-field-note">已选 {selected.length} 个会话</span>
      </div>
      <details><summary>定期归档与保留</summary><p>仅在本应用运行且计划账号已连接时执行。保留最新指定份数；超额归档仅在新归档完整覆盖原消息、媒体和标注且文件未被修改时回收空间，其余归档会保留并显示保护原因。旧版归档不会自动删除。</p>
        <label>间隔（分钟）<input type="number" min={15} max={43200} value={everyMinutes} onChange={event => setEveryMinutes(Number(event.target.value))} /></label>
        <label>保留最新归档数<input type="number" min={1} max={100} value={keep} onChange={event => setKeep(Number(event.target.value))} /></label>
        <button className="secondary-btn" disabled={busy || !selected.length || !destination} onClick={() => void action(async () => { unwrap(await api().saveSchedule({ request: request(), enabled: true, everyMinutes, keep })); setNotice('定期归档已启用') })}>启用定期归档</button>
        {schedules.map(schedule => <p key={schedule.id}>每 {schedule.everyMinutes} 分钟 · 保留最新 {schedule.keep} 份及受保护归档 · {schedule.lastError || new Date(schedule.nextRunAt).toLocaleString()} <button className="secondary-btn" onClick={() => void action(async () => { unwrap(await api().removeSchedule(schedule.id)) })}>移除计划</button></p>)}
      </details>
    </section>
    <section className="panel archive-library"><div className="archive-section-heading"><h2>已保存归档</h2><button className="secondary-btn" disabled={busy} onClick={() => void action(async () => { const folder = unwrap(await api().chooseDirectory()); if (folder) { const imported = unwrap(await api().import(folder)); await openArchive(imported.entry.archiveId) } })}>打开已有归档目录</button></div>
      {entries.map(entry => <article key={entry.archiveId} className="archive-entry"><div className="archive-entry-info"><strong>{new Date(entry.createdAt).toLocaleString()}</strong> · {entry.sessions} 个会话 · {entry.messages} 条消息 {entry.retentionReason ? <p>{entry.retentionState === 'cleaning' ? '清理待续跑：' : '受保护：'}{entry.retentionReason}</p> : null}</div><div className="archive-inline-actions"><button className="secondary-btn" disabled={busy || entry.retentionState === 'cleaning'} onClick={() => void action(() => openArchive(entry.archiveId))}>离线打开</button><button className="secondary-btn" disabled={busy || entry.retentionState === 'cleaning'} onClick={() => void action(async () => { const folder = unwrap(await api().chooseDirectory()); if (folder) { const result = unwrap(await api().restore(entry.archiveId, folder)); setNotice('已复制并验证：' + result.path) } })}>复制并验证</button></div></article>)}
      {jobs.filter(job => ['failed', 'aborted', 'interrupted'].includes(job.state)).map(job => <p key={job.id}>{job.error || job.stage} <button className="secondary-btn" disabled={busy || task.status === 'running'} onClick={() => void action(async () => { unwrap(await api().create(job.request, job.id)) })}>校验后续跑</button></p>)}
    </section>
    {opened ? <section className="panel archive-reader"><h2>离线阅读</h2><p>{opened.entry.path}</p><p>媒体状态：{Object.entries(opened.manifest.mediaOutcomes).map(([key, count]) => `${mediaStatusLabel[key] || key} ${count}`).join(' · ') || '未请求媒体'}</p>
      <details><summary>归档书签 · {opened.annotations.bookmarks.length}</summary>
        {opened.annotations.bookmarks.map((bookmark, index) => <p key={`${bookmark.sessionId}:${bookmark.sourceIdentityHash || index}`}>
          {opened.manifest.sessions.find(session => session.id === bookmark.sessionId)?.name || bookmark.sessionId} · {bookmark.note || '已保存的消息'}
          {bookmark.resolved && bookmark.sourceIdentityHash ? <button className="secondary-btn" onClick={() => { setSessionId(bookmark.sessionId); setTargetIdentity(bookmark.sourceIdentityHash!); setQuery('') }}>打开书签消息</button> : <span> · 来源未能唯一匹配，原标注已保留</span>}
        </p>)}
      </details>
      <div className="archive-reader-filters"><label>归档会话<select value={sessionId} onChange={event => { setSessionId(event.target.value); setTargetIdentity('') }}>{opened.manifest.sessions.map(session => <option key={session.id} value={session.id}>{session.name} · {session.count} 条</option>)}</select></label>
      <label>在归档中筛选<input value={query} onChange={event => { setQuery(event.target.value); setTargetIdentity('') }} /></label></div>
      {targetIdentity ? <button className="secondary-btn" onClick={() => setTargetIdentity('')}>返回完整会话</button> : null}
      {messages.map(message => <article key={message.sourceIdentityHash} className="archive-message"><small>{new Date(message.createTime * 1000).toLocaleString()} · {message.senderDisplayName || message.senderUsername || ''}</small><p>{message.content}</p><small>{mediaStatusLabel[message.mediaOutcome?.status || ''] || ''}</small>
        <details className="archive-evidence"><summary>原始内容与精确来源</summary>
          <p>数据库：{message.sourceIdentity?.db} · 表：{message.sourceIdentity?.table} · 消息 ID：{message.sourceIdentity?.localId}</p>
          <p>证据 ID：{message.sourceIdentityHash}</p><pre>{message.rawContent || message.content}</pre>
          <button className="secondary-btn" onClick={() => void action(async () => { const evidence = unwrap(await api().evidence(opened.entry.archiveId, sessionId, message.sourceIdentityHash)); await navigator.clipboard.writeText(evidence.uri); setNotice('已复制精确证据引用') })}>复制证据引用</button>
        </details>
        {message.mediaOutcome?.relativePath ? <button className="secondary-btn" onClick={() => void action(async () => { const result = unwrap(await api().media(opened.entry.archiveId, sessionId, message.sourceIdentityHash)); if (result.available && result.url) setMedia(previous => ({ ...previous, [message.sourceIdentityHash]: result.url! })) })}>读取本地媒体</button> : null}
        {media[message.sourceIdentityHash] ? message.localType === 3 ? <img src={media[message.sourceIdentityHash]} alt="归档图片" loading="lazy" /> : <a href={media[message.sourceIdentityHash]} target="_blank" rel="noreferrer">打开归档附件</a> : null}
        <button className="secondary-btn" onClick={() => void action(async () => { const annotations = unwrap(await api().bookmark(opened.entry.archiveId, sessionId, message.sourceIdentityHash, '')); setOpened(previous => previous ? { ...previous, annotations } : previous); setNotice('已保存归档书签') })}>保存书签</button>
      </article>)}
      {hasMore ? <button className="secondary-btn" disabled={busy} onClick={() => void action(async () => { const page = unwrap(await api().page(opened.entry.archiveId, sessionId, offset, 80, query)); setMessages(previous => [...previous, ...page.messages]); setOffset(page.nextOffset); setHasMore(page.hasMore) })}>读取下一页</button> : null}
    </section> : null}
  </div>
}
