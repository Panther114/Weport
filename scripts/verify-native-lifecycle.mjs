// Isolated demo lifecycle stress: real renderer, IPC and packaged dependencies.
import assert from 'node:assert/strict'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { resolveLayout } = createRequire(import.meta.url)('./verify-packaged-native.cjs')
const layout = resolveLayout(resolve('release'))
const profile = mkdtempSync(join(tmpdir(), 'weport-lifecycle-'))
const output = resolve('.ui-probe/cross-platform/lifecycle')
mkdirSync(output, { recursive: true })
writeFileSync(join(profile, 'Weport-config.json'), JSON.stringify({ dbPath: '', myWxid: '',
  messagePushEnabled: false, mcpEnabled: false, httpApiEnabled: false, launchAtStartup: false }))
const result = { routes: [], samples: [], errors: [], recreations: 0 }
let app
try {
  app = await _electron.launch({ executablePath: layout.appExe,
    args: ['--background', `--user-data-dir=${profile}`], timeout: 90000,
    env: { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_UI_DEMO: '1', WEPORT_NATIVE_GLASS: '0', WEPORT_DISCARD_DELAY_MS: '1000' } })
  await app.evaluate(async ({ app, BrowserWindow }) => {
    await app.whenReady()
    while (!app.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    const proto = BrowserWindow.prototype, hide = proto.hide, inactive = proto.showInactive, position = proto.setPosition
    proto.show = proto.showInactive = function () {
      if (process.platform === 'darwin') return hide.call(this)
      position.call(this, -4000, 0); return inactive.call(this)
    }
    proto.maximize = function () { if (process.platform !== 'darwin') position.call(this, -4000, 0) }
    proto.focus = function () {}
    app.emit('activate')
  })
  let page = await app.firstWindow()
  const observe = page => page.on('pageerror', error => result.errors.push(error.message))
  observe(page)
  await page.locator('.rail-item').first().waitFor()
  const tabs = await page.locator('.rail-item[data-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.tab))
  assert(tabs.length >= 10)
  const started = Date.now()
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const tab of tabs) {
      // The rail mounts before the renderer's async connection/config bootstrap.
      await page.waitForFunction(tab => {
        const button = document.querySelector(`.rail-item[data-tab="${tab}"]`)
        return button && !button.disabled
      }, tab, { timeout: 30000 })
      // Navigation hit targets are covered by verify-v12-ui. Here drive DOM
      // activation so hidden macOS windows do not depend on compositor frames.
      await page.locator(`.rail-item[data-tab="${tab}"]`).evaluate(button => {
        if (button.disabled) throw Error('Unexpected locked demo route')
        button.click()
      })
      await page.waitForFunction(tab => document.querySelector(`.rail-item[data-tab="${tab}"]`)?.dataset.active === 'true', tab)
      assert((await page.locator('body').innerText()).length > 50, `Route ${tab} must render meaningful content`)
      result.routes.push({ cycle, tab })
    }
    result.samples.push(await app.evaluate(({ app }) => ({ at: Date.now(), metrics: app.getAppMetrics() })))
    await page.screenshot({ path: join(output, `cycle-${cycle}.png`) })
    const oldPid = page.isClosed() ? null : await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html')).webContents.getOSProcessId())
    const nextWindow = app.waitForEvent('window', { predicate: candidate => candidate !== page, timeout: 60000 })
    const discarded = page.waitForEvent('close', { timeout: 30000 })
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))
      if (!window) throw Error('Missing main window')
      // Exercise the application's close-to-tray timer, including its own
      // reclaim guard. Direct destroy() intentionally follows a different path.
      window.close()
    })
    await discarded
    await app.evaluate(({ app }) => app.emit('activate'))
    page = await nextWindow
    observe(page)
    await page.locator('.rail-item').first().waitFor({ timeout: 60000 })
    const recovered = await page.evaluate(async () => ({ platform: window.electronAPI.process.platform,
      taskStatus: await window.electronAPI.task.status() }))
    assert.equal(recovered.platform, process.platform)
    assert(recovered.taskStatus && typeof recovered.taskStatus === 'object')
    const newPid = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html')).webContents.getOSProcessId())
    assert.notEqual(newPid, oldPid, 'A recreated window must own a fresh renderer process')
    result.recreations++
  }
  result.durationMs = Date.now() - started
  assert.deepEqual(result.errors, [])
  result.passed = true
} catch (error) {
  result.error = error.stack; process.exitCode = 1
} finally {
  await app?.close().catch(() => {})
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2))
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
  console.log(JSON.stringify(result))
}
