import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Crop, Eye, EyeOff, GripVertical, Square } from 'lucide-react'
import FloatingLayer from '../ui/FloatingLayer'
import type { PosterCrop, PosterItem } from './posterTypes.ts'
import { clampCrop } from './posterLayout.ts'

/**
 * 条目编辑器：排序 / 显示 / 裁剪 / 遮挡（v1.2 §4）。
 *
 * ## 拖动有两条等价路径
 *
 * 指针拖动（鼠标）**和**键盘（每条上的 ↑ / ↓ 按钮）都能改顺序。只做拖动的话，
 * 这个页面就没法只用键盘完成；只做按钮的话，长图的排序会变成点很多次。
 * 两根路径都调用同一个纯 reducer（`posterLayout.applyReorder`），所以顺序结果一致。
 *
 * ## 拖动期间不许抓图
 *
 * `onDragStateChange` 把"正在拖"告诉页面：拖动中禁止导出（`html2canvas` 会在
 * 布局抖动时抓到半张图，而且拖一下要几十毫秒 —— 那是长任务的来源）。
 */
export interface PosterItemEditorProps {
    items: PosterItem[]
    onReorder: (from: number, to: number) => void
    onToggleVisible: (key: string, visible: boolean) => void
    /** 全显示 / 全隐藏（长图里"只看我发的"这种批量调整） */
    onSetAllVisible: (visible: boolean) => void
    /** 只留这些 key 可见（九宫格挑图用） */
    onIsolate: (keys: string[]) => void
    onCrop: (key: string, crop: PosterCrop) => void
    onMaskBox: (key: string, box: PosterCrop | null) => void
    onLoadImage?: (key: string) => void
    /** true = 该模板支持拖排序（引用卡/小结卡没有意义） */
    reorderEnabled: boolean
    cropEnabled: boolean
    onDragStateChange: (dragging: boolean) => void
    busyKey?: string | null
}

/** 一行摘要：让用户认得出这是哪一条（时间 + 谁 + 前 20 字）。 */
export function itemSummary(item: PosterItem): string {
    const time = item.ts ? new Date(item.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
    const who = item.senderName || (item.isSend ? '我' : '对方')
    const text = (item.text || item.imageAlt || '').replace(/\s+/g, ' ').slice(0, 24)
    return [time, who, text].filter(Boolean).join(' · ')
}

export function PosterItemEditor(props: PosterItemEditorProps) {
    const { items, onReorder, onToggleVisible, reorderEnabled, cropEnabled, onDragStateChange } = props
    const [dragIndex, setDragIndex] = useState<number | null>(null)
    const [dropIndex, setDropIndex] = useState<number | null>(null)
    const [cropKey, setCropKey] = useState<string | null>(null)
    const [maskKey, setMaskKey] = useState<string | null>(null)
    const listRef = useRef<HTMLDivElement | null>(null)
    /**
     * 裁剪浮层必须挂在**真实可见的锚点**上。
     *
     * `FloatingLayer` 量不到锚点矩形（宽高都为 0）时会拒绝定位、保持
     * `visibility: hidden` —— 传一个空的 ref 进去，浮层就永远不出现，
     * 而且不报错。所以这里记住每一行的裁剪按钮，点开时把那个按钮当锚点。
     */
    const cropBtnRefs = useRef(new Map<string, HTMLButtonElement | null>())
    const cropAnchor = useRef<HTMLElement | null>(null)
    const maskBtnRefs = useRef(new Map<string, HTMLButtonElement | null>())
    const maskAnchor = useRef<HTMLElement | null>(null)

    useEffect(() => {
        onDragStateChange(dragIndex !== null)
    }, [dragIndex, onDragStateChange])

    const endDrag = useCallback(() => {
        if (dragIndex !== null && dropIndex !== null && dropIndex !== dragIndex) onReorder(dragIndex, dropIndex)
        setDragIndex(null)
        setDropIndex(null)
    }, [dragIndex, dropIndex, onReorder])

    /** 指针落在哪一行：用行的中位线判断"插到它前面还是后面"。 */
    const indexAtPoint = (clientY: number): number | null => {
        const list = listRef.current
        if (!list) return null
        const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-item-index]'))
        for (const row of rows) {
            const rect = row.getBoundingClientRect()
            if (clientY < rect.top + rect.height / 2) return Number(row.dataset.itemIndex)
        }
        return rows.length > 0 ? Number(rows[rows.length - 1].dataset.itemIndex) : null
    }

    const cropItem = cropKey ? items.find((item) => item.key === cropKey) : undefined
    const maskItem = maskKey ? items.find((item) => item.key === maskKey) : undefined

    return (
        <div className="poster-field">
            <div className="poster-field-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>条目（{items.filter((i) => i.visible).length}/{items.length} 可见）</span>
                <span className="poster-session-meta">
                    {reorderEnabled ? '拖动或 ↑↓ 排序' : '该模板按固定顺序取用'}
                </span>
            </div>
            <div className="poster-filter-row">
                <button type="button" className="poster-mini-btn" onClick={() => props.onSetAllVisible(true)}>
                    全部显示
                </button>
                <button type="button" className="poster-mini-btn" onClick={() => props.onSetAllVisible(false)}>
                    全部隐藏
                </button>
                {cropEnabled ? (
                    <button
                        type="button"
                        className="poster-mini-btn"
                        title="只保留图片条目可见（九宫格挑图）"
                        disabled={items.every((item) => item.kind === 'image')}
                        onClick={() => props.onIsolate(items.filter((item) => item.kind === 'image').map((item) => item.key))}
                    >
                        只留图片
                    </button>
                ) : null}
            </div>
            <div className="poster-item-list" ref={listRef}>
                {items.map((item, index) => (
                    <div key={item.key} className="poster-item-row" data-item-index={index} data-dragging={dragIndex === index} data-drop={dropIndex === index && dragIndex !== index} data-hidden={!item.visible}>
                        <button
                            type="button"
                            className="poster-mini-btn"
                            aria-label={item.visible ? '隐藏这一条' : '显示这一条'}
                            aria-pressed={item.visible}
                            onClick={() => onToggleVisible(item.key, !item.visible)}
                        >
                            {item.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                        </button>
                        <span className="poster-item-text" title={itemSummary(item)}>
                            {itemSummary(item)}
                        </span>
                        {item.imageUnavailable && props.onLoadImage ? (
                            <button type="button" className="poster-mini-btn" disabled={props.busyKey === item.key} onClick={() => props.onLoadImage?.(item.key)}>
                                {props.busyKey === item.key ? '载入中' : '载入图片'}
                            </button>
                        ) : null}
                        {cropEnabled && item.kind === 'image' ? (
                            <button
                                ref={(node) => {
                                    cropBtnRefs.current.set(item.key, node)
                                }}
                                type="button"
                                className="poster-mini-btn"
                                data-on={Boolean(item.crop)}
                                aria-label="裁剪这一张"
                                disabled={item.imageUnavailable}
                                onClick={() => {
                                    cropAnchor.current = cropBtnRefs.current.get(item.key) ?? null
                                    setCropKey(item.key)
                                }}
                            >
                                <Crop size={11} />
                            </button>
                        ) : null}
                        {item.kind === 'image' ? (
                            <button
                                ref={(node) => {
                                    maskBtnRefs.current.set(item.key, node)
                                }}
                                type="button"
                                className="poster-mini-btn"
                                data-on={Boolean(item.maskBox)}
                                aria-label={item.maskBox ? '编辑遮挡区域' : '框选遮挡区域'}
                                title={item.imageUnavailable ? '先载入图片，再框选需要遮挡的区域' : '在图片上拖动框选需要遮挡的区域'}
                                disabled={item.imageUnavailable}
                                onClick={() => {
                                    maskAnchor.current = maskBtnRefs.current.get(item.key) ?? null
                                    setMaskKey(item.key)
                                }}
                            >
                                <Square size={11} />
                            </button>
                        ) : null}
                        {reorderEnabled ? (
                            <>
                                <button
                                    type="button"
                                    className="poster-mini-btn"
                                    aria-label="上移"
                                    disabled={index === 0}
                                    onClick={() => onReorder(index, index - 1)}
                                >
                                    <ArrowUp size={11} />
                                </button>
                                <button
                                    type="button"
                                    className="poster-mini-btn"
                                    aria-label="下移"
                                    disabled={index === items.length - 1}
                                    onClick={() => onReorder(index, index + 1)}
                                >
                                    <ArrowDown size={11} />
                                </button>
                                <span
                                    className="poster-item-handle"
                                    role="button"
                                    tabIndex={0}
                                    aria-label="拖动排序"
                                    title="拖动排序"
                                    onPointerDown={(event) => {
                                        event.currentTarget.setPointerCapture(event.pointerId)
                                        setDragIndex(index)
                                        setDropIndex(index)
                                    }}
                                    onPointerMove={(event) => {
                                        if (dragIndex === null) return
                                        const next = indexAtPoint(event.clientY)
                                        if (next !== null) setDropIndex(next)
                                    }}
                                    onPointerUp={(event) => {
                                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                                        endDrag()
                                    }}
                                    onPointerCancel={endDrag}
                                >
                                    <GripVertical size={12} />
                                </span>
                            </>
                        ) : null}
                    </div>
                ))}
                {items.length === 0 ? <span className="poster-redaction-note">还没有内容：先在左边选一段会话或写一条引用。</span> : null}
            </div>

            {cropItem ? (
                <PosterCropTool
                    key={cropItem.key}
                    item={cropItem}
                    anchorRef={cropAnchor}
                    onCancel={() => setCropKey(null)}
                    onApply={(crop) => {
                        props.onCrop(cropItem.key, crop)
                        setCropKey(null)
                    }}
                />
            ) : null}

            {maskItem ? (
                <PosterMaskTool
                    key={maskItem.key}
                    item={maskItem}
                    anchorRef={maskAnchor}
                    onCancel={() => setMaskKey(null)}
                    onApply={(box) => {
                        props.onMaskBox(maskItem.key, box)
                        setMaskKey(null)
                    }}
                />
            ) : null}
        </div>
    )
}

/** Manual redaction is a user-drawn normalized rectangle on the actual image. */
function PosterMaskTool({
    item,
    anchorRef,
    onCancel,
    onApply,
}: {
    item: PosterItem
    anchorRef: { current: HTMLElement | null }
    onCancel: () => void
    onApply: (box: PosterCrop | null) => void
}) {
    const [box, setBox] = useState<PosterCrop | null>(() => item.maskBox ?? null)
    const [imageRatio, setImageRatio] = useState(1)
    const frameRef = useRef<HTMLDivElement | null>(null)
    const start = useRef<{ x: number; y: number } | null>(null)
    const frameSize = imageRatio >= 1
        ? { width: 260, height: Math.max(90, 260 / imageRatio) }
        : { width: Math.max(90, 260 * imageRatio), height: 260 }

    const pointToNorm = (clientX: number, clientY: number) => {
        const rect = frameRef.current?.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
        return {
            x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
        }
    }

    return (
        <FloatingLayer anchor={anchorRef} open placement="top-end" gap={10} width={304} className="poster-float-layer">
            <div className="poster-float-card" role="dialog" aria-label="手动遮挡区域">
                <span className="poster-float-title">在图片上拖动框选要遮挡的区域</span>
                <div
                    ref={frameRef}
                    className="poster-crop-frame poster-mask-frame"
                    style={frameSize}
                    tabIndex={0}
                    onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId)
                        const point = pointToNorm(event.clientX, event.clientY)
                        start.current = point
                        setBox({ x: point.x, y: point.y, w: 0.01, h: 0.01 })
                    }}
                    onPointerMove={(event) => {
                        if (!start.current) return
                        const point = pointToNorm(event.clientX, event.clientY)
                        const left = Math.min(start.current.x, point.x)
                        const top = Math.min(start.current.y, point.y)
                        setBox({ x: left, y: top, w: Math.max(0.01, Math.abs(point.x - start.current.x)), h: Math.max(0.01, Math.abs(point.y - start.current.y)) })
                    }}
                    onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                        start.current = null
                    }}
                    onPointerCancel={() => { start.current = null }}
                >
                    {item.imageSrc ? <img src={item.imageSrc} alt={item.imageAlt || '待遮挡图片'} draggable={false} onLoad={(event) => {
                        const image = event.currentTarget
                        if (image.naturalWidth > 0 && image.naturalHeight > 0) setImageRatio(image.naturalWidth / image.naturalHeight)
                    }} /> : <span className="poster-crop-empty">先载入图片</span>}
                    {box ? <span className="poster-mask-selection" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} /> : null}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="poster-redaction-note">遮挡框会以实心块写入预览和导出图片。</span>
                    <button type="button" className="poster-mini-btn" onClick={() => setBox(null)}>清除框选</button>
                    <button type="button" className="poster-mini-btn" onClick={onCancel}>取消</button>
                    <button type="button" className="ghost-btn compact" onClick={() => onApply(box)} disabled={!box}>应用</button>
                </div>
            </div>
        </FloatingLayer>
    )
}

/**
 * 裁剪工具 —— **浮层**（铁律 1）。
 *
 * 交互是"在图上拉一个框"：框用归一化矩形保存，所以与图片原始像素无关
 * （换一张同等比例的图不会让框漂移）。支持拖动整框与右下角把手缩放，
 * 也支持键盘（方向键移动、Shift+方向键缩放），因为按像素拉框对触控板不友好。
 */
function PosterCropTool({
    item,
    anchorRef,
    onCancel,
    onApply,
}: {
    item: PosterItem
    anchorRef: { current: HTMLElement | null }
    onCancel: () => void
    onApply: (crop: PosterCrop) => void
}) {
    const [crop, setCrop] = useState<PosterCrop>(() => item.crop ?? { x: 0, y: 0, w: 1, h: 1 })
    const frameRef = useRef<HTMLDivElement | null>(null)
    const dragMode = useRef<'move' | 'resize' | null>(null)
    const dragFrom = useRef({ x: 0, y: 0, crop } as { x: number; y: number; crop: PosterCrop })

    const pointToNorm = (clientX: number, clientY: number) => {
        const frame = frameRef.current
        if (!frame) return { x: 0, y: 0 }
        const rect = frame.getBoundingClientRect()
        return {
            x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
        }
    }

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.altKey ? 0.01 : 0.03
        const map: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
        }
        const delta = map[event.key]
        if (!delta) return
        event.preventDefault()
        setCrop((prev) =>
            clampCrop(
                event.shiftKey
                    ? { ...prev, w: prev.w + delta[0], h: prev.h + delta[1] }
                    : { x: prev.x + delta[0], y: prev.y + delta[1], w: prev.w, h: prev.h }
            )
        )
    }

    return (
        <FloatingLayer anchor={anchorRef} open placement="top-end" gap={10} width={304} className="poster-float-layer">
            <div className="poster-float-card" role="dialog" aria-label="裁剪图片">
                <span className="poster-float-title">裁剪（拖框移动，拖右下角把手缩放，方向键微调）</span>
                <div
                    ref={frameRef}
                    className="poster-crop-frame"
                    tabIndex={0}
                    onKeyDown={onKeyDown}
                    onPointerDown={(event) => {
                        const target = event.target as HTMLElement
                        // 指针捕获挂在**框**上（不是把手）：捕获之后 move 事件才会持续
                        // 送到这里，把手挪出指针范围也不会丢事件。
                        event.currentTarget.setPointerCapture(event.pointerId)
                        if (target.dataset.role === 'resize') {
                            dragMode.current = 'resize'
                            dragFrom.current = { x: 0, y: 0, crop }
                            return
                        }
                        const point = pointToNorm(event.clientX, event.clientY)
                        dragMode.current = 'move'
                        dragFrom.current = { x: point.x, y: point.y, crop }
                    }}
                    onPointerMove={(event) => {
                        if (!dragMode.current) return
                        const point = pointToNorm(event.clientX, event.clientY)
                        if (dragMode.current === 'move') {
                            const from = dragFrom.current
                            setCrop(clampCrop({ ...from.crop, x: from.crop.x + (point.x - from.x), y: from.crop.y + (point.y - from.y) }))
                        } else {
                            const from = dragFrom.current
                            setCrop(clampCrop({ ...from.crop, w: point.x - from.crop.x, h: point.y - from.crop.y }))
                        }
                    }}
                    onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                        dragMode.current = null
                    }}
                    onPointerCancel={() => {
                        dragMode.current = null
                    }}
                >
                    {item.imageSrc ? (
                        <img src={item.imageSrc} alt={item.imageAlt || '待裁剪图片'} draggable={false} />
                    ) : (
                        <span className="poster-crop-empty">这张图还没解密</span>
                    )}
                    <span className="poster-crop-shade" style={{ left: 0, top: 0, width: '100%', height: `${crop.y * 100}%` }} />
                    <span className="poster-crop-shade" style={{ left: 0, top: `${(crop.y + crop.h) * 100}%`, width: '100%', height: `${Math.max(0, 1 - crop.y - crop.h) * 100}%` }} />
                    <span className="poster-crop-shade" style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.h * 100}%` }} />
                    <span className="poster-crop-shade" style={{ left: `${(crop.x + crop.w) * 100}%`, top: `${crop.y * 100}%`, width: `${Math.max(0, 1 - crop.x - crop.w) * 100}%`, height: `${crop.h * 100}%` }} />
                    <span className="poster-crop-rect" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }} />
                    <span
                        className="poster-crop-handle"
                        data-role="resize"
                        title="拖动缩放裁剪框"
                        style={{ left: `${(crop.x + crop.w) * 100}%`, top: `${(crop.y + crop.h) * 100}%` }}
                    />
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="poster-redaction-note">
                        {Math.round(crop.w * 100)}% × {Math.round(crop.h * 100)}%
                    </span>
                    <button type="button" className="poster-mini-btn" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>
                        重置
                    </button>
                    <button type="button" className="poster-mini-btn" onClick={onCancel}>
                        取消
                    </button>
                    <button type="button" className="ghost-btn compact" onClick={() => onApply(crop)}>
                        应用
                    </button>
                </div>
            </div>
        </FloatingLayer>
    )
}
