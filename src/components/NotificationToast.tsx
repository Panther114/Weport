import React, { useEffect, useRef, useState } from 'react'
import { Avatar } from './Avatar'
import LiquidGlass, { type LiquidGlassBackdropImage } from './LiquidGlass'
import { renderTextWithEmoji } from '../utils/renderTextWithEmoji'
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
    /** 回退管线的屏幕几何信息（含静态桌面快照），玻璃用它对齐折射采样 */
    backdropImage?: LiquidGlassBackdropImage
    /** 原生玻璃模式（Windows）：折射由主进程原生面板渲染，卡片背景透明 */
    nativeBackdrop?: boolean
    /** 是否播放入场、退场和卡片过渡动效 */
    animationEnabled?: boolean
    /** 退场动画开始的一刻触发（原生模式用来提前淡出原生面板） */
    onHideStart?: () => void
}

/**
 * 通知卡片：始终渲染为全局液态玻璃（LiquidGlass 兼容层），在独立通知窗口内展示。
 * 折射背景：原生面板（默认关闭）或主进程下发的静态桌面快照（CSS 滤镜就地加工）。
 * 卡片不导航、不弹出菜单；右键当前卡片即可关闭，默认按配置时长自动消失。
 */
export function NotificationToast({
    data,
    onClose,
    duration = 5000,
    initialVisible = false,
    backdropImage,
    nativeBackdrop = false,
    animationEnabled = true,
    onHideStart
}: NotificationToastProps) {
    const [isVisible, setIsVisible] = useState(initialVisible)
    const [currentData, setCurrentData] = useState<NotificationData | null>(null)
    const onHideStartRef = useRef(onHideStart)
    const onCloseRef = useRef(onClose)
    const closeTimerRef = useRef<number | null>(null)
    const dismissedRef = useRef(false)
    onHideStartRef.current = onHideStart
    onCloseRef.current = onClose

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

    if (!currentData) return null

    return (
        <div
            className={`notification-toast-container ${isVisible ? 'visible' : ''} ${animationEnabled ? '' : 'motion-disabled'}`.trim()}
            onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                dismiss()
            }}
        >
            <LiquidGlass
                cornerRadius={16}
                padding="12px 10px"
                blurAmount={0.3}
                saturation={175}
                displacementScale={85}
                aberrationIntensity={1.5}
                backdropImage={backdropImage}
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
                            <span className="notification-title">{currentData.title}</span>
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
