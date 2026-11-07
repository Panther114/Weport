// Offscreen packaged UI acceptance. All fixtures and IPC mutations are private.
import { _electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { resolveLayout } = createRequire(import.meta.url)('./verify-packaged-native.cjs')
const profile = mkdtempSync(join(tmpdir(), 'weport-v131-ui-'))
const output = resolve('.ui-probe/v131-ui'); mkdirSync(output, { recursive: true })
const checks = [], errors = []
let app
try {
  app = await _electron.launch({ executablePath: resolveLayout(resolve('release')).appExe,
    args: ['--background', `--user-data-dir=${profile}`], env: { ...process.env, WEPORT_UI_DEMO: '1', WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }, timeout: 90000 })
  await app.evaluate(async ({ app, BrowserWindow }) => {
    await app.whenReady()
    while (!app.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    const hide = BrowserWindow.prototype.hide, position = BrowserWindow.prototype.setPosition, show = BrowserWindow.prototype.showInactive
    BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () {
      if (process.platform === 'darwin') return hide.call(this)
      position.call(this, -4000, 0); show.call(this)
    }
    BrowserWindow.prototype.focus = function () {}
    app.emit('activate')
  })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.rail-item').first().waitFor()
  const fixtures = await page.evaluate(async () => ({
    chat: await window.electronAPI.ai.getChat('fixture'),
    word: await window.electronAPI.analytics.getWordFrequency(60),
    task: (await window.electronAPI.weBot.listTasks())[0],
  }))
  await app.evaluate(({ ipcMain }, fixtures) => {
    const replace = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name, fn) }
    const qa = globalThis.v131qa = { memory: null, created: null, pending: false, calls: [], wordDone: false, referenceIdentity: null }
    const chat = { ...fixtures.chat, chat: { ...fixtures.chat.chat, memoryEnabled: true } }
    replace('ai:getChat', () => chat)
    replace('ai:createChat', (_event, _title, options) => { qa.memory = options.memoryEnabled; chat.chat = { ...chat.chat, id: 'new-memory-chat', memoryEnabled: qa.memory }; chat.messages = []; return { chat: chat.chat } })
    replace('webot:listTranscripts', () => [{ id: 'migrated-run', title: 'Migrated automation', createdAt: 1700000000000 }])
    replace('webot:getTranscript', () => ({ messages: [{ id: 'archived-turn', role: 'assistant', content: 'Archived automation result retained.', createdAt: 1700000000000 }], running: false }))
    replace('webot:createTask', (_event, input) => { qa.created = input; return { ...fixtures.task, ...input, id: 'regex-ui-task' } })
    replace('analytics:getWordFrequency', async () => { await new Promise(resolve => setTimeout(resolve, 4500)); qa.wordDone = true; return fixtures.word })
    replace('sns:checkBlockDeleteTrigger', () => ({ success: true, installed: false }))
    replace('sns:getProtectionState', () => ({ success: true, state: qa.pending ? { desired: true, pending: true } : null }))
    replace('sns:installBlockDeleteTrigger', () => { qa.pending = true; return { success: true, pending: true } })
  }, fixtures)
  const tab = async name => { await page.locator(`.rail-item[data-nav-label="${name}"]`).click() }
  await tab('WeportAI')
  const memory = page.getByRole('checkbox', { name: '新对话启用记忆' })
  await memory.waitFor(); assert.equal(await memory.isChecked(), true)
  await memory.uncheck(); await page.getByRole('button', { name: '新建对话', exact: true }).click()
  await page.getByText('记忆关闭', { exact: true }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.v131qa.memory), false)
  checks.push('new-chat default and disabled memory option reach IPC and status')
  await tab('WeBot')
  await page.getByRole('button', { name: '运行历史', exact: true }).click()
  await page.getByRole('combobox', { name: '选择 WeBot 运行记录' }).selectOption('migrated-run')
  await page.getByText('Archived automation result retained.', { exact: true }).waitFor()
  checks.push('WeBot history menu renders archived transcript turns')
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  await page.locator('.webot-editor select').first().selectOption('custom')
  await page.getByPlaceholder('例如：化学群作业整理').fill('Regex acceptance')
  await page.locator('.webot-editor textarea').first().fill('Summarize matching deadlines.')
  await page.locator('#webot-trigger-mode').selectOption('message')
  await page.locator('#webot-trigger-pattern').fill('deadline|提交')
  assert.equal(await page.getByRole('radiogroup', { name: '执行频率' }).isVisible(), false)
  await page.screenshot({ path: join(output, 'regex-editor.png') })
  await page.getByRole('button', { name: '创建任务', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.webot-editor'))
  assert.match((await app.evaluate(() => globalThis.v131qa.created)).trigger.pattern, /deadline/)
  checks.push('regex editor hides time controls and saves message trigger')
  await tab('朋友圈')
  const protection = page.locator('[data-sns-anti-delete]')
  await page.getByRole('button', { name: '防删除已关闭', exact: true }).waitFor()
  await protection.click()
  await page.getByRole('button', { name: '待退出微信后开启', exact: true }).waitFor()
  await page.getByText('已安排开启防删除；退出微信后会自动备份并应用，无需再次点击。', { exact: true }).waitFor()
  assert.equal(await protection.getAttribute('aria-pressed'), 'false')
  checks.push('deferred Moments setup remains pending rather than claiming protection')
  await tab('分析'); await page.locator('.analytics-big-card').filter({ hasText: '全局分析' }).click()
  await page.locator('.analytics-global').waitFor()
  await page.getByText('总消息数', { exact: true }).waitFor({ timeout: 2500 })
  assert.equal(await app.evaluate(() => globalThis.v131qa.wordDone), false)
  checks.push('core global statistics render before slow word-frequency scan finishes')
  await page.screenshot({ path: join(output, 'global-progressive.png') })
  const groupFixtures = await page.evaluate(async () => {
    const api = window.electronAPI.groupAnalytics
    const groups = await api.getGroupChats(), id = groups.data[0].username
    return { members: await api.getGroupMembersPanelData(id, { includeMessageCounts: true }), heatmap: await api.getGroupActivityHeatmap(id, 0, 0) }
  })
  await app.evaluate(({ ipcMain }, f) => {
    globalThis.v131qa.calls = []
    for (const [name, data] of [['getGroupMembersPanelData', f.members], ['getGroupActivityHeatmap', f.heatmap]]) {
      ipcMain.removeHandler(`groupAnalytics:${name}`)
      ipcMain.handle(`groupAnalytics:${name}`, () => { globalThis.v131qa.calls.push(name); return data })
    }
  }, groupFixtures)
  await tab('连接微信'); await tab('分析')
  await page.getByRole('button', { name: /返回/ }).click()
  await page.locator('.analytics-big-card').filter({ hasText: '群聊分析' }).click()
  await page.locator('.group-item').first().click()
  await page.getByRole('heading', { name: '成员列表', exact: true }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.v131qa.calls), ['getGroupMembersPanelData'])
  await page.getByRole('button', { name: '活跃热力图', exact: true }).click()
  await page.getByRole('heading', { name: '活跃热力图', exact: true }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.v131qa.calls), ['getGroupMembersPanelData', 'getGroupActivityHeatmap'])
  checks.push('group member selection does not scan heatmap until that tab is selected')
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:getMessageReferences')
    ipcMain.handle('chat:getMessageReferences', (_event, identity) => {
      globalThis.v131qa.referenceIdentity = identity
      return { success: true, messages: [{ localId: 999, createTime: 1700000000, parsedContent: 'Exact reverse quote fixture', localType: 1, senderDisplayName: 'Fixture sender', db: 'message_0.db', table: 'Msg_fixture' }], total: 1, hasMore: false, snapshotAt: Date.now() }
    })
  })
  await tab('聊天阅读'); await page.locator('.reader-session').first().click()
  await page.getByRole('button', { name: '查看引用此消息的消息', exact: true }).first().click({ force: true })
  const references = page.getByRole('dialog', { name: '引用此消息的消息' })
  await references.getByText('Exact reverse quote fixture', { exact: true }).waitFor()
  assert.equal(await references.evaluate(element => element.parentElement.parentElement === document.body), true)
  const identity = await app.evaluate(() => globalThis.v131qa.referenceIdentity)
  assert(identity.sessionId && identity.localId !== undefined && identity.ts)
  await page.screenshot({ path: join(output, 'reverse-quotes.png') })
  await page.keyboard.press('Escape'); await references.waitFor({ state: 'hidden' })
  checks.push('reverse quote action sends exact identity and renders a body portal with Escape dismissal')
  await page.evaluate(() => window.electronAPI.notification.showTest())
  await new Promise(resolve => setTimeout(resolve, 400))
  const popup = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL().includes('popup.html')).map(window => ({ protected: window.isContentProtected(), x: window.getBounds().x })))
  assert.equal(popup.length, 1)
  assert.equal(popup[0].protected, false)
  assert(popup[0].x < 0)
  await page.evaluate(() => window.electronAPI.notification.close())
  checks.push('default notification window is offscreen and has no OS capture exclusion')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, checks, errors, output }, null, 2))
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ passed: true, checks, errors, date: new Date().toISOString() }, null, 2))
} catch (error) {
  const page = app?.windows().find(page => page.url().includes('index.html'))
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  const state = await page?.evaluate(() => ({ body: document.body.innerText, viewport: [innerWidth, innerHeight] })).catch(() => null)
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ error: String(error), state }, null, 2))
  throw error
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}
