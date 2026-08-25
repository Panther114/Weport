import { useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  CalendarDays,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Loader2,
  MessageSquareText,
  Trash2,
  UploadCloud,
  Users2,
} from 'lucide-react'
import type { WeCloneListItem, WeCloneMdsPreview, WeCloneVisibility } from '../../types/weclone'
import { copyTextToClipboard } from '../../utils/clipboard'
import WeCloneVisibilityToggle from './WeCloneVisibilityToggle'
import WeCloneLocalChat from './WeCloneLocalChat'

const VISIBILITY_LABEL: Record<WeCloneVisibility, string> = {
  private: 'PRIVATE',
  public: 'PUBLIC',
  link: 'LINK',
}

const SOURCE_LABEL: Record<WeCloneListItem['source'], string> = {
  local: 'LOCAL',
  remote: 'REMOTE ONLY',
  both: 'LOCAL+REMOTE',
}

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
  serverBaseUrl: string
  /** 切换可见性；返回服务端下发的分享链接（若有） */
  onVisibilityChange: (clone: WeCloneListItem, v: WeCloneVisibility) => Promise<string | undefined>
  onDeleteRequest: (clone: WeCloneListItem) => void
  /** 本地-only 克隆上传成功后回调（页面据此刷新列表与服务器状态） */
  onUploaded?: () => void
}

export default function WeCloneCard({ clone, serverBaseUrl, onVisibilityChange, onDeleteRequest, onUploaded }: WeCloneCardProps) {
  const [visBusy, setVisBusy] = useState(false)
  const [shareUrl, setShareUrl] = useState(clone.shareUrl || '')
  const [copied, setCopied] = useState(false)
  const [mdOpen, setMdOpen] = useState(false)
  const [mdLoading, setMdLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [mds, setMds] = useState<WeCloneMdsPreview | null>(null)
  const [mdError, setMdError] = useState('')
  const [localChatOpen, setLocalChatOpen] = useState(false)

  const remoteOnly = clone.source === 'remote'
  const needsUpload = !remoteOnly && !clone.serverId
  const busy = visBusy || uploading

  async function handleUpload() {
    if (uploading || !needsUpload) return
    setUploading(true)
    setUploadError('')
    try {
      const r = await window.electronAPI.weclone.upload(clone.id)
      if (r.success && r.serverId) {
        onUploaded?.()
      } else {
        setUploadError(r.error || '上传失败')
      }
    } catch (e) {
      setUploadError(String(e))
    } finally {
      setUploading(false)
    }
  }

  const resolvedShareUrl =
    shareUrl || (clone.serverId && serverBaseUrl ? `${serverBaseUrl}/share/${clone.serverId}` : '')

  async function handleVisibility(v: WeCloneVisibility) {
    if (remoteOnly || busy || v === clone.visibility) return
    setVisBusy(true)
    try {
      const url = await onVisibilityChange(clone, v)
      if (v === 'link' && url) setShareUrl(url)
    } finally {
      setVisBusy(false)
    }
  }

  async function handleCopyShare() {
    if (!resolvedShareUrl) return
    const ok = await copyTextToClipboard(resolvedShareUrl)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }

  async function toggleMds() {
    const next = !mdOpen
    setMdOpen(next)
    if (next && mds === null && !remoteOnly) {
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
    <>
      <article className="v09-panel weclone-card">
      <div className="weclone-card-head">
        <div className="weclone-card-title">
          <strong className="weclone-card-name" title={clone.displayName}>{clone.displayName || clone.wxid || clone.id}</strong>
          <span className="weclone-card-id" title={clone.id}>{clone.id}</span>
        </div>
        <div className="weclone-badges">
          <span className={`badge weclone-badge-${clone.visibility}`} title={`可见性：${VISIBILITY_LABEL[clone.visibility]}`}>
            {VISIBILITY_LABEL[clone.visibility]}
          </span>
          <span className="badge" title={`档案位置：${SOURCE_LABEL[clone.source]}`}>
            {SOURCE_LABEL[clone.source]}
          </span>
          {clone.uploadStatus === 'failed' && (
            <span className="badge weclone-badge-failed" title="上传失败">UPLOAD FAILED</span>
          )}
          {!remoteOnly && clone.uploadStatus === 'local_only' && serverBaseUrl && (
            <span className="badge weclone-badge-muted" title="未上传到服务器">NOT UPLOADED</span>
          )}
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

      {remoteOnly ? (
        <p className="hint" style={{ margin: 0 }}>
          该克隆仅存在于服务器（本机无档案），无法在此修改或删除。
        </p>
      ) : (
        <>
          <div className="chip-group">
            <WeCloneVisibilityToggle value={clone.visibility} disabled={busy} onChange={(v) => void handleVisibility(v)} />
            <button
              className="primary-btn compact"
              type="button"
              disabled={busy || remoteOnly}
              title={remoteOnly ? '仅本地档案可本地对话' : '在本地直接与分身对话，无需 Railway'}
              onClick={() => setLocalChatOpen(true)}
            >
              <MessageSquareText size={13} />
              本地对话
            </button>
            {needsUpload && (
              <button
                className="primary-btn compact"
                type="button"
                disabled={busy}
                title="把本地人格档案上传到 weport.up.railway.app 以获得分享链接"
                onClick={() => void handleUpload()}
              >
                {uploading ? <Loader2 size={13} className="spin" /> : <UploadCloud size={13} />}
                {uploading ? '上传中…' : '上传到服务器'}
              </button>
            )}
            <button className="ghost-btn compact" type="button" disabled={busy} onClick={() => void toggleMds()}>
              {mdLoading ? <Loader2 size={13} className="spin" /> : <FileText size={13} />}
              {mdOpen ? '收起档案' : '查看档案'}
              <ChevronDown size={12} className={mdOpen ? 'chevron open' : 'chevron'} />
            </button>
            <button
              className="ghost-btn compact"
              type="button"
              disabled={busy}
              title="删除本地档案，并同步删除服务器上的克隆"
              onClick={() => onDeleteRequest(clone)}
            >
              <Trash2 size={13} />
              删除
            </button>
          </div>

          {uploadError && (
            <p className="weclone-error-line" style={{ margin: '8px 0 0' }}>
              <AlertTriangle size={12} /> 上传失败：{uploadError}
            </p>
          )}

          {clone.visibility === 'link' && (
            <div className="weclone-share-row">
              {resolvedShareUrl ? (
                <>
                  <input readOnly value={resolvedShareUrl} onFocus={(e) => e.target.select()} spellCheck={false} />
                  <button
                    className="ghost-btn compact"
                    type="button"
                    title={copied ? '已复制' : '复制链接'}
                    aria-label={copied ? '已复制' : '复制链接'}
                    onClick={() => void handleCopyShare()}
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </>
              ) : (
                <span className="hint" style={{ margin: 0 }}>
                  已设为链接可见。上传到私有服务器后可获得可分享的对话链接。
                </span>
              )}
            </div>
          )}

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
        </>
      )}
      </article>
      <WeCloneLocalChat cloneId={clone.id} displayName={clone.displayName || clone.wxid} open={localChatOpen} onClose={() => setLocalChatOpen(false)} />
    </>
  )
}
