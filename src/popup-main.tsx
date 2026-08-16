/**
 * 通知弹窗独立入口（v0.9.3 起）。
 *
 * 此前弹窗加载 dist/index.html 并经由 hash 路由渲染 NotificationWindow ——
 * 渲染进程要为整包（App + ECharts + html2canvas + 朋友圈/分析页）付出 V8
 * 解析/编译内存。独立入口只打包 NotificationWindow 及其依赖（React +
 * LiquidGlass 玻璃管线），弹窗渲染进程堆显著下降。
 *
 * 与主入口保持一致的透明背景设置（透明窗口必须显式透明，否则 DWM 黑底兜底）。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import NotificationWindow from './pages/NotificationWindow'
import './styles/popupBase.css'

document.documentElement.style.background = 'transparent'
document.body.style.background = 'transparent'
createRoot(document.getElementById('root')!).render(<NotificationWindow />)
