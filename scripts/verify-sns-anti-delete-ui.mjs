import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const { resolveLayout } = require('./verify-packaged-native.cjs')
const executablePath = process.argv.includes('--installed')
  ? join(process.env.LOCALAPPDATA, 'Programs', 'Weport', 'Weport.exe')
  : resolveLayout(resolve('release')).appExe
const outputRoot = resolve('.ui-probe/sns-anti-delete-ui')
require('node:fs').mkdirSync(outputRoot, { recursive: true })
const { _electron } = require('playwright-core')
const profile = mkdtempSync(join(tmpdir(), 'weport-anti-delete-ui-'))
let app
const results = [], errors = []
try {
  app = await _electron.launch({ executablePath,
    args: ['--background', `--user-data-dir=${profile}`], env: { ...process.env, WEPORT_UI_DEMO: '1', WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }, timeout: 90000 })
  await app.evaluate(async ({ app: electronApp, BrowserWindow, ipcMain }) => {
    await electronApp.whenReady()
    while (!electronApp.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    const position = BrowserWindow.prototype.setPosition, inactive = BrowserWindow.prototype.showInactive, hide = BrowserWindow.prototype.hide
    BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () {
      if (process.platform === 'darwin') return hide.call(this)
      position.call(this, -4000, 0); inactive.call(this)
    }
    BrowserWindow.prototype.focus = function () {}
    electronApp.emit('activate')
    globalThis.antiDeleteFixture = { installed: false, failCheck: true, failMutation: false, throwMutation: false, ignoreMutation: false, calls: [] }
    const replace = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
    replace('sns:checkBlockDeleteTrigger', () => {
      const fixture = globalThis.antiDeleteFixture
      fixture.calls.push('check')
      return fixture.failCheck ? { success: false, error: 'Fixture status unavailable' } : { success: true, installed: fixture.installed }
    })
    for (const [name, enabled] of [['sns:installBlockDeleteTrigger', true], ['sns:uninstallBlockDeleteTrigger', false]]) {
      replace(name, async () => {
        const fixture = globalThis.antiDeleteFixture
        fixture.calls.push(enabled ? 'install' : 'uninstall')
        await new Promise(resolve => setTimeout(resolve, 200))
        if (fixture.throwMutation) throw new Error('Fixture IPC failure')
        if (fixture.failMutation) return { success: false, error: '请先退出微信，再备份并修改数据库' }
        if (!fixture.ignoreMutation) fixture.installed = enabled
        return { success: true }
      })
    }
  })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.rail-item[data-tab="sns"]').click()
  const button = page.locator('[data-sns-anti-delete]')
  const feedback = page.locator('.sns-anti-delete-feedback')
  await feedback.getByText('检查防删除状态失败', { exact: false }).waitFor()
  assert.match(await button.innerText(), /状态未知/)
  assert.equal(await button.isEnabled(), true)
  results.push('failed initial check is visible and retryable')
  await app.evaluate(() => { globalThis.antiDeleteFixture.failCheck = false })
  await button.click()
  await page.getByRole('button', { name: '防删除已关闭', exact: true }).waitFor()
  assert.equal(await button.getAttribute('aria-pressed'), 'false')
  results.push('retry confirms disabled status')
  await button.click()
  assert.equal(await button.isDisabled(), true)
  await feedback.getByText('防删除已开启，当前状态已确认', { exact: true }).waitFor()
  assert.equal(await button.getAttribute('aria-pressed'), 'true')
  const enabledCalls = await app.evaluate(() => globalThis.antiDeleteFixture.calls.slice(-2))
  assert.deepEqual(enabledCalls, ['install', 'check'])
  results.push('enable waits, rechecks backend and confirms active state')
  await button.click()
  await feedback.getByText('防删除已关闭，当前状态已确认', { exact: true }).waitFor()
  assert.equal(await button.getAttribute('aria-pressed'), 'false')
  results.push('disable rechecks and confirms inactive state')
  await app.evaluate(() => { globalThis.antiDeleteFixture.failMutation = true })
  await button.click()
  await feedback.getByText('请先退出微信', { exact: false }).waitFor()
  assert.equal(await feedback.getAttribute('role'), 'alert')
  assert.match(await button.innerText(), /状态未知/)
  results.push('backend rejection explains the failure without claiming success')
  await app.evaluate(() => { globalThis.antiDeleteFixture.failMutation = false })
  await button.click()
  await page.getByRole('button', { name: '防删除已关闭', exact: true }).waitFor()
  await app.evaluate(() => { globalThis.antiDeleteFixture.throwMutation = true })
  await button.click()
  await feedback.getByText('Fixture IPC failure', { exact: false }).waitFor()
  results.push('rejected IPC is visible and does not remain busy')
  await app.evaluate(() => { globalThis.antiDeleteFixture.throwMutation = false })
  await button.click()
  await page.getByRole('button', { name: '防删除已关闭', exact: true }).waitFor()
  await app.evaluate(() => { globalThis.antiDeleteFixture.ignoreMutation = true })
  await button.click()
  await feedback.getByText('操作后的防删除状态未改变，请重试', { exact: true }).waitFor()
  assert.equal(await button.getAttribute('aria-pressed'), 'false')
  results.push('a success response with unchanged backend state is not reported as enabled')
  await app.evaluate(() => { globalThis.antiDeleteFixture.ignoreMutation = false; globalThis.antiDeleteFixture.failCheck = true })
  await button.click()
  await feedback.getByText('Fixture status unavailable', { exact: false }).waitFor()
  assert.match(await feedback.innerText(), /操作已完成，但状态确认失败/)
  assert.match(await button.innerText(), /状态未知/)
  results.push('failed post-operation verification shows unknown state')
  await page.screenshot({ path: join(outputRoot, 'error.png') })
  await app.evaluate(() => { globalThis.antiDeleteFixture.failCheck = false })
  await button.click()
  await page.getByRole('button', { name: '防删除已开启', exact: true }).waitFor()
  await page.screenshot({ path: join(outputRoot, 'on.png') })
  await button.click()
  await feedback.getByText('防删除已关闭，当前状态已确认', { exact: true }).waitFor()
  await page.screenshot({ path: join(outputRoot, 'off.png') })
  assert.deepEqual(errors, [])
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), position: win.getPosition() })))
  assert.equal(windows.some(win => win.visible && win.position[0] > -3000), false)
  writeFileSync(join(outputRoot, 'results.json'), JSON.stringify({ results, errors, windows,
    fakeDataOnly: true, realDatabaseWrites: false, browserFallbackReason: 'Browser plugin not available; Electron tested with private offscreen Playwright' }, null, 2))
  console.log(`PASS: ${results.length} packaged anti-delete feedback/state checks; no renderer errors or real database writes`)
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}

