import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { computeFloatingPosition, type FloatingPlacement } from '../../utils/floatingPosition'

/**
 * 浮层的**唯一**渲染出口（v1.0.1）。
 *
 * 只要一个弹层可能出现在滚动容器里、或者靠近窗口边缘，就不能把它挂在文档流里。
 * 这个组件做三件事，缺一不可：
 *
 *   1. **渲染到 `<body>` 下的浮层根节点**。浮层因此跳过所有祖先的
 *      `overflow: hidden/auto`、`transform`、`contain`、`filter` —— 那些属性都会
 *      形成裁剪块或新的层叠上下文，"被别的元素盖住/切掉"几乎总是它们造成的。
 *   2. **用视口坐标定位（position: fixed）**，空间不足时翻到另一侧，贴边时夹回
 *      视口内（算术在 `utils/floatingPosition.ts`，有单测）。
 *   3. **跟着锚点走**：窗口 resize、任意层级的滚动（捕获阶段监听）、锚点自身尺寸
 *      变化（ResizeObserver）都会重新定位，且用 rAF 合并 —— 滚动时每帧最多算一次。
 *
 * 定位完成前浮层是 `visibility: hidden`，不会在错误的位置闪一帧。
 */

export interface FloatingLayerProps {
    /** 触发元素；浮层跟着它的矩形走 */
    anchor: RefObject<HTMLElement | null>
    open: boolean
    children: ReactNode
    /** 期望方向，空间不足会自动翻转。默认 bottom-start */
    placement?: FloatingPlacement
    /** 与触发元素的间距 */
    gap?: number
    /** 固定宽度；不传则用内容宽度 */
    width?: number
    className?: string
    role?: string
    'aria-label'?: string
    /** id，供 aria-controls 关联 */
    id?: string
    /** 层级；默认取 --z-float */
    zIndex?: number
    /** 最小可用高度，两侧都放不下时压到这里并内部滚动 */
    minHeight?: number
}

export default function FloatingLayer({
    anchor,
    open,
    children,
    placement = 'bottom-start',
    gap = 8,
    width,
    className,
    role,
    id,
    zIndex,
    minHeight,
    'aria-label': ariaLabel,
}: FloatingLayerProps) {
    const contentRef = useRef<HTMLDivElement | null>(null)
    const [rect, setRect] = useState<{ top: number; left: number; maxHeight: number | null; side: string } | null>(null)

    const measure = useCallback(() => {
        const el = contentRef.current
        const anchorEl = anchor.current
        if (!el || !anchorEl) return
        const a = anchorEl.getBoundingClientRect()
        // 锚点被隐藏/未布局时不要摆浮层：读到的全 0 矩形会把浮层贴到屏幕角落
        if (a.width === 0 && a.height === 0) return
        const l = el.getBoundingClientRect()
        /**
         * **量的是内容自然高度，不是被压过之后的盒子。**
         *
         * 上限生效时盒子会变矮，如果拿这个变矮的高度当"想要多高"，下一轮就会得出
         * "空间够用、不用设上限"，于是浮层长回去、再被压下来 —— 无限抖动，
         * 而且因为是 ResizeObserver 触发的，表现为弹层疯狂闪烁。
         * `scrollHeight` 在有上限时仍然报告完整内容高度，所以判据是稳定的。
         */
        const naturalHeight = Math.max(l.height, el.scrollHeight)
        const next = computeFloatingPosition({
            anchor: { top: a.top, left: a.left, right: a.right, bottom: a.bottom, width: a.width, height: a.height },
            layer: { width: width ?? l.width, height: naturalHeight },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            placement,
            gap,
            minHeight,
        })
        setRect((prev) =>
            prev && prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight && prev.side === next.side
                ? prev
                : { top: next.top, left: next.left, maxHeight: next.maxHeight, side: next.side }
        )
    }, [anchor, gap, minHeight, placement, width])

    // 首帧定位：先渲染（visibility: hidden）→ 量到真实尺寸 → 定位。
    // 依赖里**不放 children** —— 它每次渲染都是新引用，会让这里每帧都读一次布局；
    // 内容尺寸变化由下面的 ResizeObserver 负责通知。
    useLayoutEffect(() => {
        if (!open) {
            setRect(null)
            return
        }
        measure()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, measure])

    useEffect(() => {
        if (!open) return
        /**
         * 节流，但**不用 requestAnimationFrame**。
         *
         * 弹层重新定位原本挂在 rAF 上，而 rAF 在窗口不可见/被判定为被遮挡时会停摆 ——
         * 探针把窗口移到屏幕外，于是"列表从空到 60 条"引发的尺寸变化**永远不会**被
         * 重新测量，浮层就停留在按旧高度算出的位置上（实测就是这么漏过去的）。
         * setTimeout 在后台窗口里也会被节流到 1s 一次，但至少一定会跑。
         */
        let timer = 0
        let last = 0
        const schedule = () => {
            if (timer) return
            const wait = Math.max(0, 16 - (Date.now() - last))
            timer = window.setTimeout(() => {
                timer = 0
                last = Date.now()
                measure()
            }, wait)
        }
        // 捕获阶段监听：页面主体滚动之外，锚点所在的任意内层滚动容器也要跟。
        // 用 { passive: true } 是因为这里永远不 preventDefault。
        window.addEventListener('scroll', schedule, { capture: true, passive: true })
        window.addEventListener('resize', schedule)

        const anchorEl = anchor.current
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
        if (anchorEl && observer) observer.observe(anchorEl)
        const contentEl = contentRef.current
        if (contentEl && observer) observer.observe(contentEl)

        return () => {
            if (timer) window.clearTimeout(timer)
            window.removeEventListener('scroll', schedule, { capture: true })
            window.removeEventListener('resize', schedule)
            observer?.disconnect()
        }
    }, [open, measure, anchor])

    if (!open || typeof document === 'undefined') return null

    /**
     * 结构：定位用的根（`position: fixed`，**没有高度上限**）> 内容包装层（上限在这里）。
     *
     * 上限必须挂在包装层而不是根上，因为根要用来量"内容自然多高"（见 measure 的说明）：
     * 根一旦被压矮，就再也读不出内容原本想要多高。
     */
    return createPortal(
        <div
            id={id}
            role={role}
            aria-label={ariaLabel}
            data-floating-layer="true"
            className={className}
            style={{
                position: 'fixed',
                top: rect?.top ?? 0,
                left: rect?.left ?? 0,
                width: width ? `${width}px` : undefined,
                // 定位完成前不可见：否则第一帧会出现在 (0,0)
                visibility: rect ? 'visible' : 'hidden',
                zIndex: zIndex ?? 'var(--z-float, 1200)',
            }}
        >
            <div
                ref={contentRef}
                style={{
                    maxHeight: rect?.maxHeight != null ? `${rect.maxHeight}px` : undefined,
                    overflow: rect?.maxHeight != null ? 'auto' : undefined,
                    overscrollBehavior: 'contain',
                }}
            >
                {children}
            </div>
        </div>,
        document.body
    )
}
