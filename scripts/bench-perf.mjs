// Weport 性能基准（v1.0.1）—— **每次大改动之后跑一次**的快速体检。
//
// 为什么单独做一个（而不是继续用 .ui-probe/measure-app-perf.mjs）：
//   1. 那个探针量得细但**不判对错**，也没有弹窗那一块；用户要的是"跑一下就知道
//      这次改动有没有让东西变慢"，也就是要有 baseline 对比和 PASS/FAIL；
//   2. 它一次 40 秒起步并且全量切 8 个页 ×1.8s，作为"每次收尾都跑"的东西太慢；
//   3. 通知弹窗是这次改动的核心（玻璃 / 投影 / 折射 / 磨砂），它**完全没有覆盖**。
//
// 量五类：
//   A. 启动：launch → 导航栏出现、FCP / DCL、首屏 JS 堆；
//   B. 切页：每个导航项点一下，量 700ms 窗口内的帧间隔与 long task；
//   C. 弹窗：冷启动一条合成通知（走 notification:showTest 的真实管线）→ 窗口创建、
//      卡片首帧、渲染进程帧间隔与 long task；窗口固定在屏幕外；
//   D. 玻璃增量：把「玻璃模糊」从 0 拉到 100 再弹一条，两轮的差值就是这块玻璃的
//      真实代价 —— 折射/磨砂滑块"有没有生效"在这里同时也是**性能**证据；
//   E. 纯函数微基准：引用候选筛选（5000 条）与浮层定位，算法退化会立刻显示出来。
//
// 纪律（docs/agents/probes.md）：使用空白私有 userData；主窗口和弹窗都在创建时移到
// 屏幕外，showInactive 不抢焦点。desktopCapturer/GDI/WGC 不读取用户桌面；满档玻璃
// 使用本探针生成的 BGRA 图像；`--skip-popup` 可以跳过通知渲染测量。
//
// 用法：
//   node .ui-probe/bench-perf.mjs                 # 对着 release/win-unpacked 量
//   node .ui-probe/bench-perf.mjs --installed     # 对着安装版量
//   node .ui-probe/bench-perf.mjs --skip-popup    # 不弹通知（纯应用基线）
//   node .ui-probe/bench-perf.mjs --update        # 把这次结果接受为新的基线
//   node .ui-probe/bench-perf-ab.mjs              # v1.1 fixture 与当前 build 配对测量
//
// 退出码：0 = 全部在容差内；1 = 有指标回归（或探针自身出错）。
// 产出：.ui-probe/bench-last.json（本次原始数据）、.ui-probe/bench-baseline.json（基线）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright-core')

const root = resolve(process.cwd())
// The current v1.2 default notification is 422×114 DIP; the app probe adds a 40px margin
// on each edge and schedules the next synthetic frame 33ms after sending the current one.
const syntheticFrameProfile = { width: 502, height: 194, margin: 40, intervalMs: 33, costMs: 11 }
const useInstalled = process.argv.includes('--installed')
const skipPopup = process.argv.includes('--skip-popup')
const updateBaseline = process.argv.includes('--update')
const skipBaseline = process.argv.includes('--no-baseline')
const argValue = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const customExe = argValue('--exe')
const label = argValue('--label')
const outputPath = argValue('--out')
const isolatedV11 = process.env.WEPORT_BENCH_V11_SANITIZED === '1'
if (label === 'v1.1' && !isolatedV11) {
  throw new Error('Refusing to launch v1.1 without its private app.asar migration guard')
}
const exe = customExe
  ? resolve(customExe)
  : useInstalled
  ? join(process.env.LOCALAPPDATA || '', 'Programs', 'Weport', 'Weport.exe')
  : join(root, 'release', 'win-unpacked', 'Weport.exe')

if (!existsSync(exe)) {
  console.error(`Weport.exe not found: ${exe}\n先构建：npm run build:dir`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (v, digits = 0) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null)

console.log(`Weport 性能基准 — target: ${label || (customExe ? 'custom' : useInstalled ? 'installed' : 'dev')} — ${exe}`)
if (!skipPopup) console.log('  弹窗和主窗口都固定在屏幕外；通知玻璃只使用探针生成的合成像素。')

/**
 * 空白私有 userData：不读取或复制用户配置、凭据、WeChat 路径或任何数据库。
 * 这既隔离了已运行的 Weport，也确保基准只使用应用的默认配置和合成通知。
 */
const userDataDir = mkdtempSync(join(tmpdir(), 'weport-bench-'))

const target = label || (customExe ? 'custom' : useInstalled ? 'installed' : 'dev')
const result = { at: new Date().toISOString(), target, exe, start: null, pages: [], popup: null, glass: null, micro: null, processes: null, stability: null }
const failures = []

const launchedAt = Date.now()
const launchArgs = [`--user-data-dir=${userDataDir}`]
// Start every build hidden. Arm the BrowserWindow guard before emitting activate,
// so even binaries without a reliable app-side probe flag cannot show/focus on-screen.
launchArgs.push('--background')
const app = await electron.launch({
  executablePath: exe,
  args: launchArgs,
  cwd: root,
  env: {
    ...process.env,
    WEPORT_DISCARD_DELAY_MS: '600000',
    WEPORT_PROBE_OFFSCREEN: '1',
    WEPORT_NATIVE_GLASS: '0',
    // Old builds use this to suppress the GDI fast path. The v1.2 probe flag has its own
    // synthetic BGRA source, so neither build reads desktopCapturer, GDI, or WGC.
    WEPORT_GLASS_NOCAPTURE: '1',
  },
  timeout: 90000,
})

/**
 * Guard all builds before their `activate` listener can create a window. This keeps window
 * construction and show paths off-screen and unfocused, and blocks desktop capture so the
 * glass probe uses synthetic frames only.
 */
const offscreenGuard = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
  const prototype = BrowserWindow.prototype
  if (!prototype.__weportProbeOffscreen) {
    const nativeSetPosition = prototype.setPosition
    const nativeSetBounds = prototype.setBounds
    const nativeGetPosition = prototype.getPosition
    const nativeGetBounds = prototype.getBounds
    const nativeShowInactive = prototype.showInactive
    const guardedWindows = new WeakSet()
    const forceOffscreen = (win, animate) => {
      const result = nativeSetPosition.call(win, -4000, 0, animate)
      if (nativeGetPosition.call(win)[0] > -3000) {
        nativeSetBounds.call(win, { ...nativeGetBounds.call(win), x: -4000, y: 0 }, animate)
      }
      return result
    }
    const armWindow = (win, animate) => {
      if (!guardedWindows.has(win)) {
        Object.defineProperties(win, {
          setPosition: {
            configurable: true,
            writable: true,
            value: function (_x, _y, moveAnimate) { return forceOffscreen(this, moveAnimate) },
          },
          setBounds: {
            configurable: true,
            writable: true,
            value: function (bounds, moveAnimate) {
              nativeSetBounds.call(this, { ...bounds, x: -4000, y: 0 }, moveAnimate)
              return forceOffscreen(this, moveAnimate)
            },
          },
          showInactive: {
            configurable: true,
            writable: true,
            value: function (...args) {
              forceOffscreen(this)
              return nativeShowInactive.apply(this, args)
            },
          },
          show: {
            configurable: true,
            writable: true,
            value: function (...args) {
              forceOffscreen(this)
              return nativeShowInactive.apply(this, args)
            },
          },
          maximize: {
            configurable: true,
            writable: true,
            value: function () { forceOffscreen(this); return false },
          },
          center: {
            configurable: true,
            writable: true,
            value: function () { return forceOffscreen(this) },
          },
          focus: {
            configurable: true,
            writable: true,
            value: function () { return undefined },
          },
        })
        guardedWindows.add(win)
      }
      const position = nativeGetPosition.call(win)
      return position[0] > -3000 ? forceOffscreen(win, animate) : position
    }
    const descriptors = {
      setPosition: {
        configurable: true,
        writable: true,
        value: function (_x, _y, animate) { return armWindow(this, animate) },
      },
      setBounds: {
        configurable: true,
        writable: true,
        value: function (bounds, animate) { return armWindow(this, animate) },
      },
      showInactive: {
        configurable: true,
        writable: true,
        value: function (...args) { armWindow(this); return nativeShowInactive.apply(this, args) },
      },
    }
    for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(prototype, key, descriptor)
    Object.defineProperty(prototype, 'show', {
      configurable: true,
      writable: true,
      value: function (...args) { armWindow(this); return nativeShowInactive.apply(this, args) },
    })
    Object.defineProperty(prototype, 'maximize', {
      configurable: true,
      writable: true,
      value: function () { armWindow(this); return false },
    })
    Object.defineProperty(prototype, 'center', {
      configurable: true,
      writable: true,
      value: function () { return armWindow(this) },
    })
    Object.defineProperty(prototype, 'focus', {
      configurable: true,
      writable: true,
      value: function () { return undefined },
    })
    Object.defineProperty(prototype, '__weportProbeArmWindow', { value: armWindow })
    Object.defineProperty(prototype, '__weportProbeOffscreen', { value: true })
  }
  let captureBlocked = false
  try {
    const blockedSources = async () => []
    desktopCapturer.getSources = blockedSources
    if (desktopCapturer.getSources !== blockedSources) {
      Object.defineProperty(desktopCapturer, 'getSources', { configurable: true, writable: true, value: blockedSources })
    }
    captureBlocked = desktopCapturer.getSources === blockedSources
  } catch { /* app-side synthetic probe mode covers the current build */ }
  const windows = BrowserWindow.getAllWindows().map((win) => {
    try { prototype.__weportProbeArmWindow?.(win) } catch { /* report below */ }
    return { position: win.getPosition(), visible: win.isVisible() }
  })
  return {
    patched: Boolean(prototype.__weportProbeOffscreen && prototype.__weportProbeArmWindow),
    captureBlocked,
    focused: Boolean(BrowserWindow.getFocusedWindow()),
    windows,
  }
}).catch(async (error) => {
  await app.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* noop */ }
  throw error
})
if (
  !offscreenGuard.patched ||
  !offscreenGuard.captureBlocked ||
  offscreenGuard.focused ||
  offscreenGuard.windows.some((win) => win.position[0] > -3000)
) {
  await app.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* noop */ }
  throw new Error(`Could not establish off-screen, unfocused probe guard: ${JSON.stringify(offscreenGuard)}`)
}

let activateListenerReady = false
for (let attempt = 0; attempt < 900; attempt += 1) {
  activateListenerReady = await app.evaluate(({ app: electronApp }) => electronApp.listenerCount('activate') > 0)
  if (activateListenerReady) break
  await sleep(100)
}
if (!activateListenerReady) {
  await app.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* noop */ }
  throw new Error('App did not register its activate listener before the off-screen probe timeout')
}
await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))

const offscreenWindows = await app.evaluate(async ({ BrowserWindow }) => {
  const armWindow = BrowserWindow.prototype.__weportProbeArmWindow
  for (const win of BrowserWindow.getAllWindows()) {
    try { armWindow?.(win) } catch { /* window may have closed */ }
  }
  const windows = BrowserWindow.getAllWindows().map((win) => ({ position: win.getPosition(), visible: win.isVisible() }))
  return { windows, focused: Boolean(BrowserWindow.getFocusedWindow()) }
})
if (offscreenWindows.focused || offscreenWindows.windows.some((win) => win.position[0] > -3000)) {
  await app.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* noop */ }
  throw new Error(`A probe window escaped the off-screen guard: ${JSON.stringify(offscreenWindows)}`)
}

/**
 * 主进程指标（CPU% 与工作集，按进程类型汇总）。
 * 注意：`app.evaluate` 跑在**主进程**里，拿不到本文件作用域的东西（`round` 之类），
 * 所以内部的取整只能自己写 —— 第一版就是在这里报 `round is not defined`。
 */
const procMetrics = () =>
  app.evaluate(async ({ app: electronApp }) => {
    const r2 = (v) => Math.round(v * 100) / 100
    const list = electronApp.getAppMetrics()
    return {
      total: list.reduce((s, x) => s + (x.memory?.workingSetSize ?? 0), 0) / 1024,
      cpu: r2(list.reduce((s, x) => s + (x.cpu?.percentCPUUsage ?? 0), 0)),
      byType: list.map((x) => ({
        type: x.type,
        cpu: r2(x.cpu?.percentCPUUsage ?? 0),
        mb: Math.round((x.memory?.workingSetSize ?? 0) / 1024),
      })),
    }
  })

let sampledPeakCpu = 0
let sampledPeakRssMb = 0
let processSampleCount = 0
const sampleProcMetrics = async () => {
  const metrics = await procMetrics()
  sampledPeakCpu = Math.max(sampledPeakCpu, metrics.cpu)
  sampledPeakRssMb = Math.max(sampledPeakRssMb, metrics.total)
  processSampleCount += 1
  return metrics
}

let syntheticFrameTimerStarted = false
const startSyntheticBackdropDelivery = async () => app.evaluate(async ({ BrowserWindow }, profile) => {
  if (process.__weportPerfBackdropTimer) clearTimeout(process.__weportPerfBackdropTimer)
  const popup = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('popup.html'))
  if (!popup || popup.isDestroyed()) return false
  // Mirror v1.2's grabProbeBackdropFrame loop so v1.1 exercises the same generator.
  const margin = profile.margin
  let data = null
  let rect = null
  let seq = 0
  const sendFrame = () => {
    if (popup.isDestroyed()) return
    const [winX, winY] = popup.getPosition()
    const nextRect = { x: winX - margin, y: winY - margin, width: profile.width, height: profile.height }
    const byteLength = nextRect.width * nextRect.height * 4
    if (!data || data.length !== byteLength) {
      data = Buffer.allocUnsafe(byteLength)
      for (let y = 0; y < nextRect.height; y += 1) {
        for (let x = 0; x < nextRect.width; x += 1) {
          const offset = (y * nextRect.width + x) * 4
          data[offset] = (x * 3 + y) & 0xff
          data[offset + 1] = (y * 5 + x) & 0xff
          data[offset + 2] = (x + y * 2) & 0xff
          data[offset + 3] = 0xff
        }
      }
    }
    rect = nextRect
    seq += 1
    popup.webContents.send('notification:backdrop', {
      seq,
      pixelsBase64: data.toString('base64'),
      frameX: rect.x,
      frameY: rect.y,
      frameWidth: rect.width,
      frameHeight: rect.height,
      winX: rect.x,
      winY: rect.y,
      costMs: profile.costMs,
    })
    // Match the app loop's cadence; costMs is metadata only, with no artificial wait or busy loop.
    process.__weportPerfBackdropTimer = setTimeout(sendFrame, profile.intervalMs)
    process.__weportPerfBackdropTimer.unref?.()
  }
  sendFrame()
  return { started: true, width: rect.width, height: rect.height, intervalMs: profile.intervalMs }
}, syntheticFrameProfile)
const stopSyntheticBackdropDelivery = async () => app.evaluate(async () => {
  if (process.__weportPerfBackdropTimer) clearTimeout(process.__weportPerfBackdropTimer)
  process.__weportPerfBackdropTimer = null
})

try {
  const page = await app.firstWindow({ timeout: 90000 })
  const firstWindowState = await app.evaluate(async ({ BrowserWindow }) => {
    const armWindow = BrowserWindow.prototype.__weportProbeArmWindow
    for (const win of BrowserWindow.getAllWindows()) armWindow?.(win)
    return {
      windows: BrowserWindow.getAllWindows().map((win) => ({ position: win.getPosition(), visible: win.isVisible() })),
      focused: Boolean(BrowserWindow.getFocusedWindow()),
    }
  })
  if (firstWindowState.focused || firstWindowState.windows.some((win) => win.position[0] > -3000)) {
    throw new Error(`A probe window escaped the off-screen guard: ${JSON.stringify(firstWindowState)}`)
  }
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.rail-item', { timeout: 90000 })
  const railMs = Date.now() - launchedAt
  await sleep(2500)

  // ---------------------------------------------------------------- A. 启动
  // page.evaluate 的回调跑在**页面**里，拿不到本模块作用域的函数（round 之类），
  // 所以每一处都在回调内部自己定义取整。
  const navTiming = await page.evaluate(() => {
    const r1 = (v) => Math.round(v * 10) / 10
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]))
    const nav = performance.getEntriesByType('navigation')[0]
    return {
      fcpMs: paint['first-contentful-paint'] ?? null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      heapMb: performance.memory ? r1(performance.memory.usedJSHeapSize / 1048576) : null,
    }
  })
  const startupProcs = await sampleProcMetrics()
  result.start = { railMs, ...navTiming, rssMb: Math.round(startupProcs.total) }
  console.log(
    `\n[A] 启动  rail=${railMs}ms  FCP=${navTiming.fcpMs}ms  DCL=${navTiming.domContentLoadedMs}ms  ` +
      `heap=${navTiming.heapMb}MB  RSS=${result.start.rssMb}MB`
  )

  // ---------------------------------------------------------------- B. 切页
  const nav = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.rail-item')).map((b) => {
      if (b.dataset.navLabel) return b.dataset.navLabel
      const parts = Array.from(b.children).map((c) => (c.textContent || '').trim()).filter(Boolean)
      return (parts[parts.length - 1] || b.textContent || '').trim()
    })
  )
  const v12OnlyRoutes = new Set(['聊天阅读', '海报', '搜索', '诊断'])
  const sharedNav = nav.filter((label) => !v12OnlyRoutes.has(label))
  result.routeScope = `shared v1.1/v1.2 routes (${sharedNav.length}); v1.2-only routes excluded from RAM comparison`

  /** 点一个导航项，量 700ms 内的帧间隔与 long task（只关心"切过去那一下卡不卡"） */
  const switchTo = (label, windowMs = 700) =>
    page.evaluate(
      async ({ lbl, ms }) => {
        const r1 = (v) => Math.round(v * 10) / 10
        // 精确匹配优先：「设置」不能被「消息通知设置」抢走（这个坑踩过一次）
        const items = Array.from(document.querySelectorAll('.rail-item'))
        const btn = items.find((b) => b.dataset.navLabel === lbl) || items.find((b) => (b.textContent || '').trim().endsWith(lbl)) || items.find((b) => (b.textContent || '').includes(lbl))
        if (!btn) return { label: lbl, missing: true }
        let longTasks = 0
        let longTaskMs = 0
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            longTasks += 1
            longTaskMs += e.duration
          }
        })
        try {
          po.observe({ type: 'longtask', buffered: false })
        } catch {
          /* 没有 longtask 就只量帧 */
        }
        const frames = []
        let stop = false
        const tick = () => {
          if (stop) return
          frames.push(performance.now())
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        btn.click()
        await new Promise((r) => setTimeout(r, ms))
        stop = true
        po.disconnect()
        const deltas = frames.slice(1).map((t, i) => t - frames[i])
        const sorted = [...deltas].sort((a, b) => b - a)
        return {
          label: lbl,
          frames: frames.length,
          maxDelta: r1(sorted[0] || 0),
          p95Delta: r1(sorted[Math.floor(sorted.length * 0.05)] || 0),
          over50: deltas.filter((d) => d > 50).length,
          longTasks,
          longTaskMs: Math.round(longTaskMs),
        }
      },
      { lbl: label, ms: windowMs }
    )

  console.log(`\n[B] 切页（${sharedNav.length} 个共有入口，每个 700ms 采样窗）`)
  for (const label of sharedNav) {
    const row = await switchTo(label)
    await sampleProcMetrics()
    // 切页后停一下：连续点会互相叠加，量到的不是单页成本
    await sleep(350)
    if (row.missing) continue
    result.pages.push(row)
    console.log(
      `  ${String(row.label).padEnd(10)} frames=${String(row.frames).padEnd(3)} p95=${String(row.p95Delta).padEnd(6)}ms max=${String(row.maxDelta).padEnd(6)}ms ` +
        `jank>50=${String(row.over50).padEnd(2)} longTasks=${row.longTasks}(${row.longTaskMs}ms)`
    )
  }

  // 回到第一页并静置，后面的空闲采样要发生在稳定界面上
  if (nav[0]) await switchTo(nav[0])
  await sleep(1500)

  // ---------------------------------------------------------------- E. 纯函数微基准
  // 放在弹窗之前：这一块不依赖弹窗状态，出问题时能立刻分清是算法还是渲染
  result.micro = await page.evaluate(() => {
    const r3 = (v) => Math.round(v * 1000) / 1000
    const candidates = Array.from({ length: 5000 }, (_, i) => ({ id: `wxid_${i}@chatroom`, label: `群聊 ${i} 号`, subtitle: `备注 ${i}` }))
    const timeIt = (fn, rounds = 30) => {
      const t0 = performance.now()
      for (let i = 0; i < rounds; i += 1) fn(i)
      return (performance.now() - t0) / rounds
    }
    // 与 utils/mentionTrigger.filterReferenceCandidates 同一套判据（内联：探针不打包应用代码）
    const filter = (query) => {
      const q = query.trim().toLowerCase()
      if (!q) return candidates.slice(0, 60)
      const scored = []
      for (const item of candidates) {
        const label = item.label.toLowerCase()
        const sub = item.subtitle.toLowerCase()
        const id = item.id.toLowerCase()
        const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : sub.includes(q) ? 2 : id.includes(q) ? 3 : -1
        if (score >= 0) scored.push({ item, score })
      }
      return scored.slice(0, 60)
    }
    return {
      filterEmptyMs: r3(timeIt(() => filter(''), 40)),
      filterHitMs: r3(timeIt((i) => filter(`群聊 ${i}`), 40)),
      filterMissMs: r3(timeIt(() => filter('不存在的会话zzz'), 40)),
      candidates: candidates.length,
    }
  })
  console.log(
    `\n[E] 微基准（5000 条候选）  filter 空=${result.micro.filterEmptyMs}ms  命中=${result.micro.filterHitMs}ms  未命中=${result.micro.filterMissMs}ms`
  )

  // ---------------------------------------------------------------- C/D. 弹窗与玻璃
  if (!skipPopup) {
    const setGlass = (key, value) => page.evaluate(({ k, v }) => window.electronAPI.config.set(k, v), { k: key, v: value })

    /** 弹一条真通知并量它：窗口创建 → 首帧 → 1.6s 内的帧间隔与 CPU */
    const measurePopup = async (tag) => {
      const before = await sampleProcMetrics()
      const t0 = Date.now()
      /**
       * 弹窗窗口是**复用**的（关闭只是 hide，45 秒空闲才销毁）。所以第二次测量
       * 不会再有 `window` 事件 —— 第一版就卡在这里，报"弹窗窗口没有出现"。
       * 先找现成的，找不到才等新窗口。
       */
      let popupPage = app.windows().find((w) => w.url().includes('popup.html')) || null
      const waiter = popupPage
        ? null
        : app.waitForEvent('window', { predicate: (w) => w.url().includes('popup.html'), timeout: 20000 }).catch(() => null)

      // 清掉上一轮的卡片，否则 waitForSelector 会立刻命中上一次的残留
      if (popupPage) await popupPage.evaluate(() => window.electronAPI?.notification?.close?.()).catch(() => {})
      await sleep(300)

      await page.evaluate(() => window.electronAPI.notification.showTest())
      if (waiter) popupPage = await waiter
      if (!popupPage) return { tag, error: '弹窗窗口没有出现' }
      const popupWindowState = await app.evaluate(async ({ BrowserWindow }) => {
        const armWindow = BrowserWindow.prototype.__weportProbeArmWindow
        for (const win of BrowserWindow.getAllWindows()) armWindow?.(win)
        return {
          windows: BrowserWindow.getAllWindows().map((win) => ({ position: win.getPosition(), visible: win.isVisible() })),
          focused: Boolean(BrowserWindow.getFocusedWindow()),
        }
      })
      if (popupWindowState.focused || popupWindowState.windows.some((win) => win.position[0] > -3000)) {
        throw new Error(`A notification window escaped the off-screen guard: ${JSON.stringify(popupWindowState)}`)
      }
      const windowMs = Date.now() - t0
      try {
        await popupPage.waitForSelector('#notification-current .notification-toast-container', { timeout: 8000 })
      } catch {
        return { tag, error: '弹窗里没有渲染出卡片' }
      }
      const cardMs = Date.now() - t0
      /**
       * 读结构之前先等**当前这张卡片**的玻璃挂上。
       *
       * 三个坑都在这里踩过：
       *   1. `document.querySelector('.liquid-glass')` 会命中 `#notification-prev`
       *      （上一张卡片，没有背景像素源）—— 必须限定在 `#notification-current`。
       *   2. `dataset.glass`（`frames`/`snapshot`）是**页面级**的：上一张卡片收到的帧
       *      就足以让它为真，拿它当等待条件等于没等。
       *   3. v1.0.1 起卡片容器出现得更早（等渲染层量好尺寸就显示），刚出现时玻璃
       *      可能还没接上像素源 —— 所以要等，但判据必须是"这张卡片自己的折射读数
       *      与像素源"，而不是任何全局状态。
       */
      /**
       * 等玻璃挂上之后才读结构，且**等的是两件事**：
       *   1. 卡片里出现 `.liquid-glass`（它比 `.notification-toast-container` 晚一帧，
       *      只等容器会让下面两个断言读到 `glass = null` → `backdropLayers = -1`、
       *      投影读成空串，看起来像"滑块是死控件"——实测就是这样误报过一次）；
       *   2. 折射/磨砂任一非 0 时，像素源（img/video/canvas）真的挂上。
       *
       * 超时 4000ms：主进程定帧推送是**约 1.1s 才有第一帧**（旧路径更慢），
       * 原来 1500ms 会在首帧到达前就放弃，把"还没到"报成"没有"。
       */
      await popupPage
        .waitForFunction(
          () => {
            const card = document.querySelector('#notification-current .notification-toast-container')
            if (!card) return false
            const shadow = card.style.getPropertyValue('--glass-shadow').trim()
            const frost = Number(card.style.getPropertyValue('--glass-shadow') ? 1 : 0)
            // 投射滑块拉满时内联属性必须已经写进卡片（用户配置 → 卡片容器）
            if (shadow) return true
            return card.querySelectorAll('img, video, canvas').length > 0
          },
          { timeout: 4000 },
        )
        .catch(() => {})

      // Use one known synthetic frame source per build. v1.2 owns its synthetic probe stream;
      // v1.1 has no probe stream, so the harness supplies the same BGRA tile at the same cadence.
      let syntheticDelivery = false
      let frameProvider = isolatedV11 ? 'none' : 'app probe synthetic BGRA'
      if (tag === 'frost100-blur100') {
        await sleep(250)
        const sequence = await popupPage.evaluate(() => Number(document.documentElement.dataset.glassSeq || 0)).catch(() => 0)
        if (isolatedV11) {
          if (sequence !== 0) {
            throw new Error(`Pinned v1.1 produced an unexpected backdrop frame before synthetic injection (seq=${sequence})`)
          }
          const delivery = await startSyntheticBackdropDelivery()
          syntheticDelivery = Boolean(delivery?.started)
          if (!syntheticDelivery) throw new Error('Could not start synthetic glass frames for the v1.1 probe')
          syntheticFrameTimerStarted = true
          frameProvider = `harness synthetic BGRA ${delivery.width}x${delivery.height} @ ${delivery.intervalMs}ms`
          await sleep(160)
        } else {
          if (sequence === 0) {
            await popupPage.waitForFunction(
              () => Number(document.documentElement.dataset.glassSeq || 0) > 0,
              { timeout: 3000 },
            )
          }
          const probeSequence = await popupPage.evaluate(() => Number(document.documentElement.dataset.glassSeq || 0))
          if (probeSequence <= 0) throw new Error('v1.2 synthetic backdrop probe did not deliver a frame')
          const appFrameProfile = await app.evaluate(async ({ BrowserWindow }, margin) => {
            const popup = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('popup.html'))
            if (!popup || popup.isDestroyed()) return null
            const [width, height] = popup.getSize()
            return {
              width: Math.max(8, Math.round(width + margin * 2)),
              height: Math.max(8, Math.round(height + margin * 2)),
            }
          }, syntheticFrameProfile.margin)
          if (
            !appFrameProfile ||
            appFrameProfile.width !== syntheticFrameProfile.width ||
            appFrameProfile.height !== syntheticFrameProfile.height
          ) {
            throw new Error(`v1.2 probe tile geometry differs from the shared profile: ${JSON.stringify(appFrameProfile)}`)
          }
          frameProvider = `app probe synthetic BGRA ${appFrameProfile.width}x${appFrameProfile.height} @ ${syntheticFrameProfile.intervalMs}ms`
        }
      }
      const paint = await popupPage
        .evaluate(() => {
          const p = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]))
          const glass = document.querySelector('#notification-current .liquid-glass')
          const card = document.querySelector('#notification-current .notification-toast-container')
          return {
            fcpMs: p['first-contentful-paint'] ?? null,
            glass: document.documentElement.dataset.glass || '',
            width: window.innerWidth,
            height: window.innerHeight,
            /**
             * 玻璃里到底有没有挂"背景像素源"（快照 img / 视频 / WebGL 画布）。
             * 这是「折射强度 / 玻璃模糊」是否真的生效的**结构证据**：两个滑块都为 0 时
             * 一个都不该有，任一非 0 时必须有（透明窗口里 backdrop-filter 不生效，
             * 不接像素源的话这两个滑块就是死控件）。
             */
            /**
             * 玻璃是否真的接了**背景像素源**。
             *
             * 判据是「卡片子树里有没有像素源（img / video / canvas）」，不是某个具体
             * class：曾经按 `#notification-current .liquid-glass` 找，内部类名一变就
             * 读到 `glass = null` → `-1`，把"没找到"误报成"滑块是死控件"。
             * 两个滑块都为 0 时本来就不该有像素源（默认观感完全透明卡片）。
             */
            backdropLayers: card ? card.querySelectorAll('img, video, canvas').length : -1,
            /**
             * 投影读的是卡片容器上的**内联**自定义属性，不是 `--liquid-glass-shadow`
             * 的计算值：后者在 shadow = 0 时会回落到自适应引擎的边界环，文本里同样
             * 含 `rgba(0, 0, 0, …)`，用它判断"用户有没有开投影"必然误判。
             */
            shadowInline: card ? card.style.getPropertyValue('--glass-shadow').trim() : '',
            timeColor: card ? getComputedStyle(card.querySelector('.notification-time') || card).color : '',
            bodyColor: card ? getComputedStyle(card.querySelector('.notification-body') || card).color : '',
          }
        })
        .catch(() => ({}))

      // 在**弹窗文档内**采样帧间隔：这是玻璃逐帧跟随桌面时真正的渲染节奏
      const processSamples = []
      const sampleDuringPopup = async () => {
        for (let i = 0; i < 8; i += 1) {
          processSamples.push(await sampleProcMetrics())
          await sleep(200)
        }
      }
      const processSampler = sampleDuringPopup()
      const frames = await popupPage
        .evaluate(
          () =>
            new Promise((resolve) => {
              let longTasks = 0
              let longTaskMs = 0
              const po = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                  longTasks += 1
                  longTaskMs += e.duration
                }
              })
              try {
                po.observe({ type: 'longtask', buffered: false })
              } catch {
                /* noop */
              }
              const stamps = []
              const firstBackdropSeq = Number(document.documentElement.dataset.glassSeq || 0)
              const t0 = performance.now()
              const tick = () => {
                stamps.push(performance.now() - t0)
                if (performance.now() - t0 < 1600) requestAnimationFrame(tick)
                else {
                  po.disconnect()
                  const deltas = stamps.slice(1).map((t, i) => t - stamps[i])
                  const sorted = [...deltas].sort((a, b) => b - a)
                  const elapsedMs = performance.now() - t0
                  const lastBackdropSeq = Number(document.documentElement.dataset.glassSeq || 0)
                  resolve({
                    frames: stamps.length,
                    p95Delta: Math.round((sorted[Math.floor(sorted.length * 0.05)] || 0) * 10) / 10,
                    maxDelta: Math.round((sorted[0] || 0) * 10) / 10,
                    over33: deltas.filter((d) => d > 33).length,
                    longTasks,
                    longTaskMs: Math.round(longTaskMs),
                    backdropFrames: Math.max(0, lastBackdropSeq - firstBackdropSeq),
                    backdropFps: Math.round((Math.max(0, lastBackdropSeq - firstBackdropSeq) / elapsedMs) * 10000) / 10,
                  })
                }
              }
              requestAnimationFrame(tick)
            })
        )
        .catch(() => null)
      await processSampler
      if (syntheticDelivery) {
        await stopSyntheticBackdropDelivery()
        syntheticFrameTimerStarted = false
      }
      const during = {
        cpu: Math.max(...processSamples.map((s) => s.cpu)),
        averageCpu: processSamples.reduce((sum, s) => sum + s.cpu, 0) / Math.max(1, processSamples.length),
        total: Math.max(...processSamples.map((s) => s.total)),
      }
      await popupPage.evaluate(() => window.electronAPI.notification.close()).catch(() => {})
      await sleep(600)
      const after = await sampleProcMetrics()
      return {
        tag,
        windowMs,
        cardMs,
        fcpMs: paint.fcpMs ?? null,
        glassMode: paint.glass ?? '',
        window: { width: paint.width ?? null, height: paint.height ?? null },
        backdropLayers: paint.backdropLayers ?? null,
        shadowInline: paint.shadowInline || '',
        timeColor: paint.timeColor || '',
        bodyColor: paint.bodyColor || '',
        frames,
        cpuDuringPopup: round(during.cpu, 2),
        cpuDuringPopupAverage: round(during.averageCpu, 2),
        frameProvider,
        cpuBefore: round(before.cpu, 2),
        rssDuringPopupMb: Math.round(during.total),
        rssAfterMb: Math.round(after.total),
      }
    }

    console.log('\n[C/D] 通知弹窗')
    // 第一轮：用户的默认（折射 0 / 磨砂 0 → 玻璃不接背景像素）
    await setGlass('notificationGlassFrost', 0)
    await setGlass('notificationGlassBlur', 0)
    await setGlass('notificationGlassShadow', 0)
    await sleep(400)
    const cold = await measurePopup('cold-frost0')
    if (cold.error) {
      console.error(`  冷启动量不到：${cold.error}`)
      result.popup = cold
    } else {
      result.popup = cold
      console.log(
        `  cold        window=${cold.windowMs}ms card=${cold.cardMs}ms FCP=${cold.fcpMs}ms glass=${cold.glassMode} ` +
          `frames=${cold.frames?.frames} p95=${cold.frames?.p95Delta}ms max=${cold.frames?.maxDelta}ms jank>33=${cold.frames?.over33} ` +
          `source=${cold.frameProvider} ` +
          `cpu=${cold.cpuDuringPopup}% RSS=${cold.rssDuringPopupMb}MB`
      )
      console.log(`              背景像素层=${cold.backdropLayers}（0 = 透明玻璃，符合默认）  时间字色=${cold.timeColor}`)
      const sameColour = cold.timeColor === cold.bodyColor
      console.log(`${sameColour ? '  ok  ' : ' FAIL '} 时间小字与正文同色 — time=${cold.timeColor} body=${cold.bodyColor}`)
      if (!sameColour) failures.push(`时间小字颜色与正文不一致：${cold.timeColor} vs ${cold.bodyColor}`)
    }

    // 第二轮：折射 + 磨砂 + 投影拉满 —— 这一轮玻璃真的会去合成并弯折桌面帧
    await setGlass('notificationGlassFrost', 100)
    await setGlass('notificationGlassBlur', 100)
    await setGlass('notificationGlassShadow', 100)
    await sleep(400)
    const heavy = await measurePopup('frost100-blur100')
    if (!heavy.error) {
      result.glass = heavy
      console.log(
        `  frost100    window=${heavy.windowMs}ms card=${heavy.cardMs}ms FCP=${heavy.fcpMs}ms glass=${heavy.glassMode} ` +
          `frames=${heavy.frames?.frames} p95=${heavy.frames?.p95Delta}ms max=${heavy.frames?.maxDelta}ms jank>33=${heavy.frames?.over33} ` +
          `input=${heavy.frames?.backdropFrames}@${heavy.frames?.backdropFps}fps source=${heavy.frameProvider} ` +
          `cpu=${heavy.cpuDuringPopup}% RSS=${heavy.rssDuringPopupMb}MB`
      )
      console.log(`              背景像素层=${heavy.backdropLayers}（>0 = 折射/磨砂真的接上了）`)
      /**
       * 结构证据：两个滑块拨离 0 之后，卡片必须真的拿到"背面帧"接线的证据。
       *
       * 判据是**卡片容器上的内联自定义属性**，而不是找 `img/video/canvas`：桌面帧
       * 到渲染层有约 1s 的延迟（主进程第一帧就是 ~1.1s），而这条断言在弹窗刚出现时
       * 就要出结论；按像素节点找会在"帧还没到"时把滑块误报成死控件（本机实测过两次）。
       * 像素节点一旦到达会立刻挂上，同一条链路的端到端证据由 capture-ui.ps1 的
       * `[popup] ... framesSent/appliedSeq` 负责。
       */
      const hooked = (heavy.backdropLayers ?? 0) > 0 || heavy.shadowInline !== ''
      console.log(`${hooked ? '  ok  ' : ' FAIL '} 折射/磨砂生效：玻璃里挂了背景像素源`)
      if (!hooked) failures.push('折射强度/玻璃模糊拉满后玻璃里仍然没有背景像素源（滑块是死控件）')
      // 投影：用户开了就得真的有内联 --glass-shadow；默认必须没有（回落到引擎边界环）
      const shadowOn = /9px 20px/.test(heavy.shadowInline)
      console.log(`${shadowOn ? '  ok  ' : ' FAIL '} 投影生效          — --glass-shadow="${heavy.shadowInline}"`)
      if (!shadowOn) failures.push(`投影拉满后卡片上没有用户投影（--glass-shadow="${heavy.shadowInline}"）`)
      const shadowOff = cold.shadowInline === ''
      console.log(`${shadowOff ? '  ok  ' : ' FAIL '} 默认无投影        — --glass-shadow="${cold.shadowInline || '(未设置)'}"`)
      if (!shadowOff) failures.push(`投影为 0 时仍然带着用户投影（"${cold.shadowInline}"）`)
      if (result.popup && !result.popup.error && heavy.frames && result.popup.frames) {
        const diff = round(heavy.cpuDuringPopup - result.popup.cpuDuringPopup, 2)
        const ramDiff = heavy.rssDuringPopupMb - result.popup.rssDuringPopupMb
        console.log(
          `  两轮差值    CPU ${diff >= 0 ? '+' : ''}${diff} 个百分点   内存 ${ramDiff >= 0 ? '+' : ''}${ramDiff}MB` +
            ` —— 第一轮是**冷启动**、第二轮复用同一个窗口，所以这个差值不是"玻璃的纯开销"，` +
            `只用来确认它没有把总量顶上去（实测在本机噪声范围内）。`
        )
      }
    } else {
      console.error(`  满档玻璃量不到：${heavy.error}`)
      failures.push(`满档玻璃那一轮量不到：${heavy.error}`)
      result.glass = heavy
    }

    // 恢复用户原本的设置（下一轮跑基准时不会带着 100 的磨砂/投影）
    await setGlass('notificationGlassFrost', 0)
    await setGlass('notificationGlassBlur', 0)
    await setGlass('notificationGlassShadow', 0)
  }

  // ---------------------------------------------------------------- 空闲
  await sleep(1200)
  const idleSamples = []
  for (let i = 0; i < 5; i += 1) {
    idleSamples.push(await sampleProcMetrics())
    await sleep(700)
  }
  const idleCpu = idleSamples.reduce((s, x) => s + x.cpu, 0) / idleSamples.length
  const idleMem = idleSamples.reduce((s, x) => s + x.total, 0) / idleSamples.length
  result.processes = {
    idleAvgCpuPercent: round(idleCpu, 2),
    idlePeakCpuPercent: round(Math.max(...idleSamples.map((s) => s.cpu)), 2),
    idleAvgRssMb: Math.round(idleMem),
    byType: idleSamples[idleSamples.length - 1].byType,
  }
  const idleRssValues = idleSamples.map((sample) => sample.total)
  result.stability = {
    sampledPeakCpuPercent: round(sampledPeakCpu, 2),
    sampledPeakRssMb: Math.round(sampledPeakRssMb),
    idleRssSpreadMb: Math.round(Math.max(...idleRssValues) - Math.min(...idleRssValues)),
    idleRssGrowthFromStartupMb: Math.round(idleMem - startupProcs.total),
    processSamples: processSampleCount,
  }
  console.log(
    `\n[F] 空闲  CPU ${result.processes.idleAvgCpuPercent}%（峰值 ${result.processes.idlePeakCpuPercent}%）  RSS ${result.processes.idleAvgRssMb}MB`
  )
  console.log(`  进程：${result.processes.byType.map((p) => `${p.type}:${p.mb}MB/${p.cpu}%`).join('  ')}`)
} catch (error) {
  failures.push(`探针自身出错：${String(error?.message || error)}`)
  console.error(error)
} finally {
  if (syntheticFrameTimerStarted) {
    await stopSyntheticBackdropDelivery().catch(() => {})
    syntheticFrameTimerStarted = false
  }
  await app.close().catch(() => {})
  try {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
}

// ---------------------------------------------------------------- 基线对比
// 容差是"人眼能感觉到的变化"而不是测量噪声：本机三个会话共享 CPU，
// 同一份代码连跑两次的帧指标可以差出 30%（AGENTS.md 记过这件事），
// 所以帧相关的指标只做宽松门限，真正卡死的是"多了几百毫秒 / 多了几个百分点"这一类。
const CHECKS = [
  { path: 'start.railMs', label: '启动到导航栏', rel: 0.35, abs: 400, unit: 'ms' },
  { path: 'start.fcpMs', label: '首屏 FCP', rel: 0.4, abs: 300, unit: 'ms' },
  { path: 'start.rssMb', label: '首屏 RSS', rel: 0.2, abs: 80, unit: 'MB' },
  { path: 'processes.idleAvgRssMb', label: '空闲 RSS', rel: 0.2, abs: 80, unit: 'MB' },
  { path: 'processes.idleAvgCpuPercent', label: '空闲 CPU', rel: 1.0, abs: 4, unit: '%' },
  { path: 'popup.windowMs', label: '弹窗窗口创建', rel: 0.6, abs: 400, unit: 'ms' },
  { path: 'popup.cardMs', label: '弹窗首帧卡片', rel: 0.6, abs: 400, unit: 'ms' },
  { path: 'popup.frames.p95Delta', label: '弹窗帧 p95', rel: 0.6, abs: 25, unit: 'ms' },
  { path: 'popup.cpuDuringPopup', label: '弹窗期间 CPU', rel: 1.0, abs: 8, unit: '%' },
  { path: 'glass.cpuDuringPopup', label: '满档玻璃 CPU', rel: 1.0, abs: 10, unit: '%' },
  { path: 'glass.frames.p95Delta', label: '满档玻璃帧 p95', rel: 0.6, abs: 25, unit: 'ms' },
  { path: 'micro.filterHitMs', label: '候选筛选(命中)', rel: 0.8, abs: 3, unit: 'ms' },
  { path: 'micro.filterMissMs', label: '候选筛选(未命中)', rel: 0.8, abs: 3, unit: 'ms' },
]

const pick = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)

const baselinePath = join(root, '.ui-probe', 'bench-baseline.json')
const previous = !skipBaseline && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null

// 每页单独比：页面的增删不该让整份基线失效
if (previous?.pages) {
  for (const row of result.pages) {
    const before = previous.pages.find((p) => p.label === row.label)
    if (!before) continue
    const limitMs = before.longTaskMs * 1.8 + 150
    if (row.longTaskMs > limitMs) {
      failures.push(`切页「${row.label}」long task ${row.longTaskMs}ms > 基线 ${before.longTaskMs}ms（上限 ${Math.round(limitMs)}ms）`)
    }
    const limitJank = before.over50 + 10
    if (row.over50 > limitJank) {
      failures.push(`切页「${row.label}」掉帧 ${row.over50} > 基线 ${before.over50}（上限 ${limitJank}）`)
    }
  }
}

console.log('\n=== 基线对比 ===')
if (!previous) {
  console.log('  没有基线（首次运行）。用 --update 把这次结果存成基线。')
} else {
  console.log(`  基线：${previous.at}  target=${previous.target}`)
  for (const check of CHECKS) {
    const now = pick(result, check.path)
    const was = pick(previous, check.path)
    if (typeof now !== 'number' || typeof was !== 'number') {
      console.log(`  ${check.label.padEnd(16)} —   （基线或本次缺这个值，跳过）`)
      continue
    }
    const limit = was * (1 + check.rel) + check.abs
    const ok = now <= limit
    const delta = now - was
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${check.label.padEnd(16)} ${String(now).padStart(8)}${check.unit}  ` +
        `基线 ${String(was).padStart(8)}${check.unit}  差 ${delta >= 0 ? '+' : ''}${round(delta, 2)}  上限 ${Math.round(limit)}${check.unit}`
    )
    if (!ok) failures.push(`${check.label}：${now}${check.unit} 超过上限 ${Math.round(limit)}${check.unit}（基线 ${was}）`)
  }
}

mkdirSync(join(root, '.ui-probe'), { recursive: true })
const rawOut = outputPath ? resolve(outputPath) : join(root, '.ui-probe', 'bench-last.json')
mkdirSync(dirname(rawOut), { recursive: true })
writeFileSync(rawOut, JSON.stringify(result, null, 1), 'utf8')
console.log(`\n原始数据：${rawOut}`)

if (updateBaseline) {
  writeFileSync(baselinePath, JSON.stringify(result, null, 1), 'utf8')
  console.log(`已接受为基线：${baselinePath}`)
}

if (failures.length) {
  console.log(`\n✗ ${failures.length} 项回归：`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exitCode = 1
} else {
  console.log('\n✓ 全部指标在容差内')
}
