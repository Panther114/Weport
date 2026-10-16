// Actual packaged app/native acceptance, synthetic data and a hidden private profile.
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { verifyFixtureModules } from './verify-mac-fixture-modules.mjs'

assert(['darwin', 'linux'].includes(process.platform))
assert.equal(process.arch, process.platform === 'darwin' ? 'arm64' : 'x64')
const { resolveLayout } = createRequire(import.meta.url)('./verify-packaged-native.cjs')
const layout = resolveLayout(resolve(process.argv[2] || 'release'))
const installedExe = process.argv[3]
if (installedExe) {
  assert.equal(process.platform, 'linux')
  assert.equal(realpathSync(installedExe), '/opt/Weport/weport')
  layout.appExe = installedExe
  layout.appResources = join(dirname(installedExe), 'resources')
}
const bundle = process.platform === 'darwin' ? dirname(layout.appContents) : null
const output = resolve(`.ui-probe/${process.platform === 'darwin' ? 'mac' : 'linux'}-native-positive${installedExe ? '-installed' : ''}`)
mkdirSync(output, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'weport-mac-positive-'))
const profile = join(scratch, 'profile'), fixture = join(scratch, 'fixture')
mkdirSync(profile)
const source = resolve('scripts/fixtures/mac-native-positive')
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
assert.equal(manifest.synthetic, true)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const sealedFiles = [layout.appExe, join(layout.appResources, 'app.asar'), join(layout.appResources, 'host/wcdbHost.js')]
const packagedHashes = sealedFiles.map(file => hash(file))
const seal = () => {
  if (bundle) execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  assert.deepEqual(sealedFiles.map(file => hash(file)), packagedHashes, 'Packaged executables/resources must remain unchanged')
}
const result = { candidate: process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  fixtureOnly: true, positiveNativeAccepted: false, platform: process.platform, architecture: process.arch }
let app, page
try {
  result.productVersion = process.platform === 'darwin'
    ? execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
    : execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim()
  if (bundle) assert(Number(result.productVersion.split('.')[0]) >= 15)
  const before = Date.now()
  const clock = await fetch(`https://api.github.com/rate_limit?weport_clock=${before}`, {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }, signal: AbortSignal.timeout(15000) })
  const after = Date.now(), serverUtc = Date.parse(clock.headers.get('date'))
  result.utc = { before: new Date(before).toISOString(), after: new Date(after).toISOString(),
    server: Number.isFinite(serverUtc) ? new Date(serverUtc).toISOString() : null,
    httpStatus: clock.status, age: clock.headers.get('age'), cacheControl: clock.headers.get('cache-control') }
  assert(Number.isFinite(serverUtc) && serverUtc >= before - 2000 && serverUtc <= after + 2000, 'Actual UTC must match independent HTTPS server time')
  for (const file of manifest.files) {
    assert.equal(hash(join(source, file.source)), file.sha256)
    const target = join(fixture, file.target)
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(source, file.source), target)
  }
  seal(); result.bundleSealBefore = true
  // Seed a coherent saved-account profile before the real renderer bootstraps.
  // Mutating an empty profile while its initial account scan is running races
  // the renderer's asynchronous key/account hydration after reload.
  writeFileSync(join(profile, 'Weport-config.json'), JSON.stringify({
    dbPath: fixture, myWxid: manifest.account, decryptKey: manifest.keyHex,
    wxidConfigs: { [manifest.account]: { decryptKey: manifest.keyHex, updatedAt: Date.now() } },
    messagePushEnabled: false, mcpEnabled: false, httpApiEnabled: false, launchAtStartup: false,
  }))
  const env = { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_FATAL_LOG: join(output, 'fatal.log') }
  for (const name of Object.keys(env)) if (name === 'ELECTRON_RUN_AS_NODE' || name === 'WEPORT_UI_DEMO' || name.startsWith('WEPORT_SCREENSHOT_')) delete env[name]
  app = await _electron.launch({ executablePath: layout.appExe, chromiumSandbox: process.platform === 'darwin' || Boolean(installedExe),
    args: ['--background', `--user-data-dir=${profile}`], env, timeout: 180000 })
  const outputTail = []
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', data => {
    outputTail.push(data.toString()); if (outputTail.length > 80) outputTail.shift()
  })
  app.process().on('exit', (code, signal) => { result.processExit = { code, signal } })
  result.processOutput = outputTail
  // Poll from the test process instead of leaving an unresolved CDP promise in
  // Electron during startup. V8 can collect that promise before app readiness.
  const readyDeadline = Date.now() + 60000
  let ready = false
  while (Date.now() < readyDeadline) {
    ready = await app.evaluate(({ app }) => app.isReady() && app.listenerCount('activate') > 0)
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert(ready, 'Application must register its activation handler within 60 seconds')
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const hide = BrowserWindow.prototype.hide
    BrowserWindow.prototype.show = function () { hide.call(this) }
    BrowserWindow.prototype.showInactive = function () { hide.call(this) }
    BrowserWindow.prototype.maximize = function () { hide.call(this) }
    BrowserWindow.prototype.focus = function () {}
    electronApp.emit('activate')
  })
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(realpathSync(actualProfile), realpathSync(profile), 'Actual app must use the private profile')
  page = await app.firstWindow()
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
  const hostPaths = bundle
    ? [actualProfile, realpathSync(actualProfile)].map(root => join(root, 'wcdb-host/Contents/MacOS/WeFlow'))
    : [join(dirname(layout.appExe), 'WeFlow'), join(actualProfile, 'wcdb-host/WeFlow')]
  // macOS comm includes the executable path; Linux comm is only a short basename.
  const processColumns = process.platform === 'darwin' ? 'pid=,ppid=,comm=' : 'pid=,ppid=,args='
  result.hostProcessEvidence = execFileSync('/bin/ps', ['-ww', '-axo', processColumns], { encoding: 'utf8' }).split('\n')
    .filter(line => Number(line.trim().split(/\s+/)[1]) === app.process().pid && hostPaths.some(path => line.includes(path)))
  assert(result.hostProcessEvidence.length > 0, 'Actual deployed WeFlow host must be alive during the read')
  await verifyFixtureModules(page, scratch, manifest, result, output)
  await page.evaluate(() => window.electronAPI.chat.close())
  result.reconnected = await page.evaluate(async contact => {
    const connected = await window.electronAPI.chat.connect()
    const messages = await window.electronAPI.chat.getMessages(contact, 0, 20)
    return { connected, messages }
  }, manifest.contact)
  assert.equal(result.reconnected.connected.success, true)
  assert.deepEqual(result.reconnected.messages.messages.map(m => [m.localId, m.serverId, m.isSend, m.parsedContent]), manifest.messages)
  await page.evaluate(() => window.electronAPI.chat.close())
  await app.close(); app = undefined
  for (const file of manifest.files) {
    assert.equal(hash(join(source, file.source)), file.sha256)
    assert.equal(hash(join(fixture, file.target)), file.sha256)
  }
  if (bundle) assert(!existsSync(join(bundle, 'Contents/MacOS/WeFlow')), 'Original bundle must not acquire a host link')
  seal(); result.bundleSealAfter = true; result.positiveNativeAccepted = true
} catch (error) {
  result.error = { name: error.name, message: error.message }; process.exitCode = 1
  result.rendererFailure = await page?.evaluate(() => ({
    text: document.body.innerText.slice(0, 6000),
    routes: [...document.querySelectorAll('.rail-item')].map(button => ({ tab: button.dataset.tab, disabled: button.disabled })),
  })).catch(() => null)
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
} finally {
  await app?.close().catch(() => {})
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
  rmSync(scratch, { recursive: true, force: true })
}
