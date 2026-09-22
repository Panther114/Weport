import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { NotificationToast, type NotificationData } from '../components/NotificationToast'
import type { LiquidGlassBackdropImage } from '../components/LiquidGlass'
import {
    getLayoutRect,
    NATIVE_BAND_IDS,
    useNotificationNativeAdaptiveTheme,
    useNotificationSnapshotTheme,
    type CardLayoutRect,
    type ThemeTextInput
} from './useNotificationAdaptiveTheme'
import '../components/NotificationToast.scss'
import './NotificationWindow.scss'
import {
    NOTIFICATION_CARD_MAX_HEIGHT,
    NOTIFICATION_GLASS_DEFAULT,
    NOTIFICATION_GLASS_KEYS,
    notificationGlassFillAlpha,
    notificationGlassRepresentativeRgb,
    normalizeNotificationGlass,
    notificationCardPadding,
    notificationGlassRenderParams,
    type NotificationGlass
} from '../utils/notificationGlass'
import {
    NOTIFICATION_REVEAL_FALLBACK_MS,
    NOTIFICATION_SLIDE_IN_MS,
    NOTIFICATION_SLIDE_ROOM_PX,
    normalizeNotificationAnimationStyle,
    slideFromPosition,
    type NotificationAnimationStyle,
    type NotificationSlideFrom
} from '../utils/notificationAnimation'

/**
 * 与 NotificationToast 传给 LiquidGlass 的参数保持一致（原生面板需要同一套值）。
 *
 * 纱层压到近乎全透之后，卡片的"玻璃感"就全落在折射本身了：blurSigma 让玻璃
 * 读起来是"厚玻璃"而不是"贴纸"，displacementScale/aberration 抬高一档让边缘的
 * 透镜弯曲与色散可见（之前 0.42~0.58 的厚纱层把这些全盖住了）。
 *
 * v1.0.3：这些值改由用户的玻璃配置换算（notificationGlassRenderParams），
 * 本常量只作为"配置读不出来"时的兜底。
 */
const GLASS_PARAMS = { cornerRadius: 16, blurSigma: 6, displacementScale: 100, aberrationIntensity: 2, saturation: 175 }

/**
 * 延迟追踪：报「距上一条标记」的毫秒数。
 *
 * 与主进程的 `popupMark` 同一套口径（相对上一步，而不是相对页面启动）——
 * 弹窗路径上要看的是相邻两步之间的间隙。只在主进程随 payload 下发 `trace:true`
 * 时被调用，默认零输出。见 electron/services/popupTrace.ts。
 */
let traceLastAt = 0
function traceDelta(label: string): number {
    const now = performance.now()
    const delta = traceLastAt === 0 ? 0 : Math.round(now - traceLastAt)
    traceLastAt = now
    void label
    return delta
}

/**
 * 主进程快速采集帧（base64 的 BGRA）→ `ImageData`。
 *
 * 主进程侧的 `Buffer.toString('base64')` 实测 <1ms，渲染层 `atob` + 一次类型化数组
 * 复制也在这个量级 —— 比走 JPEG 编码/解码（每帧 3~10ms）便宜一个数量级。
 * 解不出来（长度对不上）时返回 null，调用方保持上一帧。
 */
function decodeBackdropPixels(base64: string, rect: { width: number; height: number }): ImageData | null {
    try {
        const binary = atob(base64)
        const expected = rect.width * rect.height * 4
        if (binary.length !== expected) return null
        const bytes = new Uint8ClampedArray(expected)
        for (let i = 0; i < expected; i += 1) bytes[i] = binary.charCodeAt(i)
        return new ImageData(bytes, rect.width, rect.height)
    } catch {
        return null
    }
}

/** 用户配置 → 原生面板参数（与渲染层同一个换算函数，两条路径观感一致）。 */function nativeGlassParams(glass: NotificationGlass) {
    const render = notificationGlassRenderParams(glass)
    return {
        cornerRadius: glass.radius,
        blurSigma: render.blurSigma,
        displacementScale: render.displacementScale,
        aberrationIntensity: render.aberrationIntensity,
        saturation: render.saturation
    }
}
const DEFAULT_NOTIFICATION_DURATION_MS = 5000
const MIN_NOTIFICATION_DURATION_MS = 1000
const MAX_NOTIFICATION_DURATION_MS = 60_000

function normalizeNotificationDuration(value: unknown): number {
    const duration = Number(value)
    if (!Number.isFinite(duration)) return DEFAULT_NOTIFICATION_DURATION_MS
    return Math.min(MAX_NOTIFICATION_DURATION_MS, Math.max(MIN_NOTIFICATION_DURATION_MS, Math.round(duration)))
}

export default function NotificationWindow() {
    const [notification, setNotification] = useState<NotificationData | null>(null)
    const [prevNotification, setPrevNotification] = useState<NotificationData | null>(null)
    const [position, setPosition] = useState<string>('top-right')
    /**
     * 动效风格与滑入方向（v1.0.1）。
     *
     * `slide` 从**离弹窗最近的那条屏幕边**滑入、沿原路滑出；`classic` 是旧版的
     * 原地淡入缩放（用户要求保留）。方向由 position 换算（utils/notificationAnimation），
     * 主进程与这里用的是同一个函数，所以"哪个角从哪边进来"只有一份定义。
     */
    const [animationStyle, setAnimationStyle] = useState<NotificationAnimationStyle>('slide')
    const [slideFrom, setSlideFrom] = useState<NotificationSlideFrom>('right')
    /**
     * 入场动画的起跑门。
     *
     * 主进程在 `showInactive()` 之后发 `notification:shown`（带 payloadId），这里
     * 收到才让卡片开始滑 —— 否则动画在"窗口还没显示"的那几帧里就跑掉一段，
     * 用户看到的不是滑入，而是从屏幕边上闪一下。没有信号时 400ms 兜底起跑。
     */
    const [revealedPayloadId, setRevealedPayloadId] = useState<string | null>(null)
    const currentPayloadIdRef = useRef<string>('')
    const revealFallbackRef = useRef<number | null>(null)
    /**
     * 入场动画是否已经落定（`arrived`）—— 决定主进程能不能把窗口**收回**到卡片大小。
     *
     * 滑动时窗口要往滑动方向多留一段 `room`（那段在屏幕外，卡片才有地方滑），
     * 动画结束后必须收回来：屏幕上多出来的每一个像素都会拦截桌面点击
     * （AGENTS.md 第 4 条）。收回是安全的 —— 多出来的那段永远在卡片**背后**那一侧，
     * 卡片在窗口里的贴边方式与方向严格对应（见下面的 slideLayout），所以窗口收缩时
     * 卡片一像素都不动。
     */
    const [arrived, setArrived] = useState(true)
    // 主进程随通知下发的屏幕几何信息（尺寸 + 窗口坐标）+ 首帧快照 + 采集源 ID。
    // 快照只是视频流出现前的底色；实时折射由下面的 backdropStream 提供
    const [backdrop, setBackdrop] = useState<LiquidGlassBackdropImage | undefined>(undefined)
    // 实时桌面视频流（getUserMedia + 主进程下发的采集源）：玻璃逐帧跟随桌面。
    // 只在弹窗可见期间存在，隐藏时立刻停掉全部 track（零常驻开销）
    const [backdropStream, setBackdropStream] = useState<MediaStream | null>(null)
    // 收到过多少帧桌面推送：>0 才算"玻璃在动"（见 data-glass 断言）
    const [frameCount, setFrameCount] = useState(0)
    // 原生玻璃模式（Windows）：折射由主进程的原生面板在窗口下方提供，
    // 渲染层不开视频流、不渲染折射画布，只负责上报卡片几何与内容层
    const [nativeBackdrop, setNativeBackdrop] = useState(false)
    // 玻璃观感（设置 → 消息通知 → 通知玻璃）。默认值 = 用户要求的那套：
    // 浅填充 + 发丝描边（不再是那圈 1.5px 白边）。
    const [glass, setGlass] = useState<NotificationGlass>(NOTIFICATION_GLASS_DEFAULT)
    // 事件回调里需要读取"当前展示中"的通知作为过渡的旧通知，用 ref 避免重建监听
    const notificationRef = useRef<NotificationData | null>(null)
    // 上次上报的窗口尺寸：**同一条通知内**的重复上报会被丢掉 —— 可见状态下反复
    // 设置尺寸会让 DWM 短暂拉伸旧帧缓冲，闪出一圈幽灵轮廓。
    //
    // 必须带上通知 id：主进程现在要等这份上报才会显示窗口（见 notificationWindow.ts
    // `revealPopup`），如果沿用"上次尺寸相同就不报"的去重，内容一样的连续两条通知
    // （最常见的情况）会让主进程一直等到 120ms 兜底计时器才显示 —— 白等 120ms，
    // 正好把这条优化变成反向优化（实测热路径 1ms → 138ms）。
    const lastSizeRef = useRef<{ id: string; width: number; height: number; settled: boolean } | null>(null)
    // 渲染层实测的卡片尺寸（含自适应加宽的宽度）。窗口必须跟着它走：卡片变宽而
    // 窗口不变 = 右侧被裁掉；卡片变窄而窗口不变 = 留下一片拦截桌面点击的空白。
    const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null)
    // 采集源 ID：与窗口/流生命周期解耦，事件回调里读 ref
    const sourceIdRef = useRef<string | null>(null)
    /** WGC 采集流是否已被证明不可用（主进程随 payload 下发，见 notificationWindow.ts） */
    const streamUnavailableRef = useRef(false)
    /** 已处理过的投递 id（幂等去重，见 handleShow 里的说明） */
    const lastPayloadIdRef = useRef<string | null>(null)

    /**
     * 当前这条通知的入场动画是否已经起跑（见 `revealedPayloadId` 的说明）。
     * 未起跑时卡片钉在位移起点（窗口外）：既不可见，也不会误拦截桌面点击。
     *
     * 在主进程「窗口已显示」信号到达前，任何位置都不该开始播动画 —— 所以这个
     * 值要在原生面板上报等副作用之前算好。
     */
    const revealed = revealedPayloadId !== null && revealedPayloadId === currentPayloadIdRef.current
    /**
     * 当前这条通知是否播放动效。
     *
     * 必须在副作用之前算好：上报窗口尺寸 / 收回窗口 / 原生面板几何这几个 effect
     * 的依赖数组里都要用它，放到组件末尾会让依赖数组在 TDZ 里求值。
     */
    const animationsOn = notification ? notification.notificationAnimationEnabled !== false : true

    useEffect(() => {
        notificationRef.current = notification
    }, [notification])

    useEffect(() => {
        const handleShow = (_event: any, data: any) => {
            /**
             * 同一次投递只处理一次。
             *
             * 主进程有两条路径会把同一条通知送进来：正常的 `notification:show`，
             * 以及渲染层刚挂载时主动要缓存数据的 `notification:ready`。重复处理
             * 一次 = 重新挂载卡片 + 入场动画从头再播 —— 用户看到的是"弹窗闪了一下"。
             * 带 payloadId 之后这件事是幂等的（旧版主进程没有这个字段，跳过即可）。
             */
            const payloadId = String(data?.payloadId || '')
            if (payloadId && payloadId === lastPayloadIdRef.current) return
            if (payloadId) lastPayloadIdRef.current = payloadId

            // 延迟追踪（主进程 WEPORT_POPUP_TRACE=1 时随 payload 下发）：
            // 渲染层没有主进程的时间基准，这里只报自己的 performance.now()，
            // 差值由探针读取。见 electron/services/popupTrace.ts。
            const trace = Boolean(data?.trace)
            if (trace) console.log(`[popup-rt] +${traceDelta('payload-received')}ms  payload-received`)
            const timestamp = Math.floor(Date.now() / 1000)
            const style = normalizeNotificationAnimationStyle(data?.notificationAnimationStyle)
            const direction = slideFromPosition(data?.position)
            const animationsOn = data.notificationAnimationEnabled !== false
            const newNoti: NotificationData = {
                id: `noti_${timestamp}_${Math.random().toString(36).substr(2, 9)}`,
                sessionId: data.sessionId,
                channel: data.channel,
                insightRecordId: data.insightRecordId,
                targetRoute: data.targetRoute,
                title: data.title,
                content: data.content,
                timestamp: timestamp,
                avatarUrl: data.avatarUrl,
                persistent: Boolean(data.persistent),
                notificationDuration: normalizeNotificationDuration(data.notificationDuration),
                notificationAnimationEnabled: animationsOn,
                notificationAnimationStyle: style,
                slideFrom: direction
            }

            if (data.position) {
                setPosition(data.position)
            }
            setAnimationStyle(style)
            setSlideFrom(direction)
            /**
             * 重新起跑入场动画：把门关上，等主进程的 `notification:shown`。
             *
             * 关掉动效时不需要门（没有动画可截断），直接算作已就位。
             * payloadId 为空（旧版主进程 / `notification:ready` 的缓存数据）时
             * 也用兜底计时器起跑 —— 卡片绝不能因为少一个信号就停在屏幕外。
             */
            currentPayloadIdRef.current = payloadId
            if (revealFallbackRef.current !== null) {
                window.clearTimeout(revealFallbackRef.current)
                revealFallbackRef.current = null
            }
            if (!animationsOn) {
                setRevealedPayloadId(payloadId)
            } else {
                setRevealedPayloadId(null)
                revealFallbackRef.current = window.setTimeout(() => {
                    revealFallbackRef.current = null
                    setRevealedPayloadId(payloadId)
                }, NOTIFICATION_REVEAL_FALLBACK_MS)
            }
            /**
             * 新的一条通知 = 窗口要重新按 room 放大一遍（滑动时卡片才有地方出现），
             * 所以先把"已落定"关掉；入场动画跑完再打开，主进程随即收回窗口。
             * 关闭动效时没有滑动，直接算落定。
             */
            setArrived(!animationsOn || style !== 'slide')
            if (data.backdrop) {
                setBackdrop({
                    width: data.backdrop.width,
                    height: data.backdrop.height,
                    screenX: data.backdrop.winX,
                    screenY: data.backdrop.winY,
                    // 窗口自身尺寸：采样必须挪到窗口**外面**，否则抓帧里读到的就是弹窗
                    // 自己那张卡片（自指 → 主题被第一次采样锁死）
                    winW: data.backdrop.winW ?? undefined,
                    winH: data.backdrop.winH ?? undefined,
                    dataUrl: data.backdrop.dataUrl ?? null
                })
                setNativeBackdrop(Boolean(data.backdrop.native))
                sourceIdRef.current = data.backdrop.sourceId ?? null
                // 这台机器上 WGC 采集流已经被证明起不来（主进程记着上次的失败结果）：
                // 不再每次弹窗都去试一遍 —— 本机实测那次尝试要 ~150ms，全部白等。
                streamUnavailableRef.current = Boolean(data.backdrop.streamUnavailable)
            }

            if (notificationRef.current && newNoti.notificationAnimationEnabled !== false) {
                setPrevNotification(notificationRef.current)
            } else {
                setPrevNotification(null)
            }
            setNotification(newNoti)
        }

        if (window.electronAPI) {
            const remove = window.electronAPI.notification?.onShow?.(handleShow)
            // 「窗口真的显示出来了」→ 入场动画从这一刻起跑（见上面的说明）。
            const removeShown = window.electronAPI.notification?.onShown?.((_event, payload) => {
                const id = String(payload?.payloadId ?? '')
                // 只认当前这条投递的信号：连续两条通知时，迟到的信号不能让
                // 新卡片提前起跑（那正是"动画被截断"的另一种形式）。
                if (id && id !== currentPayloadIdRef.current) return
                if (revealFallbackRef.current !== null) {
                    window.clearTimeout(revealFallbackRef.current)
                    revealFallbackRef.current = null
                }
                setRevealedPayloadId(id)
            })
            // 窗口收回后主进程会发来**新的窗口几何**：主题采样按"窗口在屏幕上的位置"
            // 把取样点挪出窗口，坐标过时就会去读几百像素外的桌面。
            const removeGeometry = window.electronAPI.notification?.onGeometry?.((_event, geometry) => {
                setBackdrop((prev) => {
                    if (!prev) return prev
                    return {
                        ...prev,
                        screenX: geometry?.winX ?? prev.screenX,
                        screenY: geometry?.winY ?? prev.screenY,
                        winW: geometry?.winW ?? prev.winW,
                        winH: geometry?.winH ?? prev.winH
                    }
                })
            })
            window.electronAPI.notification?.ready?.()
            return () => {
                remove?.()
                removeShown?.()
                removeGeometry?.()
                if (revealFallbackRef.current !== null) window.clearTimeout(revealFallbackRef.current)
            }
        }
    }, [])

    // 玻璃观感配置：每次通知到来时重读一次，用户在设置里改完下一条就生效，
    // 不需要重启弹窗。读失败一律退回默认值（弹窗永远不能因为配置读不出来而不显示）。
    useEffect(() => {
        let cancelled = false
        const load = async () => {
            const api = window.electronAPI
            if (!api?.config?.get) return
            const read = async (key: string) => {
                try {
                    return await api.config.get(key)
                } catch {
                    return undefined
                }
            }
            const values = await Promise.all(
                (Object.keys(NOTIFICATION_GLASS_KEYS) as Array<keyof NotificationGlass>).map((field) =>
                    read(NOTIFICATION_GLASS_KEYS[field])
                )
            )
            if (cancelled) return
            const raw: Partial<Record<keyof NotificationGlass, unknown>> = {}
            ;(Object.keys(NOTIFICATION_GLASS_KEYS) as Array<keyof NotificationGlass>).forEach((field, index) => {
                raw[field] = values[index]
            })
            setGlass(normalizeNotificationGlass(raw))
        }
        void load()
        return () => {
            cancelled = true
        }
    }, [notification])

    // Clean up prevNotification after transition
    useEffect(() => {
        if (prevNotification) {
            const timer = setTimeout(() => {
                setPrevNotification(null)
            }, 400)
            return () => clearTimeout(timer)
        }
    }, [prevNotification])

    /**
     * 延迟追踪：卡片**布局落定**与**首个合成帧**。
     *
     * 「布局落定」用 useLayoutEffect（DOM 已更新、样式已算），「首个合成帧」用
     * 双 rAF —— 单帧 rAF 只说明"下一帧要开始了"，双 rAF 才是"上一帧已经画出去"。
     * 用户看到弹窗的那一刻就是后者。
     */
    useLayoutEffect(() => {
        if (!notification) return
        if (!(notification as { trace?: boolean }).trace) return
        console.log(`[popup-rt] +${traceDelta('card-layout')}ms  card-layout`)
        const raf1 = requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                console.log(`[popup-rt] +${traceDelta('card-painted')}ms  card-painted`)
            })
        })
        return () => cancelAnimationFrame(raf1)
    }, [notification])

    // 实时桌面折射（两条路，按可用性自动选）。
    //
    // 之前这里是"一条通知只拍一次"的静态快照 —— 弹出瞬间的画面被钉在玻璃里，
    // 之后桌面怎么动都不变，看起来像贴了一张旧截图。现在：
    //   1. 优选 WGC 视频流：desktopCapturer 的采集源 + getUserMedia，30fps、GPU
    //      合成、主进程零成本；
    //   2. WGC 不可用（虚拟机 / 无 GPU / 驱动不支持，本机实测 CreateForMonitor
    //      返回 E_ACCESSDENIED）时退回**主进程的定帧推送**（notification:backdrop，
    //      约 3fps，按实测帧成本自适应）—— 帧率低，但背景确实在动。
    //
    // 两条路都只在弹窗可见期间运行：隐藏即停 track / 主进程停循环。
    const visible = Boolean(notification || prevNotification)
    /**
     * 只在**原生面板不可用**时才去试 Chromium 采集。
     *
     * 原生面板（Windows 默认开启）自己合成桌面，渲染层再开一路 getUserMedia 纯属
     * 白费：本机实测 `chromeMediaSource: 'desktop'` 必然 NotReadableError，而每次
     * 通知都要付一次失败尝试 + 一条 console.warn。原生可用时直接跳过。
     */
    useEffect(() => {
        if (!visible || nativeBackdrop) return
        const sourceId = sourceIdRef.current
        if (!sourceId) return
        // 这台机器上采集流已经失败过：直接走主进程的定帧推送，不再付那次注定失败的
        // 尝试（本机实测 ~150ms/条通知）。进程重启后主进程的记忆清空，会再试一次。
        if (streamUnavailableRef.current) return
        let stream: MediaStream | null = null
        let cancelled = false
        void (async () => {
            try {
                const media = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        // Electron 的桌面采集约束（非标准枚举值，TS 类型里没有）
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        ...({ mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 30 } } as any)
                    }
                })
                if (cancelled) {
                    media.getTracks().forEach(track => track.stop())
                    return
                }
                stream = media
                setBackdropStream(media)
                // 告诉主进程：折射由视频流接管，别再抓帧了
                window.electronAPI?.notification?.setGlassMode?.('stream')
                window.electronAPI?.notification?.reportDesktopStream?.(true)
            } catch (error) {
                // 采集失败（权限/驱动/虚拟桌面）时不要放弃：主进程的定帧推送继续
                // 供帧，玻璃依然是"跟着桌面走"的，只是帧率低一些
                console.warn('[NotificationWindow] WGC desktop stream unavailable, falling back to main-process frames:', error)
                // 告诉主进程"这台机器起不来"：后续通知不再重复这次尝试
                window.electronAPI?.notification?.reportDesktopStream?.(false)
            }
        })()
        return () => {
            cancelled = true
            setBackdropStream(null)
            stream?.getTracks().forEach(track => track.stop())
        }
    }, [visible, nativeBackdrop])

    // 主进程定帧推送：只替换快照来源（几何信息沿用首次下发的那份）
    useEffect(() => {
        if (nativeBackdrop) return
        const api = window.electronAPI?.notification
        if (!api?.onBackdrop) {
            console.warn('[NotificationWindow] onBackdrop missing from preload - glass cannot follow the desktop')
            return
        }
        console.log('[NotificationWindow] subscribing to desktop backdrop frames')
        let first = true
        return api.onBackdrop((frame) => {
            if (first) {
                first = false
                console.log('[NotificationWindow] first backdrop frame received')
            }
            /**
             * 两条帧形态（v1.1）：
             *
             * - **快速路径**（主进程 koffi BitBlt，只抓卡片附近 ≈5~22ms）：`pixelsBase64`
             *   是原始 BGRA 像素，`frameX/Y/Width/Height` 是它在屏幕逻辑坐标里的矩形。
             *   玻璃把它画成 ImageData 直接用 —— 不经过 JPEG 编解码。
             * - **兜底路径**（`desktopCapturer` 整屏 JPEG ≈150~208ms）：`dataUrl` 整屏图，
             *   窗口位置给 `winX/winY`。
             */
            const raw = frame as Record<string, unknown>
            const rect = raw.frameWidth
                ? { x: Number(raw.frameX) || 0, y: Number(raw.frameY) || 0, width: Number(raw.frameWidth) || 0, height: Number(raw.frameHeight) || 0 }
                : null
            const pixels = raw.pixelsBase64 && rect ? decodeBackdropPixels(String(raw.pixelsBase64), rect) : null
            // 每帧内容指纹 + 帧序号：截图 QA 用它们断言"玻璃上显示的确实是主进程最新
            // 发出的那一帧"，比只看像素差少一层猜测。
            try {
                document.documentElement.dataset.glassHash = pixels
                    ? `fast:${String(raw.pixelsBase64).length}:${raw.seq}`
                    : `${String(raw.dataUrl || '').length}:${String(raw.dataUrl || '').slice(2000, 2012)}`
                document.documentElement.dataset.glassSeq = String(raw.seq ?? '')
            } catch { /* noop */ }
            setBackdrop(prev => ({
                width: pixels && rect ? rect.width : Number(raw.width) || 0,
                height: pixels && rect ? rect.height : Number(raw.height) || 0,
                screenX: pixels && rect ? rect.x : Number(raw.winX) || 0,
                screenY: pixels && rect ? rect.y : Number(raw.winY) || 0,
                // 窗口尺寸按上一份沿用：定帧推送里不带它，但采样要靠它把取样点挪出窗口
                winW: prev?.winW,
                winH: prev?.winH,
                dataUrl: pixels ? null : (raw.dataUrl as string | null) ?? null,
                ...(pixels ? { pixels } : {})
            }))
            // 收到真实帧才算"动起来了"；在此之前 data-glass 保持 snapshot
            setFrameCount(count => (count < 1000 ? count + 1 : count))
        })
    }, [nativeBackdrop])

    /**
     * 文字色 / 纱层**一次成型**：采样一次、算一次、写一次，然后完全静止。
     *
     * 旧实现是逐帧自适应（桌面每出一帧就重算十几个 CSS 变量）。实测代价
     * （.ui-probe/measure-var-writes.mjs）：定帧回退路径 6 次变量写入/秒；每次写入
     * 都让整窗重算样式。而通知只显示 3 秒 —— 为它跑一条常驻管线不值得，观感上还
     * 会因为采样率被玻璃帧率绑住而一顿一顿。
     *
     * 现在只在「首批样本稳定」或「卡片几何变化」时解析一次。可读性由
     * 整卡纱层 + 文字色/光晕 + 文字后实色底共同保证。
     */
    const cardLayout = useCallback((): CardLayoutRect[] => {
        const host = document.getElementById('notification-current')
        const glassEl = host?.querySelector<HTMLElement>('.liquid-glass')
        const card = glassEl ? getLayoutRect(glassEl) : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        const header = host?.querySelector<HTMLElement>('.notification-header')
        const body = host?.querySelector<HTMLElement>('.notification-body')
        return [
            card,
            header ? getLayoutRect(header) : card,
            body ? getLayoutRect(body) : card
        ]
    }, [])

    /**
     * 文字极性：**由"填充 × 不透明度"叠在采样到的背景上**决定（v1.0.1 修正）。
     *
     * 用户报的："自适应只看了渐变/填充色，没考虑乘上不透明度之后的实际效果。"
     * 极性的输入因此不只是填充色，而是 `fill`（填充不透明度 + 填充本身亮度，
     * 渐变给两端）—— 引擎拿到桌面采样后按 `α·填充 + (1-α)·背景` 合成再判。
     * 折射全关时卡片就是"填充叠桌面"，这个合成值就是眼睛看到的那张卡。
     */
    const themeText = useMemo<ThemeTextInput>(
        () => ({ fill: { alpha: notificationGlassFillAlpha(glass), rgb: notificationGlassRepresentativeRgb(glass) } }),
        [glass]
    )
    useNotificationNativeAdaptiveTheme(nativeBackdrop, cardLayout, themeText)
    useNotificationSnapshotTheme(backdrop, cardLayout, themeText)

    // 折射管线状态挂在 <html data-glass> 上：截图 QA 据此断言"弹窗真的是实时
    // 玻璃"，而不是只在代码里以为接上了（采集失败会静默退回静态快照）。
    //   native = 原生面板；stream = WGC 视频流；frames = 主进程定帧推送；
    //   snapshot = 一帧都没收到（真·静态）
    useEffect(() => {
        document.documentElement.dataset.glass = nativeBackdrop
            ? 'native'
            : backdropStream
                ? 'stream'
                : frameCount > 0
                    ? 'frames'
                    : 'snapshot'
    }, [nativeBackdrop, backdropStream, frameCount])

    const handleClose = () => {
        setNotification(null)
        setPrevNotification(null)
        window.electronAPI.notification?.close()
    }

    /**
     * 退场前的准备：请主进程按滑动方向把窗口重新放开一段。
     *
     * 必须**等它落地**再让卡片开始滑（NotificationToast.dismiss 里 await 它）：
     * 窗口不放开，卡片滑出屏幕的那一半会被窗口边界裁掉 —— 就是用户看到的"退场
     * 一顿、还有一段是切断的"。
     */
    const prepareExit = useCallback(async () => {
        try {
            await window.electronAPI?.notification?.prepareExit?.()
        } catch { /* 主进程没回应也不能挡住关窗（调用方另有超时兜底） */ }
    }, [])

    /**
     * 入场落定 → 让主进程把窗口收回卡片大小（v1.0.1）。
     *
     * **不是**"等 820ms 就收"：过渡的实际进度取决于渲染层什么时候真正起跑（窗口显示
     * 信号可能晚一两帧）。抢在过渡结束前收窗口，卡片会因为窗口变小而**提前被裁掉**,
     * 看起来是"滑到一半就没了"。所以这里轮询计算样式，等 `transform` 真的回到
     * `none` 再收 —— 上限 ~1.8s，异常时也一定会收（不收的话屏幕上会长期多出一块
     * 拦截点击的面积）。
     */
    useEffect(() => {
        if (!notification) return
        if (animationStyle !== 'slide' || !animationsOn) {
            setArrived(true)
            return
        }
        if (!revealed) return
        let cancelled = false
        let timer = 0
        let checks = 0
        const check = () => {
            if (cancelled) return
            const el = document.querySelector('#notification-current .notification-toast-container')
            const finished = !el || getComputedStyle(el).transform === 'none'
            if (finished || checks >= 14) {
                setArrived(true)
                return
            }
            checks += 1
            timer = window.setTimeout(check, 90)
        }
        timer = window.setTimeout(check, NOTIFICATION_SLIDE_IN_MS + 60)
        return () => {
            cancelled = true
            window.clearTimeout(timer)
        }
    }, [notification, animationStyle, animationsOn, revealed])

    /**
     * 窗口尺寸跟卡片走（v1.0.1）。
     *
     * 旧版把宽度写死成 344（top-center 写死 280），高度取 `#notification-root` 实测值；
     * 现在卡片宽度是"用户基础宽度 + 昵称过长时的自适应增量"，只有渲染层知道，
     * 所以这里改成：
     *   · 宽度 = 卡片实测宽度（onMeasure 上报，未上报前先按配置的基础宽度兜底）；
     *   · 高度 = max(root 实测高度, 卡片上报高度)，上限 NOTIFICATION_CARD_MAX_HEIGHT。
     *
     * 主进程收到 notification:resize 后会按弹窗位置重新贴边（右上/右下/居中），
     * 因此加宽不会把卡片推出屏幕。
     */
    useEffect(() => {
        if (!notification && !prevNotification) return

        const trace = Boolean((notification as { trace?: boolean } | null)?.trace)

        /**
         * 上报窗口尺寸。
         *
         * **第一次必须同步跑**（不再等 50ms）：主进程现在等这份尺寸到了才显示窗口
         * （见 notificationWindow.ts `revealPopup`）。放在定时器里等于每条通知都多等
         * 50ms，而那 50ms 里窗口按"上一次的尺寸"显示 —— 卡片比它高就会被裁掉，
         * 随后窗口长大并重算贴边，就是用户看到的"先出现、再抖一下"。
         *
         * 后面两次是复测：字体与 emoji 图片就位后度量会再收敛一次（首帧用的是
         * 回退字体的宽度），以及尺寸变化后主进程要重新贴边。
         */
        const report = (why: 'immediate' | 'raf' | 'timer') => {
            // 窗口必须精确贴合内容：多余区域会拦截桌面点击。
            // 宽度 = 卡片 + 两侧留白（留白里画的是投影，见 notificationCardPadding）。
            const root = document.getElementById('notification-root')
            if (!root || !window.electronAPI?.notification?.resize) return
            // 高度 0 = 这一帧里卡片还没铺开（异步数据/字体未就绪）。**绝不能上报**：
            // 主进程会按它把窗口缩成 0 高再显示出来，用户看到的是"闪一下再长开"。
            // 让后面的 rAF / 120ms 复测去报真实尺寸，主进程另有兜底显示。
            //
            // 滑动风格下卡片是"贴着滑动来向那一侧"的（见下面的 slideLayout），根节点
            // 的实测高度就是卡片高度；别的风格仍取两者的较大值。
            const rootHeight = Math.ceil(root.getBoundingClientRect().height)
            if (rootHeight < 1 && !measured) return
            const minWidth = glass.width + notificationCardPadding(glass.shadow) * 2
            const width = Math.max(Math.round(measured?.width ?? minWidth), minWidth)
            /**
             * 高度：**卡片自己量出来的值优先**。
             *
             * 顶部居中时根节点铺满窗口（`height: 100%`），根节点高度等于**窗口**高度
             * 而不是卡片高度 —— 拿它上报会形成正反馈：窗口 = 上报值 + travel，下一帧
             * 上报值又变成新的窗口高度。其余情况两者一致（根节点由卡片撑开），
             * 取较大值是为了覆盖"卡片比根节点高一帧"的度量收敛过程。
             */
            const height = Math.min(
                slideLayout === 'top'
                    ? Math.round(measured?.height ?? 0)
                    : Math.max(rootHeight, Math.round(measured?.height ?? 0)),
                NOTIFICATION_CARD_MAX_HEIGHT
            )
            if (height < 1) return
            const slide = animationStyle === 'slide' && animationsOn
            const last = lastSizeRef.current
            // 同一条通知内尺寸没变 → 不重复 setSize（避免 DWM 幽灵轮廓）；
            // 换了通知（id 不同）→ 必须报一次，主进程正等着它才显示窗口。
            //
            // `arrived` 也是键的一部分：窗口从"留了 room 的大窗口"收回成卡片大小是
            // 一次**必须发出**的上报，尺寸本身没变、只有 settled 变了。
            const notiId = notification?.id || prevNotification?.id || ''
            if (
                last &&
                last.id === notiId &&
                last.width === width &&
                last.height === height &&
                last.settled === arrived
            ) {
                return
            }
            lastSizeRef.current = { id: notiId, width, height, settled: arrived }
            if (trace) console.log(`[popup-rt] +${traceDelta(`resize-sent(${why})`)}ms  resize-sent(${why}) ${width}x${height} settled=${arrived}`)
            window.electronAPI.notification.resize(width, height, {
                slideFrom: slide ? slideFrom : undefined,
                room: slide ? NOTIFICATION_SLIDE_ROOM_PX : 0,
                settled: arrived || !slide
            })
        }

        report('immediate')
        const raf = requestAnimationFrame(() => report('raf'))
        const timer = setTimeout(() => report('timer'), 120)

        return () => {
            cancelAnimationFrame(raf)
            clearTimeout(timer)
        }
    }, [notification, prevNotification, position, measured, glass.width, glass.shadow, arrived, animationStyle, animationsOn, slideFrom])

    // 原生玻璃模式：卡片挂载后上报实测几何（窗口本地 CSS 像素 + 卡片本地亮度带），
    // 主进程据此创建/复用窗口下方的原生面板；参数与 LiquidGlass 的视觉参数一致
    useEffect(() => {
        if (!nativeBackdrop || !notification) return
        const slideStyle =
            notification.notificationAnimationStyle === 'slide' && notification.notificationAnimationEnabled !== false
        /**
         * 滑动入场期间**不上报几何**。
         *
         * 原生面板是"挂在窗口底下、按卡片终态位置摆好"的独立窗口，而滑动是渲染层
         * 内部的位移 —— 面板不跟着动。中途上报的话用户看到的是"玻璃板先落在终点，
         * 卡片再滑进来盖住它"。等位移跑完再上报，面板的 `show(120)` 本身是渐显，
         * 于是观感变成"卡片滑到位，玻璃显形"。
         *
         * 几何本身不受位移影响：`getLayoutRect` 读的是 offsetLeft/offsetTop
         * （transform 不参与布局），所以这里量到的永远是终态坐标。
         */
        if (slideStyle && !revealed) return
        // 同一条通知内的重复上报去重（双 rAF 首测 + 120ms 复测几何通常一致）：
        // 跳过后主进程不会白做 setBounds/setLumaBands/anchor 原生调用，
        // 也避免 setLumaBands 触发的一次带 GPU 同步等待的亮度补采。
        // 局部变量随 effect 重建，新通知（即使几何相同）必然重新上报以驱动面板 show
        let lastSent = ''
        const report = () => {
            const host = document.getElementById('notification-current')
            const glassEl = host?.querySelector<HTMLElement>('.liquid-glass')
            if (!glassEl) return
            const card = getLayoutRect(glassEl)
            if (card.width < 1 || card.height < 1) return
            const bands: Array<{ id: number; x: number; y: number; width: number; height: number }> = [
                { id: NATIVE_BAND_IDS.card, x: 0, y: 0, width: card.width, height: card.height }
            ]
            const bandEls: Array<[number, HTMLElement | null]> = [
                [NATIVE_BAND_IDS.title, host?.querySelector<HTMLElement>('.notification-header') ?? null],
                [NATIVE_BAND_IDS.body, host?.querySelector<HTMLElement>('.notification-body') ?? null]
            ]
            for (const [id, el] of bandEls) {
                if (!el) continue
                const rect = getLayoutRect(el)
                bands.push({ id, x: rect.left - card.left, y: rect.top - card.top, width: rect.width, height: rect.height })
            }
            const payload = {
                card: { x: card.left, y: card.top, width: card.width, height: card.height },
                bands,
                // CSS px → 物理 px 的换算系数（devicePixelRatio 已含页面缩放，
                // 主进程不能只用显示器 scaleFactor：缩放会随 file:// 域持久化）
                dpr: window.devicePixelRatio || 1,
                // 用户在设置里改玻璃观感时要重新上报（key 里含这些值，变了就会重发）
                ...nativeGlassParams(glass)
            }
            const key = JSON.stringify(payload)
            if (key === lastSent) return
            lastSent = key
            window.electronAPI?.notification?.glassRect?.(payload)
        }
        // 滑动风格：等位移跑完再量（+40ms 余量，见上面的说明）；其余情况立刻量。
        // 双 rAF 等首次布局落定后测量；+120ms 复测一次，覆盖表情图/字体就绪导致的高度变化
        const delay = slideStyle ? NOTIFICATION_SLIDE_IN_MS + 40 : 0
        let raf2 = 0
        let raf1 = 0
        const kickoff = setTimeout(() => {
            raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(report) })
        }, delay)
        const timer = setTimeout(report, delay + 120)
        return () => {
            clearTimeout(kickoff)
            cancelAnimationFrame(raf1)
            cancelAnimationFrame(raf2)
            clearTimeout(timer)
        }
    }, [nativeBackdrop, notification, position, glass, revealed])

    if (!notification && !prevNotification) return null

    /**
     * 卡片在窗口里的贴边方式，必须与主进程"多留一段 room"的方向严格对应：
     * 多出来的那一段永远在卡片**背后**那一侧，所以窗口放大 / 收回的时候卡片
     * 一像素都不动（收回时若卡片跟着挪，就是一次肉眼可见的抽动）。
     *
     *   slide=right → 窗口往右多留 → 卡片贴**左**边（默认流向即左对齐）
     *   slide=left  → 窗口往左多留 → 卡片贴右边（flex-end）
     *   slide=top   → 窗口往上多留 → 卡片贴下边（padding-top 顶下去）
     *
     * 顶部居中不用 flex（那要求根节点有固定高度，而"首帧尺寸上报"依赖根节点高度
     * 就是卡片高度），改用 padding-top：卡片被顶到根节点下沿 = 贴窗口下边。
     */
    /**
     * 卡片在窗口里的**固定偏移**，必须与主进程"多留一段 travel"的方向严格对应。
     *
     * 偏移是常量（= 卡片在该轴上的尺寸 + 屏幕留白），**不是**靠 `flex-end` / `bottom: 0`
     * 这类"贴另一条边"的对齐：那种对齐让卡片的位置依赖于**窗口尺寸**，而渲染层的
     * 布局比窗口的实际变化晚一帧 —— 窗口一改尺寸，那一帧里卡片会被画到错误的位置
     * （实测：一次 104px 的跳动 + 一帧被裁）。改成常量偏移后，卡片的位置只由
     * "窗口原点 + 常量"决定，窗口怎么变都不影响它。
     *
     *   slide=right → 偏移 0（窗口左边缘就是卡片左边缘；多留的一段在右边）
     *   slide=left  → 偏移 = 卡片宽 + 20（多留的一段在左边，窗口左边缘在屏幕外）
     *   slide=top   → 偏移 = 卡片高 + 20（多留的一段在上边）
     *
     * 注意：只有右侧滑动会**收回**窗口（见 notificationWindow.ts anchorPopupBounds），
     * 左侧/顶部保留那段偏移 —— 它们的窗口一收就要移动原点，而原点一动就会撞上上面
     * 那个"布局晚一帧"的问题。代价是屏幕上多出 20px 窄带，比闪烁划算。
     */
    const slideLayout: NotificationSlideFrom | null = animationStyle === 'slide' && animationsOn ? slideFrom : null
    const cardBoxWidth = Math.max(Math.round(measured?.width ?? glass.width), glass.width)
    const cardBoxHeight = Math.round(measured?.height ?? 0)
    const slideOffset = slideLayout
        ? (slideLayout === 'top' ? cardBoxHeight : cardBoxWidth) + NOTIFICATION_SLIDE_ROOM_PX
        : 0
    const rootSlideStyle: CSSProperties =
        slideLayout === 'left' ? { paddingLeft: slideOffset } : slideLayout === 'top' ? { paddingTop: slideOffset } : {}
    /** 当前卡片的外层：宽度整宽（贴边由根节点的 padding 决定）。 */
    const currentWrapperSlideStyle: CSSProperties = { width: '100%' }
    /** 旧卡片的绝对定位锚点：必须与当前卡片同偏移，否则替换动画会错位。 */
    const prevWrapperAnchor: CSSProperties =
        slideLayout === 'left'
            ? { left: slideOffset }
            : slideLayout === 'top'
                ? { top: slideOffset }
                : { left: 0 }

    return (
        <>
            <div
                id="notification-root"
                style={{
                    width: '100%',
                    height: 'auto',
                    background: 'transparent',
                    position: 'relative', // Context for absolute children
                    overflow: 'hidden', // Prevent scrollbars during transition
                    ...rootSlideStyle
                }}>

                {/* Previous Notification (Background / Fading Out) */}
                {prevNotification && (
                    <div
                        id="notification-prev"
                        key={prevNotification.id}
                        className={position === 'top-center' ? 'anim-center' : ''}
                        data-anim={prevNotification.notificationAnimationStyle || animationStyle}
                        data-slide={slideFrom}
                        /**
                         * 旧卡片的退场也门控在"窗口真的显示了"上。
                         *
                         * 它和当前卡片共用一条时间线：主进程先把窗口放开一段（滑动
                         * 要滑到屏幕外），发来 `notification:shown`，**两张卡片这时
                         * 才一起动** —— 旧卡片往外走、新卡片往里走。门控之前旧卡片
                         * 一挂载就开跑，头几毫秒是在还没放开的窗口里，被裁掉一截。
                         */
                        data-run={slideLayout ? (revealed ? 'true' : 'false') : undefined}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            zIndex: 1,
                            pointerEvents: 'none', // Disable interaction on old one
                            ...prevWrapperAnchor
                        }}
                    >
                        <NotificationToast
                            key={prevNotification.id}
                            data={prevNotification}
                            onClose={() => { }} // No-op for background item
                            initialVisible={true}
                            // 桌面帧进玻璃：这是"折射强度 / 玻璃模糊"唯一能作用的对象
                            // （透明窗口里 backdrop-filter 不生效）。NotificationToast
                            // 只在用户把这两个滑块拨离 0 时才真的用它。
                            backdropImage={backdrop}
                            backdropStream={backdropStream}
                            nativeBackdrop={nativeBackdrop}
                            glass={glass}
                            duration={prevNotification.notificationDuration}
                            animationEnabled={prevNotification.notificationAnimationEnabled !== false}
                            animationStyle={prevNotification.notificationAnimationStyle || animationStyle}
                            slideFrom={prevNotification.slideFrom || slideFrom}
                        />
                    </div>
                )}

                {/* Current Notification (Foreground / Fading In) */}
                {notification && (
                    <div
                        id="notification-current"
                        key={notification.id}
                        className={[
                            position === 'top-center' ? 'anim-center' : '',
                            notification.notificationAnimationEnabled === false ? 'motion-disabled' : ''
                        ].filter(Boolean).join(' ')}
                        // 动效风格 / 方向 / 是否起跑：三者都挂在属性上，位移与过渡
                        // 全在 NotificationWindow.scss 里（内联 transform 会把退场
                        // 的 transition 盖掉）。
                        data-anim={animationStyle}
                        data-slide={slideFrom}
                        data-run={animationsOn ? (revealed ? 'true' : 'false') : undefined}
                        style={{
                            position: 'relative', // Takes up space
                            zIndex: 2,
                            ...currentWrapperSlideStyle
                        }}
                    >
                        <NotificationToast
                            key={notification.id} // Ensure remount for animation
                            data={notification}
                            onClose={handleClose}
                            initialVisible={true}
                            backdropImage={backdrop}
                            backdropStream={backdropStream}
                            nativeBackdrop={nativeBackdrop}
                            glass={glass}
                            duration={notification.notificationDuration}
                            animationEnabled={notification.notificationAnimationEnabled !== false}
                            animationStyle={animationStyle}
                            slideFrom={slideFrom}
                            revealed={revealed}
                            // 只有"当前"这条上报尺寸：旧卡片是绝对定位的过渡层，
                            // 它的宽度不该决定窗口大小
                            onMeasure={setMeasured}
                            // 退场动画开始的一刻：原生面板同步淡出（窗口的放开已经在
                            // dismiss 之前用 prepareExit 做完了 —— 那是异步的，不能和
                            // 动画抢同一帧）。
                            onBeforeExit={slideLayout ? prepareExit : undefined}
                            onHideStart={() => {
                                if (nativeBackdrop) window.electronAPI?.notification?.glassHide?.()
                            }}
                        />
                    </div>
                )}
            </div>
        </>
    )
}
