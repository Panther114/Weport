import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Avatar } from './Avatar'
import LiquidGlass, { type LiquidGlassBackdropImage } from './LiquidGlass'
import { renderTextWithEmoji } from '../utils/renderTextWithEmoji'
import {
    NOTIFICATION_GLASS_DEFAULT,
    notificationCardExtraWidth,
    notificationCardPadding,
    notificationCardWidth,
    notificationGlassRenderParams,
    notificationGlassVars,
    type NotificationGlass
} from '../utils/notificationGlass'
import './NotificationToast.scss'

export interface NotificationData {
    id: string
    sessionId: string
    channel?: string
    insightRecordId?: string
    targetRoute?: string
    avatarUrl?: string
    title: string
    content: string
    timestamp: number
    /** 常驻模式：不自动淡出（QA 截图模式用，保证捕获完整不透明卡片） */
    persistent?: boolean
    /** 主进程根据用户配置下发的显示时长（毫秒） */
    notificationDuration?: number
    /** 是否播放弹窗入场/退场动效 */
    notificationAnimationEnabled?: boolean
}

interface NotificationToastProps {
    data: NotificationData | null
    onClose: () => void
    duration?: number
    initialVisible?: boolean
    /** 回退管线的屏幕几何信息（含首帧快照），玻璃用它对齐折射采样 */
    backdropImage?: LiquidGlassBackdropImage
    /** 实时桌面视频流：就绪后玻璃跟着桌面逐帧更新（静态快照只作首帧兜底） */
    backdropStream?: MediaStream | null
    /** 原生玻璃模式（Windows）：折射由主进程原生面板渲染，卡片背景透明 */
    nativeBackdrop?: boolean
    /** 是否播放入场、退场和卡片过渡动效 */
    animationEnabled?: boolean
    /** 退场动画开始的一刻触发（原生模式用来提前淡出原生面板） */
    onHideStart?: () => void
    /**
     * 玻璃与卡片观感（设置 → 消息通知设置 → 通知玻璃）。是**变量**而不是写死的观感，
     * 因此同一份配置在弹窗与设置页预览里渲染出的结果完全一致。
     */
    glass?: NotificationGlass
    /**
     * 实测尺寸上报（v1.0.1）。
     *
     * 卡片宽度不再是常数：昵称放不下时它会自己变宽（见下面的自适应逻辑），
     * 而弹窗窗口必须**跟着卡片一起变**，否则右侧被裁掉或者留下一片拦截点击的空白。
     * 主进程只认渲染层报上来的数，这个回调就是那条链路的上半段。
     */
    onMeasure?: (size: { width: number; height: number }) => void
}

/**
 * 通知卡片：始终渲染为全局液态玻璃（LiquidGlass 兼容层），在独立通知窗口内展示。
 * 折射背景：原生面板（默认关闭）或桌面视频流（渲染层 getUserMedia，逐帧实时）；
 * 视频流出帧前用主进程下发的首帧快照垫底。
 * 卡片不导航、不弹出菜单；右键当前卡片即可关闭，默认按配置时长自动消失。
 *
 * ## 自适应宽度与高度（v1.0.1）
 *
 * 用户报的问题：昵称很长时它和右上角的时间撞在一起（旧实现是硬截断 + 给时间留
 * 50px 的死值），长消息也只能看到两行。两条都不是"排版微调"能解决的 —— 卡片本身
 * 得让出空间：
 *
 *   · **宽度**：标题的自然宽度由一段隐藏的测量元素给出（不受当前卡片宽度影响，
 *     因此不需要"先渲染再量、量完再缩"的来回）；差额按 1:1 加在卡片宽度上，
 *     上限 +220px。标题仍然单行，超过上限才用省略号收尾。
 *   · **高度**：正文行数上限由用户配置（默认 4 行），卡片高度自然增长，
 *     窗口高度由主进程按实测值同步。
 *
 * 向上取整与上限裁剪都在 `notificationCardWidth()` 里（纯函数，有单测）。
 */
export function NotificationToast({
    data,
    onClose,
    duration = 5000,
    initialVisible = false,
    backdropImage,
    backdropStream,
    nativeBackdrop = false,
    animationEnabled = true,
    onHideStart,
    glass = NOTIFICATION_GLASS_DEFAULT,
    onMeasure,
}: NotificationToastProps) {
    const [isVisible, setIsVisible] = useState(initialVisible)
    /**
     * 首帧就用 props 里的 data 渲染，不经过"先空一帧、再由 effect 填上"。
     *
     * 这个组件每来一条通知都会因 `key` 变化而重新挂载，所以初始值就是这一条的
     * 内容。旧写法（`useState(null)` + effect 里 set）会让第一次提交渲染出一个
     * **空容器**（高度 0）：窗口尺寸上报读到的就是 0，而主进程现在正是按这份
     * 上报来定尺寸再显示弹窗的 —— 空一帧的代价从"白画一帧"变成"窗口按 0 高度
     * 弹一下再长开"。入场动画不受影响：`isVisible` 仍由 effect 翻到 true，
     * 过渡照旧走。
     */
    const [currentData, setCurrentData] = useState<NotificationData | null>(data)
    /** 标题放不下时额外申请的宽度（0 = 基础宽度够用） */
    const [extraWidth, setExtraWidth] = useState(0)
    const onHideStartRef = useRef(onHideStart)
    const onCloseRef = useRef(onClose)
    const onMeasureRef = useRef(onMeasure)
    const closeTimerRef = useRef<number | null>(null)
    const dismissedRef = useRef(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const titleRef = useRef<HTMLSpanElement>(null)
    const titleMeasureRef = useRef<HTMLSpanElement>(null)
    onHideStartRef.current = onHideStart
    onCloseRef.current = onClose
    onMeasureRef.current = onMeasure

    const cardWidth = notificationCardWidth(glass.width, extraWidth)
    /**
     * 卡片四周留白 = 基础 8px + 投影要占的空间。
     *
     * 窗口尺寸等于容器的**边框盒**，所以留白就是"投影能画到哪里"。旧实现把留白
     * 写死在 CSS 里（8px），用户把投影拉到 100 时投影要甩出 30 多像素，
     * 多出来的部分被窗口裁掉 —— 滑块看起来毫无作用。见 notificationShadowMargin。
     */
    const pad = notificationCardPadding(glass.shadow)
    const boxWidth = cardWidth + pad * 2
    /** 盒子总宽（含留白）——弹窗窗口必须正好是这个数，否则右侧被裁或留下一片拦截点击的空白 */
    const boxWidthRef = useRef(boxWidth)
    boxWidthRef.current = boxWidth

    // 任何路径（超时）触发的退场都在动画开始的一刻通知外层
    const beginHide = () => {
        setIsVisible(false)
        onHideStartRef.current?.()
    }

    const dismiss = () => {
        if (dismissedRef.current) return
        dismissedRef.current = true
        beginHide()
        closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = null
            onCloseRef.current()
        }, animationEnabled ? 300 : 0)
    }

    useEffect(() => {
        if (data) {
            dismissedRef.current = false
            if (closeTimerRef.current !== null) {
                window.clearTimeout(closeTimerRef.current)
                closeTimerRef.current = null
            }
            setCurrentData(data)
            setExtraWidth(0)
            setIsVisible(true)

            if (data.persistent) return

            const timer = window.setTimeout(dismiss, duration)

            return () => window.clearTimeout(timer)
        } else {
            setIsVisible(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, duration])

    useEffect(() => () => {
        if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    }, [])

    /**
     * 自适应加宽：量标题的**自然宽度**，再与"基础宽度下它能拿到多少"比。
     *
     * 用隐藏测量元素而不是标题自身的 scrollWidth —— 标题在被撑宽之后 scrollWidth
     * 就等于 clientWidth，量出来永远是"刚好放得下"，于是卡片会先变宽再缩回去。
     * 测量元素的宽度与卡片当前宽度无关，因此这个计算是幂等的（跑多少次结果一样），
     * 不需要"只在第一次量"这种脆弱的状态。
     *
     * 度量全部用 getBoundingClientRect 的**小数**值，并额外留 1px 余量：标题的
     * clientWidth 是取整的，差半个像素就会触发省略号（实测：420px 宽时最后一个字
     * 仍被"…"吃掉）。留 1px 的代价是卡片可能宽出一个像素，肉眼不可见。
     */
    const measureExtraWidth = (): number => {
        const measureEl = titleMeasureRef.current
        const titleEl = titleRef.current
        const container = containerRef.current
        if (!measureEl || !titleEl || !container) return 0
        const natural = measureEl.getBoundingClientRect().width
        // chrome = 卡片里除标题外被占掉的宽度（内边距 + 头像 + 时间 + 间隙）。
        // 它与卡片宽度无关，因此可以从当前这一帧直接反推基础宽度下的可用宽度。
        // 容器的边框盒含四周留白，先减掉它才是卡片自己的宽度。
        const chrome = container.getBoundingClientRect().width - pad * 2 - titleEl.getBoundingClientRect().width
        return notificationCardExtraWidth(natural + 1, glass.width - chrome)
    }

    // 每次渲染后都跑（两次布局读取，成本可忽略）：字体加载完、emoji 图就位之后
    // 宽度会再收敛一次。
    useLayoutEffect(() => {
        const needed = measureExtraWidth()
        if (needed !== extraWidth) setExtraWidth(needed)
    })

    /** 尺寸上报：**容器**宽度（含投影留白）+ 容器高度。窗口必须等于它。 */
    useLayoutEffect(() => {
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        onMeasureRef.current?.({ width: boxWidthRef.current, height: Math.ceil(rect.height) })
    }, [cardWidth, currentData, glass.maxLines, glass.frost, glass.blur, pad])

    // 字体 / 表情图就位后重新收敛（首帧用的是回退字体的度量）
    useEffect(() => {
        let cancelled = false
        const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
        void fonts?.ready?.then(() => {
            if (cancelled) return
            const needed = measureExtraWidth()
            if (needed !== extraWidth) setExtraWidth(needed)
        })
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentData, extraWidth, glass.width])

    if (!currentData) return null

    const render = notificationGlassRenderParams(glass)
    // 变量挂在**卡片容器**上（不是 documentElement）：设置页的预览卡片用的是
    // 同一个组件、同一组变量，因此"预览 = 真弹窗"是结构上成立的，不靠人工同步。
    // null 值的变量直接不写（--glass-text-color 未指定时让 --noti-* 生效）。
    const glassStyle = Object.fromEntries(
        Object.entries(notificationGlassVars(glass)).filter(([, value]) => value !== null)
    ) as CSSProperties

    /**
     * 折射与磨砂只有在**有背景像素可加工**时才会改变观感。
     *
     * 弹窗是 Electron 透明窗口，Chromium 在那里不生效 `backdrop-filter`；能作用的
     * 对象只有主进程推上来的桌面帧。所以：用户把"折射强度"或"玻璃模糊"拨离 0 时
     * 才把 `backdropImage` 接进玻璃，两个都是 0（默认）时保持完全透明卡片 ——
     * 默认观感不变，也不为一项没人用的效果每帧合成一张整屏截图。
     */
    const effectiveBackdrop = render.needsBackdrop ? backdropImage : undefined

    return (
        <div
            ref={containerRef}
            className={`notification-toast-container ${isVisible ? 'visible' : ''} ${animationEnabled ? '' : 'motion-disabled'}`.trim()}
            style={{ ...glassStyle, width: boxWidth, padding: pad }}
            onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                dismiss()
            }}
        >
            <LiquidGlass
                cornerRadius={glass.radius}
                padding="12px 10px"
                // 折射/模糊强度来自同一份配置，弹窗与设置页预览共用
                // notificationGlassRenderParams()，两条路径不会算出不同的玻璃厚度。
                blurAmount={render.blurAmount}
                blurPx={render.blurPx}
                saturation={render.saturation}
                displacementScale={render.displacementScale}
                aberrationIntensity={render.aberrationIntensity}
                backdropImage={effectiveBackdrop}
                backdropStream={effectiveBackdrop ? backdropStream : null}
                nativeBackdrop={nativeBackdrop}
                hoverEffect={false}
            >
                <div className="notification-content">
                    <div className="notification-avatar">
                        <Avatar
                            src={currentData.avatarUrl}
                            name={currentData.title}
                            size={40}
                        />
                    </div>
                    <div className="notification-text">
                        <div className="notification-header">
                            <span className="notification-title" ref={titleRef}>{currentData.title}</span>
                            {/* 隐藏测量元素：只用来问"这个标题的自然宽度是多少"，
                                它不参与排版（position:absolute + visibility:hidden）。 */}
                            <span className="notification-title-measure" ref={titleMeasureRef} aria-hidden="true">
                                {currentData.title}
                            </span>
                            <span className="notification-time">
                                {new Date(currentData.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                        </div>
                        <div className="notification-body">
                            {renderTextWithEmoji(currentData.content, 17)}
                        </div>
                    </div>
                </div>
            </LiquidGlass>
        </div>
    )
}
