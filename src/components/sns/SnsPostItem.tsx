import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Code2, Heart, ImageIcon, MapPin, Trash2 } from 'lucide-react'
import type { SnsLinkCardData, SnsPost } from '../../types/sns'
import { buildLinkCardData, buildLocationText, decodeHtmlEntities, formatSnsTime, isSnsVideoUrl, snsMediaProtocolUrl } from '../../utils/snsParse'
import { renderTextWithEmoji } from '../../utils/renderTextWithEmoji'
import { Avatar } from '../Avatar'
import { SnsMediaGrid } from './SnsMediaGrid'

const emojiLocalCache = new Map<string, string>()

const CommentEmoji: React.FC<{
  emoji: { url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }
  onPreview?: (src: string) => void
}> = ({ emoji, onPreview }) => {
  const cacheKey = emoji.encryptUrl || emoji.url
  const [localSrc, setLocalSrc] = useState<string>(() => emojiLocalCache.get(cacheKey) || '')

  useEffect(() => {
    if (!cacheKey) return
    if (emojiLocalCache.has(cacheKey)) {
      setLocalSrc(emojiLocalCache.get(cacheKey)!)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const res = await window.electronAPI.sns.downloadEmoji({
          url: emoji.url,
          encryptUrl: emoji.encryptUrl,
          aesKey: emoji.aesKey,
        })
        if (cancelled) return
        if (res.success && res.localPath) {
          const fileUrl = res.localPath.startsWith('file:') ? res.localPath : snsMediaProtocolUrl(res.localPath)
          emojiLocalCache.set(cacheKey, fileUrl)
          setLocalSrc(fileUrl)
        }
      } catch {
        /* 静默失败 */
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [cacheKey])

  if (!localSrc) return null

  return (
    <img
      src={localSrc}
      alt="emoji"
      className="comment-custom-emoji"
      draggable={false}
      onClick={(e) => {
        e.stopPropagation()
        onPreview?.(localSrc)
      }}
      style={{
        width: Math.min(emoji.width || 24, 30),
        height: Math.min(emoji.height || 24, 30),
        verticalAlign: 'middle',
        marginLeft: 2,
        borderRadius: 4,
        cursor: onPreview ? 'pointer' : 'default',
      }}
    />
  )
}

const SnsLinkCard: React.FC<{ card: SnsLinkCardData; thumbKey?: string }> = ({ card, thumbKey }) => {
  const [thumbFailed, setThumbFailed] = useState(false)
  const [thumbSrc, setThumbSrc] = useState(card.thumb || '')
  const [reloadNonce, setReloadNonce] = useState(0)
  const retryCountRef = useRef(0)

  const hostname = useMemo(() => {
    try {
      return new URL(card.url).hostname.replace(/^www\./i, '')
    } catch {
      return card.url
    }
  }, [card.url])

  useEffect(() => {
    retryCountRef.current = 0
  }, [card.thumb, thumbKey])

  useEffect(() => {
    const rawThumb = card.thumb || ''
    setThumbFailed(false)
    setThumbSrc(rawThumb)
    if (!rawThumb) return

    let cancelled = false
    const loadThumb = async () => {
      try {
        const result = await window.electronAPI.sns.proxyImage({ url: rawThumb, key: thumbKey })
        if (cancelled) return
        if (!result.success) {
          if (retryCountRef.current < 2) {
            retryCountRef.current += 1
            window.setTimeout(() => setReloadNonce((v) => v + 1), 900)
          }
          return
        }
        if (result.dataUrl) setThumbSrc(result.dataUrl)
        else if (result.videoPath) setThumbSrc(snsMediaProtocolUrl(result.videoPath))
      } catch {
        /* noop */
      }
    }
    loadThumb()
    return () => {
      cancelled = true
    }
  }, [card.thumb, thumbKey, reloadNonce])

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    try {
      await window.electronAPI.shell.openExternal(card.url)
    } catch {
      /* noop */
    }
  }

  return (
    <button type="button" className="post-link-card" onClick={handleClick}>
      <div className="link-thumb">
        {thumbSrc && !thumbFailed ? (
          <img
            src={thumbSrc}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => {
              const rawThumb = card.thumb || ''
              if (thumbSrc !== rawThumb && rawThumb) {
                setThumbSrc(rawThumb)
                return
              }
              setThumbFailed(true)
              if (retryCountRef.current < 2) {
                retryCountRef.current += 1
                window.setTimeout(() => setReloadNonce((v) => v + 1), 900)
              }
            }}
          />
        ) : (
          <div className="link-thumb-fallback">
            <ImageIcon size={18} />
          </div>
        )}
      </div>
      <div className="link-meta">
        <div className="link-title">{card.title}</div>
        <div className="link-url">{hostname}</div>
      </div>
      <ChevronRight size={16} className="link-arrow" />
    </button>
  )
}

interface SnsPostItemProps {
  post: SnsPost
  onPreview: (src: string, isVideo?: boolean, liveVideoPath?: string, mediaIndex?: number) => void
  onDecrypt?: (mediaIndex: number, src: string, isVideo?: boolean) => void
  onDebug: (post: SnsPost) => void
  onDelete?: (postId: string, username: string) => void
  onOpenAuthorPosts?: (post: SnsPost) => void
  hideAuthorMeta?: boolean
}

export const SnsPostItem: React.FC<SnsPostItemProps> = memo(function SnsPostItem({
  post,
  onPreview,
  onDecrypt,
  onDebug,
  onDelete,
  onOpenAuthorPosts,
  hideAuthorMeta = false,
}) {
  const [mediaDeleted, setMediaDeleted] = useState(false)
  const [dbDeleted, setDbDeleted] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const linkCard = useMemo(() => buildLinkCardData(post), [post])
  const linkCardThumbKey = linkCard?.thumbKey || post.media[0]?.key
  const locationText = useMemo(() => buildLocationText(post.location), [post.location])
  const hasVideoMedia = post.type === 15 || post.media.some((item) => isSnsVideoUrl(item.url))
  const isLinkCardType = post.type === 3 || post.type === 5
  const showLinkCard = Boolean(linkCard) && !hasVideoMedia && (isLinkCardType || post.media.length <= 1)
  const showMediaGrid = post.media.length > 0 && !showLinkCard

  const handleDeleteConfirm = async () => {
    setShowDeleteConfirm(false)
    setDeleting(true)
    try {
      const r = await window.electronAPI.sns.deleteSnsPost(post.tid ?? post.id)
      if (r.success) {
        setDbDeleted(true)
        onDelete?.(post.id, post.username)
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div className={`sns-post-item ${mediaDeleted || dbDeleted ? 'post-deleted' : ''}`}>
        {!hideAuthorMeta && (
          <div className="post-avatar-col">
            <button
              type="button"
              className="author-trigger-btn avatar-trigger"
              onClick={(e) => {
                e.stopPropagation()
                onOpenAuthorPosts?.(post)
              }}
              title="查看该发布者的全部朋友圈"
            >
              <Avatar src={post.avatarUrl} name={post.nickname} size={36} shape="rounded" />
            </button>
          </div>
        )}

        <div className="post-content-col">
          <div className="post-header-row">
            {hideAuthorMeta ? (
              <span className="post-time post-time-standalone">{formatSnsTime(post.createTime)}</span>
            ) : (
              <div className="post-author-info">
                <button
                  type="button"
                  className="author-trigger-btn author-name-trigger"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenAuthorPosts?.(post)
                  }}
                  title="查看该发布者的全部朋友圈"
                >
                  <span className="author-name">{decodeHtmlEntities(post.nickname)}</span>
                </button>
                <span className="post-time">{formatSnsTime(post.createTime)}</span>
              </div>
            )}
            <div className="post-header-actions">
              {(mediaDeleted || dbDeleted) && (
                <span className="post-deleted-badge">
                  <Trash2 size={12} />
                  <span>已删除</span>
                </span>
              )}
              <button
                className="icon-btn-ghost delete-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  if (deleting || dbDeleted) return
                  setShowDeleteConfirm(true)
                }}
                disabled={deleting || dbDeleted}
                title="从数据库删除此条记录"
              >
                <Trash2 size={14} />
              </button>
              <button
                className="icon-btn-ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  onDebug(post)
                }}
                title="查看原始数据"
              >
                <Code2 size={14} />
              </button>
            </div>
          </div>

          {post.contentDesc && <div className="post-text">{renderTextWithEmoji(decodeHtmlEntities(post.contentDesc))}</div>}

          {locationText && (
            <div className="post-location" title={locationText}>
              <MapPin size={14} />
              <span className="post-location-text">{locationText}</span>
            </div>
          )}

          {showLinkCard && linkCard && <SnsLinkCard card={linkCard} thumbKey={linkCardThumbKey} />}

          {showMediaGrid && (
            <div className="post-media-container">
              <SnsMediaGrid
                mediaList={post.media}
                postType={post.type}
                onPreview={onPreview}
                onDecrypt={onDecrypt}
                onMediaDeleted={[1, 54].includes(post.type ?? 0) ? () => setMediaDeleted(true) : undefined}
              />
            </div>
          )}

          {(post.likes.length > 0 || post.comments.length > 0) && (
            <div className="post-interactions">
              {post.likes.length > 0 && (
                <div className="likes-block">
                  <Heart size={14} className="like-icon" />
                  <span className="likes-text">{post.likes.join('、')}</span>
                </div>
              )}
              {post.comments.length > 0 && (
                <div className="comments-block">
                  {post.comments.map((c, idx) => (
                    <div key={idx} className="comment-row">
                      <span className="comment-user">{c.nickname}</span>
                      {c.refNickname && (
                        <>
                          <span className="reply-text">回复</span>
                          <span className="comment-user">{c.refNickname}</span>
                        </>
                      )}
                      <span className="comment-colon">：</span>
                      {c.content && <span className="comment-content">{renderTextWithEmoji(c.content)}</span>}
                      {c.emojis &&
                        c.emojis.map((emoji, ei) => <CommentEmoji key={ei} emoji={emoji} onPreview={(src) => onPreview(src)} />)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showDeleteConfirm &&
        createPortal(
          <div className="wp-overlay" onClick={() => setShowDeleteConfirm(false)}>
            <div className="wp-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="wp-dialog-icon danger">
                <Trash2 size={20} />
              </div>
              <div className="wp-dialog-title">删除这条记录？</div>
              <div className="wp-dialog-desc">将从本地数据库中永久删除，无法恢复。</div>
              <div className="wp-dialog-actions">
                <button className="ghost-btn" onClick={() => setShowDeleteConfirm(false)}>
                  取消
                </button>
                <button className="danger-btn" onClick={handleDeleteConfirm} disabled={deleting}>
                  {deleting ? '删除中…' : '删除'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
})
