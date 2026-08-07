import './styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import NotificationWindow from './pages/NotificationWindow'

const hash = window.location.hash
const rootEl = document.getElementById('root')!

if (hash.startsWith('#/notification-window')) {
  // 通知弹窗：窗口透明，页面背景必须透明，否则会出现黑底矩形
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  createRoot(rootEl).render(<NotificationWindow />)
} else {
  createRoot(rootEl).render(<App />)
}
