import './styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installLiveTaskWiring } from './utils/liveTaskWiring'

/**
 * 长任务的进度接线在**应用启动时**装好，不等任何页面挂载。
 *
 * 页面是 `React.lazy` + 条件渲染，切一个标签页就卸载了；托盘隐藏更会直接销毁
 * 窗口。订阅必须活在页面之上 —— 否则"切走再切回来就看不到进度"永远修不掉
 * （用户报的克隆生成 / 导出 / 连接微信三个场景都是这一条）。
 */
installLiveTaskWiring()

const hash = window.location.hash
const rootEl = document.getElementById('root')!

if (hash.startsWith('#/notification-window')) {
  /**
   * 通知弹窗：窗口透明，页面背景必须透明，否则会出现黑底矩形。
   *
   * 这条分支是**历史兼容路径**（v0.9.3 起弹窗走独立入口 `popup.html` +
   * `popup-main.tsx`，见 electron/windows/notificationWindow.ts），但不要因此把它
   * 和下面的 `NotificationWindow` 一起放进静态导入：静态导入会把**整个弹窗包
   * （含 LiquidGlass 玻璃管线，实测 230KB）塞进主窗口的启动图**，主窗口每次启动都
   * 要白解析一遍。改成动态导入之后两条路径都还在，代价只在真的用这条路径时才付。
   */
  void import('./pages/NotificationWindow').then(({ default: NotificationWindow }) => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    createRoot(rootEl).render(<NotificationWindow />)
  })
} else {
  createRoot(rootEl).render(<App />)
}
