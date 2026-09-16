import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import GlassFilter from './GlassFilter'
import { generateLensDisplacementMap } from './lensDisplacementMap'
import { GLASS_OPTICS_MODEL_DEFAULT, prefersReducedMotion, type GlassOpticsModel } from './glassPhysics'

/**
 * 界面（导航层）用的液态玻璃表面。
 *
 * 用的是**本项目自己的折射引擎**（lensDisplacementMap + GlassFilter）：位移贴图 + SVG
 * `feDisplacementMap` + 三通道色散 + 贴图蓝通道里的镜面高光。刻意不用
 * `@samasante/liquid-glass` —— 那个库在本项目里量到的内部尺寸恒为 0×0，材质从不生效
 * （证据见 .ui-probe/diagnose-glass-errors.mjs）。
 *
 * 与弹窗的区别：弹窗是**透明窗口**，渲染层拿不到窗口背后的桌面，必须由主进程抓屏喂进来；
 * 这里是普通窗口，导航层背后就是本应用自己的壁纸图层，于是直接用
 * `backdrop-filter: url(#滤镜)` 折射真实背景 —— Chromium 原生合成路径，不抓屏、不跑 JS。
 *
 * 苹果的层级规则：玻璃属于**控制与导航层**（导航、工具栏、浮层），不要用在内容层，
 * 也不要把玻璃叠在玻璃上。
 *
 * ## 运动响应（pointer sheen）
 *
 * 玻璃会跟着指针走一层柔光——这是液态玻璃"活的"那一半。实现上有一处**刻意的取舍**：
 * 位移贴图**绝不**跟着指针重算（文章明确要求"贴图只在形状变化时重算，移动不重算"），
 * 高光改为元素自己的 `background-image` 径向渐变，位置由两个 CSS 变量驱动，
 * rAF 节流写入 —— 没有布局、没有重算贴图，只有一次廉价的图层重绘。
 * 系统开启"减少动态效果"时整体关闭。
 *
 * ## 性能闸门
 *  · 视频背景 → 不做逐帧折射（实测过：大表面上的逐帧 backdrop-filter 就是
 *    "选了视频背景就卡"的根因；位移滤镜比模糊更贵，不值得赌）；
 *  · 没有背景 → 没东西可折射；· 系统要求减少透明度 → 退回实底保证对比度。
 * 贴图只在**尺寸/圆角变化**时重算。
 */
export interface GlassSurfaceProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
    children: ReactNode
    /** 光学参数覆盖（默认 GLASS_OPTICS_MODEL_DEFAULT：IOR 1.5、左上打光） */
    optics?: Partial<GlassOpticsModel>
    /** 强制开/关折射；不传则按 shouldRefract() 判定 */
    refract?: boolean
    /** 圆角 px（贴图的圆角按它算，必须与 CSS 的 border-radius 一致） */
    radius?: number
    /** 兜底表面底色 */
    fallbackBackground?: string
    /** 调试标签（出现在 data 属性上，探针据此断言走了哪条路径） */
    surfaceId?: string
}

/** 这个表面该不该做实时折射。理由见文件头。 */
function shouldRefract(): boolean {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false
    if (window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches) return false
    const root = document.documentElement
    // 视频背景：逐帧折射太贵（实测过的老问题），退回静态表面
    if (root.dataset.bgKind === 'video') return false
    return root.dataset.hasBg === 'true'
}

export function GlassSurface({
    children,
    className,
    style,
    optics,
    refract,
    radius = 0,
    fallbackBackground = 'var(--panel, rgba(18, 18, 22, 0.72))',
    surfaceId,
    ...rest
}: GlassSurfaceProps) {
    const filterId = `glass-surface-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
    const hostRef = useRef<HTMLDivElement | null>(null)
    const [box, setBox] = useState({ w: 0, h: 0 })
    const [allowed, setAllowed] = useState(() => refract ?? shouldRefract())

    // 折射闸门要跟着外观配置变化重判（背景类型是异步加载的）
    useEffect(() => {
        if (refract !== undefined) {
            setAllowed(refract)
            return
        }
        const root = document.documentElement
        const update = () => setAllowed(shouldRefract())
        update()
        const mq = window.matchMedia?.('(prefers-reduced-transparency: reduce)')
        mq?.addEventListener?.('change', update)
        const observer = new MutationObserver(update)
        observer.observe(root, { attributes: true, attributeFilter: ['data-bg-kind', 'data-has-bg'] })
        return () => {
            mq?.removeEventListener?.('change', update)
            observer.disconnect()
        }
    }, [refract])

    /**
     * 量自己的尺寸。依赖里带 `allowed` 是**必须**的：首帧背景类型还没加载、`allowed`
     * 为 false，可能走不带 ref 的渲染分支；effect 若只跑一次就会拿到 null 并永不重跑，
     * `box` 停在 0×0，材质静默失效（这个坑在探针里真实发生过）。
     */
    useEffect(() => {
        const el = hostRef.current
        if (!el) return
        const measure = () => {
            const rect = el.getBoundingClientRect()
            const w = Math.round(rect.width)
            const h = Math.round(rect.height)
            setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
    }, [allowed])

    const mergedOptics = useMemo<GlassOpticsModel>(() => ({ ...GLASS_OPTICS_MODEL_DEFAULT, ...optics }), [optics])
    // 贴图只在**形状**变化时重算（尺寸/圆角）；指针移动、滚动都不触发
    const map = useMemo(
        () => (allowed && box.w > 0 && box.h > 0 ? generateLensDisplacementMap(box.w, box.h, radius, mergedOptics) : null),
        [allowed, box.w, box.h, radius, mergedOptics]
    )
    const active = Boolean(map?.url)

    // 运动响应：指针位置 → 两个 CSS 变量（rAF 节流）。不重算贴图、不触发布局。
    useEffect(() => {
        if (!active) return
        const el = hostRef.current
        if (!el || prefersReducedMotion()) return
        let frame = 0
        let pending: { x: number; y: number } | null = null
        const flush = () => {
            frame = 0
            if (!pending) return
            el.style.setProperty('--glass-sheen-x', `${pending.x.toFixed(1)}%`)
            el.style.setProperty('--glass-sheen-y', `${pending.y.toFixed(1)}%`)
            pending = null
        }
        const onMove = (event: PointerEvent) => {
            const rect = el.getBoundingClientRect()
            if (rect.width < 1 || rect.height < 1) return
            pending = {
                x: ((event.clientX - rect.left) / rect.width) * 100,
                y: ((event.clientY - rect.top) / rect.height) * 100,
            }
            if (!frame) frame = requestAnimationFrame(flush)
        }
        const onEnter = () => el.style.setProperty('--glass-sheen', '1')
        const onLeave = () => el.style.setProperty('--glass-sheen', '0')
        el.addEventListener('pointermove', onMove)
        el.addEventListener('pointerenter', onEnter)
        el.addEventListener('pointerleave', onLeave)
        return () => {
            el.removeEventListener('pointermove', onMove)
            el.removeEventListener('pointerenter', onEnter)
            el.removeEventListener('pointerleave', onLeave)
            if (frame) cancelAnimationFrame(frame)
        }
    }, [active])

    const surfaceStyle: CSSProperties = active
        ? {
              ...style,
              // 折射真实背景：位移滤镜 + 一点模糊与饱和（Chromium 原生合成路径）
              backdropFilter: `url(#${filterId}) blur(${mergedOptics.frost}px) saturate(1.6)`,
              WebkitBackdropFilter: `url(#${filterId}) blur(${mergedOptics.frost}px) saturate(1.6)`,
              // 跟随指针的柔光。用现代 rgb() 斜杠语法做 alpha 乘法 —— 不用
              // color-mix(…calc(…))（那玩意在 Chromium 上会整条声明失效，AGENTS.md 记过）。
              // 它画在元素**自己的背景**上，所以永远在内容之下，不会压到文字。
              backgroundImage:
                  'radial-gradient(220px circle at var(--glass-sheen-x, 50%) var(--glass-sheen-y, 0%), rgb(255 255 255 / calc(0.12 * var(--glass-sheen, 0))), transparent 70%)',
          }
        : { background: fallbackBackground, ...style }

    return (
        <div
            ref={hostRef}
            className={className}
            data-glass-surface={surfaceId}
            data-glass-mode={active ? 'refract' : 'solid'}
            data-glass-map-px={map ? `${map.computedPixels}/${map.totalPixels}` : undefined}
            style={surfaceStyle}
            {...rest}
        >
            {map?.url ? (
                <GlassFilter
                    id={filterId}
                    map={map}
                    displacementScale={mergedOptics.strength * 70}
                    aberrationIntensity={mergedOptics.dispersion * 10}
                />
            ) : null}
            {children}
        </div>
    )
}

export default GlassSurface
