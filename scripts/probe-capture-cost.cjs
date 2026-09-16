// How expensive is one desktop frame on THIS machine?
//
// The popup wants a live glass backdrop. WGC (getUserMedia) is unavailable here
// (DXGI duplication cannot initialise on this adapter), so the fallback is a
// periodic `desktopCapturer.getSources` grab in the main process — which is only
// viable if a frame is cheap enough to run a few times per second. This measures
// capture + encode cost so the frame interval is chosen from data, not hope.
//
// Usage: node_modules\electron\dist\electron.exe scripts\probe-capture-cost.cjs
const { app, desktopCapturer, screen } = require('electron')

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay()
  const thumbSize = {
    width: Math.round(display.size.width * 0.5),
    height: Math.round(display.size.height * 0.5),
  }

  // 一次预热（首次调用要初始化采集管线，成本与后续帧不同）
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumbSize })

  const results = []
  for (let i = 0; i < 12; i += 1) {
    const t0 = Date.now()
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumbSize })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    const tCapture = Date.now() - t0
    const t1 = Date.now()
    const png = source?.thumbnail.toDataURL()
    const tPng = Date.now() - t1
    const t2 = Date.now()
    const jpeg = source?.thumbnail.toJPEG(60).toString('base64')
    const tJpeg = Date.now() - t2
    results.push({ captureMs: tCapture, pngMs: tPng, jpegMs: tJpeg, pngKb: Math.round((png?.length || 0) / 1024), jpegKb: Math.round((jpeg?.length || 0) / 1024) })
  }

  const avg = (key) => Math.round((results.reduce((s, r) => s + r[key], 0) / results.length) * 10) / 10
  const max = (key) => Math.max(...results.map((r) => r[key]))
  console.log(
    'COST ' +
      JSON.stringify(
        {
          thumbSize,
          display: display.size,
          captureAvgMs: avg('captureMs'),
          captureMaxMs: max('captureMs'),
          pngAvgMs: avg('pngMs'),
          pngMaxMs: max('pngMs'),
          jpegAvgMs: avg('jpegMs'),
          jpegMaxMs: max('jpegMs'),
          pngAvgKb: Math.round(results.reduce((s, r) => s + r.pngKb, 0) / results.length),
          jpegAvgKb: Math.round(results.reduce((s, r) => s + r.jpegKb, 0) / results.length),
        },
        null,
        2,
      ),
  )
  app.exit(0)
})
