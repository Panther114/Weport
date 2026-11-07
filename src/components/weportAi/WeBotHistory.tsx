import { useEffect, useRef, useState } from 'react'
import AiMarkdown from './AiMarkdown'
import './weBotHistory.css'

type History = Awaited<ReturnType<Window['electronAPI']['weBot']['listTranscripts']>>
type Transcript = Awaited<ReturnType<Window['electronAPI']['weBot']['getTranscript']>>

export default function WeBotHistory() {
  const [history, setHistory] = useState<History>([])
  const [selected, setSelected] = useState('')
  const [transcript, setTranscript] = useState<Transcript>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const revision = useRef(0)
  useEffect(() => {
    let active = true
    const refresh = () => window.electronAPI.weBot.listTranscripts().then(rows => {
      if (active) { setHistory(rows); setLoading(false) }
    }).catch(error => { if (active) { setError(String(error)); setLoading(false) } })
    void refresh()
    const off = window.electronAPI.weBot.onRunFinished(() => void refresh())
    return () => { active = false; off() }
  }, [])
  useEffect(() => {
    const request = ++revision.current
    setTranscript(null)
    setError('')
    if (!selected) return
    void window.electronAPI.weBot.getTranscript(selected).then(data => {
      if (request === revision.current) {
        setTranscript(data)
        if (!data) setError('该运行记录在当前账号中不可用。')
      }
    }).catch(error => { if (request === revision.current) setError(String(error)) })
    return () => { revision.current++ }
  }, [selected])
  return <section className="webot-history" aria-label="WeBot 运行历史">
    <label>选择运行记录
      <select value={selected} onChange={event => setSelected(event.target.value)} aria-label="选择 WeBot 运行记录">
        <option value="">{loading ? '正在加载…' : history.length ? `共 ${history.length} 次运行` : '暂无运行记录'}</option>
        {history.map(chat => <option value={chat.id} key={chat.id}>{new Date(chat.createdAt).toLocaleString('zh-CN')} · {chat.title}</option>)}
      </select>
    </label>
    {error ? <p role="alert">{error}</p> : null}
    {selected && !transcript && !error ? <p role="status">正在读取完整记录…</p> : null}
    {transcript ? <div className="webot-transcript">
      {transcript.messages.map(message => <article key={message.id} className={`webot-transcript-${message.role}`}>
        <div className="webot-transcript-meta">{message.role === 'user' ? '任务' : message.role === 'assistant' ? '助手' : '工具结果'} · {new Date(message.createdAt).toLocaleString('zh-CN')}</div>
        {message.role === 'tool' ? <details><summary>查看工具结果</summary><pre>{message.content}</pre></details> : <AiMarkdown text={message.content} />}
        {message.toolCalls?.map(call => <details key={call.id}><summary>{call.friendly || call.name}</summary><pre>{JSON.stringify(call.args, null, 2)}{call.result ? `\n${call.result}` : ''}</pre></details>)}
      </article>)}
      {transcript.running ? <p role="status">任务仍在执行，完成后可重新选择查看。</p> : null}
    </div> : null}
  </section>
}
