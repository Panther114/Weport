import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'

// Generated on-disk index; actual packaged configuration/build/query IPC and UI.
// Browser plugin unavailable. All windows are born offscreen in a private profile.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-v13-semantic-ui-'))
const profile = path.join(scratch, 'profile'), output = path.resolve('.ui-probe/v13-semantic-ui')
fs.mkdirSync(profile); fs.mkdirSync(output, { recursive: true })
const receipt = { checks: [], errors: [], data: 'Synthetic bilingual indexed messages; real local ONNX model; production packaged IPC' }
const check = name => { receipt.checks.push(name); console.log(name) }
let app, page
try {
  const bundle = path.join(scratch, 'search.cjs')
  await build({ entryPoints: [path.resolve('electron/services/searchIndexService.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const { SearchIndexService } = createRequire(import.meta.url)(bundle)
  const account = 'synthetic-recall', dbRoot = path.join(scratch, 'accounts')
  const db = path.join(dbRoot, account, 'db_storage', 'message', 'message_0.db')
  fs.mkdirSync(path.dirname(db), { recursive: true }); fs.writeFileSync(db, 'Synthetic fixture only, not a live database')
  const table = 'Msg_' + createHash('md5').update('fixture-chat').digest('hex')
  const rows = ['The train leaves at noon.', '火车中午出发。', 'Project review moved to Monday.'].map((text, index) => ({
    local_id: index + 1, server_id: index + 100, local_type: 1, create_time: 1700000000 + index,
    is_send: 0, sender_username: 'fixture', message_content: text,
    __weport_local_id_text: String(index + 1), __weport_server_id_text: String(index + 100),
  }))
  const service = new SearchIndexService({ rootDir: path.join(profile, 'search-index'), resolveWxid: () => account, resolveDbPath: () => dbRoot,
    decodeText: row => ({ text: row.message_content, senderUsername: row.sender_username }), source: {
      listMessageDbs: async () => [db], listTables: async () => [table],
      getSessions: async () => [{ username: 'fixture-chat', displayName: 'Fixture chat' }], getDisplayNames: async () => ({}),
      execQuery: async (_db, sql) => {
        if (sql.includes('max(rowid)')) return [{ rowid_max: 3, local_max: 3 }]
        const match = /WHERE (?:rowid|local_id) > (\d+).*LIMIT (\d+)/.exec(sql)
        if (match) return rows.filter(row => row.local_id > Number(match[1])).slice(0, Number(match[2]))
        throw Error('Unexpected fixture SQL')
      },
    } })
  await service.build()
  fs.writeFileSync(path.join(profile, 'Weport-config.json'), JSON.stringify({ onboardingDone: true, myWxid: account, dbPath: dbRoot,
    lastTab: 'search', mcpEnabled: false, httpApiEnabled: false, messagePushEnabled: false, launchAtStartup: false, appearanceBackgroundPath: '',
    exportPath: path.join(scratch, 'exports'), cachePath: path.join(scratch, 'media') }))
  const executablePath = path.resolve('release/win-unpacked/Weport.exe')
  receipt.appAsarSha256 = createHash('sha256').update(fs.readFileSync(path.join(path.dirname(executablePath), 'resources/app.asar'))).digest('hex')
  app = await _electron.launch({ executablePath, args: ['--background', `--user-data-dir=${profile}`],
    env: { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }, timeout: 90000 })
  await app.evaluate(async ({ app, BrowserWindow }) => {
    await app.whenReady(); while (!app.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    const position = BrowserWindow.prototype.setPosition, show = BrowserWindow.prototype.showInactive
    BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () { position.call(this, -4000, 0); show.call(this) }
    BrowserWindow.prototype.focus = function () {}; app.emit('activate')
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false)
  })
  page = await app.firstWindow(); page.on('pageerror', error => receipt.errors.push(error.message))
  page.setDefaultTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; }' })
  await page.getByText('可选本地语义索引', { exact: false }).click()
  assert.equal((await page.evaluate(() => window.electronAPI.search.indexStatus())).docs, 3)
  assert.equal(await page.getByRole('button', { name: '混合召回', exact: true }).isDisabled(), true)
  check('Production search opens the generated on-disk corpus; semantic mode defaults off')
  await page.getByLabel('允许把当前范围的文本交给本机模型').check()
  await page.getByLabel('本机嵌入服务地址').fill('http://127.0.0.1:5083/v1/embeddings')
  await page.getByLabel('模型名称', { exact: true }).fill('Xenova/multilingual-e5-small')
  await page.getByLabel('固定模型版本或文件摘要').fill('e3b222633d142ec3041c486c4537b027807035608f159d8fd99d4a858a2e51e7')
  await page.getByLabel('查询前缀（E5：query: ）').fill('query: ')
  await page.getByLabel('正文前缀（E5：passage: ）').fill('passage: ')
  await page.getByRole('button', { name: '保存本地配置', exact: true }).click()
  await page.getByRole('button', { name: '建立当前范围语义索引', exact: true }).click()
  let task
  for (let attempt = 0; attempt < 120; attempt++) {
    task = await page.evaluate(async () => (await window.electronAPI.task.status())['search.index'])
    if (['done', 'failed', 'aborted'].includes(task?.status)) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(task.status, 'done', task.error)
  check('Explicit UI build calls the real local model and commits global task completion')
  await page.getByRole('button', { name: '混合召回', exact: true }).click()
  await page.getByLabel('搜索', { exact: true }).fill('When does the railway depart? 检索:hybrid')
  await page.waitForFunction(() => document.querySelector('.sp-semantic')?.textContent.includes('语义索引 3 条'), null, { polling: 100 })
  const query = await page.evaluate(() => window.electronAPI.search.query({ text: 'When does the railway depart?', retrieval: 'hybrid' }))
  assert(query.hits.length > 0); assert.equal(query.coverage.engine, 'local-hybrid-v1')
  assert(query.hits.every(hit => hit.db && hit.table && hit.localId && hit.contentHash))
  assert((await page.getByLabel('搜索', { exact: true }).inputValue()).includes('检索:hybrid'))
  check('Hybrid UI query discloses semantic coverage and preserves exact source identities and mode syntax')
  await page.screenshot({ path: path.join(output, 'semantic-search.png') })
  await page.getByLabel('允许把当前范围的文本交给本机模型').uncheck()
  await page.getByRole('button', { name: '保存本地配置', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.sp-semantic button[aria-pressed="true"]')?.textContent === '精确匹配', null, { polling: 100 })
  assert.equal((await page.evaluate(() => window.electronAPI.search.semanticConfig())).enabled, false)
  check('Disabling local processing persists configuration and restores lexical mode')
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), x: window.getBounds().x })))
  assert(windows.every(window => !window.visible || window.x < -1000)); assert.deepEqual(receipt.errors, [])
  receipt.ok = true
} catch (error) { receipt.ok = false; receipt.error = String(error.stack || error); process.exitCode = 1 }
finally {
  await app?.close().catch(() => {})
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir())); assert(path.basename(scratch).startsWith('weport-v13-semantic-ui-'))
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); receipt.privateCleanupVerified = !fs.existsSync(scratch)
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ ok: receipt.ok, receipt: path.join(output, 'result.json') }))
}
