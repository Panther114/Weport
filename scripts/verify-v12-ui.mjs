// Packaged UI acceptance, private fake-data profile, no desktop input or clipboard.
import { _electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const { resolveLayout } = createRequire(import.meta.url)('./verify-packaged-native.cjs')
const installed = process.argv.includes('--installed')
if (installed && process.platform !== 'win32') throw new Error('--installed currently supports Windows only; use a native unpacked build on other platforms')
const executablePath = installed
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Weport', 'Weport.exe')
  : resolveLayout(resolve('release')).appExe

const base = resolve(process.argv[2] || '.ui-probe/v12-interactions')
mkdirSync(base, { recursive: true })
const out = mkdtempSync(join(base, 'run-'))
const profile = mkdtempSync(join(tmpdir(), 'weport-v12-ui-'))
const errors = [], results = []
let page, app
try {
  app = await _electron.launch({ executablePath,
    args: ['--background', `--user-data-dir=${profile}`], env: { ...process.env, WEPORT_UI_DEMO: '1', WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }, timeout: 90000 })
  await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    await electronApp.whenReady()
    while (!electronApp.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    const proto = BrowserWindow.prototype
    const inactive = proto.showInactive, position = proto.setPosition, hide = proto.hide
    // macOS constrains native windows to display bounds. Keep them hidden rather
    // than relying on offscreen coordinates that the window server can clamp.
    const present = function () {
      if (process.platform === 'darwin') return hide.call(this)
      position.call(this, -4000, 0)
      return inactive.call(this)
    }
    proto.show = present
    proto.showInactive = present
    proto.maximize = function () { position.call(this, -4000, 0) }
    proto.focus = function () {}
    electronApp.emit('activate')
  })
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.rail-item').first().waitFor()
  if (await page.locator('.rail-group-toggle, .rail-density-toggle').count()) throw new Error('Navigation must have no collapse or density toggles')
  if (await page.locator('.rail-group-items[hidden]').count()) throw new Error('All navigation groups must remain visible')
  if (await page.evaluate(() => document.documentElement.dataset.density) !== 'compact') throw new Error('Fixed compact density required')
  if (await page.locator('.rail-item[data-tab="diagnostics"]').count()) throw new Error('Diagnostics must only appear in Settings')
  const packageSmoke = await app.evaluate(() => globalThis.__weportPackageSmoke())
  if (packageSmoke.xlsxBytes < 1000 || packageSmoke.wasmBytes !== 256 || !packageSmoke.mcpReady || packageSmoke.version !== '1.2.0') throw new Error('Packaged dependencies/version smoke failed')
  if (packageSmoke.momentsImage?.width !== 1 || packageSmoke.momentsImage?.contentType !== 'image/png') throw new Error('Packaged Moments image decryption failed')
  const capture = async name => { await page.screenshot({ path: join(out, `${name}.png`) }); results.push(name) }
  const posterFitMetrics = async () => page.evaluate(() => {
    const stage = document.querySelector('.poster-stage')
    const zoomNode = document.querySelector('[data-testid="poster-zoom"]')
    const fitButton = document.querySelector('.poster-fit-toggle')
    if (!stage || !zoomNode || !fitButton) return null
    const style = getComputedStyle(stage)
    const available = stage.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - 4
    const zoom = Number.parseFloat(zoomNode.textContent || '0') / 100
    return { available, zoom, scaledWidth: 1080 * zoom, fitMode: fitButton.getAttribute('aria-pressed'), horizontalOverflow: stage.scrollWidth > stage.clientWidth + 2 }
  })
  const assertPosterFits = async label => {
    const metrics = await posterFitMetrics()
    if (!metrics || metrics.fitMode !== 'true' || metrics.scaledWidth > metrics.available + 1 || metrics.horizontalOverflow) {
      throw new Error(`Poster fit-to-width failed ${label}: ${JSON.stringify(metrics)}`)
    }
    return metrics
  }
  const tab = async text => {
    if (text === '诊断') {
      await page.locator('.rail-item[data-tab="settings"]').click()
      await page.getByRole('button', { name: '诊断 连接 · 数据健康 · 运行自检' }).click()
      await page.locator('.dx-page').waitFor()
      await page.waitForTimeout(400)
      return
    }
    // Every route stays visible in the fixed navigation.
    const item = page.locator(`.rail-item[data-nav-label="${text}"]`).first()
    await item.click()
    await page.waitForTimeout(600)
  }
  for (const height of [600, 720, 900]) {
    await app.evaluate(({ BrowserWindow }, height) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html')).setBounds({ x: -4000, y: 0, width: 1080, height }), height)
    await tab('导出数据')
    await page.evaluate(() => { document.querySelector('.workspace').scrollTop = 0 })
    await page.mouse.move(30, 100)
    await page.waitForTimeout(350)
    const geometry = await page.evaluate(() => {
      const rail = document.querySelector('.rail'), nav = document.querySelector('.rail-nav'), bounds = rail.getBoundingClientRect()
      return { railOverflow: getComputedStyle(rail).overflowY, navOverflow: getComputedStyle(nav).overflowY,
        clipped: Array.from(rail.querySelectorAll('button')).filter(button => button.getClientRects().length).filter(button => {
          const rect = button.getBoundingClientRect(), container = button.closest('.rail-nav') ? nav.getBoundingClientRect() : bounds;
          return rect.top < container.top - 1 || rect.bottom > container.bottom + 1
        }).map(button => button.textContent.trim()),
        hidden: Array.from(nav.querySelectorAll('.rail-item')).filter(item => !item.getClientRects().length).length }
    })
    if (['auto','scroll'].includes(geometry.railOverflow) || ['auto','scroll'].includes(geometry.navOverflow) || geometry.clipped.length || geometry.hidden) throw new Error('Navigation clipped/scrollable at ' + height + ': ' + JSON.stringify(geometry))
    const scrollState = () => page.evaluate(() => ({ y: window.scrollY, body: document.body.scrollTop, root: document.querySelector('#root').scrollTop, rail: document.querySelector('.rail').scrollTop, nav: document.querySelector('.rail-nav').scrollTop, workspace: document.querySelector('.workspace').scrollTop }))
    const before = await scrollState()
    await page.mouse.wheel(0, 1600)
    await page.waitForTimeout(350)
    if (JSON.stringify(await scrollState()) !== JSON.stringify(before)) throw new Error('Wheel over navigation moved layout at ' + height)
    await page.mouse.move(650, 250)
    await page.mouse.wheel(0, 900)
    await page.waitForTimeout(350)
    if ((await scrollState()).workspace <= before.workspace) throw new Error('Workspace scrolling lost at ' + height)
    await capture('nav-fixed-' + height)
  }
  await tab('连接微信')
  const compact = await page.locator('.rail-item').first().evaluate(el => el.getBoundingClientRect().height)
  if (compact !== 30) throw new Error('Unexpected compact navigation density ' + compact)
  const paletteProof = []
  for (const mode of ['dark', 'light']) {
    for (const accent of ['blue', 'violet', 'teal', 'rose', 'amber', 'graphite']) {
      await page.evaluate(({ mode, accent }) => { document.documentElement.dataset.mode = mode; document.documentElement.dataset.accent = accent }, { mode, accent })
      await page.waitForTimeout(220)
      const sample = await page.evaluate(() => {
        const icon = document.querySelector('.rail-item[data-tab="settings"] svg')
        const button = document.querySelector('.rail-item[data-tab="settings"]')
        const title = document.querySelector('.topbar-title h2')
        return { icon: getComputedStyle(icon).color, text: getComputedStyle(button).color,
          title: getComputedStyle(title).color, timing: getComputedStyle(button).transitionTimingFunction,
          properties: getComputedStyle(button).transitionProperty }
      })
      if (accent !== 'graphite' && sample.icon === sample.text) throw new Error(`Monochrome navigation icon for ${mode}/${accent}`)
      if (!sample.properties.includes('transform') || !sample.timing.includes('1.45')) throw new Error(`Spring feedback absent for ${mode}/${accent}`)
      paletteProof.push({ mode, accent, ...sample })
      await capture(`palette-${mode}-${accent}`)
    }
  }
  if (new Set(paletteProof.map(sample => sample.icon)).size < 6) throw new Error('Palette changes do not reach icons')
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dark'; document.documentElement.dataset.accent = 'blue' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await page.locator('.workspace > *').first().evaluate(el => getComputedStyle(el).animationName)
  if (reduced !== 'none') throw new Error(`Reduced motion ignored: ${reduced}`)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  writeFileSync(join(out, 'palette-motion.json'), JSON.stringify({ compact, paletteProof, reduced }, null, 2))
  await app.evaluate(({ ipcMain }, output) => {
    globalThis.__weportQaExports = []
    ipcMain.removeHandler('poster:saveImage')
    ipcMain.handle('poster:saveImage', (_event, payload) => {
      globalThis.__weportQaExports.push(payload)
      return { success: true, path: `${output}/qa-poster.png` }
    })
  }, out)
  await tab('防撤回')
  await page.locator('.anti-revoke-list .account-item').first().waitFor()
  if (!(await page.locator('.anti-revoke-list [data-revoke-state="installed"]').count())) throw new Error('Demo anti-revoke status must contain verified installed rows')
  await capture('antirecall-populated')
  await tab('聊天阅读')
  await page.locator('.reader-session').first().click()
  await page.locator('.reader-row').first().waitFor()
  await capture('reader-populated')
  await page.getByTitle('收藏这个会话', { exact: true }).click()
  await page.getByTitle('取消收藏这个会话', { exact: true }).waitFor()
  await tab('导出数据')
  if (!(await page.locator('.export-scope-trigger').innerText()).includes('仅选中 0')) throw new Error('Fresh export must default to selected-only')
  await page.locator('.export-scope-trigger').click()
  await page.locator('.export-session-favorite[aria-pressed="true"]').first().waitFor()
  await page.getByRole('dialog', { name: '选择导出会话' }).getByRole('radio', { name: '收藏', exact: true }).click()
  if (!(await page.locator('.export-session-favorite[aria-pressed="true"]').count())) throw new Error('Reader favorites did not reach the export picker')
  await capture('export-shared-favorites')
  await page.locator('.export-session-row').first().click()
  await page.keyboard.press('Escape')
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('export:exportSessions')
    ipcMain.handle('export:exportSessions', () => ({ success: true, successCount: 1, formatFolder: 'TXT' }))
    ipcMain.removeHandler('export:integrityReport')
    ipcMain.handle('export:integrityReport', () => ({ success: true, path: 'D:/demo/integrity-report.json', report: {
      ok: true, totals: { sessions: 1, messages: 2, mismatches: 0, missingMedia: 0, duplicates: 0, sourceIdCollisions: 1 }, notes: [],
    } }))
  })
  await page.getByRole('button', { name: /^导出已选（1）$/ }).click()
  await page.getByText('导出数据自检通过', { exact: true }).waitFor()
  await page.getByText(/源 server_id 冲突 1 组/).waitFor()
  if (await page.getByText('导出数据自检未通过', { exact: true }).count()) throw new Error('Source ID collisions must not be export failures')
  await capture('export-source-collision-info')
  await tab('搜索')
  await page.locator('input').filter({ visible: true }).first().fill('公园')
  await page.waitForTimeout(800)
  await capture('search-results')
  const firstHit = page.locator('.sp-row').first()
  await firstHit.waitFor()
  await firstHit.click()
  await page.locator('.reader-row-wrap[data-active="true"]').waitFor()
  await capture('search-exact-reader')
  await tab('海报')
  const workflow = page.locator('.poster-workflow-step')
  if (await workflow.count() !== 3 || await page.locator('.poster-workflow-step[data-step="content"]').getAttribute('aria-current') !== 'step') {
    throw new Error('Poster must open on the first content step')
  }
  if (!(await page.locator('.poster-preview-empty').isVisible())) throw new Error('Empty poster preview must explain how to start')
  const continueWithoutContent = page.locator('.poster-step-footer .poster-step-next')
  if (!(await continueWithoutContent.isDisabled())) throw new Error('Poster must not advance with no visible content')
  const sourceTabs = page.locator('.poster-src-tabs > button')
  if (await sourceTabs.count() !== 3) throw new Error('Poster must expose chat, Moments, and manual quote sources')
  const fitButton = page.locator('.poster-fit-toggle')
  await assertPosterFits('at laptop startup')
  await page.getByRole('button', { name: '放大预览' }).click()
  const manualZoom = (await posterFitMetrics())?.zoom
  if (!manualZoom || (await fitButton.getAttribute('aria-pressed')) !== 'false') throw new Error('Explicit zoom did not leave fit mode')
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))
    win.setBounds({ x: -4000, y: 0, width: 1000, height: 900 })
  })
  await page.waitForTimeout(160)
  const manualAfterResize = await posterFitMetrics()
  if (!manualAfterResize || Math.abs(manualAfterResize.zoom - manualZoom) > 0.005 || manualAfterResize.fitMode !== 'false') {
    throw new Error(`Explicit preview zoom changed after resize: ${JSON.stringify({ before: manualZoom, after: manualAfterResize })}`)
  }
  await fitButton.click()
  await page.waitForTimeout(120)
  await assertPosterFits('after re-enabling fit mode')
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))
    win.setBounds({ x: -4000, y: 0, width: 1080, height: 900 })
  })
  await page.waitForTimeout(120)
  await assertPosterFits('after fit-mode resize')
  await page.locator('.poster-session-row').first().click()
  const advancedFilters = page.locator('.poster-advanced-filters')
  await advancedFilters.locator('summary').click()
  await page.getByLabel('条数上限', { exact: true }).fill('60')
  await advancedFilters.locator('summary').click()
  if (await advancedFilters.getAttribute('open') !== null) throw new Error('Poster filters did not collapse')
  await page.getByRole('button', { name: /载入「.*」的消息/ }).click()
  await page.locator('.pp-bubble').first().waitFor({ timeout: 15000 })
  if ((await page.locator('.poster-item-row').count()) === 0) throw new Error('Seeded chat messages did not reach the poster item editor')
  await capture('poster-populated')

  // Follow the visible workflow and exercise the inline template controls.
  await page.locator('.poster-step-footer .poster-step-next').click()
  const templateCards = page.locator('.poster-template-card')
  if (await templateCards.count() !== 4) throw new Error('Poster design step must show all four templates')
  const gridTemplate = templateCards.filter({ hasText: '九宫格拼贴' })
  await gridTemplate.click()
  if (await gridTemplate.getAttribute('aria-pressed') !== 'true') throw new Error('Poster template selection did not update')
  await templateCards.filter({ hasText: '长图' }).click()
  await page.getByLabel('标题', { exact: true }).fill('验收海报')
  await page.locator('.poster-stage .pp-title').filter({ hasText: '验收海报' }).waitFor({ timeout: 10000 })
  await page.getByLabel('个人模板名称').fill('验收模板')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.poster-saved-template-list').getByText('验收模板').waitFor()
  await capture('poster-style-step')

  await page.locator('.poster-step-footer .poster-step-next').click()
  await page.locator('.poster-final-check strong').waitFor()
  if (!(await page.getByRole('button', { name: '已开启', exact: true }).isVisible())) throw new Error('Poster privacy step must show the default redaction state')
  await page.getByRole('button', { name: '已开启', exact: true }).click()
  await page.locator('.modal.danger').getByRole('button', { name: '保持开启' }).click()
  if (!(await page.getByRole('button', { name: '已开启', exact: true }).isVisible())) throw new Error('Poster redaction confirmation did not preserve the safe default')
  await capture('poster-privacy-step')

  // PNG export uses the same action from the persistent top bar and final step.
  await page.locator('.annual-actions').getByRole('button', { name: /导出 PNG/ }).click()
  let payloads = []
  for (let i = 0; i < 100 && !payloads.length; i++) {
    await page.waitForTimeout(300)
    payloads = await app.evaluate(() => globalThis.__weportQaExports)
  }
  if (!payloads.length) throw new Error('Poster export did not produce a PNG')
  await page.getByText(/已保存 \d+ 张：/).waitFor({ timeout: 30000 })
  const bytes = Buffer.from(String(payloads[0].dataUrl).split(',')[1], 'base64')
  if (bytes.subarray(1, 4).toString() !== 'PNG') throw new Error('Expected PNG capture')
  writeFileSync(join(out, 'exported-poster.png'), bytes)
  const exported = { bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  writeFileSync(join(out, 'export-proof.json'), JSON.stringify(exported))
  if (exported.width !== 2160 || exported.height < 100 || exported.bytes < 1000) throw new Error(`Poster 2× export dimensions/content invalid: ${JSON.stringify(exported)}`)

  // Moments uses the seeded timeline and image proxy; manual quotes are local-only.
  await page.locator('.poster-workflow-step[data-step="content"]').click()
  await page.locator('.poster-src-tabs button[data-source="sns"]').click()
  await page.getByRole('button', { name: '载入朋友圈动态', exact: true }).click()
  await page.getByText(/已载入 \d+ 条朋友圈动态/).waitFor({ timeout: 15000 })
  const momentsCount = await page.locator('.poster-item-row').count()
  if (momentsCount === 0 || (await page.locator('.pp-page').count()) === 0) throw new Error('Seeded Moments did not reach the poster preview')
  await capture('poster-moments')

  await page.locator('.poster-src-tabs button[data-source="manual"]').click()
  await page.getByLabel('引用文本').fill('验收手写引用：我的号码是 13800138000。')
  await page.getByLabel('引用署名').fill('验收用户')
  await page.getByRole('button', { name: '加入海报', exact: true }).click()
  await page.locator('.poster-item-row').filter({ hasText: '验收手写引用' }).waitFor()
  await page.locator('.pp-page').getByText('验收手写引用').waitFor({ timeout: 10000 })
  if ((await page.locator('.pp-mask').count()) === 0) throw new Error('Default redaction did not mask the seeded manual phone number')
  await capture('poster-manual-quote')

  await page.locator('.poster-src-tabs button[data-source="session"]').click()
  await page.locator('.poster-step-footer .poster-step-next').click()
  await page.locator('.poster-step-footer .poster-step-next').click()
  await page.locator('.poster-workflow-step[data-step="content"]').click()
  await tab('诊断')
  await page.locator('.dx-page').waitFor()
  await page.locator('.dx-check').first().waitFor()
  if (!(await page.locator('.dx-head-main h2').isVisible())) throw new Error('Settings diagnostics heading hidden')
  const diagnosticsLayout = await page.evaluate(() => {
    const page = document.querySelector('.dx-page'), groups = Array.from(page.querySelectorAll('.dx-group'))
    const scroller = document.querySelector('.workspace')
    return { scrollable: scroller.scrollHeight > scroller.clientHeight + 100,
      groupHeights: groups.map(group => group.getBoundingClientRect().height),
      clippedRows: Array.from(page.querySelectorAll('.dx-check')).filter(row => row.getBoundingClientRect().height < 48).length }
  })
  if (!diagnosticsLayout.scrollable || diagnosticsLayout.clippedRows || diagnosticsLayout.groupHeights.some(height => height < 70)) throw new Error(`Diagnostics panels collapsed: ${JSON.stringify(diagnosticsLayout)}`)
  await capture('diagnostics')
  const nav = await page.locator('.rail-item').evaluateAll(items => items.map(item => item.dataset.navLabel))
  for (const width of [1440, 1080, 1000, 920]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))
      win.setBounds({ x: -4000, y: 0, width, height: 900 })
    }, width)
    for (const label of nav) {
      await tab(label.trim())
      const overflow = await page.evaluate(() => {
        const workspace = document.querySelector('.workspace')
        return document.documentElement.scrollWidth > innerWidth + 2 || workspace.scrollWidth > workspace.clientWidth + 2
      })
      if (overflow) throw new Error(`Horizontal overflow: ${label.trim()} at ${width}px`)
      await capture(`${width}-${label.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-')}`)
    }

    await tab('海报')
    await page.locator('.poster-workflow-step[data-step="content"]').click()
    const posterLayout = await page.evaluate(() => {
      const read = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          overflowY: getComputedStyle(element).overflowY,
        }
      }
      return {
        viewportWidth: innerWidth,
        editor: read('.poster-workflow-column'),
        stepScroll: read('.poster-step-scroll'),
        source: read('.poster-src'),
        preview: read('.poster-preview-pane'),
        canvas: read('.poster-stage'),
        workflowSteps: [...document.querySelectorAll('.poster-workflow-step')].map(button => ({
          step: button.dataset.step,
          iconColor: getComputedStyle(button.querySelector('.poster-flow-icon svg')).color,
        })),
        sourceTabs: [...document.querySelectorAll('.poster-src-tabs > button')].map(button => {
          const rect = button.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width: rect.width, scrollWidth: button.scrollWidth, clientWidth: button.clientWidth }
        }),
        loadAction: read('.poster-src > button:not(.poster-more-sessions)'),
      }
    })
    const { editor, stepScroll, source, preview, canvas } = posterLayout
    if (!editor || !stepScroll || !source || !preview || !canvas) throw new Error(`Poster regions missing at ${width} DIP`)
    if (canvas.width < 200 || canvas.height < 160) {
      throw new Error(`Poster preview collapsed at ${width} DIP: ${JSON.stringify(posterLayout)}`)
    }
    if (stepScroll.overflowY !== 'auto') {
      throw new Error(`Poster workflow inspector is not scrollable at ${width} DIP: ${JSON.stringify(posterLayout)}`)
    }
    if (posterLayout.sourceTabs.length !== 3 || posterLayout.sourceTabs.some(button => button.left < source.left || button.right > source.right + 1 || button.scrollWidth > button.clientWidth + 1)) {
      throw new Error(`Poster source selector clipped at ${width} DIP: ${JSON.stringify(posterLayout)}`)
    }
    if (!posterLayout.loadAction || posterLayout.loadAction.bottom > source.bottom + 2) throw new Error(`Poster load action hidden below source pane at ${width} DIP`)
    if (new Set(posterLayout.workflowSteps.map(step => step.iconColor)).size !== 3) throw new Error(`Poster workflow icons lost their color palette at ${width} DIP`)
    const stacked = width <= 700
    const overlaps = stacked ? editor.bottom > preview.top + 2 : editor.right > preview.left + 2
    if (overlaps) throw new Error(`Poster inspector and preview overlap at ${width} DIP: ${JSON.stringify(posterLayout)}`)
    await capture(`poster-layout-${width}`)
  }
  // Every Settings surface has its own controls and lazy styles.
  await tab('设置')
  const settingsLabels = await page.locator('.settings-nav-item').evaluateAll(items => items.map(item => item.querySelector('strong')?.textContent))
  for (const label of settingsLabels) {
    await page.locator('.settings-nav-item').filter({ has: page.locator('strong', { hasText: new RegExp(`^${label}$`) }) }).click()
    await page.waitForTimeout(400)
    if (await page.evaluate(() => {
      const workspace = document.querySelector('.workspace')
      return document.documentElement.scrollWidth > innerWidth + 2 || workspace.scrollWidth > workspace.clientWidth + 2
    })) throw new Error(`Settings horizontal overflow: ${label}`)
    await capture(`settings-${label}`)
  }
  // Exercise the actual preload event and global rows after page navigation.
  for (const [key, label] of [['db.maintenance', '数据库维护'], ['search.index', '建立搜索索引']]) {
    await app.evaluate(({ BrowserWindow }, key) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))
      win.webContents.send('task:statusChanged', { [key]: { status: 'running', progress: 0, message: '演示后台任务', logs: [], startedAt: Date.now() } })
    }, key)
    await page.locator('.bg-task').filter({ hasText: label }).waitFor()
    await tab('诊断')
    await page.locator('.bg-task').filter({ hasText: label }).waitFor()
    await app.evaluate(({ BrowserWindow }, key) => {
      const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))
      win.webContents.send('task:statusChanged', { [key]: { status: 'done', progress: 100, message: '演示任务完成', logs: [], startedAt: Date.now(), finishedAt: Date.now() } })
    }, key)
    await page.locator('.bg-task').filter({ hasText: label }).waitFor({ state: 'hidden' })
  }
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ position: win.getPosition(), visible: win.isVisible() })))
  if (windows.some(win => win.visible && win.position[0] > -3000)) throw new Error('Visible probe window left offscreen bounds')
  if (errors.length) throw new Error(`Renderer errors: ${errors.join('; ')}`)
  writeFileSync(join(out, 'results.json'), JSON.stringify({ results, packageSmoke, exported, errors, windows }, null, 2))
  console.log(`Verified ${results.length} offscreen UI captures and Search→Reader identity navigation: ${out}`)
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
    const status = await page.locator('.poster-status, .poster-error, .poster-warn').allTextContents().catch(() => [])
    writeFileSync(join(out, 'failure.json'), JSON.stringify({ error: String(error), status, errors }, null, 2))
    console.log(`Failure details: ${out}`)
  }
  throw error
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
}
