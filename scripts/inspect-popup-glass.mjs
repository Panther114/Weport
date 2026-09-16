// 检查通知弹窗的实际计算样式：纱层浓度、文字 scrim、以及自适应是否真的在改值。
//
// 为什么要单独看：截图只能看出"白"，看不出是**哪一层**白，也看不出自适应引擎
// 有没有在动（没动的话截图看起来一样）。这里直接把 computed style 与 --noti-*
// 变量打出来，并且连续采样几次，用"值有没有变化"判断动态是否生效。
//
// 用法：node scripts/inspect-popup-glass.mjs [samples]

import { _electron as electron } from 'playwright-core'

const root = process.cwd()
const exe = `${root}\\release\\win-unpacked\\Weport.exe`
const samples = Number(process.argv[2] || 3)

const app = await electron.launch({
  executablePath: exe,
  args: [`--user-data-dir=${root}\\.ui-probe\\userData`],
  cwd: root,
  // 复用截图模式的弹窗路径：那条路径会把通知真的弹出来（并临时关掉内容保护），
  // 不用自己去调主进程内部函数（主进程是 ESM，app.evaluate 里拿不到 require，
  // 动态 import 也会因为没有 import 回调而失败）。
  env: { ...process.env, WEPORT_SCREENSHOT_POPUP: '1', WEPORT_SCREENSHOT_OUT: `${process.env.TEMP}\\weport-glass-inspect` }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readPopup = (w) =>
  w.evaluate(() => {
    const rs = getComputedStyle(document.documentElement)
    const toast = document.querySelector('.notification-toast-container')
    const glass = document.querySelector('.liquid-glass')
    const text = document.querySelector('.notification-text')
    const before = text ? getComputedStyle(text, '::before') : null
    return {
      glassMode: document.documentElement.dataset.glass,
      tint: rs.getPropertyValue('--noti-tint').trim(),
      baseTint: toast ? getComputedStyle(toast).getPropertyValue('--liquid-glass-tint').trim() : null,
      titleColor: rs.getPropertyValue('--noti-title-color').trim(),
      bodyColor: rs.getPropertyValue('--noti-body-color').trim(),
      textScrim: rs.getPropertyValue('--noti-text-scrim').trim(),
      scrimStrong: rs.getPropertyValue('--noti-text-scrim-strong').trim(),
      scrimBg: before ? before.backgroundImage.slice(0, 90) : null,
      // 各层的实际底色：用来定位"白"到底来自哪一层
      layers: glass
        ? Array.from(glass.children).map((c) => {
            const s = getComputedStyle(c)
            return `${c.tagName}:${s.backgroundColor}|${s.backgroundImage.slice(0, 34)}`
          })
        : null
    }
  })

try {
  const main = await app.firstWindow({ timeout: 40000 })
  await main.waitForSelector('.rail-item', { timeout: 40000 })
  await sleep(3500)

  // 截图模式下弹窗由主进程自己弹（demo 数据）。注意 `firstWindow()` 返回的是
  // **主窗口**；弹窗是另一个 BrowserWindow，用 `windows()` 按 URL 找。
  // 找不到时把全部窗口列出来 —— 静默返回 null 会让脚本看起来"弹窗没起来"。
  const dumpWindows = () => app.windows().map((w) => `${w.url().slice(0, 70)}`).join(' | ')
  let popup = null
  for (let i = 0; i < 40 && !popup; i += 1) {
    await sleep(500)
    popup = app.windows().find((w) => w.url().includes('popup')) || null
  }
  if (!popup) {
    console.log('NO POPUP WINDOW. windows=' + dumpWindows())
  } else {
    console.log('POPUP URL ' + popup.url().slice(0, 80))
    for (let i = 0; i < samples; i += 1) {
      await sleep(i === 0 ? 1200 : 2500)
      const snap = await readPopup(popup)
      console.log(`SAMPLE[${i}] ` + JSON.stringify(snap))
    }
  }
} finally {
  await app.close().catch(() => {})
}
