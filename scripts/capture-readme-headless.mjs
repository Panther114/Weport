/** Render the real built UI with existing synthetic fixtures, without starting the app engine.
 * No appMain import, profile copy, native databases, credentials, network or visible windows.
 * Browser plugin is unavailable; Playwright's Electron transport inspects this private renderer.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'

const root = resolve('.')
const output = resolve(process.env.WEPORT_README_OUT || '.ui-probe/readme-current')
mkdirSync(output, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'weport-readme-headless-'))
const source = readFileSync('electron/appMain.ts', 'utf8')
const ast = ts.createSourceFile('appMain.ts', source, ts.ScriptTarget.Latest, true)
// Reuse fixture declarations only, never evaluate app startup or service imports.
const fixtureNames = new Set(['demoConfigValue','demoAiSetup','demoAiChatData','demoAiNotes','demoAntiRevokeSessions','demoSessions','installScreenshotDemoHandlers','demoSnsAvatarUrl','demoSnsPosts','demoAnalyticsData','demoGroupData','demoDualReport','demoAnnualReport','installV09DemoHandlers'])
const fixtures = ast.statements.filter(node =>
  ts.isFunctionDeclaration(node) && fixtureNames.has(node.name?.text || '') ||
  ts.isVariableStatement(node) && node.declarationList.declarations.every(d => /^DEMO_/.test(d.name.getText(ast))))
  .map(node => {
    let text=node.getText(ast)
    // Exclude the packaged-dependency smoke hook, which imports real services.
    if(ts.isFunctionDeclaration(node) && node.name?.text==='installScreenshotDemoHandlers') {
      const first=node.body.statements[0]
      if(!ts.isIfStatement(first)||!first.getText(ast).includes('__weportPackageSmoke')) throw Error('Fixture boundary changed: review before capture')
      text=text.replace(first.getText(ast),'')
    }
    if(/\b(?:require\s*\(|import\s*\()/.test(text)) throw Error('Fixture imports are prohibited')
    return text
  }).join('\n')
const preload = join(work, 'preload.cjs')
await build({ entryPoints: ['electron/preload.ts'], outfile: preload, bundle: true, platform: 'node', external: ['electron'] })
const channels = [...readFileSync('electron/preload.ts', 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1])
const bootstrap = `
const {app,BrowserWindow,ipcMain,session,shell,desktopCapturer,clipboard}=require('electron');
const {join}=require('node:path');
const APP_VERSION=${JSON.stringify(JSON.parse(readFileSync('package.json')).version)};
const configService={getCacheBasePath:()=>${JSON.stringify(join(work, 'empty-cache'))},get:(key)=>({decryptKey:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',contentProtectionEnabled:false,silentStartup:false,windowCloseBehavior:'tray'}[key])};
const readdirSync=()=>[];
const toProtocolUrl=()=>'';
globalThis.__readmeWrite=(file,bytes)=>require('node:fs').writeFileSync(file,bytes);
process.env.WEPORT_UI_DEMO='0';
process.env.WEPORT_THEME_MODE='dark';
const missing=new Set(); globalThis.__readmeMissing=missing;
globalThis.__readmeCalls=[];
for(const channel of ${JSON.stringify([...new Set(channels)])}) ipcMain.handle(channel,()=>{missing.add(channel);return null});
${fixtures}
for(const method of ['show','showInactive','focus','moveTop','maximize','restore']) BrowserWindow.prototype[method]=function(){throw Error('Visible window operation blocked: '+method)};
shell.openExternal=async()=>{throw Error('External launch blocked')};
shell.openPath=async()=>{throw Error('External launch blocked')};
desktopCapturer.getSources=async()=>{throw Error('Desktop capture blocked')};
clipboard.writeText=()=>{throw Error('System clipboard blocked in documentation capture')};
app.on('window-all-closed',()=>{});
app.on('web-contents-created',(_e,wc)=>{wc.setWindowOpenHandler(()=>({action:'deny'}));wc.on('will-navigate',(event,url)=>{if(!url.startsWith('file://')&&!url.startsWith('about:'))event.preventDefault()})});
app.whenReady().then(async()=>{
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 session.defaultSession.on('will-download',(event)=>event.preventDefault());
 session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/i.test(details.url)}));
 installScreenshotDemoHandlers(); installV09DemoHandlers();
 const override=(channel,handler)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,handler)};
 override('app:getVersion',()=>APP_VERSION);
 override('app:getPlatform',()=>process.platform);
 override('app:getUpdateStatus',()=>({status:'idle'}));
 override('dbpath:autoDetect',()=>({success:true,path:DEMO_DB_PATH}));
 override('config:updateWxidEntry',()=>({success:true}));
 override('task:status',()=>[]);
 override('bug-report:clear-images',()=>({success:true}));
 override('ai:getAssignments',()=>({success:true,consumers:[],profiles:demoAiSetup().profiles,activeProfileId:demoAiSetup().profiles[0].id}));
 override('ai:getConsumerAssignments',()=>({success:true,consumers:[],profiles:demoAiSetup().profiles,activeProfileId:demoAiSetup().profiles[0].id}));
 override('app:getLaunchAtStartupStatus',()=>({enabled:false,supported:true}));
 override('export:getExportLog',()=>null);
 override('mcp:getStatus',()=>({running:false,port:5032}));
 override('annotations:list',()=>({tags:{},favorites:[],marks:[],savedSearches:[]}));
 override('search:suggest',()=>[]);
 override('weclone:getRedact',()=>({success:true,redact:true}));
 override('weclone:getSettings',()=>({success:true,settings:{refusal:'character'}}));
 override('ai:previewContext',async(_e,scope)=>{ globalThis.__readmeCalls.push({channel:'ai:previewContext',scope}); await new Promise(resolve=>setTimeout(resolve,globalThis.__readmePreviewDelay||0)); return {scope,text:'Synthetic selected messages only',snapshotAt:Date.now(),truncated:false}; });
 override('diagnostics:collect',()=>({supported:true,collectedAt:Date.now(),platform:'win32',appVersion:APP_VERSION,arch:'x64',summary:'演示连接检查通过',checks:[['host','WCDB 宿主'],['init','原生初始化'],['path','数据目录'],['account','所选账号'],['key','密钥表示'],['coverage','历史分片覆盖']].map(([id,label])=>({id:'connection.'+id,label,state:'ok',detail:id==='coverage'?'6 / 6 个历史分片已验证':'演示检查通过'}))}));
 override('diagnostics:listLogs',()=>({files:[]}));
 override('diagnostics:monitorSnapshot',()=>({collectedAt:Date.now(),runtime:{rssBytes:251658240,heapUsedBytes:67108864,cpuPercent:0.2},totals:{files:6,bytes:125829120,sizeGrowthBytesPerSecond:0},tasks:[],files:[],subsystems:{wcdbReady:true,databaseConnected:true,imageKeyConfigured:true}}));
 override('snapshot:list',()=>({success:true,snapshots:[]}));
 override('backup:list',()=>({success:true,backups:[]}));
 override('storage:status',()=>({entries:['media','cache','search-index','archive-library','ai-data','ai-workspace','model-cache','exports'].map(kind=>({kind,path:'D:\\\\demo\\\\Weport\\\\'+kind,retention:['search-index','model-cache'].includes(kind)?'derived-rebuildable':'user-managed'})),relocation:null,cleanup:null,mediaPath:'D:\\\\demo\\\\Weport\\\\media',exportPath:DEMO_EXPORT_PATH}));
 override('weclone:chat',(_e,cloneId,message,history,guard)=>{globalThis.__readmeCalls.push({channel:'weclone:chat',cloneId,message,history,guard});return {success:true,reply:/Hello|weekend|park/.test(message)?'Sounds good. Let’s meet at three.':'可以，下午三点见。',meta:{cloneId,providerId:'demo-only',model:'synthetic-fixture'}}});
 override('export:exportSessions',(_e,root,options)=>{globalThis.__readmeCalls.push({channel:'export:exportSessions',root,options});return {success:true,successCount:1,failCount:0}});
 override('chat:enrichSessionsContactInfo',(_e,ids)=>({success:true,contacts:Object.fromEntries((ids||[]).map(id=>[id,{displayName:demoSessions().find(s=>s.username===id)?.displayName||'演示联系人',avatarUrl:''}]))}));
 globalThis.__readmeWindow=new BrowserWindow({width:1360,height:900,x:-4000,y:0,show:false,focusable:false,skipTaskbar:true,webPreferences:{preload:${JSON.stringify(preload)},offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
 await globalThis.__readmeWindow.loadFile(${JSON.stringify(join(root, 'dist/index.html'))});
});`
writeFileSync(join(work, 'main.cjs'), ts.transpileModule(bootstrap, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)
const errors = [], captures = [], checks = [], controlAudits = []
let app
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [join(work, 'main.cjs'), `--user-data-dir=${join(work, 'profile')}`], env, timeout: 60000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(String(error)))
  await page.waitForSelector('[data-tab="connect"]', { timeout: 30000 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(1200)
  const tabs = await page.locator('[data-tab]').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.tab, text: node.textContent })))
  const requested = (process.env.WEPORT_README_TABS || tabs.map(tab => tab.id).join(',')).split(',')
  if(requested.some(tab=>!tabs.some(known=>known.id===tab))) throw Error('Unknown documentation tab')
  const auditControls = async (surface) => {
    const audit = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, summary, [role="button"]')].filter(node => {
        const r = node.getBoundingClientRect(), css = getComputedStyle(node);
        return r.width > 0 && r.height > 0 && css.visibility !== 'hidden' && css.opacity !== '0' && r.bottom > 0 && r.top < innerHeight;
      });
      const describe = node => ({ tag: node.tagName, className: node.className, text: (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim().slice(0, 100) });
      return { visible: buttons.length,
        unnamed: buttons.filter(node => !describe(node).text).map(describe),
        native: buttons.filter(node => getComputedStyle(node).borderStyle === 'outset').map(describe),
        horizontalOverflow: buttons.filter(node => { const r = node.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(describe),
        pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    controlAudits.push({ surface, ...audit });
    if(audit.pageOverflow || audit.unnamed.length || audit.native.length || audit.horizontalOverflow.length) throw Error('Control layout/accessibility issue at '+surface+': '+JSON.stringify(audit));
  };
  const capture = async (tab) => {
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await auditControls(tab);
    const image = await app.evaluate(async ({BrowserWindow}, file) => {
      const windows=BrowserWindow.getAllWindows();
      if(windows.some(w=>w.isVisible())||BrowserWindow.getFocusedWindow()) throw Error('Documentation capture must remain hidden');
      const win=globalThis.__readmeWindow;
      const image=await win.webContents.capturePage();
      const pixels=image.toBitmap(); let sum=0,squares=0,n=0;
      for(let i=0;i<pixels.length;i+=40){sum+=pixels[i];squares+=pixels[i]**2;n++}
      const stddev=Math.sqrt(Math.max(0,squares/n-(sum/n)**2));
      globalThis.__readmeWrite(file,image.toPNG());
      if(image.isEmpty()||stddev<12)throw Error('Blank documentation capture '+file+' stddev='+stddev);
      return {width:image.getSize().width,height:image.getSize().height,visible:win.isVisible(),stddev};
    }, join(output, `${tab}.png`))
    const text=await page.locator('body').innerText()
    if(/TypeError:|ReferenceError:|Error invoking remote method/.test(text))throw Error('Fixture or renderer error visible in '+tab)
    captures.push({ tab, ...image, sha256:createHash('sha256').update(readFileSync(join(output, `${tab}.png`))).digest('hex'), text:text.slice(0,2400) })
  }
  for (const tab of requested) {
    await page.locator(`[data-tab="${tab}"]`).click()
    await page.waitForTimeout(800)
    if(tab==='reader') {
      await page.locator('.reader-session').first().click(); await page.waitForTimeout(600)
    }
    if(tab==='search') {
      await page.locator('input').filter({visible:true}).first().fill('公园'); await page.locator('input').filter({visible:true}).first().press('Enter'); await page.waitForTimeout(600)
    }
    await capture(tab)
    if(tab==='reader') {
      await page.getByRole('button',{name:'导出本会话',exact:true}).click()
      await page.getByLabel('导出开始时间',{exact:true}).fill('2026-10-01T10:00:01')
      await page.getByLabel('导出结束时间',{exact:true}).fill('2026-10-01T15:00:01')
      await page.getByLabel('阅读器导出图片策略').selectOption('original-only')
      await capture('reader-export')
      await page.getByRole('button',{name:'按以上设置导出本会话',exact:true}).click()
      await page.waitForTimeout(300)
      const exported=await app.evaluate(()=>globalThis.__readmeCalls.find(c=>c.channel==='export:exportSessions'))
      if(exported?.options.mediaPolicy!=='original-only'||exported.options.dateRange.end-exported.options.dateRange.start!==18000)throw Error('Reader export options lost at IPC')
      await page.getByRole('button',{name:'收起导出设置',exact:true}).click()
      await page.getByRole('button',{name:'复制范围',exact:true}).click()
      await page.locator('.reader-row[data-kind="text"]').first().click()
      await page.getByRole('button',{name:'WeClone 回复草稿',exact:true}).click()
      await page.getByLabel('选择草稿使用的分身').selectOption('clone-demo-1')
      if(await page.getByRole('button',{name:'生成一次草稿',exact:true}).isEnabled())throw Error('Draft consent gate missing')
      await page.getByRole('checkbox',{name:/我已审阅片段/}).check()
      await page.getByRole('button',{name:'生成一次草稿',exact:true}).click()
      await page.getByLabel('可编辑的回复草稿').waitFor()
      const drafted=await app.evaluate(()=>globalThis.__readmeCalls.find(c=>c.channel==='weclone:chat'))
      if(drafted?.guard.accountId!=='wxid_demo'||drafted.guard.sessionId!=='family@chatroom'||drafted.history.length!==0)throw Error('Reader draft account guard lost at IPC')
      await page.locator('.reader-reply-output').scrollIntoViewIfNeeded()
      await capture('reader-draft')
    }
  }
  if(requested.includes('settings')) {
    for(const [label,file] of [['诊断','diagnostics'],['数据','settings-storage'],['外观','settings-appearance']]) {
      await page.locator('.settings-nav-item').filter({has:page.getByText(label,{exact:true})}).click(); await page.waitForTimeout(700)
      if(file==='settings-storage') { await page.locator('.storage-settings > details > summary').click(); await page.locator('.storage-settings').evaluate(element=>element.scrollIntoView({block:'start'})) }
      await capture(file)
    }
    await page.getByRole('button',{name:'浅色',exact:true}).click()
    await page.waitForTimeout(250)
    await capture('settings-light')
    await page.getByRole('button',{name:'深色',exact:true}).click()
    checks.push('light-theme-rendered')
  }
  if(requested.includes('reader')) {
    await page.locator('[data-tab="reader"]').click()
    await page.locator('.reader-session').first().click()
    await page.getByRole('button',{name:'导出本会话',exact:true}).click()
    await app.evaluate(()=>globalThis.__readmeWindow.setContentSize(930,700))
    await page.waitForTimeout(400)
    const fits=await page.locator('.reader-export-options').evaluate(element=>element.scrollWidth<=element.clientWidth+2)
    if(!fits)throw Error('Reader export options overflow at 930px')
    await capture('reader-narrow')
    checks.push('reader-export-930px-no-horizontal-overflow')
    await app.evaluate(()=>globalThis.__readmeWindow.setContentSize(1360,852))
  }
  if(requested.includes('search')) {
    await page.locator('[data-tab="search"]').click()
    await page.locator('.sp-semantic summary').click()
    await page.getByRole('button',{name:'E5 聊天语义（query/query）',exact:true}).click()
    const prefixes=await page.locator('.sp-semantic-fields input').evaluateAll(inputs=>inputs.slice(3).map(input=>input.value))
    if(prefixes.length!==2||prefixes.some(prefix=>prefix!=='query: '))throw Error('Semantic preset lost preprocessing fields')
    await capture('search-semantic')
    checks.push('explicit-semantic-chat-prefix-preset')
  }
  if(process.env.WEPORT_CONTROLS_AUDIT === '1') {
    // Exercise the inspector without reading actual history or dispatching any model request.
    await page.locator('[data-tab="ai"]').click();
    await page.getByRole('button', {name:'数据范围与发送预览',exact:true}).click();
    await page.locator('.ai-context-boundary').waitFor({state:'visible'});
    if(await page.locator('.ai-main .ai-context-boundary, .ai-main .ai-investigation-coverage').count()) throw Error('Secondary panels still interrupt composer');
    const local=page.locator('.ai-local-only input');
    await local.check();
    await page.locator('.ai-inspector-nav button').filter({hasText:'笔记'}).click();
    await page.locator('.ai-inspector-nav button').filter({hasText:'范围'}).click();
    if(!await local.isChecked())throw Error('Scope state lost on inspector navigation');
    await local.uncheck();
    await page.locator('.ai-input').fill('@');
    await page.locator('.ref-picker-item').first().click();
    await page.getByLabel('开始日期',{exact:true}).fill('2026-10-01');
    await page.getByLabel('结束日期',{exact:true}).fill('2026-10-03');
    await app.evaluate(()=>{globalThis.__readmePreviewDelay=400});
    await page.getByRole('button',{name:'预览选中的上下文',exact:true}).click();
    await page.getByLabel('结束日期',{exact:true}).fill('2026-10-02');
    await page.waitForTimeout(550);
    if(await page.locator('.ai-context-boundary pre').count())throw Error('Stale context preview restored after date change');
    await app.evaluate(()=>{globalThis.__readmePreviewDelay=0});
    await page.getByRole('button',{name:'预览选中的上下文',exact:true}).click();
    await page.locator('.ai-context-boundary pre').waitFor();
    await page.getByRole('button',{name:'取消仅预览范围',exact:true}).click();
    await page.locator('.ai-ref-chips button').first().click();
    checks.push('stale-preview-discarded-after-scope-change');

    await capture('ai-scope');
    await page.locator('.ai-inspector-nav button').filter({hasText:'调查'}).click();
    await capture('ai-coverage');
    await page.getByRole('button',{name:'收起对话侧栏',exact:true}).click();
    await page.locator('.ai-context-boundary').waitFor({state:'hidden'});
    await page.getByRole('button', {name:'数据范围与发送预览',exact:true}).click();
    await page.locator('.ai-context-boundary').waitFor({state:'visible'});
    checks.push('ai-secondary-controls-in-inspector','ai-scope-state-survives-inspector-navigation');
    await page.locator('[data-tab="settings"]').click();
    const categories=await page.locator('.settings-nav-item').count();
    for(let i=0;i<categories;i++) {
      await page.locator('.settings-nav-item').nth(i).click();await page.waitForTimeout(180);
      const label=(await page.locator('.settings-nav-item').nth(i).innerText()).trim();
      await auditControls('settings-'+label);
    }
    await page.locator('.settings-nav-item').filter({has:page.getByText('数据',{exact:true})}).click();
    const storage=page.locator('.storage-settings > details');
    if(!await storage.evaluate(node=>node.open))await storage.locator(':scope > summary').click();
    await page.locator('.settings-storage-entry').first().locator(':scope > summary').click();
    await capture('storage-actions');
    await page.locator('.settings-nav-item').filter({has:page.getByText('接口',{exact:true})}).click();
    await page.locator('.panel').filter({has:page.getByRole('heading',{name:'外部客户端数据范围',exact:true})}).scrollIntoViewIfNeeded();
    await capture('client-scopes');
    checks.push('settings-controls-reviewed-by-category');
    await page.locator('[data-tab="webot"]').click();
    await page.getByRole('button',{name:'新建任务',exact:true}).click();
    await page.locator('.webot-editor').waitFor();
    await capture('webot-editor');
    await page.locator('.webot-editor').getByRole('button',{name:'取消',exact:true}).click();
    await page.locator('[data-tab="sns"]').click();
    await page.getByRole('button',{name:'导出',exact:true}).click();
    await page.locator('[role="dialog"]').waitFor();
    await capture('sns-export-dialog');
    await page.keyboard.press('Escape');
    // Close only the synthetic modal via its own cancel control if Escape is not implemented.
    const dialogs=page.locator('[role="dialog"]');
    if(await dialogs.count()) { const cancel=dialogs.getByRole('button',{name:'取消',exact:true}); if(await cancel.count()) await cancel.click(); }
    checks.push('webot-editor-and-sns-export-controls');
    await page.locator('[data-tab="weclone"]').click();
    await page.locator('.analytics-big-card').first().click();
    await page.locator('.weclone-card').waitFor();
    await capture('weclone-manage');
    await page.getByRole('button',{name:'行为',exact:true}).first().click();
    await capture('weclone-behavior');
    await page.locator('.weclone-settings-dialog').getByRole('button',{name:'完成',exact:true}).click();
    checks.push('weclone-management-action-hierarchy');


    // Desktop app minimum width, rather than a mobile layout it does not support.
    await app.evaluate(()=>globalThis.__readmeWindow.setContentSize(930,700));
    for(const tab of ['ai','webot','weclone','sns','archive','search','export','poster']) {
      await page.locator('[data-tab="'+tab+'"]').click();await page.waitForTimeout(250);
      await capture(tab+'-narrow');
    }
    checks.push('all-major-control-surfaces-at-930px');
    await app.evaluate(()=>globalThis.__readmeWindow.setContentSize(1360,852));
    await page.locator('[data-tab="settings"]').click();
    await page.locator('.settings-nav-item').filter({has:page.getByText('外观',{exact:true})}).click();
    await page.getByRole('button',{name:'浅色',exact:true}).click();
    for(const tab of ['ai','webot','weclone','sns','archive','search','export','poster']) {
      await page.locator('[data-tab="'+tab+'"]').click();await page.waitForTimeout(150);
      if(tab==='weclone') { if(await page.locator('.analytics-big-card').count())await page.locator('.analytics-big-card').first().click(); await page.locator('.weclone-card').waitFor(); }
      await capture(tab+'-light');
    }
    checks.push('all-major-control-surfaces-in-light-theme');

  }
  const missing = await app.evaluate(()=>[...globalThis.__readmeMissing])
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({timestamp:new Date().toISOString(), syntheticOnly:true, noEngine:true, hidden:true, sourceSha256:createHash('sha256').update(source).digest('hex'),rendererHtmlSha256:createHash('sha256').update(readFileSync('dist/index.html')).digest('hex'), tabs, captures, checks, controlAudits, missing, errors},null,2))
  console.log(JSON.stringify({captures:captures.map(({text,...rest})=>rest), missing, errors}))
  if(errors.length) throw Error('Renderer errors occurred; inspect receipt')
} finally {
  if(app) await app.close()
  if(!resolve(work).startsWith(resolve(tmpdir()) + sep)) throw Error('Unsafe private cleanup boundary')
  rmSync(work,{recursive:true,force:true,maxRetries:5})
}
