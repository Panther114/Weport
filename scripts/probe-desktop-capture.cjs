// Why can't the popup open a live desktop stream?
//
// The notification glass wants live desktop refraction via getUserMedia with a
// desktopCapturer source id. On this machine that call fails, and the Chromium
// log only says `wgc_capture_source.cc: CreateForMonitor failed ... E_ACCESSDENIED`.
// This probe isolates the two halves — getSources (which has a GDI fallback) and
// getUserMedia (WGC only) — and reports the exact DOMException, so the fix targets
// the real cause instead of guessing.
//
// Usage: node_modules\electron\dist\electron.exe scripts\probe-desktop-capture.cjs
const { app, BrowserWindow, desktopCapturer, screen } = require('electron')
const path = require('node:path')
const os = require('node:os')

app.commandLine.appendSwitch('enable-logging')

app.whenReady().then(async () => {
  const out = { platform: process.platform, release: os.release(), gpu: app.getGPUFeatureStatus?.() ?? null }
  const display = screen.getPrimaryDisplay()
  out.display = { id: display.id, size: display.size, scaleFactor: display.scaleFactor }

  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
    out.sources = sources.map((s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id,
      size: s.thumbnail.getSize(),
      empty: s.thumbnail.isEmpty(),
      // 平均亮度：全黑说明桌面采集只拿到了空帧
      meanLuma: (() => {
        try {
          const bmp = s.thumbnail.toBitmap()
          let sum = 0
          for (let i = 0; i < bmp.length; i += 4) sum += bmp[i]
          return Math.round(sum / (bmp.length / 4))
        } catch {
          return -1
        }
      })(),
    }))
  } catch (error) {
    out.sourcesError = String(error)
  }

  // getUserMedia 必须在一个真实页面里跑：用 data: URL 的空白窗口
  const win = new BrowserWindow({ width: 200, height: 120, show: false, webPreferences: { sandbox: false } })
  await win.loadURL('data:text/html,<html><body>probe</body></html>')
  const sourceId = out.sources?.[0]?.id
  out.getUserMedia = await win.webContents
    .executeJavaScript(
      `(async () => {
         try {
           const stream = await navigator.mediaDevices.getUserMedia({
             audio: false,
             video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(sourceId)} } }
           })
           const track = stream.getVideoTracks()[0]
           const settings = track.getSettings ? track.getSettings() : {}
           stream.getTracks().forEach((t) => t.stop())
           return { ok: true, settings }
         } catch (e) {
           return { ok: false, name: e && e.name, message: e && e.message }
         }
       })()`,
      true,
    )
    .catch((e) => ({ ok: false, name: 'executeJavaScript-failed', message: String(e) }))

  console.log('PROBE ' + JSON.stringify(out, null, 2))
  app.exit(0)
})
