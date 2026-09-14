import { useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  CalendarDays,
  ChevronDown,
  FileText,
  Loader2,
  MessageSquareText,
  ShieldCheck,
  Trash2,
  Users2,
} from 'lucide-react'
import type { WeCloneListItem, WeCloneMdsPreview } from '../../types/weclone'

const MD_SECTIONS: Array<{ key: keyof WeCloneMdsPreview; label: string }> = [
  { key: 'profile', label: '人格画像 · profile.md' },
  { key: 'relationships', label: '关系图谱 · relationships.md' },
  { key: 'knowledge', label: '知识与经历 · knowledge.md' },
  { key: 'timeline', label: '时间线 · timeline.md' },
  { key: 'language', label: '语料样例 · language.md' },
]

function formatDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface WeCloneCardProps {
  clone: WeCloneListItem
  onDeleteRequest: (clone: WeCloneListItem) => void
  /** 打开对话抽屉（对话在本机完成，不需要任何服务器） */
  onChat: (clone: WeCloneListItem) => void
}

export default function WeCloneCard({ clone, onDeleteRequest, onChat }: WeCloneCardProps) {
  const [mdOpen, setMdOpen] = useState(false)
  const [mdLoading, setMdLoading] = useState(false)
  const [mds, setMds] = useState<WeCloneMdsPreview | null>(null)
  const [mdError, setMdError] = useState('')

  async function toggleMds() {
    const next = !mdOpen
    setMdOpen(next)
    if (next && mds === null) {
      setMdLoading(true)
      try {
        const r = await window.electronAPI.weclone.get(clone.id)
        if (r.success && r.mds) setMds(r.mds)
        else setMdError(r.error || '读取失败')
      } catch (e) {
        setMdError(String(e))
      } finally {
        setMdLoading(false)
      }
    }
  }

  return (
    <article className="v09-panel weclone-card">
      <div className="weclone-card-head">
        <div className="weclone-card-title">
          <strong className="weclone-card-name" title={clone.displayName}>{clone.displayName || clone.wxid || clone.id}</strong>
          <span className="weclone-card-id" title={clone.id}>{clone.id}</span>
        </div>
        <div className="weclone-badges">
          {/* 只有一个徽标，而且说的是**边界**而不是"上传状态"：v1.0 的承诺就是
              这个克隆只活在这台机器上，把这句话放在最显眼处比放"本机档案"更有用。 */}
          <span className="badge" title="人格档案与语料只保存在本机，对话也在本机完成">
            <ShieldCheck size={10} strokeWidth={2} /> 仅本机
          </span>
        </div>
      </div>

      <div className="weclone-meta">
        <div className="weclone-meta-cell">
          <span><CalendarDays size={10} strokeWidth={1.8} /> 知识截止</span>
          <b>{clone.knowledgeCutoff || '—'}</b>
        </div>
        <div className="weclone-meta-cell">
          <span><MessageSquareText size={10} strokeWidth={1.8} /> 消息</span>
          <b>{clone.messageCount.toLocaleString()}</b>
        </div>
        <div className="weclone-meta-cell">
          <span><Users2 size={10} strokeWidth={1.8} /> 会话</span>
          <b>{clone.sessionCount.toLocaleString()}</b>
        </div>
        <div className="weclone-meta-cell">
          <span><Boxes size={10} strokeWidth={1.8} /> 语料块</span>
          <b>{clone.chunkCount.toLocaleString()}</b>
        </div>
      </div>

      <div className="weclone-card-foot">
        <span>生成于 {formatDateTime(clone.generatedAt)}</span>
        {(clone.piiHits ?? 0) > 0 && <span>· 脱敏 {clone.piiHits} 处</span>}
        {clone.truncated && <span>· 数据量过大已截断</span>}
      </div>

      <div className="weclone-card-actions">
        <button
          className="primary-btn weclone-card-chat"
          type="button"
          title="和这个分身对话（人格档案 + 本地检索，全程不上传）"
          onClick={() => onChat(clone)}
        >
          <MessageSquareText size={13} />
          开始对话
        </button>
      </div>

      <div className="chip-group">
        <button className="ghost-btn compact" type="button" onClick={() => void toggleMds()}>
          {mdLoading ? <Loader2 size={13} className="spin" /> : <FileText size={13} />}
          {mdOpen ? '收起档案' : '查看档案'}
          <ChevronDown size={12} className={mdOpen ? 'chevron open' : 'chevron'} />
        </button>
        <button
          className="ghost-btn compact weclone-card-delete"
          type="button"
          title="删除本机档案与语料（本机是唯一副本，删除后无法恢复）"
          onClick={() => onDeleteRequest(clone)}
        >
          <Trash2 size={13} />
          删除
        </button>
      </div>

      {mdOpen && (
        <div className="weclone-md-view">
          {mdError ? (
            <p className="weclone-error-line"><AlertTriangle size={12} /> {mdError}</p>
          ) : mds === null ? (
            <div className="wp-loading"><Loader2 size={14} className="spin" /> 正在读取档案…</div>
          ) : (
            MD_SECTIONS.map(({ key, label }) => {
              const content = mds[key]
              return (
                <details key={key} className="weclone-md-item" open={Boolean(content) && key === 'profile'}>
                  <summary className="weclone-md-item-head">
                    <FileText size={12} />
                    {label}
                    {!content && <span className="weclone-md-missing">缺失</span>}
                  </summary>
                  {content ? (
                    <pre className="weclone-md-pre">{content}</pre>
                  ) : (
                    <p className="hint" style={{ padding: '0 10px 10px', margin: 0 }}>该档案不存在（可能生成时被跳过）。</p>
                  )}
                </details>
              )
            })
          )}
        </div>
      )}
    </article>
  )
}
