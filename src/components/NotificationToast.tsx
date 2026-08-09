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
    /** 退场动画开始的一刻触发（原生模式用来提前淡出原生面板） */
    onHideStart?: () => void
}

/**
 * 通知卡片：始终渲染为全局液态玻璃（LiquidGlass 兼容层），在独立通知窗口内展示。
 * 折射背景：原生面板（默认关闭）或主进程下发的静态桌面快照（CSS 滤镜就地加工）。
 * 除悬停平滑放大外无任何鼠标交互（不可点击、无关闭按钮，5 秒后自动消失）。
 */
export function NotificationToast({
    data,
    onClose,
    duration = 5000,
    initialVisible = false,
    backdropImage,
    nativeBackdrop = false,
    onHideStart
}: NotificationToastProps) {
    const [isVisible, setIsVisible] = useState(initialVisible)
    const [currentData, setCurrentData] = useState<NotificationData | null>(null)
    const onHideStartRef = useRef(onHideStart)
    onHideStartRef.current = onHideStart

    // 任何路径（超时）触发的退场都在动画开始的一刻通知外层
    const beginHide = () => {
        setIsVisible(false)
        onHideStartRef.current?.()
    }

    useEffect(() => {
        if (data) {
            setCurrentData(data)
            setIsVisible(true)

            const timer = setTimeout(() => {
                beginHide()
                // clean up data after animation
                setTimeout(onClose, 300)
            }, duration)

            return () => clearTimeout(timer)
        } else {
            setIsVisible(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, duration, onClose])

    if (!currentData) return null

    return (
        <div className={`notification-toast-container ${isVisible ? 'visible' : ''}`}>
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
