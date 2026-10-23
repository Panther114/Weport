import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const root = process.cwd(), require = createRequire(path.join(root, 'package.json'))
const { _electron } = require('playwright-core')
const out = path.join(root, '.ui-probe', 'v13-archive-acceptance')
fs.mkdirSync(out, { recursive: true })
if(fs.existsSync(path.join(out,'real-export.json')))fs.copyFileSync(path.join(out,'real-export.json'),path.join(out,`prior-${Date.now()}.json`))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-v13-archive-private-'))
const profile = path.join(scratch, 'profile'); fs.mkdirSync(profile)
const realProfile = path.join(process.env.APPDATA, 'weport')
const config = JSON.parse(fs.readFileSync(path.join(realProfile, 'Weport-config.json'), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = file => hash(fs.readFileSync(file))
const protectedBefore = Object.fromEntries(['Weport-config.json','Local State'].map(n => [n, fileHash(path.join(realProfile,n))]))
const executable = path.resolve(process.env.WEPORT_ARCHIVE_EXECUTABLE || path.join(root,'release','win-unpacked','Weport.exe'))
const result = { checkedAt: new Date().toISOString(), scope: 'existing-account-key export baseline; not a V1.3 archive library', executableSha256: fileHash(executable), cases: [], errors: [], privateCleanupVerified: false }
result.integrityFailures=[]
const asar=path.join(path.dirname(executable),'resources','app.asar');if(fs.existsSync(asar))result.appAsarSha256=fileHash(asar)
const record = (name, data = {}) => { result.cases.push({name, ...data}); fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify({name, ...data})) }
const dirs = [config.dbPath, path.join(config.dbPath, config.myWxid)]
if (fs.existsSync(config.dbPath)) for (const n of fs.readdirSync(config.dbPath, {withFileTypes:true})) {
  if (n.isDirectory() && (n.name === config.myWxid || n.name.startsWith(config.myWxid + '_'))) dirs.push(path.join(config.dbPath,n.name))
}
const account = dirs.find(d => fs.existsSync(path.join(d,'db_storage','session','session.db')) || fs.existsSync(path.join(d,'db_storage','session.db')))
assert(account, 'Saved account directory unavailable')
const source = path.join(account,'db_storage'), copiedAccount = path.join(scratch,'accounts',path.basename(account))
const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)])
let app
try {
  const files = walk(source).filter(f => /\.db(?:-wal)?$/i.test(f))
  const signature = () => Object.fromEntries(files.map(f => { const s=fs.statSync(f); return [path.relative(source,f),`${s.size}|${s.mtimeMs}|${s.ctimeMs}`] }))
  const before=signature(); let bytes=0
  for (const f of files) {
    const dest=path.join(copiedAccount,'db_storage',path.relative(source,f)); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(f,dest)
    assert.equal(fileHash(dest),fileHash(f),'Source changed while copying'); bytes+=fs.statSync(dest).size
  }
  assert.deepEqual(signature(),before,'Live database changed during snapshot; retry required')
  record('stable-real-account-copy',{files:files.length,bytes})
  Object.assign(config,{dbPath:path.dirname(copiedAccount),myWxid:path.basename(copiedAccount),exportPath:path.join(scratch,'exports'),
    cachePath:path.join(scratch,'cache'),
    messagePushEnabled:false,antiRevokeAutoApplyNewGroups:false,mcpEnabled:false,httpApiEnabled:false,launchAtStartup:false,
    appearanceBackgroundPath:'',logEnabled:false})
  fs.copyFileSync(path.join(realProfile,'Local State'),path.join(profile,'Local State'))
  fs.writeFileSync(path.join(profile,'Weport-config.json'),JSON.stringify(config))
  app=await _electron.launch({executablePath:executable,args:['--background',`--user-data-dir=${profile}`],
    env:{...process.env,WEPORT_PROBE_OFFSCREEN:'1',WEPORT_NATIVE_GLASS:'0',WEPORT_DISCARD_DELAY_MS:'1000'},timeout:90000})
  await app.evaluate(async ({app,BrowserWindow})=>{
    await app.whenReady(); while(!app.listenerCount('activate')) await new Promise(r=>setTimeout(r,25))
    const position=BrowserWindow.prototype.setPosition,show=BrowserWindow.prototype.showInactive
    BrowserWindow.prototype.show=BrowserWindow.prototype.showInactive=function(){position.call(this,-4000,0);show.call(this)}
    BrowserWindow.prototype.focus=function(){}; app.emit('activate')
  })
  let page=await app.firstWindow(); page.on('pageerror',()=>result.errors.push('RendererError'))
  await page.waitForFunction(()=>Boolean(window.electronAPI?.chat),null,{polling:100,timeout:60000})
  const connected=await page.evaluate(()=>window.electronAPI.chat.connect()); assert.equal(connected.success,true,connected.error)
  const sessions=await page.evaluate(async()=>{const r=await window.electronAPI.chat.getSessions(); if(!r.success)throw Error(r.error);return r.sessions.map(s=>s.username)})
  assert(sessions.length>0); record('native-real-account-connection',{sessions:sessions.length})
  const cutoff=Math.floor(Date.now()/1000)
  const options={format:'json',sessionIds:sessions,dateRange:{start:0,end:cutoff},exportMedia:false,exportAvatars:false,exportVoiceAsText:false,exportConflictStrategy:'overwrite',verifyAfterExport:false}
  const exportDir=path.join(scratch,'exports','full')
  const exported=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir:exportDir,options})
  assert.equal(exported.success,true,exported.error);assert.equal(exported.failCount,0)
  record('full-real-json-export',{successCount:exported.successCount,failCount:exported.failCount})
  const identity=m=>{
    let db=path.resolve(String(m._db_path||'')).replaceAll('\\','/').toLowerCase(); const i=db.split('/').lastIndexOf('db_storage'); if(i>=0) db=db.split('/').slice(i).join('/')
    const table=String(m._table_name||'').trim().toLowerCase(),id=String(m.localIdRaw??m.localId).replace(/^0+(?=\d)/,'')
    assert(db&&table&&id!=='0','Unscoped reader identity');return hash(`${db}\0${table}\0${id}`)
  }
  const reader=async(id,start=0,end=cutoff)=>{
    const rows=[];let offset=0
    for(let i=0;i<10000;i++){
      const r=await page.evaluate(({id,offset,start,end})=>window.electronAPI.chat.getMessages(id,offset,500,start,end,true),{id,offset,start,end})
      assert.equal(r.success,true,r.error);rows.push(...(r.messages||[]));if(!r.hasMore) return rows
      const next=r.nextOffset??offset+(r.messages||[]).length;assert(next>offset,'Reader cursor did not advance');offset=next
    }throw Error('Reader paging limit')
  }
  const imageGroups=new Map(),mediaSamples=new Map(),encryptedSourceDigests=new Map(),portableMediaChecks=[]
  const attachmentRoot=path.join(account,'msg','attach')
  if(fs.existsSync(attachmentRoot))for(const file of walk(attachmentRoot)){
    const match=path.basename(file).match(/^([a-f\d]{32})(_h|_t)?\.dat$/i);if(!match)continue
    const stem=match[1].toLowerCase(),groups=imageGroups.get(stem)||[]
    groups.push(file);imageGroups.set(stem,groups)
  }
  const chooseMedia=(sessionId,rows)=>{
    for(const row of rows){if(row.localType!==3)continue
      const stems=[row.imageMd5,row.imageDatName].map(v=>String(v||'').toLowerCase().replace(/(?:_h|_t)?\.dat$/,''))
      const files=[...new Set(stems.flatMap(s=>imageGroups.get(s)||[]))]
      const kind=files.some(f=>/_h\.dat$/i.test(f))?'original':files.some(f=>!/_t\.dat$/i.test(f))?'display':files.length?'thumbnail':'not-located'
      if(!mediaSamples.has(kind))mediaSamples.set(kind,{sessionId,row,files})
    }
  }
  let messages=0,nonempty=0,chosen,chosenRows=[]
  for(const id of sessions){
    const rows=await reader(id);chooseMedia(id,rows); const artifact=exported.sessionOutputPaths?.[id]
    if(!rows.length){assert(!artifact||!fs.existsSync(artifact),'Unexpected empty-session artifact');continue}
    assert(artifact&&fs.existsSync(artifact),'Missing nonempty session artifact')
    const doc=JSON.parse(fs.readFileSync(artifact,'utf8'));const entries=doc.messages
    assert.equal(entries.length,rows.length,'Reader/export count mismatch')
    const a=rows.map(identity).sort(),b=entries.map(m=>m.sourceIdentityHash).sort();assert.deepEqual(b,a,'Reader/export physical identities mismatch');assert.equal(new Set(b).size,b.length,'Duplicate identity')
    messages+=rows.length;nonempty++
    if(rows.length>chosenRows.length){chosen=id;chosenRows=rows}
    if(nonempty%20===0) console.log(JSON.stringify({progress:'identity-audit',nonempty,messages}))
  }
  assert(messages>0);record('all-session-reader-export-identity',{sessions:sessions.length,nonempty,messages,missing:0,extra:0,duplicates:0})
  for(const [tier,sample] of mediaSamples){
    let encryptedBytes=0
    for(const file of sample.files){const dest=path.join(copiedAccount,path.relative(account,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);const digest=fileHash(file);assert.equal(fileHash(dest),digest);encryptedSourceDigests.set(file,digest);encryptedBytes+=fs.statSync(dest).size}
    const row=sample.row,request={sessionId:sample.sessionId,localId:String(row.localIdRaw??row.localId),ts:row.createTime,db:row._db_path,table:row._table_name,idKind:'local'}
    const decoded=await page.evaluate(async identity=>{const r=await window.electronAPI.chat.getImageDataByIdentity(identity,{excludeThumbnail:true});return {success:r.success,data:r.data,failureKind:r.success?undefined:/密钥|key/i.test(r.error||'')?'image-key-unavailable':/未找到|不存在|无法定位|not found/i.test(r.error||'')?'local-file-not-resolved':'decode-or-resolution-failed'}},request)
    const receipt={candidateTier:tier,encryptedFilesCopied:sample.files.length,encryptedBytes,readerDecodeSuccess:decoded.success,failureKind:decoded.failureKind}
    if(decoded.success&&decoded.data){
      const bytes=Buffer.from(decoded.data,'base64'),decodedHash=hash(bytes)
      const dimensions=await app.evaluate(({nativeImage},base64)=>{const image=nativeImage.createFromBuffer(Buffer.from(base64,'base64'));return {empty:image.isEmpty(),...image.getSize()}},decoded.data)
      assert(!dimensions.empty&&dimensions.width>0&&dimensions.height>0,'Decoded sample is not a usable image')
      Object.assign(receipt,{decodedBytes:bytes.length,decodedSha256:decodedHash,width:dimensions.width,height:dimensions.height})
      const cacheMatches=fs.existsSync(path.join(scratch,'cache'))?walk(path.join(scratch,'cache')).filter(f=>fileHash(f)===decodedHash):[]
      receipt.decodedCacheTiers=[...new Set(cacheMatches.map(f=>/_hd\.[^.]+$/i.test(f)?'original':/(?:_t|_thumb)\.[^.]+$/i.test(f)?'thumbnail':'display-or-other'))]
      const dir=path.join(scratch,'exports','media-'+tier)
      const mediaExport=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir,options:{...options,sessionIds:[sample.sessionId],contentType:'image',dateRange:{start:row.createTime,end:row.createTime},exportMedia:true,exportImages:true,exportVoices:false,exportVideos:false,exportEmojis:false,exportFiles:false,exportPathStyle:'posix'}})
      assert.equal(mediaExport.success,true);assert.equal(mediaExport.failCount,0)
      const doc=JSON.parse(fs.readFileSync(mediaExport.sessionOutputPaths[sample.sessionId],'utf8'))
      const exactSourceIdentityPreserved=doc.messages.some(m=>m.sourceIdentityHash===identity(row))
      if(!exactSourceIdentityPreserved)result.integrityFailures.push('Image export lost source identity: '+tier)
      const exportedFiles=walk(dir).filter(f=>fileHash(f)===decodedHash)
      if(!exportedFiles.length)result.integrityFailures.push('No exported image matches reader decoded bytes: '+tier)
      Object.assign(receipt,{exportSuccess:true,exportMatchesDecodedSha256:exportedFiles.length>0,exactSourceIdentityPreserved,exportedMessages:doc.messages.length,exportedMessagesWithIdentity:doc.messages.filter(m=>Boolean(m.sourceIdentityHash)).length})
    }else{
      const dir=path.join(scratch,'exports','media-'+tier)
      const attempted=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir,options:{...options,sessionIds:[sample.sessionId],contentType:'image',dateRange:{start:row.createTime,end:row.createTime},exportMedia:true,exportImages:true,exportVoices:false,exportVideos:false,exportEmojis:false,exportFiles:false}})
      Object.assign(receipt,{exportSuccess:attempted.success,exportFailCount:attempted.failCount,imageKeyMissingFiles:attempted.imageKeyMissingFiles??0})
    }
    record('message-linked-image-sample',receipt)
    if (process.argv.includes('--media-policy')) {
      for (const mediaPolicy of ['best-available', 'original-only']) {
        const directory = path.join(scratch, 'exports', `archive-policy-${tier}-${mediaPolicy}`)
        const exportedPolicy = await page.evaluate(({ directory, options }) => window.electronAPI.export.exportSessions(directory, options), {
          directory, options: { ...options, sessionIds: [sample.sessionId], dateRange: { start: row.createTime, end: row.createTime },
            archiveMode: true, mediaPolicy, exportMedia: true, exportImages: true, exportVoices: true, exportVideos: true, exportFiles: true,
            exportEmojis: false, exportPathStyle: 'posix' },
        })
        assert.equal(exportedPolicy.success, true); assert.equal(exportedPolicy.failCount, 0)
        const artifact = exportedPolicy.sessionOutputPaths[sample.sessionId]
        const document = JSON.parse(fs.readFileSync(artifact, 'utf8'))
        const matches = document.messages.filter(message => message.sourceIdentityHash === identity(row))
        assert.equal(matches.length, 1, 'Media policy formatter lost exact physical source identity')
        const message = matches[0], outcome = message.mediaOutcome
        assert.equal(message.sourceIdentity.localId, String(row.localIdRaw ?? row.localId))
        assert(['original', 'display', 'thumbnail', 'missing-locally', 'decryption-failed', 'original-unavailable'].includes(outcome.status))
        let verifiedMediaBytes = 0
        if (outcome.relativePath) {
          assert(['original', 'display', 'thumbnail'].includes(outcome.status))
          if (mediaPolicy === 'original-only') assert.equal(outcome.status, 'original')
          const mediaPath = path.resolve(path.dirname(artifact), outcome.relativePath)
          assert(!path.relative(directory, mediaPath).startsWith('..'))
          assert(fs.existsSync(mediaPath)); verifiedMediaBytes = fs.statSync(mediaPath).size
          assert(verifiedMediaBytes > 0)
          if (decoded.success && decoded.data) assert.equal(fileHash(mediaPath), hash(Buffer.from(decoded.data, 'base64')))
        } else assert(!['original', 'display', 'thumbnail'].includes(outcome.status))
        record('real-archive-media-policy-formatter', { candidateTier: tier, mediaPolicy, status: outcome.status, exactIdentity: true,
          messagesInBoundedSecond: document.messages.length, verifiedMediaBytes })
      }
      if (tier !== 'not-located') {
        const accountId = await page.evaluate(() => window.electronAPI.dataAccess.currentAccount())
        const created = await page.evaluate(request => window.electronAPI.archive.create(request), {
          accountId, sessionIds: [sample.sessionId], destination: path.join(scratch, 'bounded-media-library'),
          dateRange: { start: row.createTime, end: row.createTime }, includeMedia: true, mediaPolicy: 'best-available',
        })
        assert.equal(created.success, true, 'Bounded real-media portable archive failed')
        const opened = await page.evaluate(id => window.electronAPI.archive.open(id), created.data.archiveId)
        assert.equal(opened.success, true)
        const media = await page.evaluate(({ id, sessionId, identity }) => window.electronAPI.archive.media(id, sessionId, identity),
          { id: created.data.archiveId, sessionId: sample.sessionId, identity: identity(row) })
        assert.equal(media.success, true)
        const restored = await page.evaluate(({ id, destination }) => window.electronAPI.archive.restore(id, destination),
          { id: created.data.archiveId, destination: scratch })
        assert.equal(restored.success, true); assert.equal(restored.data.verified, true)
        portableMediaChecks.push({ id: created.data.archiveId, sessionId: sample.sessionId, identity: identity(row), status: media.data.status, available: media.data.available })
        record('real-bounded-portable-media-copy', { candidateTier: tier, status: media.data.status,
          available: media.data.available, verifiedCopy: true, boundedSecond: true })
      }
    }
  }
  const midpoint=chosenRows[Math.floor(chosenRows.length/2)].createTime,d=new Date(midpoint*1000);d.setHours(0,0,0,0)
  const start=Math.floor(d.getTime()/1000);d.setDate(d.getDate()+1);const end=Math.floor(d.getTime()/1000)-1
  const filtered=chosenRows.filter(m=>m.createTime>=start&&m.createTime<=end)
  const ranged=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir:path.join(scratch,'exports','range'),options:{...options,sessionIds:[chosen],dateRange:{start,end}}})
  assert.equal(ranged.success,true,ranged.error);assert.equal(ranged.failCount,0)
  const rangedMessages=JSON.parse(fs.readFileSync(ranged.sessionOutputPaths[chosen],'utf8')).messages
  assert.deepEqual(rangedMessages.map(m=>m.sourceIdentityHash).sort(),filtered.map(identity).sort());record('inclusive-local-day-export',{messages:rangedMessages.length})
  const retryOptions={...options,sessionIds:[chosen],exportConflictStrategy:'incremental'}
  const retry=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir:exportDir,options:retryOptions})
  assert.equal(retry.success,true,retry.error);assert.equal(retry.failCount,0);record('incremental-repeat',{success:true})
  const chosenArtifact=exported.sessionOutputPaths[chosen], originalHash=fileHash(chosenArtifact)
  const normalizedArtifactHash=file=>{const doc=JSON.parse(fs.readFileSync(file,'utf8'));if(doc.weflow)delete doc.weflow.exportedAt;if(doc.chatlab)delete doc.chatlab.exportedAt;return hash(JSON.stringify(doc))}
  const originalNormalizedHash=normalizedArtifactHash(chosenArtifact)
  const ledgerFiles=walk(exportDir).filter(f=>path.basename(f)==='.weport-export-ledger.jsonl')
  const ledgers=()=>ledgerFiles.flatMap(f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)))
  assert(ledgerFiles.length>0,'Export ledger absent')
  const latest=new Map();for(const entry of ledgers()) if(entry.outputPath) latest.set(entry.outputPath,entry)
  for(const [file,entry] of latest){assert.equal(fs.statSync(file).size,entry.bytes,'Ledger size mismatch');assert.equal(fileHash(file),entry.sha256,'Ledger hash mismatch')}
  record('all-artifact-ledger-sha256',{artifacts:latest.size})
  const repeatBefore={hash:fileHash(chosenArtifact),mtime:fs.statSync(chosenArtifact).mtimeMs,records:ledgers().length}
  const repeatAgain=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir:exportDir,options:retryOptions})
  assert.equal(repeatAgain.success,true);assert.equal(fileHash(chosenArtifact),repeatBefore.hash);assert.equal(fs.statSync(chosenArtifact).mtimeMs,repeatBefore.mtime);assert.equal(ledgers().length,repeatBefore.records)
  record('incremental-verified-skip',{unchangedHash:true,unchangedMtime:true,noAdditionalLedgerEntries:true})
  fs.writeFileSync(chosenArtifact,'private probe damaged artifact')
  const repair=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir:exportDir,options:retryOptions})
  assert.equal(repair.success,true);assert.equal(repair.failCount,0);assert.deepEqual(JSON.parse(fs.readFileSync(chosenArtifact,'utf8')).messages.map(m=>m.sourceIdentityHash).sort(),chosenRows.map(identity).sort())
  assert.equal(normalizedArtifactHash(chosenArtifact),originalNormalizedHash,'Repaired artifact semantic payload changed')
  record('incremental-corrupt-artifact-recovery',{restoredIdentities:chosenRows.length,restoredOriginalBytes:fileHash(chosenArtifact)===originalHash,restoredNormalizedPayload:true})
  fs.appendFileSync(ledgerFiles[0],'{"v":1,"interrupted":')
  const recoverTail=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir:exportDir,options:retryOptions})
  assert.equal(recoverTail.success,true);assert.equal(recoverTail.failCount,0)
  record('truncated-ledger-tail-recovery',{success:true})
  const txt=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir:path.join(scratch,'exports','txt'),options:{...options,format:'txt'}})
  assert.equal(txt.success,true);assert.equal(txt.failCount,0)
  for(const file of Object.values(txt.sessionOutputPaths||{}))assert(fs.statSync(file).size>0,'Empty TXT artifact')
  record('full-real-txt-export',{successCount:txt.successCount,failCount:txt.failCount,artifacts:Object.keys(txt.sessionOutputPaths||{}).length})
  const cancel=await page.evaluate(async({dir,options})=>{
    const api=window.electronAPI;let requested=false;let cancelResult
    const unsub=api.export.onProgress(p=>{if(p.taskId&&!requested){requested=true;cancelResult=api.export.cancelTask(p.taskId)}})
    try{const r=await api.export.exportSessions(dir,options);return {requested,cancelResult:await cancelResult,result:{success:r.success,stopped:r.stopped,error:r.error,successCount:r.successCount,failCount:r.failCount},tasks:await api.task.status()}}finally{unsub()}
  },{dir:path.join(scratch,'exports','cancel'),options})
  assert(cancel.requested);assert.equal(cancel.cancelResult.success,true);assert(!Object.values(cancel.tasks).some(t=>t.status==='running'),'Task remained running after cancellation')
  assert.equal(cancel.result.stopped,true);assert(Object.values(cancel.tasks).some(t=>t.status==='aborted'))
  const cancelledFiles=walk(path.join(scratch,'exports','cancel')).filter(f=>f.endsWith('.json')&&!path.basename(f).startsWith('.'))
  const cancelledMessages=cancelledFiles.reduce((n,f)=>n+(JSON.parse(fs.readFileSync(f,'utf8')).messages?.length||0),0)
  assert.equal(cancelledMessages,0);record('real-export-cancellation',{requested:true,terminal:'aborted',remainingMessages:0})
  const postCancel=await page.evaluate(({dir,options})=>window.electronAPI.export.exportSessions(dir,options),{dir:path.join(scratch,'exports','after-cancel'),options:{...options,sessionIds:[chosen],dateRange:{start,end}}})
  assert.equal(postCancel.success,true);assert.equal(postCancel.failCount,0);record('retry-after-cancellation',{success:true})
  const closed=page.waitForEvent('close',{timeout:30000})
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.close()))
  await closed
  const restored=app.waitForEvent('window',{timeout:60000})
  await app.evaluate(({app})=>app.emit('activate'))
  page=await restored;page.on('pageerror',()=>result.errors.push('RendererError'))
  await page.waitForFunction(()=>Boolean(window.electronAPI?.task),null,{timeout:60000,polling:100})
  assert(!Object.values(await page.evaluate(()=>window.electronAPI.task.status())).some(t=>t.status==='running'))
  record('tray-restore-terminal-status',{phantomTasks:0})
  if (process.argv.includes('--library')) {
    const expectedRows = await reader(chosen, 0, 0)
    const currentAccountId = await page.evaluate(() => window.electronAPI.dataAccess.currentAccount())
    const created = await page.evaluate(request => window.electronAPI.archive.create(request), {
      accountId: currentAccountId, sessionIds: [chosen], destination: path.join(scratch, 'portable-library'), includeMedia: false, mediaPolicy: 'best-available',
    })
    assert.equal(created.success, true, 'Real archive library creation failed')
    const archiveId = created.data.archiveId
    const opened = await page.evaluate(id => window.electronAPI.archive.open(id), archiveId)
    assert.equal(opened.success, true, 'Real archive manifest verification failed')
    assert.equal(opened.data.manifest.sessions[0].count, expectedRows.length)
    const archived = JSON.parse(fs.readFileSync(path.join(created.data.path, opened.data.manifest.sessions[0].path), 'utf8')).messages
    assert.deepEqual(archived.map(row => row.sourceIdentityHash).sort(), expectedRows.map(identity).sort())
    record('real-portable-archive-exact-identities', { messages: archived.length, missing: 0, extra: 0, duplicates: 0 })
    await page.evaluate(async () => {
      await window.electronAPI.chat.close()
      for (const key of ['dbPath', 'myWxid', 'decryptKey']) await window.electronAPI.config.set(key, '')
    })
    await app.close(); app = undefined
    app = await _electron.launch({ executablePath: executable, args: ['--background', `--user-data-dir=${profile}`],
      env: { ...process.env, WEPORT_PROBE_OFFSCREEN: '1', WEPORT_NATIVE_GLASS: '0' }, timeout: 90000 })
    await app.evaluate(async ({ app, BrowserWindow }) => {
      await app.whenReady(); while (!app.listenerCount('activate')) await new Promise(resolve => setTimeout(resolve, 25))
      const position = BrowserWindow.prototype.setPosition, show = BrowserWindow.prototype.showInactive
      BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive = function () { position.call(this, -4000, 0); show.call(this) }
      BrowserWindow.prototype.focus = function () {}; app.emit('activate')
    })
    page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.electronAPI?.archive), null, { timeout: 60000 })
    const offline = await page.evaluate(async ({ archiveId, sessionId }) => ({
      accountId: await window.electronAPI.config.get('myWxid'),
      open: await window.electronAPI.archive.open(archiveId),
      page: await window.electronAPI.archive.page(archiveId, sessionId, 0, 80),
    }), { archiveId, sessionId: chosen })
    assert.equal(offline.accountId, '')
    assert.equal(offline.open.success, true); assert.equal(offline.page.success, true)
    assert.equal(offline.page.data.total, archived.length)
    assert.equal(offline.page.data.messages.length, Math.min(80, archived.length))
    assert.deepEqual(offline.page.data.messages.map(row => row.sourceIdentityHash), archived.slice(0, 80).map(row => row.sourceIdentityHash))
    record('real-portable-archive-offline-restart', { configuredAccount: false, readableMessages: offline.page.data.messages.length, totalMessages: archived.length })
    for (const expected of portableMediaChecks) {
      const actual = await page.evaluate(async expected => ({ open: await window.electronAPI.archive.open(expected.id),
        media: await window.electronAPI.archive.media(expected.id, expected.sessionId, expected.identity) }), expected)
      assert.equal(actual.open.success, true); assert.equal(actual.media.success, true)
      assert.equal(actual.media.data.status, expected.status); assert.equal(actual.media.data.available, expected.available)
      record('real-portable-media-offline-restart', { status: expected.status, available: expected.available, configuredAccount: false })
    }
    result.scope = 'existing-account-key baseline plus V1.3 portable archive creation and offline restart'
  }
  result.liveWechatSourceAdvanced=JSON.stringify(signature())!==JSON.stringify(before)
  record('source-isolation',{stableAtCopy:true,liveWechatSourceAdvanced:result.liveWechatSourceAdvanced})
  assert([...encryptedSourceDigests].every(([file,digest])=>fileHash(file)===digest),'Sampled encrypted media source changed')
  record('sampled-encrypted-media-preservation',{files:encryptedSourceDigests.size,unchanged:true})
  assert.deepEqual(Object.fromEntries(Object.keys(protectedBefore).map(n=>[n,fileHash(path.join(realProfile,n))])),protectedBefore,'Real profile changed')
  record('real-profile-byte-preservation',{config:true,localState:true})
  assert.equal(result.errors.length,0);assert.equal(result.integrityFailures.length,0,'Media integrity gate failed');result.ok=true
}catch(e){result.ok=false;result.error='Verification assertion failed; private error details intentionally withheld';result.afterCase=result.cases.at(-1)?.name;result.errorCode=e.code||e.name;result.failedCheck=String(e.stack||'').split('\n').find(line=>line.includes('verify-v13-archive-real.mjs:'))?.trim().replaceAll(root,'<repo>');console.error(result.error);process.exitCode=1}
finally{
  if(app) await app.close().catch(()=>{})
  result.realProfileUnchanged=Object.keys(protectedBefore).every(n=>fileHash(path.join(realProfile,n))===protectedBefore[n])
  const resolved=path.resolve(scratch);assert(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('weport-v13-archive-private-'))
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5});result.privateCleanupVerified=!fs.existsSync(resolved)
  fs.writeFileSync(path.join(out,'real-export.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,privateCleanupVerified:result.privateCleanupVerified,receipt:path.join(out,'real-export.json')}))
}
