import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'

// Browser plugin not available. Exercise the actual packaged Electron IPC and UI.
// All content below is generated, and every window is born in probe-offscreen mode.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-v13-archive-storage-'))
const profile = path.join(scratch, 'profile'), output = path.resolve('.ui-probe/v13-archive-storage-ui')
fs.mkdirSync(profile); fs.mkdirSync(output, { recursive: true })
const receipt = { source: 'generated bilingual archive; actual packaged IPC; no real account or provider', checks: [], errors: [] }
const check = name => { receipt.checks.push(name); console.log(name) }
receipt.interaction = 'Programmatic DOM activation of real controls; actual IPC/restart and screenshot checks. Offscreen pointer/keyboard delivery was unreliable.'
let app, page
try {
  const bundle = path.join(scratch, 'archive-library.cjs')
  await build({ entryPoints: [path.resolve('electron/services/archive/archiveLibrary.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' })
  const { ArchiveLibrary } = createRequire(import.meta.url)(bundle)
  const hash = value => createHash('sha256').update(value).digest('hex')
  const rows = ['你好 archive evidence', 'English archive evidence'].map((content, index) => ({
    localType: 1, createTime: 1700000000 + index, content, rawContent: content,
    sourceIdentity: { db: `db_storage/message/message_${index}.db`, table: 'Msg_fixture', localId: '9007199254740993' },
    sourceIdentityHash: hash([`db_storage/message/message_${index}.db`, 'msg_fixture', '9007199254740993'].join('\0')),
  }))
  rows[0].localType = 3
  rows[0].mediaOutcome = { kind: 'image', status: 'thumbnail', relativePath: 'media/thumb.png' }
  const thumbnail = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ7cAAAAASUVORK5CYII=', 'base64')
  const library = new ArchiveLibrary({ root: path.join(scratch, 'fixture-library'), currentAccount: () => 'fixture-account',
    source: async () => ({ fingerprint: 'generated-stable-snapshot', capability: 'history-snapshot' }),
    annotations: () => ({ favorites: [], marks: [], tags: {} }), task: { begin() {}, progress() {}, end() {} },
    exportJson: async (_request, directory) => {
      fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'fixture.json')
      fs.mkdirSync(path.join(directory, 'media'), { recursive: true }); fs.writeFileSync(path.join(directory, 'media/thumb.png'), thumbnail)
      fs.writeFileSync(file, JSON.stringify({ session: { displayName: 'Offline bilingual fixture' }, messages: rows }))
      return { success: true, sessionOutputPaths: { fixture: file } }
    },
  })
  const entry = await library.create({ accountId: 'fixture-account', destination: scratch, sessionIds: ['fixture'], mediaPolicy: 'best-available', includeMedia: true })
  fs.writeFileSync(path.join(profile, 'Weport-config.json'), JSON.stringify({ onboardingDone: true, lastTab: 'archive', mcpEnabled: false, httpApiEnabled: false,
    messagePushEnabled: false, launchAtStartup: false, appearanceBackgroundPath: '', dbPath: '', myWxid: '', exportPath: path.join(scratch, 'exports') }))
  const sourceIndex = path.join(profile, 'search-index'); fs.mkdirSync(sourceIndex)
  fs.writeFileSync(path.join(sourceIndex, 'relocation-fixture.txt'), 'Synthetic index placement proof')
  const executablePath = path.resolve('release/win-unpacked/Weport.exe')
  receipt.appAsarSha256 = hash(fs.readFileSync(path.join(path.dirname(executablePath), 'resources/app.asar')))
  const launch = async () => {
    app = await _electron.launch({ executablePath, args: ['--background', `--user-data-dir=${profile}`],
      env: { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }, timeout: 90000 })
    await app.evaluate(async ({ app, BrowserWindow }) => {
      await app.whenReady(); while (!app.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
      const position = BrowserWindow.prototype.setPosition, show = BrowserWindow.prototype.showInactive
      BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () { position.call(this, -4000, 0); show.call(this) }
      BrowserWindow.prototype.focus = function () {}
      app.emit('activate')
      for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false)
    })
    page = await app.firstWindow(); page.on('pageerror', error => receipt.errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; }' })
    await page.locator('.rail-item[data-tab="archive"]').waitFor()
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), x: window.getBounds().x })))
    assert(windows.every(window => !window.visible || window.x < -1000), 'Probe window must stay offscreen')
  }
  const pickDirectory = directory => app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }) }, directory)
  await launch()
  if (await page.locator('.rail-item[data-tab="archive"]').getAttribute('data-active') !== 'true') await page.locator('.rail-item[data-tab="archive"]').evaluate(element => element.click())
  await page.getByRole('heading', { name: '归档库', exact: true, level: 1 }).waitFor()
  await pickDirectory(entry.path)
  await page.getByRole('button', { name: '打开已有归档目录', exact: true }).evaluate(element => element.click())
  await page.locator('.archive-message > p').filter({ hasText: rows[0].content }).waitFor()
  await page.locator('.archive-message > p').filter({ hasText: rows[1].content }).waitFor()
  assert.equal(await page.evaluate(() => window.electronAPI.config.get('myWxid')), '')
  check('Archive opens bilingually through real IPC without a configured WeChat account')
  assert.equal(await page.getByLabel('开始日期（可选）').inputValue(), '')
  assert.equal(await page.getByLabel('结束日期（可选）').inputValue(), '')
  await page.locator('.archive-evidence summary').first().evaluate(element => element.click())
  await page.getByText(/消息 ID：9007199254740993/).first().waitFor()
  await page.locator('.archive-evidence pre').first().waitFor()
  const reference = await page.evaluate(({ id, identity }) => window.electronAPI.archive.evidence(id, 'fixture', identity), { id: entry.archiveId, identity: rows[0].sourceIdentityHash })
  assert.equal(reference.success, true); assert(reference.data.uri.endsWith(rows[0].sourceIdentityHash))
  assert.equal(reference.data.message.sourceIdentity.localId, '9007199254740993')
  check('Reader exposes raw content, exact 64-bit local ID and a portable evidence URI')
  await page.getByRole('button', { name: '读取本地媒体', exact: true }).evaluate(element => element.click())
  await page.locator('.archive-message img').evaluate(element => element.scrollIntoView({ block: 'center' }))
  // Offscreen Chromium can keep native lazy images deferred despite a DOM scroll.
  // Check the actual protocol/codec here; this does not claim desktop lazy-load timing.
  await page.locator('.archive-message img').evaluate(element => { element.loading = 'eager' })
  await page.waitForFunction(() => document.querySelector('.archive-message img')?.naturalWidth === 1, null, { polling: 100 })
  const mediaCheck = await page.evaluate(({ id, identity }) => window.electronAPI.archive.media(id, 'fixture', identity), { id: entry.archiveId, identity: rows[0].sourceIdentityHash })
  assert.equal(mediaCheck.data.status, 'thumbnail'); assert.equal(mediaCheck.data.available, true)
  check('Generated thumbnail opens through actual media protocol and retains explicit thumbnail status')
  await page.getByRole('button', { name: '保存书签', exact: true }).first().evaluate(element => element.click())
  await page.getByText('已保存归档书签', { exact: true }).waitFor()
  assert.equal(JSON.parse(fs.readFileSync(path.join(entry.path, 'bookmarks.json'), 'utf8')).bookmarks.length, 1)
  check('Reader bookmark persists into portable archive annotations')
  await page.getByText('归档书签 · 1', { exact: true }).evaluate(element => element.click())
  await page.getByRole('button', { name: '打开书签消息', exact: true }).evaluate(element => element.click())
  await page.waitForFunction(() => document.querySelectorAll('.archive-message').length === 1, null, { polling: 100 })
  await page.getByRole('button', { name: '返回完整会话', exact: true }).evaluate(element => element.click())
  await page.waitForFunction(() => document.querySelectorAll('.archive-message').length === 2, null, { polling: 100 })
  check('Portable bookmark navigates to its exact row and returns to the full conversation')
  const restore = path.join(scratch, 'restored'); fs.mkdirSync(restore)
  await pickDirectory(restore)
  await page.getByRole('button', { name: '复制并验证', exact: true }).evaluate(element => element.click())
  await page.getByText(/^已复制并验证：/).waitFor()
  assert.equal(fs.readdirSync(restore).length, 1)
  check('Restore copies and verifies a portable archive through real UI controls')
  await page.screenshot({ path: path.join(output, 'archive-offline.png') })
  const relocationDestination = path.join(scratch, 'relocated'); fs.mkdirSync(relocationDestination)
  await pickDirectory(relocationDestination)
  const prepared = await page.evaluate(() => window.electronAPI.storage.prepare('search-index'))
  assert.equal(prepared.state, 'ready')
  assert.equal(fs.existsSync(path.join(profile, 'storage-locations.json')), false)
  check('Storage preparation verifies a copy without changing active runtime paths')
  await app.close(); app = undefined
  await launch()
  const status = await page.evaluate(() => window.electronAPI.storage.status())
  assert.equal(status.relocation.state, 'applied')
  assert.equal(status.entries.find(entry => entry.kind === 'search-index').path, prepared.target)
  assert.equal(fs.readFileSync(path.join(prepared.target, 'relocation-fixture.txt'), 'utf8'), 'Synthetic index placement proof')
  assert.equal(fs.readFileSync(path.join(sourceIndex, 'relocation-fixture.txt'), 'utf8'), 'Synthetic index placement proof')
  check('A fresh packaged process applies relocation and retains the original source')
  if (await page.locator('.rail-item[data-tab="archive"]').getAttribute('data-active') !== 'true') await page.locator('.rail-item[data-tab="archive"]').evaluate(element => element.click())
  await page.getByRole('button', { name: '离线打开', exact: true }).evaluate(element => element.click())
  await page.locator('.archive-message > p').filter({ hasText: rows[0].content }).waitFor()
  check('Saved archive library reopens after a real process restart')
  assert.deepEqual(receipt.errors, [])
  receipt.ok = true
} catch (error) { receipt.ok = false; receipt.error = String(error.stack || error); process.exitCode = 1
  if (page) { receipt.dom = await page.locator('body').innerText().catch(() => 'unavailable'); await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {}) } }
finally {
  await app?.close().catch(() => {})
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()))
  assert(path.basename(scratch).startsWith('weport-v13-archive-storage-'))
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  receipt.privateCleanupVerified = !fs.existsSync(scratch)
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ ok: receipt.ok, receipt: path.join(output, 'result.json') }))
}
