import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

// Read-only acceptance: no application entrypoint, BrowserWindow, login hook,
// source SQLite handle or provider configuration is used by this harness.
const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const native = require('./verify-packaged-native.cjs')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-v13-connection-'))
const receiptPath = path.resolve(process.argv[2] || '.ui-probe/v13-connection.json')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const receipt = { date: new Date().toISOString(), platform: process.platform, packageBaseline: 'release/win-unpacked', gates: {}, cleanup: false }
let temporaryHost
try {
  assert.equal(process.platform, 'win32', 'This receipt harness requires Windows')
  const layout = native.resolveLayout(path.join(root, 'release'))
  receipt.artifactHashes = { executable: hash(layout.appExe), appAsar: hash(path.join(layout.appResources, 'app.asar')), hostScript: hash(path.join(layout.appResources, 'host', 'wcdbHost.js')), wcdb: hash(layout.wcdbDll) }
  let host = path.join(layout.appOutDir, 'WeFlow.exe')
  if (!fs.existsSync(host)) { temporaryHost = native.createHostExecutable(layout, scratch); host = temporaryHost.hostExe }
  assert.equal(hash(host), hash(layout.appExe), 'Deployed host differs from packaged executable')
  const smoke = path.join(scratch, 'native.cjs')
  fs.writeFileSync(smoke, native.smokeSource())
  const nativeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(layout.appResources, 'host', 'libs'),
    WEPORT_RESOURCES_PATH: layout.payloadRoot, WCDB_RESOURCES_PATH: layout.payloadRoot,
    WEPORT_NATIVE_SMOKE_DLL: layout.wcdbDll, WEFLOW_USER_DATA_PATH: scratch, WEFLOW_CONFIG_CWD: scratch,
    WEPORT_USER_DATA_PATH: scratch, PATH: [layout.wcdbDir, path.join(layout.payloadRoot, 'runtime', 'win32'), process.env.PATH].join(path.delimiter) }
  for (const [label, executable, wrong] of [['packagedHost', host, false], ['wrongHostRejected', layout.appExe, true]]) {
    const child = spawnSync(executable, [smoke], { env: { ...nativeEnv, WEPORT_NATIVE_EXPECT_WRONG_HOST: wrong ? '1' : '0' }, cwd: scratch, windowsHide: true, encoding: 'utf8', timeout: 45000 })
    receipt.gates[label] = { passed: child.status === 0, output: String(child.stdout || '').trim() }
    assert.equal(child.status, 0, `${label} failed`)
  }
  const realProfile = path.join(process.env.APPDATA, 'weport')
  const protectedFiles = ['Weport-config.json', 'Local State'].map(name => path.join(realProfile, name))
  const before = protectedFiles.map(hash)
  const config = JSON.parse(fs.readFileSync(protectedFiles[0], 'utf8'))
  const candidates = [config.dbPath, path.join(config.dbPath, config.myWxid)]
  if (fs.existsSync(config.dbPath)) for (const e of fs.readdirSync(config.dbPath, { withFileTypes: true })) {
    if (e.isDirectory() && (e.name === config.myWxid || e.name.startsWith(config.myWxid + '_'))) candidates.push(path.join(config.dbPath, e.name))
  }
  const account = candidates.find(dir => fs.existsSync(path.join(dir, 'db_storage', 'session', 'session.db')))
  assert(account, 'Current saved account DB directory missing')
  const accountStore = config.dbKeyStore?.accounts?.[path.basename(account)] || {}
  // Explicit field allowlist prevents provider secrets from entering the probe.
  const material = { account, decryptKey: config.wxidConfigs?.[config.myWxid]?.decryptKey || config.decryptKey,
    accountStore: { passphrase: accountStore.passphrase, dbKeys: accountStore.dbKeys || {} } }
  const profile = path.join(scratch, 'profile'); fs.mkdirSync(profile)
  fs.copyFileSync(protectedFiles[1], path.join(profile, 'Local State'))
  fs.writeFileSync(path.join(scratch, 'material.json'), JSON.stringify(material))
  const bundle = path.join(scratch, 'helpers.cjs')
  await build({ stdin: { contents: `export * from './electron/services/wcdbPageKey'; export * from './electron/services/keyScanService'; export * from './electron/services/v12StablePolicy'`, resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
    plugins: [{ name: 'native-koffi-path', setup(b) { b.onResolve({ filter: /^koffi$/ }, () => ({ path: require.resolve('koffi'), external: true })) } }], logLevel: 'silent' })
  const runner = path.join(scratch, 'runner.cjs')
  fs.writeFileSync(runner, String.raw`
const { app, safeStorage, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
app.setPath('userData', path.join(__dirname, 'profile'))
app.on('window-all-closed', () => {})
let stage = 'ready'
app.whenReady().then(async () => {
  stage = 'load-helpers'
  const h = require('./helpers.cjs'), m = JSON.parse(fs.readFileSync(path.join(__dirname, 'material.json'), 'utf8'))
  const decrypt = value => !value ? '' : value.startsWith('safe:') ? safeStorage.decryptString(Buffer.from(value.slice(5), 'base64')) : value.startsWith('lock:') ? '' : value
  const files = h.listDbFiles(path.join(m.account, 'db_storage'))
  const required = files.filter(f => f.kind === 'session' || f.kind.startsWith('message') || f.kind.startsWith('biz_message'))
  const pages = new Map(files.map(f => [f.id, h.readPage1(f.path)]))
  stage = 'decrypt-account-key'
  const key = decrypt(m.decryptKey || m.accountStore.passphrase)
  const existing = [], storedScan = []
  const representations = { raw: 0, decodedBytesPassphrase: 0, utf8HexPassphrase: 0 }
  for (const f of files) {
    const page = pages.get(f.id).page1
    if (!page) continue
    const verdict = h.verifyHexKeyForPage(page, key)
    if (verdict) existing.push({ id: f.id, mode: verdict.mode })
    if (/^[0-9a-f]{64}$/i.test(key)) {
      if (h.verifyPageKey(page, Buffer.from(key, 'hex'), ['raw']).mode) representations.raw++
      if (h.verifyPageKey(page, Buffer.from(key, 'hex'), ['passphrase']).mode) representations.decodedBytesPassphrase++
      if (h.verifyPageKey(page, Buffer.from(key, 'utf8'), ['passphrase']).mode) representations.utf8HexPassphrase++
    }
    const saved = m.accountStore.dbKeys[f.id]
    if (saved?.source === 'scan' && h.verifyHexKeyForPage(page, decrypt(saved.key))) storedScan.push(f.id)
  }
  const coverage = ids => ({ connectionReady: required.length > 0 && required.every(f => ids.includes(f.id)), ready: required.filter(f => ids.includes(f.id)).length, required: required.length,
    missing: required.filter(f => !ids.includes(f.id)).map(f => f.id), mediaReady: files.filter(f => /^media_\d+$/.test(f.kind) && ids.includes(f.id)).length,
    mediaRequired: files.filter(f => /^media_\d+$/.test(f.kind)).length })
  stage = 'scan'
  const cancellation = await h.scanWindowsWeChatDbKeys({ accountDir: m.account, cancel: { cancelled: true } })
  const activeCancel = { cancelled: false }
  let activeCancelRequested = false, activeCancelBytes = 0
  const activeCancellation = await h.scanWindowsWeChatDbKeys({ accountDir: m.account, cancel: activeCancel,
    onProgress: progress => {
      if (!activeCancelRequested && progress.bytesScanned > 0) {
        activeCancelRequested = true
        activeCancelBytes = progress.bytesScanned
        activeCancel.cancelled = true
      }
    } })
  const cancel = { cancelled: false }, timer = setTimeout(() => { cancel.cancelled = true }, 45000)
  let scanned
  try { scanned = await h.scanWindowsWeChatDbKeys({ accountDir: m.account, cancel }) } finally { clearTimeout(timer) }
  const freshIds = scanned.keys.filter(k => k.verified).map(k => k.id)
  const changedPage1 = files.filter(f => { const a = pages.get(f.id).page1, b = h.readPage1(f.path).page1; return !a || !b || !a.equals(b) }).map(f => f.id)
  const d = scanned.diagnostics
  const output = { enumerated: files.length, existingKey: { ...coverage(existing.map(x => x.id)), authenticated: existing.length, modes: [...new Set(existing.map(x => x.mode))], representations },
    storedScan: coverage(storedScan), freshScan: { ...coverage(freshIds), success: scanned.success, errorCode: scanned.errorCode || null,
      diagnostics: { processes: d.pids.length, openDenied: d.pidDetails.filter(p => p.openDenied).length, bytesScanned: d.bytesScanned, needleHits: d.needleHits, nodeConfirmed: d.nodeConfirmed, blobs: d.blobs, decodedRecords: d.decodedRecords, hmacChecks: d.hmacChecks, elapsedMs: d.elapsedMs, cancelled: d.cancelled } },
    preCancelledScan: { passed: cancellation.errorCode === 'cancelled', errorCode: cancellation.errorCode },
    activeCancelledScan: { passed: activeCancelRequested && activeCancellation.errorCode === 'cancelled' && activeCancellation.diagnostics.cancelled,
      requested: activeCancelRequested, bytesBeforeRequest: activeCancelBytes, bytesScanned: activeCancellation.diagnostics.bytesScanned,
      errorCode: activeCancellation.errorCode || null, cancelled: activeCancellation.diagnostics.cancelled, elapsedMs: activeCancellation.diagnostics.elapsedMs },
    sourcePage1Stable: changedPage1.length === 0, changedPage1, productionScannerDisabled: !h.isNoLoginDbKeyScanEnabled('win32'), windowsCreated: BrowserWindow.getAllWindows().length }
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(output))
  app.exit(0)
}).catch(error => { fs.writeFileSync(path.join(__dirname, 'failure.json'), JSON.stringify({ stage, name: error.name, code: error.code || null })); app.exit(1) })
`)
  const childEnv = { ...process.env, NODE_PATH: path.join(root, 'node_modules'), WEPORT_PROBE_OFFSCREEN: '1' }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawnSync(require('electron'), [runner, `--user-data-dir=${profile}`], { cwd: scratch, env: childEnv, windowsHide: true, timeout: 120000, encoding: 'utf8' })
  if (fs.existsSync(path.join(scratch, 'failure.json'))) receipt.helperFailure = JSON.parse(fs.readFileSync(path.join(scratch, 'failure.json'), 'utf8'))
  assert.equal(child.status, 0, 'Private no-window connection helper failed (stderr withheld to protect secrets)')
  receipt.gates.account = JSON.parse(fs.readFileSync(path.join(scratch, 'result.json'), 'utf8'))
  receipt.gates.realProfileUnchanged = protectedFiles.every((file, i) => hash(file) === before[i])
  assert(receipt.gates.realProfileUnchanged, 'Real profile changed during acceptance')
  assert.equal(receipt.gates.account.windowsCreated, 0)
  receipt.ok = true
} catch (error) {
  receipt.ok = false
  receipt.error = String(error.message)
  process.exitCode = 1
} finally {
  temporaryHost?.cleanup()
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()))
  assert(path.basename(scratch).startsWith('weport-v13-connection-'))
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  receipt.cleanup = !fs.existsSync(scratch)
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt, null, 2))
}
