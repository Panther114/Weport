// Actual production facade acceptance, called only by the private scan-mirror harness.
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)

export async function prepareScanExports(root, scratch) {
  const { build } = require('esbuild')
  const built = await build({ stdin: { contents: `export { ExportServiceFacade } from './electron/services/export'; export { chatService } from './electron/services/chatService'; export { wcdbService } from './electron/services/wcdbService'; export { ConfigService } from './electron/services/config'; export { isNoLoginDbKeyScanEnabled } from './electron/services/v12StablePolicy'`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', metafile: true, outfile: path.join(scratch, 'export-helpers.cjs'), logLevel: 'silent',
    plugins: [{ name: 'explicit-production-dependencies', setup(b) { b.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path === 'electron' || args.path.startsWith('node:') || builtinModules.includes(args.path)) return { path: args.path, external: true }
      try { return { path: require.resolve(args.path, { paths: [root] }), external: true } }
      catch { return { path: args.path, external: true } } // Preserve optional try/catch requires.
    }) } }] })
  fs.writeFileSync(path.join(scratch, 'export-runner.cjs'), String.raw`
const { app, nativeImage, safeStorage, BrowserWindow }=require('electron')
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
app.setPath('userData',path.join(__dirname,'export-profile'));app.on('window-all-closed',()=>{})
console.log=console.warn=console.error=()=>{}
let stage='ready',h
const check=(v,label)=>{if(!v){const error=Error(label);error.acceptanceCode=label.toUpperCase().replace(/[^A-Z0-9]+/g,'_');throw error}}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
let windowsCreated=0
app.on('browser-window-created',()=>{windowsCreated++;app.exit(1)})
const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]):[]
app.whenReady().then(async()=>{
 const m=JSON.parse(fs.readFileSync(path.join(__dirname,'export-material.json')))
 process.env.WEPORT_WCDB_HOST_EXE=m.hostExe;process.env.WEPORT_RESOURCES_PATH=m.resourcesPath
 process.env.WEPORT_USER_DATA_PATH=app.getPath('userData')
 h=require('./export-helpers.cjs');check(!h.isNoLoginDbKeyScanEnabled('win32'),'production scan unexpectedly enabled')
 const privateConfig=new h.ConfigService();privateConfig.set('cachePath',path.join(__dirname,'export-cache'))
 check(!privateConfig.get('dbPath')&&!privateConfig.get('myWxid'),'private reader account must remain empty')
 h.wcdbService.setPaths(m.resourcesPath,app.getPath('userData'));h.wcdbService.setLogEnabled(false)
 const decrypt=v=>typeof v!=='string'?v:v.startsWith('safe:')?safeStorage.decryptString(Buffer.from(v.slice(5),'base64')):v.startsWith('lock:')?'':v
 const imageAesKey=decrypt(m.imageAesKey),imageXorKey=decrypt(m.imageXorKey)
 const results=[], mediaCandidates=[]
 const imageGroups=new Map(),attachments=path.join(m.originalAccount,'msg','attach')
 for(const file of walk(attachments)){const match=path.basename(file).match(/^([a-f\d]{32})(_h|_t)?\.dat$/i);if(match){const key=match[1].toLowerCase(),files=imageGroups.get(key)||[];files.push(file);imageGroups.set(key,files)}}
 const contentComparisons=new Map(), txtComparisons=new Map()
 const facade=new h.ExportServiceFacade()
 for(const [label,accountDir,key] of [['baseline',m.baselineDir,m.baselineKey],['scan-mirror',m.mirrorDir,m.mirrorKey]]){
  stage=label+'-connect'
  // Keep persisted reader account settings empty: the production runtime must
  // reach the reader's owned image service, not silently use global config.
  await h.chatService.close();facade.setRuntimeConfig({dbPath:path.dirname(accountDir),accountDir,myWxid:m.myWxid,decryptKey:key,imageAesKey,imageXorKey,resourcesPath:m.resourcesPath,appPath:m.appPath,isPackaged:true})
  check((await h.chatService.connect()).success,'production chat connection failed')
  const sessions=await h.chatService.getSessions();check(sessions.success,'production session query failed')
  const nativeSessions=await h.wcdbService.getSessions();check(nativeSessions.success,'native session query failed')
  const sessionIds=[...new Set([...sessions.sessions.map(s=>s.username),...nativeSessions.sessions.map(s=>s.username||s.user_name||s.userName)])].sort()
  check(sessionIds.length>0&&sessionIds.every(id=>typeof id==='string'&&id.length),'union session IDs unavailable')
  // ChatService includes official/history-only sessions absent from native getSessions.
  // Census the IDENTICAL union before comparing production export identities.
  stage=label+'-native-union-census'
  const nativeIdentities=[];let nativeCount=0
  for(const sessionId of sessionIds){
   const count=await h.wcdbService.getMessageCount(sessionId);check(count.success,'union native message count failed')
   if(count.count===0)continue
   const cursor=await h.wcdbService.openMessageCursor(sessionId,500,true,0,0);check(cursor.success&&cursor.cursor,'union native cursor failed')
   let collected=0
   try{for(let batch=0;batch<10000;batch++){
    const data=await h.wcdbService.fetchMessageBatch(cursor.cursor);check(data.success,'union native batch failed')
    for(const row of data.rows||[]){
     const db=String(row._db_path||row.db_path||'').replaceAll('\\','/').toLowerCase(),at=db.lastIndexOf('/db_storage/')
     const table=String(row._table_name||row.table_name||row.source_table_name||row.sourceTableName||'').toLowerCase()
     const local=String(row.local_id??row.localIdRaw??row.localId??'')
     check(at>=0&&table&&/^\d+$/.test(local)&&local!=='0','union row lacks physical identity')
     nativeIdentities.push(hash(db.slice(at+1)+'\0'+table+'\0'+local.replace(/^0+(?=\d)/,'')));collected++
    }
    if(!data.hasMore)break
    check(batch<9999,'union native paging limit exceeded')
   }}finally{await h.wcdbService.closeMessageCursor(cursor.cursor)}
   check(collected===count.count,'union native cursor count mismatch');nativeCount+=collected
  }
  nativeIdentities.sort();check(new Set(nativeIdentities).size===nativeIdentities.length,'duplicate union native identity')
  const unionIdentityDigest=hash(JSON.stringify(nativeIdentities))
  const options={format:'json',exportMedia:false,exportAvatars:false,exportVoiceAsText:false,exportConflictStrategy:'overwrite',verifyAfterExport:false,exportConcurrency:1,sessionLayout:'shared',exportWriteLayout:'B'}
  stage=label+'-json-export'
  const json=await facade.exportSessions(sessionIds,path.join(__dirname,'exports',label,'json'),options)
  check(json.success&&json.failCount===0,'production JSON export failed')
  const identities=[];let messages=0,nonempty=0
  for(const sessionId of sessionIds){
   const artifact=json.sessionOutputPaths?.[sessionId];if(!artifact)continue
   const doc=JSON.parse(fs.readFileSync(artifact,'utf8')),rows=doc.messages||[]
   if(!rows.length)continue;messages+=rows.length;nonempty++
   for(const row of rows){check(/^[a-f\d]{64}$/.test(row.sourceIdentityHash||''),'export lacks physical source identity');identities.push(row.sourceIdentityHash)}
   const serialized=hash(JSON.stringify(rows))
   if(label==='baseline')contentComparisons.set(sessionId,serialized);else check(contentComparisons.get(sessionId)===serialized,'mirror JSON content differs from same-copy baseline')
   if(label==='baseline'&&mediaCandidates.length<3){
    let offset=0
    for(let page=0;page<1000&&mediaCandidates.length<3;page++){
     const read=await h.chatService.getMessages(sessionId,offset,500,0,0,true);check(read.success,'production media candidate reader failed')
     for(const row of read.messages||[]){if(row.localType!==3)continue
      const stems=[row.imageMd5,row.imageDatName].map(v=>String(v||'').toLowerCase().replace(/(?:_h|_t)?\.dat$/,''))
      const files=[...new Set(stems.flatMap(stem=>imageGroups.get(stem)||[]))]
      const tier=files.some(f=>/_h\.dat$/i.test(f))?'original':files.some(f=>!/_t\.dat$/i.test(f))?'display':files.length?'thumbnail':null
      if(tier&&!mediaCandidates.some(s=>s.tier===tier)){mediaCandidates.push({sessionId,row,files,tier});if(mediaCandidates.length>=3)break}
     }
     if(!read.hasMore)break;const next=read.nextOffset??offset+(read.messages||[]).length;check(next>offset,'production reader cursor did not advance');offset=next
    }
   }
  }
  stage=label+'-json-identity-audit'
  identities.sort();check(messages===nativeCount&&hash(JSON.stringify(identities))===unionIdentityDigest,'export/native union physical history mismatch');check(new Set(identities).size===identities.length,'duplicate export identity')
  stage=label+'-txt-export'
  const txt=await facade.exportSessions(sessionIds,path.join(__dirname,'exports',label,'txt'),{...options,format:'txt'})
  check(txt.success&&txt.failCount===0,'production TXT export failed')
  let txtFiles=0,txtBytes=0
  for(const sessionId of sessionIds){const file=txt.sessionOutputPaths?.[sessionId];if(!file)continue;const bytes=fs.readFileSync(file);check(bytes.length>0,'empty TXT artifact');txtFiles++;txtBytes+=bytes.length
   if(label==='baseline')txtComparisons.set(sessionId,hash(bytes));else check(txtComparisons.get(sessionId)===hash(bytes),'mirror TXT bytes differ from same-copy baseline')
  }
  const media=[]
  stage=label+'-media'
  for(const sample of mediaCandidates){
   for(const source of sample.files){const target=path.join(accountDir,path.relative(m.originalAccount,source));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);check(hash(fs.readFileSync(source))===hash(fs.readFileSync(target)),'source media changed while copying')}
   const row=sample.row,normalizedDb=String(row._db_path).replace(m.baselineDir,accountDir)
   const identity={sessionId:sample.sessionId,localId:String(row.localIdRaw??row.localId),ts:row.createTime,db:normalizedDb,table:row._table_name,idKind:'local'}
   const decoded=await h.chatService.getImageDataByIdentity(identity,{excludeThumbnail:false})
   const item={tier:sample.tier,encryptedFiles:sample.files.length,opened:decoded.success}
   if(decoded.success&&decoded.data){const bytes=Buffer.from(decoded.data,'base64'),image=nativeImage.createFromBuffer(bytes),size=image.getSize();check(!image.isEmpty()&&size.width>0&&size.height>0,'decoded media is not an image')
    Object.assign(item,{bytes:bytes.length,sha256:hash(bytes),width:size.width,height:size.height})
    const dir=path.join(__dirname,'exports',label,'media',sample.tier)
    const exported=await facade.exportSessions([sample.sessionId],dir,{...options,format:'json',archiveMode:true,contentType:'image',dateRange:{start:row.createTime,end:row.createTime},exportMedia:true,exportImages:true,exportVoices:false,exportVideos:false,exportFiles:false,exportEmojis:false})
    check(exported.success&&exported.failCount===0,'production image export failed')
    const document=JSON.parse(fs.readFileSync(exported.sessionOutputPaths[sample.sessionId],'utf8'))
    const sourceHash=hash(String(row._db_path).replaceAll('\\','/').toLowerCase().split('/db_storage/').slice(-1).map(v=>'db_storage/'+v)[0]+'\0'+String(row._table_name).toLowerCase()+'\0'+String(row.localIdRaw??row.localId).replace(/^0+(?=\d)/,''))
    const exact=document.messages.filter(v=>v.sourceIdentityHash===sourceHash);check(exact.length===1,'image export physical identity mismatch')
    check(walk(dir).some(f=>hash(fs.readFileSync(f))===item.sha256),'exported image differs from opened image');item.exportedExactBytes=true
   }else item.failureKind=/密钥|key/i.test(decoded.error||'')?'image-key-unavailable':/未找到|不存在|无法定位|not found/i.test(decoded.error||'')?'local-file-not-resolved':'decode-or-resolution-failed'
   media.push(item)
  }
  results.push({label,sessions:sessionIds.length,nativeSessionCount:nativeSessions.sessions.length,sessionDigest:hash(JSON.stringify(sessionIds)),nonempty,messages,nativeUnionMessages:nativeCount,nativeUnionIdentityDigest:unionIdentityDigest,jsonFiles:json.successCount,txtFiles,txtBytes,identityDigest:hash(JSON.stringify(identities)),jsonContentMatchesBaseline:true,txtBytesMatchBaseline:true,media})
 }
 check(results[0].media.length===results[1].media.length,'media sample count mismatch')
 check(results[0].sessionDigest===results[1].sessionDigest&&results[0].identityDigest===results[1].identityDigest&&results[0].messages===results[1].messages,'baseline mirror union census mismatch')
 check(JSON.stringify(results[0].media)===JSON.stringify(results[1].media),'scan mirror media differs from baseline')
 await h.chatService.close();await h.wcdbService.shutdown()
 check(windowsCreated===0&&BrowserWindow.getAllWindows().length===0,'window invariant failed')
 check(!privateConfig.get('dbPath')&&!privateConfig.get('myWxid'),'private reader account changed')
 fs.writeFileSync(path.join(__dirname,'export-result.json'),JSON.stringify({results,persistedReaderAccountEmpty:true,windowsCreated,windows:BrowserWindow.getAllWindows().length,productionScannerDisabled:!h.isNoLoginDbKeyScanEnabled('win32'),productionExportsProven:true,mediaOpeningProven:results[1].media.some(m=>m.opened&&m.exportedExactBytes)}))
 app.exit(0)
}).catch(async e=>{try{await h?.wcdbService.shutdown()}catch{}const frames=[...String(e.stack||'').matchAll(/(export-helpers\.cjs|export-runner\.cjs):(\d+):(\d+)/g)].slice(0,4).map(m=>({file:m[1],line:Number(m[2]),column:Number(m[3])}));fs.writeFileSync(path.join(__dirname,'export-failure.json'),JSON.stringify({stage,name:e.name,code:/^[A-Z_0-9]{1,64}$/.test(e.code||'')?e.code:null,assertion:e.acceptanceCode||null,frames,reason:e.acceptanceCode?e.message:'helper failed; private details withheld'}));app.exit(1)})
`)
  const files = [...Object.keys(built.metafile.inputs).filter(file => file !== '<stdin>'), 'scripts/verify-v13-scan-exports.mjs', 'package.json', 'package-lock.json']
  return Object.fromEntries(files.sort().map(file => [file.replaceAll('\\', '/'), createHash('sha256').update(fs.readFileSync(path.resolve(root, file))).digest('hex')]))
}

export function runScanExports({ root, scratch, layout, material, account, config, host, nativeIdentityDigest }) {
  const accountName = path.basename(account)
  const destinations = [path.join(scratch, 'export-baseline', accountName), path.join(scratch, 'export-mirror', accountName)]
  for (const [index, source] of [material.baselineDir, material.mirrorDir].entries()) {
    fs.mkdirSync(path.dirname(destinations[index]), { recursive: true }); fs.renameSync(source, destinations[index])
  }
  const profile = path.join(scratch, 'export-profile'); fs.mkdirSync(profile)
  fs.copyFileSync(path.join(scratch, 'profile', 'Local State'), path.join(profile, 'Local State'))
  const accountConfig = config.wxidConfigs?.[config.myWxid] || {}
  fs.writeFileSync(path.join(scratch, 'export-material.json'), JSON.stringify({ ...material, baselineDir: destinations[0], mirrorDir: destinations[1], originalAccount: account,
    myWxid: config.myWxid, imageAesKey: accountConfig.imageAesKey ?? config.imageAesKey, imageXorKey: accountConfig.imageXorKey ?? config.imageXorKey,
    nativeIdentityDigest, hostExe: host, appResources: layout.appResources, resourcesPath: layout.payloadRoot, appPath: path.join(layout.appResources, 'app.asar') }))
  // Exercise the existing development script-path seam with the exact packaged
  // host script; never mutate Electron's process.resourcesPath or the package.
  const hostScriptDir = path.join(scratch, 'dist-electron'); fs.mkdirSync(hostScriptDir, { recursive: true })
  fs.copyFileSync(path.join(layout.appResources, 'host', 'wcdbHost.js'), path.join(hostScriptDir, 'wcdbHost.js'))
  const env = { ...process.env, NODE_PATH: path.join(layout.appResources, 'host', 'libs'), WEPORT_DEV_MODE: '1', WEPORT_PROBE_OFFSCREEN: '1', WEPORT_USER_DATA_PATH: profile }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawnSync(require('electron'), [path.join(scratch, 'export-runner.cjs'), `--user-data-dir=${profile}`], { cwd: scratch, env, windowsHide: true, stdio: 'ignore', timeout: 900000 })
  if (fs.existsSync(path.join(scratch, 'export-failure.json'))) return { ok: false, failure: JSON.parse(fs.readFileSync(path.join(scratch, 'export-failure.json'))) }
  if (child.status !== 0) return { ok: false, failure: { stage: 'export-child', reason: 'private export helper failed or timed out' } }
  return { ok: true, ...JSON.parse(fs.readFileSync(path.join(scratch, 'export-result.json'))) }
}
