import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react'

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

const MIN_ZOOM = 1
const MAX_ZOOM = 6

/**
 * 图片查看器。
 *
 * 缩放以鼠标位置为锚点：滚轮转到哪里，那里就停在光标下（而不是把图片绕中心
 * 放大后把目标顶出屏幕）。实现方式是 `transform-origin: 0 0` +
 * `translate(tx,ty) scale(s)` —— 元素左上角不随缩放移动，于是由当前 rect 反推
 * 未变换的布局原点，就能解出让光标下的像素保持不动的平移量。
 */
export const SnsPreviewLightbox: React.FC<SnsPreviewLightboxProps> = ({ items, index, onClose, onNavigate }) => {
  const item = items[index]
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  // 事件回调用 ref 读最新值，避免每帧重建非被动监听器。
  const stateRef = useRef({ zoom, offset })
  stateRef.current = { zoom, offset }
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    setZoom(MIN_ZOOM)
    setOffset({ x: 0, y: 0 })
    setVideoError(false)
  }, [index, item?.src])

  const isVideo = Boolean(item?.isVideo)

  const zoomTo = useCallback((nextZoom: number, clientX: number, clientY: number) => {
    const img = imgRef.current
    if (!img) return
    const { zoom: current, offset: currentOffset } = stateRef.current
    const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom))
    if (target === current) return
    if (target === MIN_ZOOM) {
      setZoom(MIN_ZOOM)
      setOffset({ x: 0, y: 0 })
      return
    }
    const rect = img.getBoundingClientRect()
    // rect 含当前变换：origin 在 0 0，所以布局原点 = rect 左上角 - 当前平移。
    const layoutLeft = rect.left - currentOffset.x
    const layoutTop = rect.top - currentOffset.y
    const px = (clientX - layoutLeft - currentOffset.x) / current
    const py = (clientY - layoutTop - currentOffset.y) / current
    setZoom(target)
    setOffset({ x: clientX - layoutLeft - target * px, y: clientY - layoutTop - target * py })
  }, [])

  // 滚轮缩放必须是非被动监听器才能 preventDefault（React 在根节点上按被动注册
  // wheel，onWheel 里阻止不了页面滚动）。
  useEffect(() => {
    const body = bodyRef.current
    if (!body || isVideo) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomTo(stateRef.current.zoom * factor, e.clientX, e.clientY)
    }
    body.addEventListener('wheel', onWheel, { passive: false })
    return () => body.removeEventListener('wheel', onWheel)
  }, [isVideo, zoomTo])

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onNavigate((index - 1 + items.length) % items.length)
      if (e.key === 'ArrowRight') onNavigate((index + 1) % items.length)
      if (e.key === '0') {
        setZoom(MIN_ZOOM)
        setOffset({ x: 0, y: 0 })
      }
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

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (isVideo || stateRef.current.zoom <= MIN_ZOOM) return
    dragRef.current = { x: e.clientX, y: e.clientY, ox: stateRef.current.offset.x, oy: stateRef.current.offset.y }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    setOffset({ x: drag.ox + (e.clientX - drag.x), y: drag.oy + (e.clientY - drag.y) })
  }

  function endDrag() {
    dragRef.current = null
    setDragging(false)
  }

  return createPortal(
    // 点击空白（含图片外的整个查看区）关闭：原来只有最外层遮罩可关，而
    // `.lightbox-body` 撑满整屏并吞掉了冒泡，等于点哪里都不关。
    <div className="wp-overlay lightbox" onClick={onClose}>
      <div className="lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-count">
          {index + 1} / {items.length}
          {zoom > MIN_ZOOM && <span className="lightbox-zoom-tag">{Math.round(zoom * 100)}%</span>}
        </div>
        <div className="lightbox-actions">
          {!isVideo && (
            <>
              <button
                className="icon-btn-ghost"
                title="缩小 (滚轮向下)"
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.5))}
              >
                <ZoomOut size={16} />
              </button>
              <button
                className="icon-btn-ghost"
                title="放大 (滚轮向上)"
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.5))}
              >
                <ZoomIn size={16} />
              </button>
              <button
                className="icon-btn-ghost"
                title="原始大小 (0)"
                onClick={() => {
                  setZoom(MIN_ZOOM)
                  setOffset({ x: 0, y: 0 })
                }}
              >
                <Maximize2 size={16} />
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

      <div
        className="lightbox-body"
        ref={bodyRef}
        data-zoomed={zoom > MIN_ZOOM}
        data-dragging={dragging}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => {
          if (isVideo) return
          if (zoom > MIN_ZOOM) {
            setZoom(MIN_ZOOM)
            setOffset({ x: 0, y: 0 })
          } else {
            setZoom(2)
          }
        }}
      >
        {isVideo ? (
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
            ref={imgRef}
            src={item?.src}
            alt=""
            className="lightbox-media"
            draggable={false}
            // 大图预览是最重的一张图，异步解码尤其重要。
            decoding="async"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              transition: dragging ? 'none' : 'transform 0.14s ease-out',
            }}
          />
        )}
      </div>

      {items.length > 1 && (
        <>
          <button
            className="lightbox-nav prev"
            onClick={(e) => {
              e.stopPropagation()
              onNavigate((index - 1 + items.length) % items.length)
            }}
          >
            ‹
          </button>
          <button
            className="lightbox-nav next"
            onClick={(e) => {
              e.stopPropagation()
              onNavigate((index + 1) % items.length)
            }}
          >
            ›
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
