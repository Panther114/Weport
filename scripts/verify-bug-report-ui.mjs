// Offscreen packaged integration check. Dialog, clipboard and browser writes
// are intercepted in this private process; no GitHub issue is submitted.
import { _electron } from 'playwright-core'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const out = resolve(process.argv[2] || '.ui-probe/bug-report-ui')
mkdirSync(out, { recursive: true })
const fixtureImage = join(out, 'example-screenshot.png')
copyFileSync(resolve('assets/icons/icon.png'), fixtureImage)
const profile = mkdtempSync(join(tmpdir(), 'weport-bug-report-ui-'))
const app = await _electron.launch({ executablePath: process.argv.includes('--installed')
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Weport', 'Weport.exe')
  : resolve('release/win-unpacked/Weport.exe'),
  args: ['--background', `--user-data-dir=${profile}`],
  env: { ...process.env, WEPORT_UI_DEMO: '1', WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' } })
const errors = []
try {
  await app.evaluate(async ({ app, BrowserWindow, dialog, clipboard, shell }, imagePath) => {
    await app.whenReady()
    while (!app.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    globalThis.__bugReportQa = { urls: [], texts: [], images: [] }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imagePath] })
    shell.openExternal = async url => { globalThis.__bugReportQa.urls.push(url) }
    clipboard.writeText = text => { globalThis.__bugReportQa.texts.push(text) }
    clipboard.writeImage = image => { globalThis.__bugReportQa.images.push(image.getSize()) }
    app.emit('activate')
  }, fixtureImage)
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.rail-item[data-tab="settings"]').click()
  await page.getByRole('button', { name: /问题反馈/ }).click()
  await page.locator('#bug-report-title-input').fill('导出问题反馈示例')
  const body = '复现步骤：选择 JSON 格式，导出一个会话。\n预期：文件包含所选消息。\n实际：请在这里描述遇到的问题。'
  await page.locator('#bug-report-body-input').fill(body)
  await page.getByRole('button', { name: '选择图片', exact: true }).click()
  await page.locator('.bug-report-image-list img').waitFor()
  await page.getByRole('button', { name: '复制图片', exact: true }).click()
  await page.getByRole('button', { name: '打开 GitHub 新建问题', exact: true }).click()
  let state = await app.evaluate(() => globalThis.__bugReportQa)
  const draftUrl = new URL(state.urls[0])
  if (state.images.length !== 1 || draftUrl.origin !== 'https://github.com' || draftUrl.pathname !== '/Panther114/Weport/issues/new' || draftUrl.searchParams.get('body') !== body) throw new Error('Image/draft IPC integration failed')
  await page.evaluate(() => { document.querySelector('.settings-pane').scrollTop = 0 })
  const typography = await page.locator('#bug-report-body-input').evaluate(element => ({ font: getComputedStyle(element).fontFamily, height: element.getBoundingClientRect().height }))
  if (typography.font.includes('monospace') || typography.height > 180) throw new Error('Report editor typography/height regression')
  await page.screenshot({ path: join(out, 'settings-bug-report.png') })
  await page.getByRole('checkbox').filter({ visible: true }).last().check()
  const longBody = '完整问题说明'.repeat(500)
  await page.locator('#bug-report-body-input').fill(longBody)
  await page.getByRole('button', { name: '打开 GitHub 新建问题', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '正文较长' }).waitFor()
  await page.getByRole('button', { name: '复制正文', exact: true }).click()
  state = await app.evaluate(() => globalThis.__bugReportQa)
  if (new URL(state.urls[1]).searchParams.has('body') || !state.texts.at(-1).startsWith(longBody) || !state.texts.at(-1).includes('Weport: 1.2.0')) throw new Error('Long report lost text/environment metadata')
  await page.getByRole('button', { name: /移除图片/ }).click()
  await page.locator('.bug-report-image-list img').waitFor({ state: 'hidden' })
  for (const width of [1000, 1440]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html')).setBounds({ x: -4000, y: 0, width, height: 800 }), width)
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)) throw new Error('Bug report layout overflow')
    await page.locator('.bug-report-actions').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(out, `settings-bug-report-${width}.png`) })
  }
  // A documentation screenshot uses only fictional diagnostics, including paths.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('diagnostics:collect')
    const groups = [
      ['app', '应用与构建', 'Weport 1.2.0 · Windows x64 · Electron 43.3.0'],
      ['wechat', '微信连接', '已连接示例账号；演示数据目录 D:\\WeChatDemo'],
      ['db', '数据库校验', '演示数据库与密钥校验通过，原始数据保持只读。'],
      ['engine', 'WCDB 宿主', '原生组件初始化正常，当前连接可读取聊天记录。'],
      ['config', '配置', '配置格式正常；诊断包不会包含密钥。'],
      ['logs', '日志', '已找到演示日志，无需重新获取聊天密钥。'],
      ['env', '运行环境', '系统与可用空间符合要求。'],
      ['perm', '权限', '演示数据目录可读，导出目录可写。'],
    ]
    const checks = groups.flatMap(([id, label, detail]) => [0, 1, 2].map(index => ({
      id: `${id}.demo${index}`, label: index ? `${label}检查 ${index + 1}` : label,
      state: 'ok', detail, raw: '示例诊断数据，不含用户信息。',
    })))
    ipcMain.handle('diagnostics:collect', () => ({ supported: true, platform: 'win32',
      collectedAt: '2026-10-03T06:00:00Z', checks }))
  })
  await page.locator('.rail-item[data-tab="settings"]').click()
  await page.locator('.settings-nav-item').filter({ has: page.locator('strong', { hasText: /^诊断$/ }) }).click()
  await page.locator('.dx-check').first().waitFor()
  await page.screenshot({ path: join(out, 'diagnostics-demo.png') })
  if (errors.length) throw new Error(errors.join('; '))
  writeFileSync(join(out, 'results.json'), JSON.stringify({ pickerImagePreview: true, clipboardImage: true,
    titleAndBodyPrefilled: true, longBodyPreserved: true, environmentOptIn: true, imageRemoval: true,
    rendererErrors: errors, externalWritesIntercepted: true }, null, 2))
  console.log(`Verified packaged bug-report draft and attachment workflow: ${out}`)
} finally {
  await app.close()
  rmSync(profile, { recursive: true, force: true })
}
