import { useCallback, useEffect, useState, useRef } from 'react'
import { NotificationToast, type NotificationData } from '../components/NotificationToast'
import type { LiquidGlassBackdropImage } from '../components/LiquidGlass'
import {
    getLayoutRect,
    NATIVE_BAND_IDS,
    useNotificationNativeAdaptiveTheme,
    useNotificationSnapshotTheme,
    type CardLayoutRect
} from './useNotificationAdaptiveTheme'
import '../components/NotificationToast.scss'
import './NotificationWindow.scss'

/**
 * 与 NotificationToast 传给 LiquidGlass 的参数保持一致（原生面板需要同一套值）。
 *
 * 纱层压到近乎全透之后，卡片的"玻璃感"就全落在折射本身了：blurSigma 6 让玻璃
 * 读起来是"厚玻璃"而不是"贴纸"，displacementScale/aberration 抬高一档让边缘的
 * 透镜弯曲与色散可见（之前 0.42~0.58 的厚纱层把这些全盖住了）。
 */
const GLASS_PARAMS = { cornerRadius: 16, blurSigma: 6, displacementScale: 100, aberrationIntensity: 2, saturation: 175 }
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
    // 事件回调里需要读取"当前展示中"的通知作为过渡的旧通知，用 ref 避免重建监听
    const notificationRef = useRef<NotificationData | null>(null)
    // 上次上报的窗口尺寸：重复上报会触发主进程 setSize，
    // 可见状态下反复设置尺寸会让 DWM 短暂拉伸旧帧缓冲，闪出一圈幽灵轮廓
    const lastSizeRef = useRef<{ width: number; height: number } | null>(null)
    // 采集源 ID：与窗口/流生命周期解耦，事件回调里读 ref
    const sourceIdRef = useRef<string | null>(null)

    useEffect(() => {
        notificationRef.current = notification
    }, [notification])

    useEffect(() => {
        const handleShow = (_event: any, data: any) => {
            const timestamp = Math.floor(Date.now() / 1000)
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
                notificationAnimationEnabled: data.notificationAnimationEnabled !== false
            }

            if (data.position) {
                setPosition(data.position)
            }
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
            window.electronAPI.notification?.ready?.()
            return () => remove?.()
        }
    }, [])

    // Clean up prevNotification after transition
    useEffect(() => {
        if (prevNotification) {
            const timer = setTimeout(() => {
                setPrevNotification(null)
            }, 400)
            return () => clearTimeout(timer)
        }
    }, [prevNotification])

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
            } catch (error) {
                // 采集失败（权限/驱动/虚拟桌面）时不要放弃：主进程的定帧推送继续
                // 供帧，玻璃依然是"跟着桌面走"的，只是帧率低一些
                console.warn('[NotificationWindow] WGC desktop stream unavailable, falling back to main-process frames:', error)
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
            // 每帧内容指纹（长度 + 中段字符）+ 帧序号：截图 QA 用它们断言
            // “玻璃上显示的确实是主进程最新发出的那一帧”，比只看像素差少一层猜测。
            try {
                const url = String(frame.dataUrl || '')
                document.documentElement.dataset.glassHash = `${url.length}:${url.slice(2000, 2012)}`
                document.documentElement.dataset.glassSeq = String(frame.seq ?? '')
            } catch { /* noop */ }
            setBackdrop(prev => ({
                width: frame.width,
                height: frame.height,
                screenX: frame.winX,
                screenY: frame.winY,
                // 窗口尺寸按上一份沿用：定帧推送里不带它，但采样要靠它把取样点挪出窗口
                winW: prev?.winW,
                winH: prev?.winH,
                dataUrl: frame.dataUrl
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

    useNotificationNativeAdaptiveTheme(nativeBackdrop, cardLayout)
    useNotificationSnapshotTheme(backdrop, cardLayout)

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

    useEffect(() => {
        if (!notification && !prevNotification) return

        const timer = setTimeout(() => {
            // 窗口必须精确贴合内容高度，多余区域会拦截桌面点击
            const root = document.getElementById('notification-root')
            if (root && window.electronAPI?.notification?.resize) {
                const width = position === 'top-center' ? 280 : 344
                const height = Math.min(Math.ceil(root.getBoundingClientRect().height), 300)
                const last = lastSizeRef.current
                if (last && last.width === width && last.height === height) return
                lastSizeRef.current = { width, height }
                window.electronAPI.notification.resize(width, height)
            }
        }, 50)

        return () => clearTimeout(timer)
    }, [notification, prevNotification, position])

    // 原生玻璃模式：卡片挂载后上报实测几何（窗口本地 CSS 像素 + 卡片本地亮度带），
    // 主进程据此创建/复用窗口下方的原生面板；参数与 LiquidGlass 的视觉参数一致
    useEffect(() => {
        if (!nativeBackdrop || !notification) return
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
                ...GLASS_PARAMS
            }
            const key = JSON.stringify(payload)
            if (key === lastSent) return
            lastSent = key
            window.electronAPI?.notification?.glassRect?.(payload)
        }
        // 双 rAF 等首次布局落定后测量；120ms 复测一次，覆盖表情图/字体就绪导致的高度变化
        let raf2 = 0
        const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(report) })
        const timer = setTimeout(report, 120)
        return () => {
            cancelAnimationFrame(raf1)
            cancelAnimationFrame(raf2)
            clearTimeout(timer)
        }
    }, [nativeBackdrop, notification, position])

    useEffect(() => {
        if (!notification && !prevNotification) return

        const timer = setTimeout(() => {
            // 窗口必须精确贴合内容高度，多余区域会拦截桌面点击
            const root = document.getElementById('notification-root')
            if (root && window.electronAPI?.notification?.resize) {
                const width = position === 'top-center' ? 280 : 344
                const height = Math.min(Math.ceil(root.getBoundingClientRect().height), 300)
                const last = lastSizeRef.current
                if (last && last.width === width && last.height === height) return
                lastSizeRef.current = { width, height }
                window.electronAPI.notification.resize(width, height)
            }
        }, 50)

        return () => clearTimeout(timer)
    }, [notification, prevNotification, position])

    if (!notification && !prevNotification) return null

    return (
        <>
            <div
                id="notification-root"
                style={{
                    width: '100%',
                    height: 'auto',
                    background: 'transparent',
                    position: 'relative', // Context for absolute children
                    overflow: 'hidden' // Prevent scrollbars during transition
                }}>

                {/* Previous Notification (Background / Fading Out) */}
                {prevNotification && (
                    <div
                        id="notification-prev"
                        key={prevNotification.id}
                        className={position === 'top-center' ? 'anim-center' : ''}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            zIndex: 1,
                            pointerEvents: 'none' // Disable interaction on old one
                        }}
                    >
                        <NotificationToast
                            key={prevNotification.id}
                            data={prevNotification}
                            onClose={() => { }} // No-op for background item
                            initialVisible={true}
                            backdropStream={backdropStream}
                            nativeBackdrop={nativeBackdrop}
                            duration={prevNotification.notificationDuration}
                            animationEnabled={prevNotification.notificationAnimationEnabled !== false}
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
                        style={{
                            position: 'relative', // Takes up space
                            zIndex: 2,
                            width: '100%'
                        }}
                    >
                        <NotificationToast
                            key={notification.id} // Ensure remount for animation
                            data={notification}
                            onClose={handleClose}
                            initialVisible={true}
                            backdropStream={backdropStream}
                            nativeBackdrop={nativeBackdrop}
                            duration={notification.notificationDuration}
                            animationEnabled={notification.notificationAnimationEnabled !== false}
                            // 退场动画开始的一刻同步淡出原生面板（与卡片 0.3s 渐隐节奏匹配）
                            onHideStart={nativeBackdrop ? () => window.electronAPI?.notification?.glassHide?.() : undefined}
                        />
                    </div>
                )}
            </div>
        </>
    )
}
