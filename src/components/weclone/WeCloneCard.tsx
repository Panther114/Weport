import { useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  CalendarDays,
  ChevronDown,
  FileText,
  Loader2,
  MessageSquareText,
  Settings2,
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
  /**
   * 这两项不是模型写的，是**算出来的**（v1.0.1）。
   *
   * 放在同一列表里但排在最后：用户读档案是为了看"它了解我多少"，而这两项回答
   * 的是另一个问题 —— "这次生成到底把我的数据怎么处理了"。后者是能验证的事实，
   * 也是用户抱怨"它根本不了解我"时唯一能自查的东西。
   */
  { key: 'fingerprint', label: '说话习惯 · 本地统计（非模型推断）' },
  { key: 'corpus', label: '语料处理摘要' },
]

function formatDateTime(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 毫秒 → 「12 分 30 秒」/「45 秒」/「1 小时 4 分」 */
function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

interface WeCloneCardProps {
  clone: WeCloneListItem
  onDeleteRequest: (clone: WeCloneListItem) => void
  /** 打开对话抽屉（对话在本机完成，不需要任何服务器） */
  onChat: (clone: WeCloneListItem) => void
  /** 打开这个克隆的行为设置（拒答方式等） */
  onSettings: (clone: WeCloneListItem) => void
}

export default function WeCloneCard({ clone, onDeleteRequest, onChat, onSettings }: WeCloneCardProps) {
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
        {/* 「数据量过大已截断」这句话在 v1.0.1 之后基本不会再出现：阈值从
            15 万条/会话提到 1200 万，正常使用碰不到。保留分支是为了万一真的
            撞上硬护栏时说出来，而不是让界面继续假装一切正常。 */}
        {clone.truncated && <span title="语料超过了硬性安全上限">· 语料超出安全上限，已截断</span>}
      </div>

      {/*
        生成质量小结。
        用户看不到生成过程，只能看到结果 —— 这几行数字是他判断"这次生成到底
        干了多少活"的唯一依据：读了多少条、切了多少段、花了多久、多少 token。
        没有它们，"深度提炼"和"随便糊一份"在界面上长得一模一样。
      */}
      {(clone.shardCount ?? 0) > 0 && (
        <div className="weclone-card-depth">
          <span title="语料按时间切成的段数，每段单独提炼过">
            {clone.shardCount} 段历史
          </span>
          {clone.corpusStart && <span title="语料覆盖的时间范围">{clone.corpusStart} 起</span>}
          {(clone.elapsedMs ?? 0) > 0 && <span title="本次生成耗时">{formatDuration(clone.elapsedMs!)}</span>}
          {(clone.tokensIn ?? 0) > 0 && (
            <span title="本次生成输入/输出 token（模型返回的用量）">
              {(clone.tokensIn! + (clone.tokensOut ?? 0)).toLocaleString()} tok
            </span>
          )}
          {(clone.shardFailures ?? 0) > 0 && (
            <span className="weclone-card-warn" title="这些段落未能用模型提炼，改用本地统计兜底">
              {clone.shardFailures} 段兜底
            </span>
          )}
          {clone.redacted === false ? (
            <span className="weclone-card-warn" title="生成时没有做敏感信息脱敏">未脱敏</span>
          ) : (
            (clone.piiHits ?? 0) > 0 && <span title="生成过程中被遮蔽的敏感信息处数">脱敏 {clone.piiHits} 处</span>
          )}
        </div>
      )}

      <div className="weclone-card-actions">
        <button
          className="primary-btn weclone-card-chat"
          type="button"
          title="和这个 WeClone 对话（人格档案 + 本地检索，全程不上传）"
          onClick={() => onChat(clone)}
        >
          <MessageSquareText size={13} />
          开始对话
        </button>
        <button
          className="ghost-btn compact"
          type="button"
          title="这个克隆的行为设置（敏感话题怎么处理）"
          onClick={() => onSettings(clone)}
        >
          <Settings2 size={13} />
          行为
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
