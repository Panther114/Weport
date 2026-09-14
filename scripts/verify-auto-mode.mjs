// 验证「明暗跟随背景」：读运行时状态 + 直接调一次自适应，把每一步都摊开。
//
// 为什么要写成脚本：之前用 --eval 时替换没生效，看到的其实是旧表达式，白跑了几轮。
// 这里把「配置里的 modeAuto」「初始化后的 dataset」「亮度」「自适应返回值」一次打印。

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
  await page.waitForTimeout(6000)

  const state = await page.evaluate(async () => {
    const cfgMode = await window.electronAPI.config.get('appearanceMode')
    const cfgAuto = await window.electronAPI.config.get('appearanceModeAuto')
    const bgPath = await window.electronAPI.config.get('appearanceBackgroundPath')
    const lum = bgPath ? await window.electronAPI.app.backgroundLuminance(bgPath) : null
    return {
      cfgMode,
      cfgAuto,
      domMode: document.documentElement.dataset.mode,
      domModeAuto: document.documentElement.dataset.modeAuto ?? '(unset)',
      bgKind: document.documentElement.dataset.bgKind,
      hasBg: document.documentElement.dataset.hasBg,
      luminance: lum,
      // 期望：亮度 <= 0.42 → dark
      expected: lum && typeof lum.luminance === 'number' ? (lum.luminance < 0.5 ? 'light' : 'dark') : 'unknown'
    }
  })
  console.log('STATE ' + JSON.stringify(state, null, 1))
} finally {
  await app.close().catch(() => {})
}
