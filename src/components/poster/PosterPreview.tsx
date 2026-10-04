import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, Images, Loader2, Minus, Plus } from 'lucide-react'
import type { PosterOptions } from './posterTypes.ts'
import type { PosterPage as PosterPageModel } from './posterLayout.ts'
import { renderPosterPages, type PosterRenderContext } from './posterDom.ts'
import { POSTER_WIDTH } from './posterTypes.ts'

/**
 * 预览画布（v1.2 §4）。
 *
 * ## 为什么是"命令式挂载 DOM"
 *
 * 预览的 DOM 与导出被 `html2canvas` 抓取的 DOM **必须是同一份**（`posterDom` 顶部
 * 说明了理由）。这里用 `useLayoutEffect` 把 `renderPosterPages` 画进容器，而不是把
 * 海报写成 JSX —— 那样就会出现"预览一套、导出一套"，而两者的差异只在导出的图里
 * 显形（用户发出去之后才发现）。
 *
 * ## 缩放用 transform，不用 CSS zoom
 *
 * `zoom` 会真的改变布局（页面的 `offsetHeight` 也跟着变），而 `html2canvas` 是按
 * 元素的**当前布局**抓的 —— 用 `zoom` 预览会让导出尺寸随预览比例变化。
 * `transform: scale()` 只影响呈现，度量不变；导出走的是下面那个**离屏容器**
 * （`position: fixed; left: -20000px`，未缩放），所以输出恒为 1080 宽 × scale。
 *
 * ## 离屏容器为什么不是 `display: none`
 *
 * `display: none` 的元素没有布局盒，`html2canvas` 抓出来是空白。移到视口外即可：
 * 不参与滚动、不可点击，也不需要可见。
 */
export interface PosterPreviewHandle {
    /** 导出用的离屏容器（未缩放，宽 1080） */
    exportHost: () => HTMLElement | null
    /** 预览容器（量高度用） */
    stageHost: () => HTMLElement | null
}

interface PosterPreviewProps {
    pages: PosterPageModel[]
    options: PosterOptions
    ctx: PosterRenderContext
    zoom: number
    onZoomChange: (zoom: number) => void
    /** 每次重画后回报打码命中数（页面上的说明条用它，保证"预览里看得见"） */
    onMasked?: (masked: number) => void
    /** 页面高度合计（px，未缩放），用于缩放后的占位高度 */
    totalHeight: number
    busy?: boolean
    /** busy 时覆盖在预览上的说明 */
    busyText?: string
    /** 预览为空时进入内容选择步骤 */
    onStartContent?: () => void
}

const ZOOM_MIN = 0.18
const ZOOM_MAX = 1
const ZOOM_STEP = 0.06

/** 预览里多页之间的间距（与 `poster.css` 的 `.poster-stage-host` gap 一致）。 */
export const PREVIEW_PAGE_GAP = 22

export const PosterPreview = forwardRef<PosterPreviewHandle, PosterPreviewProps>(function PosterPreview(props, ref) {
    const { pages, options, ctx, zoom, onZoomChange, onMasked, totalHeight, busy, busyText, onStartContent } = props
    const [fitMode, setFitMode] = useState(true)
    const fitModeRef = useRef(true)
    const zoomRef = useRef(zoom)
    const stageRef = useRef<HTMLDivElement | null>(null)
    const stageFrameRef = useRef<HTMLDivElement | null>(null)
    const exportRef = useRef<HTMLDivElement | null>(null)
    const [renderMs, setRenderMs] = useState<number | null>(null)
    zoomRef.current = zoom
    fitModeRef.current = fitMode

    useImperativeHandle(ref, () => ({
        exportHost: () => exportRef.current,
        stageHost: () => stageRef.current,
    }))

    useLayoutEffect(() => {
        const host = stageRef.current
        if (!host) return
        const startedAt = performance.now()
        const result = renderPosterPages(host, pages, ctx)
        setRenderMs(Math.round(performance.now() - startedAt))
        onMasked?.(result.masked)
        // onMasked 是稳定回调（页面用 useCallback 包了）；pages/ctx 变化才重画
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pages, ctx])

    useLayoutEffect(() => {
        const stage = stageFrameRef.current
        if (!stage) return

        const updateFit = () => {
            if (!fitModeRef.current) return
            const nextZoom = fitZoom(stage)
            if (Math.abs(nextZoom - zoomRef.current) < 0.005) return
            zoomRef.current = nextZoom
            onZoomChange(nextZoom)
        }

        updateFit()
        const observer = new ResizeObserver(updateFit)
        observer.observe(stage)
        return () => observer.disconnect()
    }, [onZoomChange])

    const setManualZoom = (nextZoom: number) => {
        const clamped = clampZoom(nextZoom)
        fitModeRef.current = false
        setFitMode(false)
        zoomRef.current = clamped
        onZoomChange(clamped)
    }

    const enableFitMode = () => {
        fitModeRef.current = true
        setFitMode(true)
        const nextZoom = fitZoom(stageFrameRef.current)
        zoomRef.current = nextZoom
        onZoomChange(nextZoom)
    }

    return (
        <div className="poster-stage-wrap">
            <div className="poster-stage-toolbar">
                <button type="button" className="poster-mini-btn" onClick={() => setManualZoom(zoom - ZOOM_STEP)} aria-label="缩小预览">
                    <Minus size={12} />
                </button>
                <span className="poster-session-meta" data-testid="poster-zoom">
                    {Math.round(zoom * 100)}%
                </span>
                <button type="button" className="poster-mini-btn" onClick={() => setManualZoom(zoom + ZOOM_STEP)} aria-label="放大预览">
                    <Plus size={12} />
                </button>
                <button type="button" className="poster-mini-btn poster-fit-toggle" data-on={fitMode} aria-pressed={fitMode} onClick={enableFitMode}>
                    适应宽度
                </button>
                <button type="button" className="poster-mini-btn" onClick={() => setManualZoom(1)}>
                    100%
                </button>
                <span className="poster-session-meta">
                    {pages.length} 页 · 画布宽 {POSTER_WIDTH}px
                    {renderMs !== null ? ` · 预览重绘 ${renderMs}ms` : ''}
                </span>
            </div>

            <div className="poster-stage" ref={stageFrameRef}>
                {pages.length === 0 ? (
                    <div className="poster-preview-empty">
                        <span className="poster-preview-empty-mark"><Images size={22} aria-hidden="true" /></span>
                        <strong>预览会显示在这里</strong>
                        <span>先选择聊天会话、朋友圈动态，或粘贴一段手写引用。</span>
                        <button type="button" className="ghost-btn compact" onClick={onStartContent}>
                            选择内容<ArrowRight size={13} />
                        </button>
                    </div>
                ) : null}
                {/* transform 不占布局，所以由这一层**显式占位**（缩放后的尺寸）：
                    否则滚动条按未缩放的 1080×H 算，长图滚不到底、横向也会多出一条滚动。 */}
                <div
                    className="poster-stage-scale"
                    style={{ width: POSTER_WIDTH * zoom, height: totalHeight * zoom }}
                >
                    <div className="poster-stage-inner" style={{ transform: `scale(${zoom})`, width: POSTER_WIDTH }}>
                        <div ref={stageRef} className="poster-stage-host" />
                    </div>
                </div>
                {busy ? (
                    <div className="poster-mask-strip" data-enabled="true" style={{ position: 'sticky', bottom: 0 }}>
                        <Loader2 size={13} className="spin" />
                        {busyText ?? '处理中…'}
                    </div>
                ) : null}
            </div>

            {/* 导出容器：离屏、未缩放、只有点导出时才渲染 */}
            <div ref={exportRef} className="poster-export-host" aria-hidden="true" />
        </div>
    )
})

function clampZoom(value: number): number {
    if (!Number.isFinite(value)) return 0.42
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))
}

/** Fit the canvas against the visible stage's content box, including its scrollbar. */
function fitZoom(stage: HTMLElement | null): number {
    if (!stage || typeof window === 'undefined') return 0.42
    const style = window.getComputedStyle(stage)
    const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    const available = Math.max(0, stage.clientWidth - padding - 4)
    const roundedDown = Math.floor((available / POSTER_WIDTH) * 100) / 100
    return clampZoom(roundedDown)
}

export { clampZoom }
