/**
 * 图片灯箱（懒加载）。
 *
 * 复用朋友圈那套查看器（`components/sns/SnsPreviewLightbox`）：缩放以光标为锚点、
 * 方向键翻页、Esc 关闭、滚轮缩放、下载 —— 阅读器不该再写第二套。这里只负责两件事：
 *
 * 1. **懒加载**：查看器本身（约 8 KB + 灯箱样式）只在第一次点开图片时进入内存；
 * 2. **预取**：只解密「当前 ± 1」三张（V12 §3 的"灯箱预取相邻 N 张"）。整会话的
 *    图片一次性解密会把几 GB 的 base64 顶进渲染进程，绝对不能那么做。
 *
 * 未就绪的相邻图传空 `src`：灯箱渲染一块空白，几十毫秒后 IPC 回来就补上。
 */
import { lazy, Suspense, useMemo } from 'react'
import { X } from 'lucide-react'
import type { ReaderMessage } from './readerTypes'
import { useReaderImage } from './MessageBlocks'

const SnsPreviewLightbox = lazy(() =>
  import('../sns/SnsPreviewLightbox').then((module) => ({ default: module.SnsPreviewLightbox })),
)

export interface ReaderImageViewerProps {
  images: ReaderMessage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}

export function ReaderImageViewer({ images, index, onIndex, onClose }: ReaderImageViewerProps) {
  const total = images.length
  const safeIndex = total > 0 ? ((index % total) + total) % total : 0
  const current = images[safeIndex]
  const previous = total > 1 ? images[(safeIndex - 1 + total) % total] : undefined
  const next = total > 1 ? images[(safeIndex + 1) % total] : undefined

  const currentState = useReaderImage(current, Boolean(current))
  const previousState = useReaderImage(previous, Boolean(previous))
  const nextState = useReaderImage(next, Boolean(next))

  const items = useMemo(() => {
    const resolved = new Map<string, string>()
    if (current && currentState.url) resolved.set(current.key, currentState.url)
    if (previous && previousState.url) resolved.set(previous.key, previousState.url)
    if (next && nextState.url) resolved.set(next.key, nextState.url)
    return images.map((image) => ({ src: resolved.get(image.key) || '' }))
  }, [images, current, previous, next, currentState.url, previousState.url, nextState.url])

  if (!current) return null

  return (
    <>
      {currentState.error && !currentState.url && (
        <div className="reader-viewer-error" role="alert">
          <span>{currentState.error}</span>
          <button type="button" className="icon-btn-ghost" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
      )}
      <Suspense fallback={<div className="reader-viewer-loading">正在打开图片查看器…</div>}>
        <SnsPreviewLightbox
          items={items.map((item) => ({ src: item.src, isVideo: false }))}
          index={safeIndex}
          onClose={onClose}
          onNavigate={(nextIndex) => {
            if (nextIndex < 0 || nextIndex >= total) return
            onIndex(nextIndex)
          }}
        />
      </Suspense>
    </>
  )
}
