import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, X, ZoomIn, ZoomOut } from 'lucide-react'

interface PreviewItem {
  src: string
  isVideo?: boolean
  liveVideoPath?: string
}

interface SnsPreviewLightboxProps {
  items: PreviewItem[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
}

export const SnsPreviewLightbox: React.FC<SnsPreviewLightboxProps> = ({ items, index, onClose, onNavigate }) => {
  const item = items[index]
  const [zoom, setZoom] = useState(1)
  const [videoError, setVideoError] = useState(false)

  useEffect(() => {
    setZoom(1)
    setVideoError(false)
  }, [index, item?.src])

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onNavigate((index - 1 + items.length) % items.length)
      if (e.key === 'ArrowRight') onNavigate((index + 1) % items.length)
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(3, z + 0.25))
      if (e.key === '-') setZoom((z) => Math.max(1, z - 0.25))
    },
    [onClose, onNavigate, index, items.length],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const handleDownload = async () => {
    if (!item) return
    try {
      if (item.src.startsWith('data:')) {
        const link = document.createElement('a')
        link.download = `sns_preview_${Date.now()}.jpg`
        link.href = item.src
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
      } else {
        const url = item.src
        const response = await fetch(url)
        const blob = await response.blob()
        const objUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        const ext = (item.isVideo ? 'mp4' : blob.type.split('/')[1] || 'jpg')
        link.download = `sns_preview_${Date.now()}.${ext}`
        link.href = objUrl
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        window.setTimeout(() => URL.revokeObjectURL(objUrl), 60000)
      }
    } catch {
      /* noop */
    }
  }

  return createPortal(
    <div className="wp-overlay lightbox" onClick={onClose}>
      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-count">
          {index + 1} / {items.length}
        </div>
        <div className="lightbox-actions">
          {!item?.isVideo && (
            <>
              <button className="icon-btn-ghost" title="缩小" onClick={() => setZoom((z) => Math.max(1, z - 0.25))}>
                <ZoomOut size={16} />
              </button>
              <button className="icon-btn-ghost" title="放大" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
                <ZoomIn size={16} />
              </button>
            </>
          )}
          <button className="icon-btn-ghost" title="下载" onClick={handleDownload}>
            <Download size={16} />
          </button>
          <button className="icon-btn-ghost" title="关闭 (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        {item?.isVideo ? (
          videoError ? (
            <div className="lightbox-error">视频无法播放</div>
          ) : (
            <video
              key={item.src}
              src={item.src}
              className="lightbox-media"
              controls
              autoPlay
              playsInline
              onError={() => setVideoError(true)}
            />
          )
        ) : (
          <img
            key={item.src}
            src={item?.src}
            alt=""
            className="lightbox-media"
            style={{ transform: `scale(${zoom})`, transition: 'transform 0.2s ease' }}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>

      {items.length > 1 && (
        <>
          <button className="lightbox-nav prev" onClick={(e) => { e.stopPropagation(); onNavigate((index - 1 + items.length) % items.length) }}>
            ‹
          </button>
          <button className="lightbox-nav next" onClick={(e) => { e.stopPropagation(); onNavigate((index + 1) % items.length) }}>
            ›
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
