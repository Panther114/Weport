// Does the fallback desktop capture actually see changes?
//
// The live glass runs on `desktopCapturer.getSources` because WGC is unavailable on
// this machine. If that path returns stale frames, the glass looks frozen no matter
// how well the plumbing works. This moves a bright window across the screen and
// compares two captures, so "capture is stale" and "rendering is stale" can be told
// apart instead of guessed at.
//
// Usage: node_modules\electron\dist\electron.exe scripts\probe-capture-liveness.cjs
const { app, BrowserWindow, desktopCapturer, screen } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay()
  const thumbSize = {
    width: Math.round(display.size.width * 0.5),
    height: Math.round(display.size.height * 0.5),
  }

  const marker = new BrowserWindow({
    width: 420,
    height: 320,
    x: 40,
    y: 40,
    frame: false,
    backgroundColor: '#ff2d55',
    alwaysOnTop: true,
    skipTaskbar: true,
  })
  await marker.loadURL('data:text/html,<body style="margin:0;background:%23ff2d55"></body>')
  marker.showInactive()
  await sleep(1200)

  const grab = async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumbSize })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    return source.thumbnail.toBitmap()
  }

  const meanAbsDiff = (a, b) => {
    const n = Math.min(a.length, b.length)
    if (!n) return -1
    let sum = 0
    for (let i = 0; i < n; i += 4) sum += Math.abs(a[i] - b[i])
    return Math.round((sum / (n / 4)) * 100) / 100
  }

  const before = await grab()
  marker.setPosition(700, 260)
  await sleep(1500)
  const after = await grab()

  // 同样两帧之间不改变任何东西，作为"噪声地板"参照
  const still1 = await grab()
  await sleep(1200)
  const still2 = await grab()

  console.log(
    'LIVENESS ' +
      JSON.stringify(
        {
          display: display.size,
          thumbSize,
          movedWindowDelta: meanAbsDiff(before, after),
          staticDelta: meanAbsDiff(still1, still2),
        },
        null,
        2,
      ),
  )
  app.exit(0)
})
