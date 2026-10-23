import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { _electron } from 'playwright-core'

// Browser plugin not available. Actual packaged Electron IPC, generated fixtures only.
// Windows are born offscreen; no credentials, source databases or real profile read.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-v13-storage-boundaries-'))
const profile = path.join(scratch, 'profile'), output = path.resolve('.ui-probe/v13-storage-boundaries')
fs.mkdirSync(profile); fs.mkdirSync(output, { recursive: true })
const receipt = { checks: [], errors: [], data: 'Generated media/OCR, export/AI memory and search artifacts; private profile', browser: 'Browser plugin not available; packaged Electron/Playwright fallback' }
const check = name => { receipt.checks.push(name); console.log(name) }
receipt.interaction = 'Programmatic DOM activation of real controls; actual IPC/restart and screenshot checks. Offscreen pointer/keyboard delivery was unreliable.'
let app, page
const media = path.join(scratch, 'media'), exports = path.join(scratch, 'exports'), index = path.join(profile, 'search-index')
for (const directory of [media, path.join(exports, 'WeportAI', 'accounts', 'fixture', 'memory'), path.join(index, 'fixture'), path.join(scratch, 'wechat', 'db_storage')]) fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(media, 'ocr.txt'), '你好 OCR unique text')
fs.writeFileSync(path.join(exports, 'archive.txt'), 'Unique exported history')
fs.writeFileSync(path.join(exports, 'WeportAI', 'accounts', 'fixture', 'memory', 'memory.md'), 'Unique saved memory')
fs.writeFileSync(path.join(index, 'fixture', 'lexical-v1-g1.bin'), 'Derived generated artifact')
fs.writeFileSync(path.join(index, 'fixture', 'ocr.txt'), 'Unrecognized unique OCR retained')
fs.writeFileSync(path.join(profile, 'Weport-config.json'), JSON.stringify({ onboardingDone: true, lastTab: 'settings', mcpEnabled: false, httpApiEnabled: false, messagePushEnabled: false, launchAtStartup: false, dbPath: '', myWxid: '', appearanceBackgroundPath: '', cachePath: media, exportPath: exports }))
const executablePath = path.resolve('release/win-unpacked/Weport.exe')
receipt.appAsarSha256 = createHash('sha256').update(fs.readFileSync(path.join(path.dirname(executablePath), 'resources/app.asar'))).digest('hex')
async function launch() {
  app = await _electron.launch({ executablePath, args: ['--background', `--user-data-dir=${profile}`], env: { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }, timeout: 90000 })
  await app.evaluate(async ({ app, BrowserWindow, dialog }) => {
    await app.whenReady(); while (!app.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    const position = BrowserWindow.prototype.setPosition, show = BrowserWindow.prototype.showInactive
    BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () { position.call(this, -4000, 0); show.call(this) }
    BrowserWindow.prototype.focus = function () {}
    app.emit('activate')
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false)
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; }' })
  page.on('pageerror', error => receipt.errors.push(error.message))
  await page.locator('.rail-item[data-tab="settings"]').waitFor()
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), x: window.getBounds().x })))
  assert(windows.every(window => !window.visible || window.x < -1000), 'Every probe window must remain offscreen')
}
async function restart() { await app.close(); app = undefined; await launch() }
async function choose(directory) {
  fs.mkdirSync(directory, { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, directory)
      break
    } catch (error) {
      if (attempt >= 2 || !String(error).includes('promise was garbage collected')) throw error
    }
  }
}
try {
  await launch()
  await page.waitForFunction(() => document.querySelector('.rail-item[data-tab="settings"]')?.getAttribute('data-active') === 'true', null, { polling: 100 })
  await page.locator('.settings-nav-item').filter({ hasText: '隐私' }).evaluate(element => element.click())
  await page.getByRole('heading', { name: '存储位置与迁移', exact: true }).waitFor()
  assert.equal(await page.locator('.storage-settings article').count(), 8)
  const mediaRow = page.locator('.storage-settings article').filter({ has: page.getByRole('heading', { name: '媒体与 OCR 缓存', exact: true }) })
  await mediaRow.getByRole('button', { name: '计算占用', exact: true }).evaluate(element => element.click())
  await mediaRow.getByText(/1 个文件/).waitFor()
  await page.locator('.storage-settings').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: path.join(output, 'storage-settings.png') })
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  check('Settings renders all eight storage categories; actual usage control counts generated media/OCR')

  await choose(path.join(scratch, 'media-destination'))
  const movedMedia = await page.evaluate(() => window.electronAPI.storage.prepare('media'))
  assert.equal(await page.evaluate(() => window.electronAPI.config.get('cachePath')), media)
  await restart()
  assert.equal(await page.evaluate(() => window.electronAPI.config.get('cachePath')), movedMedia.target)
  assert.equal(fs.readFileSync(path.join(movedMedia.target, 'ocr.txt'), 'utf8'), '你好 OCR unique text')
  fs.writeFileSync(path.join(media, 'new-unique.txt'), 'Do not delete')
  await assert.rejects(() => page.evaluate(() => window.electronAPI.storage.cleanup('original')), /unique|changed/)
  assert(fs.existsSync(path.join(media, 'ocr.txt')))
  fs.unlinkSync(path.join(media, 'new-unique.txt'))
  const cleaned = await page.evaluate(() => window.electronAPI.storage.cleanup('original'))
  assert.equal(cleaned.files, 1)
  assert(!fs.existsSync(path.join(media, 'ocr.txt')))
  assert(fs.existsSync(path.join(movedMedia.target, 'ocr.txt')))
  await restart()
  assert.equal(await page.evaluate(() => window.electronAPI.config.get('cachePath')), movedMedia.target)
  check('Media relocation survives restart and original cleanup; unique source additions block deletion; OCR preserved in active target')

  await choose(path.join(scratch, 'exports-destination'))
  const movedExports = await page.evaluate(() => window.electronAPI.storage.prepare('exports'))
  await restart()
  const status = await page.evaluate(() => window.electronAPI.storage.status())
  assert.equal(await page.evaluate(() => window.electronAPI.config.get('exportPath')), movedExports.target)
  assert.equal(status.entries.find(entry => entry.kind === 'ai-workspace').path, path.join(movedExports.target, 'WeportAI'))
  assert.equal(fs.readFileSync(path.join(movedExports.target, 'WeportAI', 'accounts', 'fixture', 'memory', 'memory.md'), 'utf8'), 'Unique saved memory')
  assert.equal(fs.readFileSync(path.join(movedExports.target, 'archive.txt'), 'utf8'), 'Unique exported history')
  assert(fs.existsSync(path.join(exports, 'archive.txt')))
  check('Exports and default nested AI workspace follow the verified destination after restart; unique exports and memory preserved')

  await page.evaluate(() => window.electronAPI.storage.clearDerived('search-index'))
  assert(fs.existsSync(path.join(index, 'fixture', 'lexical-v1-g1.bin')))
  await restart()
  assert.equal((await page.evaluate(() => window.electronAPI.storage.status())).cleanup.state, 'done')
  assert(!fs.existsSync(path.join(index, 'fixture', 'lexical-v1-g1.bin')))
  assert.equal(fs.readFileSync(path.join(index, 'fixture', 'ocr.txt'), 'utf8'), 'Unrecognized unique OCR retained')
  await assert.rejects(() => page.evaluate(() => window.electronAPI.storage.clearDerived('ai-data')), /Only derived/)
  check('Restart cleanup deletes recognized derived index bytes only; unknown OCR and all user-managed categories retained')

  const protectedDestination = path.join(scratch, 'wechat', 'destination-that-must-not-be-created')
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, protectedDestination)
  await assert.rejects(() => page.evaluate(() => window.electronAPI.storage.prepare('media')), /WeChat|protected/)
  assert(!fs.existsSync(protectedDestination))
  assert(fs.existsSync(path.join(movedMedia.target, 'ocr.txt')))
  check('WeChat-like source boundary rejects a destination before creating any file or directory')
  assert.deepEqual(receipt.errors, [])
  receipt.ok = true
} catch (error) { receipt.ok = false; receipt.error = String(error.stack || error); process.exitCode = 1
  if (page) { receipt.dom = await page.locator('body').innerText().catch(() => 'unavailable'); await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {}) } }
finally {
  await app?.close().catch(() => {})
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()))
  assert(path.basename(scratch).startsWith('weport-v13-storage-boundaries-'))
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  receipt.privateCleanupVerified = !fs.existsSync(scratch)
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ ok: receipt.ok, receipt: path.join(output, 'result.json') }))
}
