// Real packaged Windows WCDB reads against copied synthetic encrypted databases.
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
assert.equal(process.platform, 'win32')
const { resolveLayout } = createRequire(import.meta.url)('./verify-packaged-native.cjs')
const scratch = mkdtempSync(join(tmpdir(), 'weport-v131-native-')), profile = join(scratch, 'profile'), fixture = join(scratch, 'data')
const source = resolve('scripts/fixtures/mac-native-positive'), manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
assert.equal(manifest.synthetic, true)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
for (const file of manifest.files) {
  assert.equal(hash(join(source, file.source)), file.sha256)
  const target = join(fixture, file.target); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(source, file.source), target)
}
mkdirSync(profile)
writeFileSync(join(profile, 'Weport-config.json'), JSON.stringify({ dbPath: fixture, myWxid: manifest.account, decryptKey: manifest.keyHex,
  wxidConfigs: { [manifest.account]: { decryptKey: manifest.keyHex, updatedAt: Date.now() } }, messagePushEnabled: false, mcpEnabled: false, httpApiEnabled: false, launchAtStartup: false }))
let app
try {
  const env = { ...process.env, WEPORT_PROBE_OFFSCREEN: '1' }
  for (const key of Object.keys(env)) if (key === 'ELECTRON_RUN_AS_NODE' || key === 'WEPORT_UI_DEMO' || key.startsWith('WEPORT_SCREENSHOT_')) delete env[key]
  app = await _electron.launch({ executablePath: resolveLayout(resolve('release')).appExe, args: ['--background', `--user-data-dir=${profile}`], env, timeout: 90000 })
  await app.evaluate(async ({ app, BrowserWindow }) => {
    await app.whenReady(); while (!app.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    const hide = BrowserWindow.prototype.hide
    BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = BrowserWindow.prototype.maximize = function () { hide.call(this) }
    BrowserWindow.prototype.focus = function () {}
    app.emit('activate')
  })
  const page = await app.firstWindow(); await page.locator('.rail-item').first().waitFor()
  const result = await page.evaluate(async ({ contact }) => {
    const api = window.electronAPI, connected = await api.chat.connect()
    const messages = await api.chat.getMessages(contact, 0, 20)
    const normal = await api.ai.createChat('Native acceptance')
    const disabled = await api.ai.createChat('Memory disabled', { memoryEnabled: false })
    const chat = await api.ai.getChat(disabled.chat.id)
    const references = await api.chat.getMessageReferences({ sessionId: contact, localId: messages.messages[0].localId, ts: messages.messages[0].createTime })
    await api.chat.close()
    const reconnected = await api.chat.connect(), reread = await api.chat.getMessages(contact, 0, 20)
    await api.chat.close()
    return { connected, messages, normal, disabled, chat, references, reconnected, reread }
  }, manifest)
  assert.equal(result.connected.success, true)
  assert.deepEqual(result.messages.messages.map(m => [m.localId, m.serverId, m.isSend, m.parsedContent]), manifest.messages)
  assert.equal(result.normal.chat.memoryEnabled, true); assert.equal(result.chat.chat.memoryEnabled, false); assert.equal(result.chat.memoryDir, '')
  assert.equal(result.references.success, true); assert.equal(result.references.total, 0)
  assert.equal(result.reconnected.success, true); assert.equal(result.reread.success, true, JSON.stringify(result.reread)); assert.deepEqual(result.reread.messages.map(m => [m.localId, m.serverId, m.isSend, m.parsedContent]), manifest.messages)
  for (const file of manifest.files) { assert.equal(hash(join(source, file.source)), file.sha256); assert.equal(hash(join(fixture, file.target)), file.sha256) }
  const receipt = { passed: true, version: await page.evaluate(() => window.electronAPI.app.getVersion()), fixtureOnly: true,
    checks: ['encrypted native reads', 'exact message fields', 'memory defaults and disabled IPC persistence', 'native reverse-quote scan', 'close and reconnect', 'fixture hashes unchanged'] }
  mkdirSync('.ui-probe', { recursive: true }); writeFileSync('.ui-probe/v131-native.json', JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt))
} finally { await app?.close().catch(() => {}); rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) }
