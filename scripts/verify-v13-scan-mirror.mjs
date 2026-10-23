// Private, read-only acquisition proof. Never enables production scan entrypoints.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { prepareScanExports, runScanExports } from './verify-v13-scan-exports.mjs'

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const native = require('./verify-packaged-native.cjs'), { build } = require('esbuild')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-v13-scan-mirror-'))
const exportRequested = process.argv.includes('--export')
const receiptFile = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || (exportRequested ? '.ui-probe/v13-scan-mirror-export.json' : '.ui-probe/v13-scan-mirror.json'))
const digest = value => createHash('sha256').update(value).digest('hex')
const hash = file => digest(fs.readFileSync(file))
const receipt = { checkedAt: new Date().toISOString(), scope: 'source scanner and mirror; packaged pure-Node native history equivalence', cases: [], cleanup: false,
  productionExportsProven: false, mediaOpeningProven: false }
const record = (name, data) => { receipt.cases.push({ name, ...data }); console.log(JSON.stringify({ name, ...data })) }
const check = (condition, label) => { if (!condition) throw new Error(label) }
let deployment, worker
let protectedFiles = [], profileBefore = []
try {
  assert.equal(process.platform, 'win32')
  if (exportRequested) receipt.exportSourceInputs = await prepareScanExports(root, scratch)
  const layout = native.resolveLayout(path.join(root, 'release'))
  receipt.artifactHashes = Object.fromEntries([layout.appExe, path.join(layout.appResources, 'app.asar'), path.join(layout.appResources, 'host', 'wcdbHost.js'), layout.wcdbDll].map(file => [path.relative(root, file), hash(file)]))
  const sources = ['electron/services/keyScanService.ts', 'electron/services/scannedDbMirror.ts', 'electron/services/wcdbPageKey.ts', 'scripts/verify-v13-scan-mirror.mjs']
  if (exportRequested) sources.push('scripts/verify-v13-scan-exports.mjs', 'electron/services/export/index.ts', 'electron/services/export/core/ExportContext.ts', 'electron/services/export/formatters/JsonFormatter.ts', 'electron/services/export/formatters/TxtFormatter.ts', 'electron/services/chatService.ts', 'electron/services/wcdbService.ts', 'electron/services/wcdbHostClient.ts')
  receipt.sourceHashes = Object.fromEntries(sources.map(file => [file, hash(path.join(root, file))]))
  if (exportRequested) receipt.exportBundleSha256 = hash(path.join(scratch, 'export-helpers.cjs'))
  const realProfile = path.join(process.env.APPDATA, 'weport')
  protectedFiles = ['Weport-config.json', 'Local State'].map(file => path.join(realProfile, file))
  profileBefore = protectedFiles.map(hash)
  const config = JSON.parse(fs.readFileSync(protectedFiles[0], 'utf8'))
  const candidates = [config.dbPath, path.join(config.dbPath, config.myWxid)]
  for (const e of fs.readdirSync(config.dbPath, { withFileTypes: true })) if (e.isDirectory() && (e.name === config.myWxid || e.name.startsWith(config.myWxid + '_'))) candidates.push(path.join(config.dbPath, e.name))
  const account = candidates.find(dir => fs.existsSync(path.join(dir, 'db_storage', 'session', 'session.db')))
  check(account, 'Saved account directory unavailable')
  const profile = path.join(scratch, 'profile'); fs.mkdirSync(profile)
  fs.copyFileSync(protectedFiles[1], path.join(profile, 'Local State'))
  const saved = config.dbKeyStore?.accounts?.[path.basename(account)] || {}
  fs.writeFileSync(path.join(scratch, 'input.json'), JSON.stringify({ account, encryptedBaselineKey: config.wxidConfigs?.[config.myWxid]?.decryptKey || config.decryptKey || saved.passphrase }))
  await build({ stdin: { contents: `export * from './electron/services/keyScanService'; export * from './electron/services/scannedDbMirror'; export * from './electron/services/wcdbPageKey'; export * from './electron/services/v12StablePolicy'`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(scratch, 'helpers.cjs'), logLevel: 'silent',
    plugins: [{ name: 'native-koffi', setup(b) { b.onResolve({ filter: /^koffi$/ }, () => ({ path: require.resolve('koffi'), external: true })) } }] })
  fs.writeFileSync(path.join(scratch, 'prepare.cjs'), String.raw`
const { app, safeStorage, BrowserWindow } = require('electron')
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
app.setPath('userData',path.join(__dirname,'profile'));app.on('window-all-closed',()=>{})
let stage='ready'
const check=(v,label)=>{if(!v)throw Error(label)}
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)])
app.whenReady().then(async()=>{
 const h=require('./helpers.cjs'),input=JSON.parse(fs.readFileSync(path.join(__dirname,'input.json')))
 check(!h.isNoLoginDbKeyScanEnabled('win32'),'production scan gate unexpectedly enabled')
 stage='scan';const cancel={cancelled:false},timer=setTimeout(()=>cancel.cancelled=true,45000)
 let scanned;try{scanned=await h.scanWindowsWeChatDbKeys({accountDir:input.account,cancel})}finally{clearTimeout(timer)}
 const files=h.listDbFiles(path.join(input.account,'db_storage'))
 const required=files.filter(f=>f.kind==='session'||f.kind.startsWith('message')||f.kind.startsWith('biz_message'))
 const verified=new Set(scanned.keys.filter(k=>k.verified).map(k=>k.id))
 check(required.every(f=>verified.has(f.id)),'fresh scan lacks required history database keys')
 stage='stable-copy';const source=path.join(input.account,'db_storage'),copy=path.join(__dirname,'source-account')
 const inventory=()=>walk(source).filter(f=>/\.db(?:-wal)?$/i.test(f)).sort()
 const signature=()=>Object.fromEntries(inventory().map(f=>{const s=fs.statSync(f);return[path.relative(source,f),[s.size,s.mtimeMs,s.ctimeMs]]}))
 let copied=false,bytes=0,count=0
 for(let attempt=0;attempt<2&&!copied;attempt++){
  fs.rmSync(copy,{recursive:true,force:true});const before=signature();bytes=0;count=0
  for(const f of inventory()){const target=path.join(copy,'db_storage',path.relative(source,f));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(f,target);check(hash(f)===hash(target),'source changed while copying');bytes+=fs.statSync(target).size;count++}
  copied=JSON.stringify(before)===JSON.stringify(signature())
 }
 check(copied,'source DB/WAL changed during snapshot')
 const copyHashes=Object.fromEntries(walk(copy).map(f=>[path.relative(copy,f),hash(f)]))
 stage='mirror';const mirror=await h.createScannedDbMirror({accountDir:copy,keys:scanned.keys.map(k=>({id:k.id,keyHex:k.keyHex})),destinationRoot:__dirname})
 check(mirror.ok,'scan mirror conversion failed')
 check(Object.entries(copyHashes).every(([file,d])=>hash(path.join(copy,file))===d),'mirror modified its private source')
 const decrypt=v=>v?.startsWith('safe:')?safeStorage.decryptString(Buffer.from(v.slice(5),'base64')):v?.startsWith('lock:')?'':v
 const baselineKey=decrypt(input.encryptedBaselineKey);check(baselineKey,'baseline key unavailable')
 const d=scanned.diagnostics
 fs.writeFileSync(path.join(__dirname,'native-material.json'),JSON.stringify({baselineDir:copy,baselineKey,mirrorDir:mirror.mirrorDir,mirrorKey:mirror.mirrorKey}))
 fs.writeFileSync(path.join(__dirname,'prepared.json'),JSON.stringify({required:required.length,ready:required.filter(f=>verified.has(f.id)).length,verifiedDbCount:verified.size,
  scan:{elapsedMs:d.elapsedMs,bytesScanned:d.bytesScanned,cancelled:d.cancelled},stableCopy:{files:count,bytes},mirror:{convertedDbCount:mirror.convertedDbCount,convertedPageCount:mirror.convertedPageCount,walFrameCount:mirror.walFrameCount,skipped:mirror.skippedDbIds.length},privateSourceUnchanged:true,productionScannerDisabled:true,windows:BrowserWindow.getAllWindows().length}))
 app.exit(0)
}).catch(e=>{fs.writeFileSync(path.join(__dirname,'failure.json'),JSON.stringify({stage,name:e.name,code:e.code||null}));app.exit(1)})
`)
  const env = { ...process.env, NODE_PATH: path.join(root, 'node_modules'), WEPORT_PROBE_OFFSCREEN: '1' }; delete env.ELECTRON_RUN_AS_NODE
  const prepared = spawnSync(require('electron'), [path.join(scratch, 'prepare.cjs'), `--user-data-dir=${profile}`], { cwd: scratch, env, windowsHide: true, encoding: 'utf8', timeout: 600000 })
  if (fs.existsSync(path.join(scratch, 'failure.json'))) receipt.failure = JSON.parse(fs.readFileSync(path.join(scratch, 'failure.json')))
  check(prepared.status === 0, 'Private scan/copy/mirror preparation failed; output withheld')
  const summary = JSON.parse(fs.readFileSync(path.join(scratch, 'prepared.json')))
  record('scan-only-mirror-preparation', summary)
  const material = JSON.parse(fs.readFileSync(path.join(scratch, 'native-material.json')))
  const existingHost = path.join(layout.appOutDir, 'WeFlow.exe')
  deployment = fs.existsSync(existingHost) ? null : native.createHostExecutable(layout, scratch)
  const host = deployment?.hostExe || existingHost
  worker = spawn(host, [path.join(layout.appResources, 'host', 'wcdbHost.js')], { cwd: scratch, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1', WEFLOW_WORKER: '1', WEFLOW_USER_DATA_PATH: profile, WEFLOW_CONFIG_CWD: profile,
      NODE_PATH: path.join(layout.appResources, 'host', 'libs'), PATH: [layout.wcdbDir, path.join(layout.payloadRoot, 'runtime', 'win32'), process.env.PATH].join(path.delimiter) } })
  let id = 0; const pending = new Map()
  worker.on('message', message => { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error('Native host request failed')) : p.resolve(message.result) })
  worker.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Native host exited')) } pending.clear() })
  const call = (type, payload = {}) => new Promise((resolve, reject) => { const requestId = ++id; const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Native host request timed out')) }, 120000); pending.set(requestId, { resolve, reject, timer }); worker.send({ id: requestId, type, payload }) })
  await call('setPaths', { resourcesPath: layout.payloadRoot, userDataPath: profile }); await call('setLogEnabled', { enabled: false })
  const census = async (accountDir, hexKey) => {
    check(await call('open', { accountDir, hexKey }), 'Native account open failed')
    const sessions = await call('getSessions'); check(sessions.success, 'Native session query failed')
    const sessionIds = sessions.sessions.map(s => String(s.username || s.user_name || s.userName || '')).sort()
    check(sessionIds.length > 0 && sessionIds.every(Boolean), 'Native session IDs unavailable')
    const physical = [], content = []; let count = 0, nonempty = 0
    for (const sessionId of sessionIds) {
      const messageCount = await call('getMessageCount', { sessionId })
      check(messageCount.success, 'Native history count failed')
      if (messageCount.count === 0) continue
      const cursor = await call('openMessageCursor', { sessionId, batchSize: 500, ascending: true, beginTimestamp: 0, endTimestamp: 0 })
      check(cursor.success && cursor.cursor, 'Native history cursor failed')
      let rowsForSession = 0
      try { for (let batch = 0; batch < 10000; batch++) {
        const result = await call('fetchMessageBatch', { cursor: cursor.cursor }); check(result.success, 'Native history batch failed')
        for (const row of result.rows || []) {
          const db = String(row._db_path || row.db_path || '').replaceAll('\\', '/').toLowerCase(), at = db.lastIndexOf('/db_storage/')
          const table = String(row._table_name || row.table_name || row.source_table_name || row.sourceTableName || '').toLowerCase()
          const local = String(row.local_id ?? row.localIdRaw ?? row.localId ?? '')
          check(at >= 0 && table && /^\d+$/.test(local) && local !== '0', 'Native row lacks exact physical identity')
          const identity = `${db.slice(at + 1)}\0${table}\0${local.replace(/^0+(?=\d)/, '')}`
          physical.push(digest(identity))
          const comparable = Object.fromEntries(Object.entries(row).filter(([key]) => !/db.?path|table.?name/i.test(key)).sort(([a], [b]) => a.localeCompare(b)))
          content.push(digest(identity + '\0' + JSON.stringify(comparable))); count++; rowsForSession++
        }
        if (!result.hasMore) break
        check(batch < 9999, 'Native history paging limit exceeded')
      } } finally { await call('closeMessageCursor', { cursor: cursor.cursor }) }
      if (rowsForSession) nonempty++
    }
    await call('close')
    physical.sort(); content.sort()
    return { sessions: sessionIds.length, nonempty, messages: count, duplicatePhysicalIdentities: physical.length - new Set(physical).size,
      sessionDigest: digest(JSON.stringify(sessionIds)), identityDigest: digest(JSON.stringify(physical)), contentDigest: digest(JSON.stringify(content)) }
  }
  const baseline = await census(material.baselineDir, material.baselineKey)
  record('native-existing-key-baseline', baseline)
  const mirror = await census(material.mirrorDir, material.mirrorKey)
  record('native-scan-mirror-census', mirror)
  check(JSON.stringify(baseline) === JSON.stringify(mirror), 'Mirror differs from same-copy native baseline')
  check(baseline.messages > 0 && baseline.duplicatePhysicalIdentities === 0, 'Empty or duplicate native history census')
  // IPC completion does not mean the OS has released database handles yet.
  // Wait for this exact owned process before moving the private account roots.
  const hostExited = new Promise(resolve => worker.once('exit', resolve))
  await call('shutdown'); worker.kill()
  await Promise.race([hostExited, new Promise(resolve => setTimeout(resolve, 10000))])
  check(worker.exitCode !== null || worker.signalCode !== null, 'Native host did not exit before private export preparation')
  worker = undefined
  if (exportRequested) {
    receipt.exports = runScanExports({ root, scratch, layout, material, account, config, host, nativeIdentityDigest: mirror.identityDigest })
    check(receipt.exports.ok, 'Production scan mirror export acceptance failed')
    receipt.productionExportsProven = receipt.exports.productionExportsProven
    receipt.mediaOpeningProven = receipt.exports.mediaOpeningProven
    receipt.exportSourceInputsUnchanged = Object.entries(receipt.exportSourceInputs).every(([file, expected]) => hash(path.resolve(root, file)) === expected)
    check(receipt.exportSourceInputsUnchanged, 'Export source inputs changed during acceptance')
  }
  receipt.realProfileUnchanged = protectedFiles.every((file, i) => hash(file) === profileBefore[i])
  check(receipt.realProfileUnchanged, 'Real profile changed')
  receipt.ok = true
} catch (error) {
  receipt.ok = false
  receipt.error = /^[a-zA-Z0-9 /;,-]+$/.test(error.message) ? error.message : 'Private verification failed; details withheld'
  receipt.errorCode = /^[A-Z_0-9]{1,64}$/.test(error.code || '') ? error.code : null
  process.exitCode = 1
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const exited = new Promise(resolve => worker.once('exit', resolve))
    worker.kill(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))])
  }
  deployment?.cleanup()
  if (protectedFiles.length === 2 && profileBefore.length === 2) {
    receipt.realProfileUnchanged = protectedFiles.every((file, i) => hash(file) === profileBefore[i])
    if (!receipt.realProfileUnchanged) { receipt.ok = false; process.exitCode = 1 }
  }
  if (receipt.exportSourceInputs) {
    receipt.exportSourceInputsUnchanged = Object.entries(receipt.exportSourceInputs).every(([file, expected]) => hash(path.resolve(root, file)) === expected)
    if (!receipt.exportSourceInputsUnchanged) { receipt.ok = false; process.exitCode = 1 }
  }
  check(path.dirname(path.resolve(scratch)) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('weport-v13-scan-mirror-'), 'Unexpected cleanup path')
  try { await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }) }
  catch { receipt.cleanupError = 'Private scratch cleanup failed' }
  receipt.cleanup = !fs.existsSync(scratch)
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true }); fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ ok: receipt.ok, cleanup: receipt.cleanup, error: receipt.error, receipt: path.relative(root, receiptFile) }))
}
