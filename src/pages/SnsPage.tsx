import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarDays,
  CheckSquare,
  ChevronDown,
  Download,
  Images,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Users2,
  X,
} from 'lucide-react'
import type { SnsPost } from '../types/sns'
import { Avatar } from '../components/Avatar'
import { CountUp } from '../components/CountUp'
import { SnsPostItem } from '../components/sns/SnsPostItem'
import { SnsPreviewLightbox } from '../components/sns/SnsPreviewLightbox'
import { ContactSnsTimelineDialog } from '../components/sns/ContactSnsTimelineDialog'
import { SnsExportDialog } from '../components/sns/SnsExportDialog'
import { useEscape } from '../utils/useEscape'
import { EmptyState } from '../components/EmptyState'
import { isSnsVideoUrl } from '../utils/snsParse'

const PAGE_SIZE = 20

interface SnsAuthor {
  username: string
  displayName: string
  avatarUrl?: string
  postCount?: number
}

interface OverviewStats {
  totalPosts: number
  totalFriends: number
  myPosts: number | null
}

interface CacheMigrationStatus {
  needed: boolean
  inProgress: boolean
  totalFiles: number
  items: { label: string; fileCount: number }[]
}

const toDayStart = (ts: number) => Math.floor(new Date(ts * 1000).setHours(0, 0, 0, 0) / 1000)

export default function SnsPage() {
  const [authors, setAuthors] = useState<SnsAuthor[]>([])
  const [authorsLoading, setAuthorsLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [keywordDraft, setKeywordDraft] = useState('')
  const [dateJump, setDateJump] = useState<{ start: number; end: number } | null>(null)
  const [dateDraft, setDateDraft] = useState('')
  const [posts, setPosts] = useState<SnsPost[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [overview, setOverview] = useState<OverviewStats | null>(null)
  const [antiDelete, setAntiDelete] = useState<'unknown' | 'installed' | 'uninstalled'>('unknown')
  const [antiDeleteBusy, setAntiDeleteBusy] = useState(false)
  const [migration, setMigration] = useState<CacheMigrationStatus | null>(null)
  const [migrationProgress, setMigrationProgress] = useState<{ current: number; total: number; status: string } | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [authorDialog, setAuthorDialog] = useState<SnsAuthor | null>(null)
  const [debugPost, setDebugPost] = useState<SnsPost | null>(null)
  const [previewItems, setPreviewItems] = useState<Array<{ src: string; isVideo?: boolean }>>([])
  const [previewIndex, setPreviewIndex] = useState(-1)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const requestSeqRef = useRef(0)
  // 媒体解密产物注册表：postId:mediaIndex → 本地可显示地址（灯箱复用）
  const previewSrcsRef = useRef<Map<string, { src: string; isVideo?: boolean }>>(new Map())

  const activeUsernames = useMemo(() => Array.from(selected), [selected])
  const scopeKey = useMemo(
    () => `${activeUsernames.join(',')}|${keyword}|${dateJump ? `${dateJump.start}-${dateJump.end}` : ''}`,
    [activeUsernames, keyword, dateJump],
  )

  // ------------------------------------------------------------------ 概览
  const loadOverview = useCallback(async () => {
    try {
      const r = await window.electronAPI.sns.getExportStats({ allowTimelineFallback: true })
      if (r.success && r.data) setOverview(r.data)
    } catch {
      /* noop */
    }
  }, [])

  // ------------------------------------------------------------------ 作者
  const loadAuthors = useCallback(async () => {
    setAuthorsLoading(true)
    try {
      const [usersRes, countsRes] = await Promise.all([
        window.electronAPI.sns.getSnsUsernames(),
        window.electronAPI.sns.getUserPostCounts({ preferCache: true }),
      ])
      const usernames = usersRes.success ? usersRes.usernames || [] : []
      const counts = countsRes.success ? countsRes.counts || {} : {}
      const enriched: Record<string, { displayName?: string; avatarUrl?: string }> = {}
      if (usernames.length > 0) {
        const enr = await window.electronAPI.chat.enrichSessionsContactInfo(usernames)
        if (enr.success && enr.contacts) Object.assign(enriched, enr.contacts)
      }
      const list: SnsAuthor[] = usernames
        .filter((u) => enriched[u]?.displayName)
        .map((u) => ({
          username: u,
          displayName: enriched[u]?.displayName || u,
          avatarUrl: enriched[u]?.avatarUrl,
          postCount: typeof counts[u] === 'number' ? counts[u] : undefined,
        }))
        .sort((a, b) => (b.postCount ?? 0) - (a.postCount ?? 0))
      setAuthors(list)
    } catch {
      /* noop */
    } finally {
      setAuthorsLoading(false)
    }
  }, [])

  // ------------------------------------------------------------------ 时间线
  const loadTimeline = useCallback(
    async (reset: boolean) => {
      if (loadingRef.current) return
      if (!reset && !hasMore) return
      loadingRef.current = true
      setFeedLoading(true)
      if (reset) setFeedError(null)
      const seq = ++requestSeqRef.current
      try {
        const offset = reset ? 0 : posts.length
        const result = await window.electronAPI.sns.getTimeline(
          PAGE_SIZE,
          offset,
          activeUsernames.length > 0 ? activeUsernames : undefined,
          keyword || undefined,
          dateJump?.start ?? 0,
          dateJump?.end ?? 0,
        )
        if (seq !== requestSeqRef.current) return
        if (result.success) {
          const list = result.timeline || []
          setPosts((prev) => (reset ? list : [...prev, ...list]))
          setHasMore(list.length >= PAGE_SIZE)
        } else {
          setFeedError(result.error || '加载失败')
        }
      } catch (e) {
        if (seq === requestSeqRef.current) setFeedError(String(e))
      } finally {
        if (seq === requestSeqRef.current) {
          loadingRef.current = false
          setFeedLoading(false)
        }
      }
    },
    [activeUsernames, keyword, dateJump, hasMore, posts.length],
  )

  // 筛选条件变化 → 重置并重新加载
  useEffect(() => {
    requestSeqRef.current++
    setPosts([])
    setHasMore(false)
    loadingRef.current = false
    void loadTimeline(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  // 首次挂载
  useEffect(() => {
    void loadOverview()
    void loadAuthors()
    void window.electronAPI.sns.checkBlockDeleteTrigger().then((r) => {
      if (r.success) setAntiDelete(r.installed ? 'installed' : 'uninstalled')
    })
    void window.electronAPI.sns.getCacheMigrationStatus().then((r) => {
      if (r.success) setMigration({ needed: r.needed, inProgress: r.inProgress, totalFiles: r.totalFiles || 0, items: r.items || [] })
    })
  }, [loadOverview, loadAuthors])

  // 无限滚动
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingRef.current) {
          void loadTimeline(false)
        }
      },
      { root: feedRef.current, rootMargin: '400px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loadTimeline])

  // ------------------------------------------------------------------ 交互
  const toggleAuthor = (username: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }

  const applyKeyword = () => {
    setKeyword(keywordDraft.trim())
  }

  const applyDateJump = () => {
    if (!dateDraft) {
      setDateJump(null)
      return
    }
    const day = new Date(`${dateDraft}T00:00:00`)
    if (Number.isNaN(day.getTime())) return
    setDateJump({ start: toDayStart(day.getTime() / 1000), end: Math.floor(day.getTime() / 1000 + 86399) })
  }

  const clearFilters = () => {
    setSelected(new Set())
    setKeyword('')
    setKeywordDraft('')
    setDateJump(null)
    setDateDraft('')
  }

  const toggleAntiDelete = async () => {
    if (antiDeleteBusy) return
    setAntiDeleteBusy(true)
    try {
      if (antiDelete === 'installed') {
        const r = await window.electronAPI.sns.uninstallBlockDeleteTrigger()
        if (r.success) setAntiDelete('uninstalled')
      } else {
        const r = await window.electronAPI.sns.installBlockDeleteTrigger()
        if (r.success) setAntiDelete(r.alreadyInstalled ? 'installed' : 'installed')
      }
    } finally {
      setAntiDeleteBusy(false)
    }
  }

  const startMigration = async () => {
    if (migrationBusy) return
    setMigrationBusy(true)
    setMigrationProgress({ current: 0, total: migration?.totalFiles || 0, status: '准备迁移…' })
    const off = window.electronAPI.sns.onCacheMigrationProgress((p) => {
      setMigrationProgress({ current: p.current, total: p.total, status: p.message || p.status })
    })
    try {
      const r = await window.electronAPI.sns.startCacheMigration()
      if (r.success) {
        setMigration(null)
        setMigrationProgress(null)
      } else {
        setMigrationProgress({ current: 0, total: 0, status: r.error || '迁移失败' })
      }
    } finally {
      off()
      setMigrationBusy(false)
    }
  }

  // 预览：构建跨帖媒体列表并定位（稳定回调，配合 React.memo 减少重渲染）
  const postsRef = useRef(posts)
  postsRef.current = posts
  const handlePreviewPost = useCallback((post: SnsPost, src: string, isVideo?: boolean, _live?: string, mediaIndex?: number) => {
    if (typeof mediaIndex === 'number') {
      // 记录该条媒体的解密产物（全图本地文件/视频本地文件）：
      // 灯箱必须用解密后的本地地址，否则直接加载 CDN 密文 URL → 无法显示
      if (src) previewSrcsRef.current.set(`${post.id}:${mediaIndex}`, { src, isVideo })
      const list = postsRef.current
      let base = 0
      for (const p of list) {
        if (p.id === post.id) break
        base += p.media.length
      }
      const allItems: Array<{ src: string; isVideo?: boolean }> = []
      // 注册表键是「post.id + 该帖内媒体下标」，重建时必须用同款键查询；
      // 此前误用全局下标，第一帖之后的媒体全部查不到本地解密产物，
      // 灯箱退回原始 CDN 密文 URL → 图片无法查看
      for (const p of list) {
        p.media.forEach((m, mediaIdx) => {
          const known = previewSrcsRef.current.get(`${p.id}:${mediaIdx}`)
          allItems.push({
            src: known?.src || m.thumb || m.url,
            isVideo: known?.isVideo ?? isSnsVideoUrl(m.url),
          })
        })
      }
      setPreviewItems(allItems)
      setPreviewIndex(base + mediaIndex)
    } else {
      setPreviewItems([{ src, isVideo }])
      setPreviewIndex(0)
    }
  }, [])

  const handleDeletePost = useCallback((postId: string) => {
    setPosts((prev) => prev.filter((p) => p.id !== postId))
    loadOverview().catch(() => undefined)
  }, [loadOverview])

  const handlePostDelete = useCallback((postId: string, _username: string) => {
    handleDeletePost(postId)
  }, [handleDeletePost])

  const handleOpenAuthor = useCallback(
    (p: SnsPost) => {
      const author = authors.find((a) => a.username === p.username) || {
        username: p.username,
        displayName: p.nickname,
        avatarUrl: p.avatarUrl,
      }
      setAuthorDialog(author)
    },
    [authors],
  )

  useEscape(() => setDebugPost(null), !!debugPost)

  const selectAllAuthors = () => {
    setSelected(new Set(authors.map((a) => a.username)))
  }

  return (
    <div className="v09-page sns-page">
      {/* 缓存迁移提示 */}
      {migration?.needed && !migration.inProgress && (
        <div className="sns-migration-banner">
          <RefreshCw size={14} />
          <span>
            检测到旧版朋友圈缓存（{migration.totalFiles} 个文件），迁移后可加速媒体加载。
          </span>
          <button className="ghost-btn" disabled={migrationBusy} onClick={() => void startMigration()}>
            {migrationBusy ? '迁移中…' : '开始迁移'}
          </button>
        </div>
      )}
      {migrationProgress && (
        <div className="sns-migration-banner">
          <Loader2 className="spin" size={14} />
          <span>{migrationProgress.status}</span>
          {migrationProgress.total > 0 && (
            <div className="progress-track migration-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, (migrationProgress.current / migrationProgress.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {(selected.size > 0 || keyword || dateJump) && (
        <div className="sns-filter-summary">
          <span className="sns-filter-summary-label">当前筛选</span>
          {selected.size > 0 && (
            <button className="chip chip-active" onClick={() => setSelected(new Set())} title="清除发布者筛选">
              <Users2 size={12} />
              {selected.size} 位发布者
              <X size={11} />
            </button>
          )}
          {keyword && (
            <button className="chip chip-active" onClick={() => { setKeyword(''); setKeywordDraft('') }} title="清除关键词">
              <Search size={12} />
              “{keyword}”
              <X size={11} />
            </button>
          )}
          {dateJump && (
            <button className="chip chip-active" onClick={() => { setDateJump(null); setDateDraft('') }} title="清除日期筛选">
              <CalendarDays size={12} />
              {new Date(dateJump.start * 1000).toLocaleDateString('zh-CN')}
              <X size={11} />
            </button>
          )}
        </div>
      )}

      <div className="sns-main">
        {/* 筛选侧栏（含页面头部：标题 / 统计 / 操作，紧凑布局） */}
        <aside className="sns-sidebar">
          <div className="sns-sidebar-hero">
            <div className="sns-sidebar-title">
              <Images size={15} />
              <span>朋友圈</span>
              <span className="v09-sub">本地归档</span>
            </div>
            <div className="sns-sidebar-stats">
              <div className="v09-stat">
                <b>
                  <CountUp value={overview?.totalPosts ?? 0} />
                </b>
                <span>总动态</span>
              </div>
              <div className="v09-stat">
                <b>
                  <CountUp value={overview?.totalFriends ?? 0} />
                </b>
                <span>好友</span>
              </div>
              {overview?.myPosts !== null && (
                <div className="v09-stat">
                  <b>
                    <CountUp value={overview?.myPosts ?? 0} />
                  </b>
                  <span>我的动态</span>
                </div>
              )}
            </div>
            <div className="sns-sidebar-actions">
              <button
                type="button"
                className={`chip ${antiDelete === 'installed' ? 'chip-active' : ''}`}
                disabled={antiDeleteBusy || antiDelete === 'unknown'}
                onClick={() => void toggleAntiDelete()}
                title="安装朋友圈删除拦截触发器（防删除）"
              >
                {antiDelete === 'installed' ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
                {antiDeleteBusy ? '处理中…' : antiDelete === 'installed' ? '防删除已开启' : '防删除'}
              </button>
              <button type="button" className="chip" onClick={() => setExportOpen(true)}>
                <Download size={13} />
                导出
              </button>
            </div>
          </div>

          <div className="sns-sidebar-search">
            <Search size={14} />
            <input
              value={keywordDraft}
              placeholder="搜索动态内容…"
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyKeyword()
              }}
            />
            {keyword && (
              <button className="sns-sidebar-clear" title="清除关键词" onClick={() => { setKeyword(''); setKeywordDraft('') }}>
                <X size={13} />
              </button>
            )}
          </div>

          <div className="sns-sidebar-date">
            <CalendarDays size={14} />
            <input
              type="date"
              value={dateDraft}
              onChange={(e) => setDateDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyDateJump()
              }}
            />
            {dateJump && (
              <button className="sns-sidebar-clear" title="清除日期筛选" onClick={() => { setDateJump(null); setDateDraft('') }}>
                <X size={13} />
              </button>
            )}
          </div>

          <div className="sns-sidebar-head">
            <span>发布者</span>
            <div className="sns-sidebar-head-actions">
              <button
                className="sns-sidebar-reset"
                title="刷新发布者列表与统计"
                onClick={() => {
                  void loadOverview()
                  void loadAuthors()
                }}
              >
                <RefreshCw size={12} />
                刷新
              </button>
              <button className="sns-sidebar-reset" onClick={selectAllAuthors}>
                <CheckSquare size={12} />
                全选
              </button>
              {(selected.size > 0 || keyword || dateJump) && (
                <button className="sns-sidebar-reset" onClick={clearFilters}>
                  <X size={12} />
                  重置
                </button>
              )}
            </div>
          </div>

          <div className="sns-author-list">
            {authorsLoading && <div className="wp-loading">加载发布者…</div>}
            {!authorsLoading && authors.length === 0 && <div className="wp-empty">未找到朋友圈数据</div>}
            {authors.map((a) => (
              <button
                key={a.username}
                type="button"
                className={`sns-author ${selected.has(a.username) ? 'sns-author-active' : ''}`}
                onClick={() => toggleAuthor(a.username)}
              >
                <Avatar src={a.avatarUrl} name={a.displayName} size={26} shape="circle" />
                <span className="sns-author-name">{a.displayName}</span>
                <span className="sns-author-count">{a.postCount ?? ''}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* 动态流 */}
        <div className="sns-feed" ref={feedRef}>
          {feedError && <div className="wp-error">{feedError}</div>}
          {posts.length === 0 && !feedLoading && !feedError && (
            <EmptyState
              icon={Images}
              title={selected.size > 0 || keyword || dateJump ? '没有匹配的动态' : '暂无朋友圈数据'}
              hint={selected.size > 0 || keyword || dateJump ? '试试调整筛选条件' : '请确认已连接微信账号'}
            />
          )}

          {posts.map((post) => (
            <SnsPostItem
              key={post.id}
              post={post}
              onPreview={(src, isVideo, live, mediaIndex) => handlePreviewPost(post, src, isVideo, live, mediaIndex)}
              onDecrypt={(mediaIndex, src, isVideo) => previewSrcsRef.current.set(`${post.id}:${mediaIndex}`, { src, isVideo })}
              onDebug={setDebugPost}
              onDelete={handlePostDelete}
              onOpenAuthorPosts={handleOpenAuthor}
            />
          ))}

          <div ref={sentinelRef} className="sns-feed-sentinel">
            {feedLoading && (
              <div className="wp-loading">
                <Loader2 className="spin" size={16} />
                加载中…
              </div>
            )}
            {!feedLoading && !hasMore && posts.length > 0 && <div className="sns-feed-end">已加载全部 {posts.length} 条动态</div>}
          </div>

          {posts.length > 30 && (
            <button
              className="sns-back-top"
              title="回到顶部"
              onClick={() => feedRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              <ChevronDown size={16} style={{ transform: 'rotate(180deg)' }} />
            </button>
          )}
        </div>
      </div>

      {/* 弹层 */}
      <SnsExportDialog
        open={exportOpen}
        usernames={activeUsernames.length > 0 ? activeUsernames : undefined}
        keyword={keyword || undefined}
        onClose={() => setExportOpen(false)}
        onDone={(summary) => setOverview((prev) => (prev ? { ...prev, totalPosts: prev.totalPosts } : prev))}
      />

      {authorDialog && (
        <ContactSnsTimelineDialog
          open
          username={authorDialog.username}
          displayName={authorDialog.displayName}
          avatarUrl={authorDialog.avatarUrl}
          onClose={() => setAuthorDialog(null)}
        />
      )}

      {debugPost && (
        <div className="wp-overlay" onClick={() => setDebugPost(null)}>
          <div className="wp-dialog debug-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="wp-dialog-head">
              <h3>原始数据</h3>
              <button className="icon-btn-ghost" onClick={() => setDebugPost(null)}>
                <X size={16} />
              </button>
            </div>
            <pre className="debug-pre">{debugPost.rawXml || JSON.stringify(debugPost, null, 2)}</pre>
          </div>
        </div>
      )}

      {previewIndex >= 0 && previewItems[previewIndex] && (
        <SnsPreviewLightbox
          items={previewItems}
          index={previewIndex}
          onClose={() => setPreviewIndex(-1)}
          onNavigate={setPreviewIndex}
        />
      )}
    </div>
  )
}


