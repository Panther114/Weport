import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { ChatHistoryDisplay } from '../../../electron/services/ai/chatHistoryDisplay'
import { copyTextToClipboard } from '../../utils/clipboard'

const historyTimestamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}$/

export default function ChatHistoryCard({ history }: { history: ChatHistoryDisplay }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const { title, rows, hasMore, clipped } = history

  async function copy() {
    const text = rows.map(row => `[${row.time}] ${row.sender}: ${row.text}`).join('\n')
    setCopyState(await copyTextToClipboard(text) ? 'copied' : 'failed')
  }

  return <section className="ai-history-card" aria-label={`${title}聊天记录`}>
    <header>
      <strong title={title}>{title}</strong>
      <span>{rows.length} 条{clipped ? ' · 此页已截断' : hasMore ? ' · 还有更多' : ''}</span>
      {rows.length > 0 && <button type="button" onClick={() => void copy()}>
        {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        <span aria-live="polite">{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '重试复制' : '复制'}</span>
      </button>}
    </header>
    {rows.length > 0 ? <ol tabIndex={0} aria-label="聊天记录内容">
      {rows.map((row, index) => {
        const [, day, minute] = historyTimestamp.exec(row.time) ?? []
        const startsDay = day && !rows[index - 1]?.time.startsWith(`${day} `)

        return <li key={index}>
          {startsDay ? <div className="ai-history-day"><time dateTime={day}>{day}</time></div> : null}
          <time dateTime={day ? row.time.replace(' ', 'T') : undefined} title={row.time}>{minute ?? row.time}</time>{' '}
          <b>{row.sender}</b> <span>{row.text}</span>
        </li>
      })}
    </ol> : <p>此页没有聊天记录</p>}
  </section>
}
