import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchPublicClones, formatDate } from '../api/client'
import type { PublicClone } from '../api/client'

export default function Browse() {
  const navigate = useNavigate()
  const [clones, setClones] = useState<PublicClone[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState('')

  const load = useCallback(async (query: string) => {
    setLoading(true)
    setError('')
    try {
      setClones(await fetchPublicClones(query || undefined))
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(applied)
  }, [load, applied])

  return (
    <div className="browse-page">
      <section className="hero">
        <h1>公开的数字分身</h1>
        <p className="muted">选择一个分身开始对话 —— 语料经双重 PII 脱敏后构建。</p>
        <div className="toolbar">
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault()
              setApplied(q.trim())
            }}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索昵称…"
              aria-label="搜索公开克隆"
            />
            <button type="submit" className="btn btn-ghost">搜索</button>
          </form>
          <button type="button" className="btn btn-ghost" onClick={() => void load(applied)}>
            刷新
          </button>
        </div>
      </section>

      {error && (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost" onClick={() => void load(applied)}>
            重试
          </button>
        </div>
      )}

      {loading ? (
        <div className="page-loading muted">加载中…</div>
      ) : clones.length === 0 ? (
        <div className="empty card">
          <h2>暂无公开克隆</h2>
          <p className="muted">
            还没有人公开数字分身。在 Weport 客户端生成克隆并选择「公开」可见性，即可出现在这里。
          </p>
        </div>
      ) : (
        <div className="clone-grid">
          {clones.map((c) => (
            <article className="clone-card card" key={c.id}>
              <div className="clone-top">
                <span className="avatar">{c.displayName.slice(0, 1)}</span>
                <h3 title={c.displayName}>{c.displayName}</h3>
              </div>
              <div className="chips">
                <span className="chip chip-accent">知识截止 {formatDate(c.knowledgeCutoff)}</span>
                <span className="chip">{c.messageCount.toLocaleString()} 条消息</span>
              </div>
              <div className="clone-foot">
                <span className="muted">{formatDate(c.createdAt)} 创建</span>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => navigate(`/c/${encodeURIComponent(c.id)}`)}
                >
                  开始聊天
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
