// Actual packaged app/native acceptance, synthetic data and a hidden private profile.
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const { resolveLayout } = createRequire(import.meta.url)('./verify-packaged-native.cjs')
const layout = resolveLayout(resolve(process.argv[2] || 'release'))
const bundle = dirname(layout.appContents)
const output = resolve('.ui-probe/mac-native-positive')
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'weport-mac-positive-'))
const profile = join(scratch, 'profile'), fixture = join(scratch, 'fixture')
mkdirSync(profile)
const source = resolve('scripts/fixtures/mac-native-positive')
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
assert.equal(manifest.synthetic, true)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const seal = () => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
const result = { candidate: process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  fixtureOnly: true, positiveNativeAccepted: false, platform: process.platform, architecture: process.arch }
let app
try {
  result.productVersion = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
  assert(Number(result.productVersion.split('.')[0]) >= 15)
  const before = Date.now()
  const clock = await fetch(`https://api.github.com/?weport_clock=${before}`, { method: 'HEAD', signal: AbortSignal.timeout(15000) })
  const after = Date.now(), serverUtc = Date.parse(clock.headers.get('date'))
  assert(Number.isFinite(serverUtc) && serverUtc >= before - 2000 && serverUtc <= after + 2000, 'Actual UTC must match independent HTTPS server time')
  result.utc = { before: new Date(before).toISOString(), after: new Date(after).toISOString(), server: new Date(serverUtc).toISOString() }
  for (const file of manifest.files) {
    assert.equal(hash(join(source, file.source)), file.sha256)
    const target = join(fixture, file.target)
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(source, file.source), target)
  }
  seal(); result.bundleSealBefore = true
  writeFileSync(join(profile, 'Weport-config.json'), JSON.stringify({ dbPath: '', myWxid: '', messagePushEnabled: false, mcpEnabled: false, httpApiEnabled: false, launchAtStartup: false }))
  const env = { ...process.env, WEPORT_PROBE_OFFSCREEN: '1' }
  for (const name of Object.keys(env)) if (name === 'ELECTRON_RUN_AS_NODE' || name === 'WEPORT_UI_DEMO' || name.startsWith('WEPORT_SCREENSHOT_')) delete env[name]
  app = await _electron.launch({ executablePath: layout.appExe, chromiumSandbox: true,
    args: ['--background', `--user-data-dir=${profile}`], env, timeout: 180000 })
  await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    await electronApp.whenReady()
    while (!electronApp.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
    const hide = BrowserWindow.prototype.hide
    BrowserWindow.prototype.show = function () { hide.call(this) }
    BrowserWindow.prototype.showInactive = function () { hide.call(this) }
    BrowserWindow.prototype.maximize = function () { hide.call(this) }
    BrowserWindow.prototype.focus = function () {}
    electronApp.emit('activate')
  })
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(realpathSync(actualProfile), realpathSync(profile), 'Actual app must use the private profile')
  const page = await app.firstWindow()
  await page.locator('.rail-item').first().waitFor({ timeout: 180000 }); result.rendererReady = true
  result.native = await page.evaluate(async ({ fixture, manifest }) => {
    const api = window.electronAPI
    const connection = await api.wcdb.testConnection(fixture, manifest.keyHex, manifest.account)
    if (!connection.success) return { connection }
    await api.config.set('dbPath', fixture); await api.config.set('myWxid', manifest.account); await api.config.set('decryptKey', manifest.keyHex)
    const connected = await api.chat.connect(), sessions = await api.chat.getSessions(), messages = await api.chat.getMessages(manifest.contact, 0, 20)
    return { connection, connected, sessions, messages }
  }, { fixture, manifest })
  assert(result.native.connection.success); assert(result.native.connected.success)
  assert.equal(result.native.sessions.sessions.length, 1)
  assert.equal(result.native.sessions.sessions[0].username, manifest.contact)
  assert.deepEqual(result.native.messages.messages.map(m => [m.localId, m.serverId, m.isSend, m.parsedContent]), manifest.messages)
  const hostPaths = [actualProfile, realpathSync(actualProfile)].map(root => join(root, 'wcdb-host/Contents/MacOS/WeFlow'))
  result.hostProcessEvidence = execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n')
    .filter(line => Number(line.trim().split(/\s+/)[1]) === app.process().pid && hostPaths.some(path => line.includes(path)))
  assert(result.hostProcessEvidence.length > 0, 'Actual deployed WeFlow host must be alive during the read')
  await page.evaluate(() => window.electronAPI.chat.close())
  await app.close(); app = undefined
  for (const file of manifest.files) {
    assert.equal(hash(join(source, file.source)), file.sha256)
    assert.equal(hash(join(fixture, file.target)), file.sha256)
  }
  assert(!existsSync(join(bundle, 'Contents/MacOS/WeFlow')), 'Original bundle must not acquire a host link')
  seal(); result.bundleSealAfter = true; result.positiveNativeAccepted = true
} catch (error) {
  result.error = { name: error.name, message: error.message }; process.exitCode = 1
} finally {
  await app?.close().catch(() => {})
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
  rmSync(scratch, { recursive: true, force: true })
}
