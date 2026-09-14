// 诊断明暗自适应：为什么背景亮度没有翻转主题。
//
// 直接在主窗口里手动跑一遍同样的采样逻辑并打印亮度值，把「采样拿不到像素」
// 和「采样到了但阈值判断不对」区分开 —— 只看最终 mode 这两个原因长得一样。

import { _electron as electron } from 'playwright-core'

const root = process.cwd()
const exe = `${root}\\release\\win-unpacked\\Weport.exe`

const app = await electron.launch({
  executablePath: exe,
  args: [`--user-data-dir=${root}\\.ui-probe\\userData`],
  cwd: root,
  env: { ...process.env }
})

try {
  const page = await app.firstWindow({ timeout: 40000 })
  await page.waitForSelector('.rail-item', { timeout: 40000 })
  await page.waitForTimeout(8000)

  const out = await page.evaluate(async () => {
    const lin = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    const sample = (src) => {
      const c = document.createElement('canvas')
      c.width = 32
      c.height = 18
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(src, 0, 0, 32, 18)
      const { data } = ctx.getImageData(0, 0, 32, 18)
      let sum = 0
      let n = 0
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2])
        n += 1
      }
      return n ? sum / n : null
    }

    const video = document.querySelector('.app-bg video')
    const result = {
      mode: document.documentElement.dataset.mode,
      bgKind: document.documentElement.dataset.bgKind,
      hasVideo: !!video,
      readyState: video ? video.readyState : null,
      videoW: video ? video.videoWidth : null,
      currentSrcStart: video ? String(video.currentSrc || video.src).slice(0, 60) : null
    }
    if (video) {
      try {
        result.luminanceFromVideo = sample(video)
      } catch (e) {
        result.videoError = String(e).slice(0, 120)
      }
    }
    // 也直接用图片元素试一次（排除视频特有的限制）
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = video ? video.src : ''
      await new Promise((res, rej) => {
        img.onload = res
        img.onerror = rej
        setTimeout(rej, 4000)
      })
      result.imageLoaded = true
      try {
        result.luminanceFromImage = sample(img)
      } catch (e) {
        result.imageSampleError = String(e).slice(0, 120)
      }
    } catch (e) {
      result.imageLoadError = String(e).slice(0, 120)
    }
    return result
  })

  console.log(JSON.stringify(out, null, 1))
} finally {
  await app.close().catch(() => {})
}
