import { memo, useEffect, useRef, useState } from 'react'
import { Download, ImageOff, Loader2, Play, RefreshCw } from 'lucide-react'
import type { SnsMedia } from '../../types/sns'
import { isSnsVideoUrl, snsMediaProtocolUrl } from '../../utils/snsParse'

export type SnsPreviewHandler = (src: string, isVideo?: boolean, liveVideoPath?: string, mediaIndex?: number) => void
export type SnsDecryptHandler = (mediaIndex: number, src: string, isVideo?: boolean) => void

interface SnsMediaGridProps {
  mediaList: SnsMedia[]
  postType?: number
  onPreview: SnsPreviewHandler
  onDecrypt?: SnsDecryptHandler
  onMediaDeleted?: () => void
}

const extractVideoFrame = async (videoPath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.src = videoPath
    video.muted = true
    video.currentTime = 0

    const onSeeked = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL('image/jpeg', 0.8))
        } else {
          reject(new Error('Canvas context failed'))
        }
      } catch (e) {
        reject(e)
      } finally {
        video.removeEventListener('seeked', onSeeked)
        video.src = ''
        video.load()
      }
    }

    video.onloadedmetadata = () => {
      if (video.duration === Infinity || Number.isNaN(video.duration)) {
        video.currentTime = 1
      } else {
        video.currentTime = Math.max(0.1, video.duration / 2)
      }
    }

    video.onseeked = onSeeked
    video.onerror = () => reject(new Error('Video load failed'))
  })
}

const MediaItem = memo(
  ({
    media,
    postType,
    onPreview,
    onDecrypt,
    onMediaDeleted,
    mediaIndex,
  }: {
    media: SnsMedia
    postType?: number
    onPreview: SnsPreviewHandler
    onDecrypt?: SnsDecryptHandler
    onMediaDeleted?: () => void
    mediaIndex?: number
  }) => {
    const [error, setError] = useState(false)
    const [deleted, setDeleted] = useState(false)
    const [loading, setLoading] = useState(true)
    const [thumbSrc, setThumbSrc] = useState('')
    const [videoPath, setVideoPath] = useState('')
    const [fullCachePath, setFullCachePath] = useState('')
    const [liveVideoPath, setLiveVideoPath] = useState('')
    const [isDecrypting, setIsDecrypting] = useState(false)
    const [isGeneratingCover, setIsGeneratingCover] = useState(false)
    const retryCount = useRef(0)
    const retrySkipFailedCache = useRef(false)
    const [retryKey, setRetryKey] = useState(0)
    // onDecrypt 用 ref 持有：load() 依赖数组不想包含回调
    const onDecryptRef = useRef(onDecrypt)
    onDecryptRef.current = onDecrypt

    const isVideo = isSnsVideoUrl(media.url)
    const isLive = !!media.livePhoto
    const targetUrl = media.thumb || media.url
    // type 7 的朋友圈媒体不需要解密，直接使用原始 URL
    const skipDecrypt = postType === 7

    const markDeleted = () => {
      setDeleted(true)
      onMediaDeleted?.()
    }

    const videoRetryOrDelete = (status?: number) => {
      if (status === 404 || status === 410) {
        markDeleted()
        return
      }
      if (retryCount.current < 2) {
        retryCount.current += 1
        setRetryKey((k) => k + 1)
      } else {
        markDeleted()
      }
    }

    const imageRetryOrFail = (status?: number) => {
      if (status === 404 || status === 410) {
        markDeleted()
        return
      }
      if (retryCount.current < 2) {
        retryCount.current += 1
        setRetryKey((k) => k + 1)
      } else {
        setError(true)
      }
    }

    const handleRetry = (e: React.MouseEvent) => {
      e.stopPropagation()
      retryCount.current = 0
      setError(false)
      // 跳过主进程 5 分钟失败缓存，显式重试立即重新走下载解密管线
      retrySkipFailedCache.current = true
      setRetryKey((k) => k + 1)
    }

    const toLocalUrl = (p: string) => snsMediaProtocolUrl(p)

    // 视口懒加载：仅当媒体进入可视区域（或接近可视区域）时才解密加载，
    // 长列表滚动时显著降低 CPU / 网络 / 内存占用
    const containerRef = useRef<HTMLDivElement>(null)
    const [visible, setVisible] = useState(false)

    useEffect(() => {
      const node = containerRef.current
      if (!node) return
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) {
            setVisible(true)
            observer.disconnect()
          }
        },
        { rootMargin: '600px 0px' },
      )
      observer.observe(node)
      return () => observer.disconnect()
    }, [])

    // 进入视口后加载 / 解密媒体
    useEffect(() => {
      if (!visible) return
      let cancelled = false
      setLoading(true)
      setError(false)

      const load = async () => {
        try {
          if (!isVideo) {
            const res = await window.electronAPI.sns.proxyImage({
              // The grid only needs the thumbnail. Fetch the encrypted full
              // asset when the user opens or downloads it.
              url: targetUrl,
              key: skipDecrypt ? undefined : media.key,
              skipFailedCache: retrySkipFailedCache.current,
            })
            if (cancelled) return
            if (res.success) {
              if (res.dataUrl) {
                setThumbSrc(res.dataUrl)
              } else if (res.videoPath) setThumbSrc(toLocalUrl(res.videoPath))
              // If no separate thumbnail exists, this response is already the
              // full asset and can be reused by the lightbox.
              if (targetUrl === media.url) {
                if (res.cachePath) setFullCachePath(res.cachePath)
                if (typeof mediaIndex === 'number') {
                  const best = res.cachePath ? toLocalUrl(res.cachePath) : res.dataUrl || ''
                  if (best) onDecryptRef.current?.(mediaIndex, best, false)
                }
              }
            } else {
              imageRetryOrFail(res.status)
            }
          } else if (targetUrl && targetUrl !== media.url && !isSnsVideoUrl(targetUrl)) {
            // Video posts usually carry an image thumbnail. Do not download
            // and decrypt the full MP4 just to paint a grid tile.
            const res = await window.electronAPI.sns.proxyImage({
              url: targetUrl,
              key: skipDecrypt ? undefined : media.key,
              skipFailedCache: retrySkipFailedCache.current,
            })
            if (cancelled) return
            if (res.success) {
              if (res.dataUrl) setThumbSrc(res.dataUrl)
              else if (res.videoPath) setThumbSrc(toLocalUrl(res.videoPath))
            } else {
              videoRetryOrDelete(res.status)
            }
          } else {
            setIsGeneratingCover(true)
            const result = await window.electronAPI.sns.proxyImage({
              url: media.url,
              key: skipDecrypt ? undefined : media.key,
              skipFailedCache: retrySkipFailedCache.current,
            })
            if (cancelled) return
            if (result.success && result.videoPath) {
              const localPath = toLocalUrl(result.videoPath)
              setVideoPath(localPath)
              if (typeof mediaIndex === 'number') onDecryptRef.current?.(mediaIndex, localPath, true)
              try {
                const coverDataUrl = await extractVideoFrame(localPath)
                if (!cancelled) setThumbSrc(coverDataUrl)
              } catch {
                if (!cancelled) setThumbSrc(localPath)
              }
            } else {
              videoRetryOrDelete(result.status)
            }
            setIsGeneratingCover(false)
          }
        } catch {
          if (!cancelled) {
            if (isVideo) videoRetryOrDelete()
            else imageRetryOrFail()
            setIsGeneratingCover(false)
          }
        } finally {
          if (!cancelled) setLoading(false)
        }
      }

      void load()
      return () => {
        cancelled = true
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, isVideo, isLive, targetUrl, media, retryKey])

    const handlePreview = async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isVideo) {
        if (!videoPath) {
          setIsDecrypting(true)
          try {
            const res = await window.electronAPI.sns.proxyImage({
              url: media.url,
              key: skipDecrypt ? undefined : media.key,
            })
            if (res.success && res.videoPath) {
              const local = toLocalUrl(res.videoPath)
              setVideoPath(local)
              if (typeof mediaIndex === 'number') onDecryptRef.current?.(mediaIndex, local, true)
              onPreview(local, true, undefined, mediaIndex)
            } else {
              window.alert('视频解密失败')
            }
          } finally {
            setIsDecrypting(false)
          }
        } else {
          onPreview(videoPath, true, undefined, mediaIndex)
        }
      } else {
        // The grid may have loaded only a thumbnail. Resolve the full image
        // on demand, then keep its local path for subsequent lightbox opens.
        let fullSrc = fullCachePath ? toLocalUrl(fullCachePath) : ''
        if (!fullSrc && media.url && media.url !== targetUrl) {
          setIsDecrypting(true)
          try {
            const res = await window.electronAPI.sns.proxyImage({
              url: media.url,
              key: skipDecrypt ? undefined : media.key,
              skipFailedCache: retrySkipFailedCache.current,
            })
            if (res.success) {
              if (res.cachePath) {
                setFullCachePath(res.cachePath)
                fullSrc = toLocalUrl(res.cachePath)
              } else if (res.dataUrl) {
                fullSrc = res.dataUrl
              }
              if (fullSrc && typeof mediaIndex === 'number') {
                onDecryptRef.current?.(mediaIndex, fullSrc, false)
              }
            }
          } finally {
            setIsDecrypting(false)
          }
        }
        if (isLive && media.livePhoto?.url && !liveVideoPath) {
          void window.electronAPI.sns
            .proxyImage({
              url: media.livePhoto.url,
              key: skipDecrypt ? undefined : media.livePhoto.key || media.key,
              skipFailedCache: retrySkipFailedCache.current,
            })
            .then((res: any) => {
              if (res.success && res.videoPath) setLiveVideoPath(toLocalUrl(res.videoPath))
            })
            .catch(() => {})
        }
        onPreview(fullSrc || thumbSrc || targetUrl, false, liveVideoPath, mediaIndex)
      }
    }

    const handleDownload = async (e: React.MouseEvent) => {
      e.stopPropagation()
      setLoading(true)
      try {
        const result = await window.electronAPI.sns.proxyImage({
          url: media.url,
          key: skipDecrypt ? undefined : media.key,
        })
        if (result.success) {
          const link = document.createElement('a')
          link.download = `sns_media_${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`
          if (isVideo && result.videoPath) {
            const local = toLocalUrl(result.videoPath)
            try {
              const response = await fetch(local)
              const blob = await response.blob()
              const url = URL.createObjectURL(blob)
              link.href = url
              window.setTimeout(() => URL.revokeObjectURL(url), 60000)
            } catch {
              link.href = local
            }
          } else if (result.cachePath) {
            // 全图磁盘缓存 → 本地协议读取（避免下载缩略图）
            const local = toLocalUrl(result.cachePath)
            try {
              const response = await fetch(local)
              const blob = await response.blob()
              const url = URL.createObjectURL(blob)
              link.href = url
              window.setTimeout(() => URL.revokeObjectURL(url), 60000)
            } catch {
              link.href = local
            }
          } else if (result.dataUrl) {
            link.href = result.dataUrl
          }
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
        } else {
          window.alert('下载失败: 无法获取资源')
        }
      } catch {
        window.alert('下载出错')
      } finally {
        setLoading(false)
      }
    }

    if (deleted) {
      return (
        <div className="sns-media-item deleted-media">
          <div className="deleted-placeholder">
            <ImageOff size={20} />
            <span>已删除</span>
          </div>
        </div>
      )
    }

    if (error) {
      return (
        <div className="sns-media-item failed-media" onClick={handleRetry} title="点击重试">
          <div className="failed-placeholder">
            <RefreshCw size={20} />
            <span>加载失败</span>
          </div>
        </div>
      )
    }

    const showVideoTag = thumbSrc && !thumbSrc.startsWith('data:') && (thumbSrc.toLowerCase().endsWith('.mp4') || thumbSrc.includes('video'))

    return (
      <div
        ref={containerRef}
        className={`sns-media-item ${isDecrypting ? 'decrypting' : ''}`}
        onClick={handlePreview}
      >
        {!visible ? (
          <div className="media-skeleton" />
        ) : showVideoTag ? (
          <video
            key={thumbSrc}
            src={`${thumbSrc}#t=0.1`}
            className="media-image"
            preload="auto"
            muted
            playsInline
            disablePictureInPicture
            disableRemotePlayback
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = 0.1
            }}
          />
        ) : thumbSrc ? (
          <img
            src={thumbSrc}
            className="media-image"
            loading="lazy"
            onError={() => {
              if (!loading && !isVideo) imageRetryOrFail()
            }}
            alt=""
          />
        ) : null}

        {(loading || isGeneratingCover) && (
          <div className="media-decrypting-mask">
            <Loader2 className="spin" size={20} />
            <span>{isGeneratingCover ? '解码中' : '解密中'}</span>
          </div>
        )}

        {isVideo && (
          <div className="media-badge video">
            {isDecrypting ? <Loader2 className="spin" size={14} /> : <Play size={14} fill="currentColor" />}
          </div>
        )}
        {isLive && !isVideo && <div className="media-badge live">实况</div>}

        <div className="media-download-btn" onClick={handleDownload} title="下载">
          <Download size={14} />
        </div>
      </div>
    )
  },
)

export const SnsMediaGrid = memo(function SnsMediaGrid({ mediaList, postType, onPreview, onDecrypt, onMediaDeleted }: SnsMediaGridProps) {
  if (!mediaList || mediaList.length === 0) return null

  const count = mediaList.length
  let gridClass = 'grid-1'
  if (count === 2) gridClass = 'grid-2'
  else if (count === 3) gridClass = 'grid-3'
  else if (count === 4) gridClass = 'grid-4'
  else if (count <= 6) gridClass = 'grid-6'
  else gridClass = 'grid-9'

  return (
    <div className={`sns-media-grid ${gridClass}`}>
      {mediaList.map((media, idx) => (
        <MediaItem key={idx} media={media} postType={postType} onPreview={onPreview} onDecrypt={onDecrypt} onMediaDeleted={onMediaDeleted} mediaIndex={idx} />
      ))}
    </div>
  )
})
