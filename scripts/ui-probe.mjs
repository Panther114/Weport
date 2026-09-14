// 真实 UI 探针：用 Playwright 打开打包后的 Weport，在渲染进程里直接跑 DOM 查询。
//
// 为什么要有它：布局问题（浮层盖住输入框、进度条被遮挡、侧栏高度算错）在
// 截图里只能靠眼睛猜，而 `getBoundingClientRect` 能直接给出「谁压在谁上面」。
// 截图证明"看着不对"，几何证明"为什么不对"，两者都要。
//
// 用法：
//   node scripts/ui-probe.mjs --tab sns --audit
//   node scripts/ui-probe.mjs --tab antirecall --eval "document.title" --shot out.png
//
// 依赖 release/win-unpacked（scripts/make-dev-app-dir.ps1 生成的快速迭代目录），
// 否则回退到已安装版本。

import { _electron as electron } from 'playwright-core'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const opt = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = argv[i + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const devExe = join(root, 'release', 'win-unpacked', 'Weport.exe')
const installedExe = join(
  process.env.LOCALAPPDATA || 'C:\\Users\\admin\\AppData\\Local',
  'Programs',
  'Weport',
  'Weport.exe'
)
const exe = existsSync(devExe) ? devExe : installedExe

// 探针自己的 userData 目录：绝不碰用户真实配置，也绝不在探针里改用户数据。
const userDataDir = join(root, '.ui-probe', 'userData')

// 这些脚本会被序列化后送进渲染进程执行。它们必须是自包含的纯函数：
// 渲染进程拿不到 Node、拿不到模块，只有 DOM。
const AUDIT_SCRIPT = `(() => {
  const vw = window.innerWidth
  const vh = window.innerHeight

  const describe = (el) => {
    if (!el || !el.tagName) return '?'
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''
    const id = el.id ? '#' + el.id : ''
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
    return el.tagName.toLowerCase() + id + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '')
  }

  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }

  // 1. 溢出视口：元素被推到可视区之外（含负坐标 —— 这是"跑到屏幕外面"的典型信号）
  const outOfViewport = []
  // 2. 滚动容器内的裁剪：父级 overflow 切掉了子元素
  const clipped = []
  // 3. 覆盖：同一位置上存在 z 序更高的元素压住了可交互元素
  const covered = []

  const all = Array.from(document.querySelectorAll('body *'))

  for (const el of all) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue

    const interactive =
      el.matches('button, input, select, textarea, a[href], [role="button"], [role="tab"], label, .chip') ||
      el.matches('[class*="progress"], [class*="bar"]')

    if (interactive) {
      if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
        // 允许"本来就在滚动容器里、还没滚到"的元素：只看它是否在某个滚动祖先内。
        let inScroller = false
        for (let p = el.parentElement; p; p = p.parentElement) {
          const ps = getComputedStyle(p)
          if (ps.overflowY === 'auto' || ps.overflowY === 'scroll' || ps.overflow === 'auto' || ps.overflow === 'scroll') {
            const pr = p.getBoundingClientRect()
            if (pr.width > 0 && pr.height > 0) { inScroller = true; break }
          }
        }
        if (!inScroller) outOfViewport.push({ el: describe(el), rect: rectOf(el) })
      }

      // 中心点被谁挡住了？
      const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 2)
      const cy = Math.min(Math.max(r.top + r.height / 2, 1), vh - 2)
      if (r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh) {
        const hit = document.elementFromPoint(cx, cy)
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          covered.push({ el: describe(el), by: describe(hit), rect: rectOf(el) })
        }
      }
    }

    // 裁剪检测：元素的矩形超出最近溢出祖先的 padding box。
    // 只算"有字可读"的元素 —— 纯装饰元素被裁掉不算缺陷，文字被裁掉才算。
    if ((el.textContent || '').trim().length > 0 && r.height > 4) {
      let p = el.parentElement
      while (p) {
        const ps = getComputedStyle(p)
        const overflowing =
          ps.overflow !== 'visible' || ps.overflowX !== 'visible' || ps.overflowY !== 'visible'
        if (overflowing) {
          const pr = p.getBoundingClientRect()
          if (pr.width > 0 && pr.height > 0) {
            const exceed = {
              top: Math.round(pr.top - r.top),
              bottom: Math.round(r.bottom - pr.bottom),
              left: Math.round(pr.left - r.left),
              right: Math.round(r.right - pr.right)
            }
            if (exceed.top > 2 || exceed.bottom > 2 || exceed.left > 2 || exceed.right > 2) {
              clipped.push({ el: describe(el), ancestor: describe(p), exceed })
            }
          }
          break
        }
        p = p.parentElement
      }
    }
  }

  return {
    viewport: { vw, vh },
    doc: {
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      canScrollX: document.documentElement.scrollWidth > vw + 1,
      canScrollY: document.documentElement.scrollHeight > vh + 1
    },
    counts: { outOfViewport: outOfViewport.length, covered: covered.length, clipped: clipped.length },
    outOfViewport: outOfViewport.slice(0, 25),
    covered: covered.slice(0, 25),
    clipped: clipped.slice(0, 25)
  }
})()`

// 帧率探针：视频背景卡顿是"看着卡"的问题，必须量出来而不是感觉。
// rAF 间隔给出掉帧分布，`getVideoPlaybackQuality()` 给出真实丢帧数。
//
// 【注意】这个字符串里**不能再出现反引号**。它本身是一个模板字面量，内层再写
// 一个 `${…}` 会提前闭合外层，后面的整段代码变成被丢掉的文本，page.evaluate
// 拿到半截脚本后静默返回 undefined（实测踩过一次，排查花了很久）。
// 需要拼字符串就用数组 join。时长则直接插值进来，不走 evaluate 的第二个参数。
const fpsScript = (durationMs) => `(async () => {
  const durationMs = ${Number(durationMs)}
  const frames = []
  let last = performance.now()
  const done = new Promise((resolve) => {
    const start = last
    const tick = (now) => {
      frames.push(now - last)
      last = now
      if (now - start >= durationMs) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await done
  frames.shift()
  const sorted = [...frames].sort((a, b) => a - b)
  const pct = (p) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10 : 0
  const video = document.querySelector('.app-bg video')
  let quality = null
  if (video && typeof video.getVideoPlaybackQuality === 'function') {
    const q = video.getVideoPlaybackQuality()
    quality = {
      dropped: q.droppedVideoFrames,
      total: q.totalVideoFrames,
      dropRate: q.totalVideoFrames ? Math.round((q.droppedVideoFrames / q.totalVideoFrames) * 1000) / 10 : 0
    }
  }
  return {
    frames: frames.length,
    avgMs: Math.round((frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length)) * 10) / 10,
    medianMs: pct(0.5),
    p95Ms: pct(0.95),
    worstMs: Math.round(Math.max(0, ...frames) * 10) / 10,
    over33ms: frames.filter((f) => f > 33).length,
    over50ms: frames.filter((f) => f > 50).length,
    video: video ? {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      clientWidth: video.clientWidth,
      clientHeight: video.clientHeight,
      paused: video.paused,
      readyState: video.readyState
    } : null,
    quality: quality
  }
})()`

const waitLongScript = (ms) => `(async () => { await new Promise(r => setTimeout(r, ${ms})); return 'waited' })()`

const DIALOG_SCRIPT = `(() => {  const vw = window.innerWidth
  const vh = window.innerHeight
  const describe = (el) => {
    if (!el || !el.tagName) return '?'
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60)
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '')
  }
  const nodes = Array.from(document.querySelectorAll(
    '.modal, .modal-backdrop, [role="dialog"], [role="menu"], [class*="popover"], [class*="dropdown"], [class*="popup"], [class*="modal"]'
  )).filter((el) => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    return r.width > 4 && r.height > 4
  })
  return nodes.map((el) => {
    const r = el.getBoundingClientRect()
    return {
      el: describe(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      position: getComputedStyle(el).position,
      centered: Math.abs((r.left + r.right) / 2 - vw / 2) < 8,
      inViewport: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1
    }
  })
})()`

async function main() {
  if (!existsSync(exe)) throw new Error(`Weport.exe not found: ${exe}`)

  const env = {
    ...process.env,
    WEPORT_UI_PROBE: '1',
    // 探针会移动/点击，别让主进程的托盘或弹窗逻辑干扰。
    WEPORT_DISCARD_DELAY_MS: '600000'
  }
  delete env.WEPORT_SCREENSHOT_POPUP
  delete env.WEPORT_V09_DUMP

  const app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${userDataDir}`],
    cwd: root,
    env
  })

  const results = []
  const log = (line) => {
    results.push(line)
    console.log(line)
  }

  try {
    const page = await app.firstWindow({ timeout: 30000 })
    await page.waitForLoadState('domcontentloaded')
    // 首屏要等 React 挂载 + 首轮 IPC 回来
    await page.waitForSelector('.rail-item', { timeout: 30000 })
    await page.waitForTimeout(Number(opt('settle', 2500)))

    log(`# window: ${await page.title()}  exe=${exe}`)

    const tab = opt('tab')
    if (tab && tab !== true) {
      const clicked = await page.evaluate((label) => {
        const btn = Array.from(document.querySelectorAll('.rail-item')).find((b) =>
          (b.textContent || '').includes(label)
        )
        if (!btn) return { ok: false, labels: Array.from(document.querySelectorAll('.rail-item')).map((b) => (b.textContent || '').trim()) }
        if (btn.disabled) return { ok: false, reason: 'disabled', label: (btn.textContent || '').trim() }
        btn.click()
        return { ok: true, label: (btn.textContent || '').trim() }
      }, String(tab))
      log(`# tab click: ${JSON.stringify(clicked)}`)
      await page.waitForTimeout(Number(opt('settle', 2500)))
    }

    const steps = opt('steps')
    if (steps && steps !== true) {
      // 用 `;;` 分隔步骤，不是 `;` —— eval 的表达式里到处是分号，用单分号切
      // 会把表达式拦腰截断。这里只认双分号，脚本自己控制转义。
      for (const raw of String(steps).split(';;')) {
        const step = raw.trim()
        if (!step) continue
        if (step.startsWith('click:')) {
          const sel = step.slice(6)
          const out = await page.evaluate((s) => {
            const el = document.querySelector(s)
            if (!el) return 'not-found'
            el.click()
            return 'clicked'
          }, sel)
          log(`# step click ${sel}: ${out}`)
          await page.waitForTimeout(700)
        } else if (step.startsWith('clicktext:')) {
          // 形如 clicktext:.selector::要匹配的文字 —— 用文字定位是因为很多按钮
          // 没有稳定的 class，只有标签文字。
          const [sel, text] = step.slice(10).split('::')
          const out = await page.evaluate(
            ({ s, t }) => {
              const nodes = Array.from(document.querySelectorAll(s)).filter((el) => {
                const style = getComputedStyle(el)
                if (style.display === 'none' || style.visibility === 'hidden') return false
                return (el.textContent || '').includes(t)
              })
              const el = nodes[0]
              if (!el) {
                return {
                  ok: false,
                  seen: Array.from(document.querySelectorAll(s)).map((e) => (e.textContent || '').trim().slice(0, 20)).slice(0, 12)
                }
              }
              el.click()
              return { ok: true, hit: (el.textContent || '').trim().slice(0, 30) }
            },
            { s: sel, t: text }
          )
          log(`# step clicktext ${sel} "${text}": ${JSON.stringify(out)}`)
          await page.waitForTimeout(900)
        } else if (step.startsWith('wait:')) {
          await page.waitForTimeout(Number(step.slice(5)) || 500)
        } else if (step.startsWith('evalout:')) {
          const out = await page.evaluate(step.slice(8))
          log(`# step eval: ${JSON.stringify(out)}`)
        }
      }
    }

    if (opt('dialogs')) {
      const dialogs = await page.evaluate(DIALOG_SCRIPT)
      log(`# dialogs (${dialogs.length}):`)
      for (const d of dialogs) log(`  ${JSON.stringify(d)}`)
    }

    if (opt('audit')) {
      const audit = await page.evaluate(AUDIT_SCRIPT)
      log(`# audit viewport=${audit.viewport.vw}x${audit.viewport.vh} counts=${JSON.stringify(audit.counts)}`)
      log(`# doc=${JSON.stringify(audit.doc)}`)
      for (const [kind, rows] of [
        ['OUT-OF-VIEWPORT', audit.outOfViewport],
        ['COVERED', audit.covered],
        ['CLIPPED', audit.clipped]
      ]) {
        if (!rows.length) continue
        log(`# ${kind} (${rows.length}):`)
        for (const row of rows) log(`  ${JSON.stringify(row)}`)
      }
    }

    const fps = opt('fps')
    if (fps && fps !== true) {
      const ms = Number(fps) || 4000
      await page.evaluate(fpsScript(ms)).then((out) => log(`# fps(${ms}ms): ${JSON.stringify(out)}`))
    }

    const evalExpr = opt('eval')
    if (evalExpr && evalExpr !== true) {
      const out = await page.evaluate(String(evalExpr))
      log(`# eval: ${JSON.stringify(out, null, 2)}`)
    }

    const shot = opt('shot')
    if (shot && shot !== true) {
      const path = resolve(root, String(shot))
      await mkdir(dirname(path), { recursive: true })
      await page.screenshot({ path, fullPage: Boolean(opt('full')) })
      log(`# shot: ${path}`)
    }

    const html = opt('html')
    if (html && html !== true) {
      const path = resolve(root, String(html))
      await mkdir(dirname(path), { recursive: true })
      const sel = html === true ? 'body' : String(html)
      const markup = await page.evaluate((s) => {
        const el = document.querySelector(s)
        return el ? el.outerHTML : null
      }, sel)
      await writeFile(path, markup ?? `<!-- no element: ${sel} -->`, 'utf8')
      log(`# html: ${path}`)
    }

    const out = opt('out')
    if (out && out !== true) {
      const path = resolve(root, String(out))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, results.join('\n'), 'utf8')
      console.log(`# wrote ${path}`)
    }
  } finally {
    await app.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
