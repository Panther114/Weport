import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { SnsPost } from '../../types/sns'
import { useEscape } from '../../utils/useEscape'
import { Avatar } from '../Avatar'
import { SnsPostItem } from './SnsPostItem'
import { SnsPreviewLightbox } from './SnsPreviewLightbox'

interface AuthorProfile {
  wxid: string
  displayName: string
  alias?: string
  avatarUrl?: string
}

interface AuthorStats {
  totalPosts: number
  likes: { username: string; displayName: string; avatarUrl?: string; count: number }[]
  liked: { username: string; displayName: string; avatarUrl?: string; count: number }[]
}

interface ContactSnsTimelineDialogProps {
  open: boolean
  username: string
  displayName: string
  avatarUrl?: string
  onClose: () => void
}

const PAGE_SIZE = 20

export const ContactSnsTimelineDialog: React.FC<ContactSnsTimelineDialogProps> = ({
  open,
  username,
  displayName,
  avatarUrl,
  onClose,
}) => {
  const [posts, setPosts] = useState<SnsPost[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<AuthorProfile | null>(null)
  const [stats, setStats] = useState<AuthorStats | null>(null)
  const [previewIndex, setPreviewIndex] = useState(-1)
  const previewItems = useMemo(() => posts.flatMap((p) => p.media.map((m) => ({ src: m.thumb || m.url }))), [posts])
  const postOffsetRef = useRef<Map<string, number>>(new Map())
  const loadingRef = useRef(false)

  const rebuildOffsets = (list: SnsPost[]) => {
    const map = new Map<string, number>()
    let acc = 0
    for (const p of list) {
      map.set(p.id, acc)
      acc += p.media.length
    }
    postOffsetRef.current = map
  }

  const loadPage = useCallback(
    async (reset: boolean) => {
      if (loadingRef.current) return
      if (!reset && !hasMore) return
      loadingRef.current = true
      setLoading(true)
      if (reset) setError(null)
      try {
        const offset = reset ? 0 : posts.length
        const result = await window.electronAPI.sns.getTimeline(PAGE_SIZE, offset, [username], undefined, 0, 0)
        if (result.success) {
          const list = result.timeline || []
          setPosts((prev) => {
            const merged = reset ? list : [...prev, ...list]
            rebuildOffsets(merged)
            return merged
          })
          setHasMore(list.length >= PAGE_SIZE)
        } else {
          setError(result.error || '加载失败')
        }
      } catch (e) {
        setError(String(e))
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
    },
    [hasMore, posts.length, username],
  )

  useEffect(() => {
    if (!open) return
    setPosts([])
    setHasMore(false)
    setPreviewIndex(-1)
    void loadPage(true)

    void (async () => {
      const [profileRes, statsRes] = await Promise.all([
        window.electronAPI.chat.getContactAvatar(username),
        window.electronAPI.sns.getUserPostCounts({ preferCache: true }),
      ])
      if (profileRes) {
        setProfile({ wxid: username, displayName: profileRes.displayName || displayName, avatarUrl: profileRes.avatarUrl || avatarUrl })
      }
      const count = statsRes.success ? statsRes.counts?.[username] : undefined
      if (typeof count === 'number') {
        setStats((prev) => ({ totalPosts: count, likes: prev?.likes || [], liked: prev?.liked || [] }))
      }
    })()
  }, [open, username])

  const handlePreview = useCallback((post: SnsPost, _src: string, _isVideo?: boolean, _live?: string, mediaIndex?: number) => {
    const base = postOffsetRef.current.get(post.id) ?? 0
    setPreviewIndex(base + (mediaIndex ?? 0))
  }, [])

  useEscape(onClose, open)

  if (!open) return null

  return createPortal(
    <div className="wp-overlay author-dialog-overlay" onClick={onClose}>
      <div className="author-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="author-dialog-head">
          <Avatar src={profile?.avatarUrl || avatarUrl} name={profile?.displayName || displayName} size={44} shape="rounded" />
          <div className="author-dialog-id">
            <h3>{profile?.displayName || displayName}</h3>
            <p>{profile?.alias || username}</p>
          </div>
          {stats !== null && <div className="author-dialog-count">{stats.totalPosts} 条动态</div>}
          <button className="icon-btn-ghost" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="author-dialog-body">
          {posts.length === 0 && loading && <div className="wp-loading">加载中…</div>}
          {posts.length === 0 && !loading && error && <div className="wp-error">{error}</div>}
          {posts.length === 0 && !loading && !error && <div className="wp-empty">暂无动态</div>}

          {posts.map((post) => (
            <SnsPostItem
              key={post.id}
              post={post}
              hideAuthorMeta
              onPreview={(src, isVideo, live, mediaIndex) => handlePreview(post, src, isVideo, live, mediaIndex)}
              onDebug={() => undefined}
            />
          ))}

          {hasMore && (
            <button className="ghost-btn load-more-btn" disabled={loading} onClick={() => void loadPage(false)}>
              {loading ? '加载中…' : '加载更多'}
            </button>
          )}
        </div>
      </div>

      {previewIndex >= 0 && previewItems[previewIndex] && (
        <SnsPreviewLightbox
          items={previewItems}
          index={previewIndex}
          onClose={() => setPreviewIndex(-1)}
          onNavigate={(i) => setPreviewIndex(i)}
        />
      )}
    </div>,
    document.body,
  )
}
