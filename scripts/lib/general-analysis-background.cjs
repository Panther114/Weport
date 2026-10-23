// Real provider, production system prompt/tool schemas, fixed synthetic local-tool responses.
// Exercises tool choice rather than real database coverage. No engine startup or windows.
const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path')
app.setPath('userData',path.join(__dirname,'profile'))
app.on('window-all-closed',()=>{})
console.log=console.warn=console.error=()=>{}
const result={stage:'ready',windowsCreated:0,windowsRemaining:0,providerRequests:0,rows:[]}
const check=(value,message)=>{if(!value)throw Error(message)}
const save=code=>{result.windowsRemaining=BrowserWindow.getAllWindows().length;fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result),{mode:0o600});app.exit(code)}
app.on('browser-window-created',()=>{result.windowsCreated++;save(1)})
const nativeFetch=globalThis.fetch
let live=false
globalThis.fetch=(url,init={})=>{check(live&&init.method==='POST'&&result.providerRequests<24,'Network budget exceeded');result.providerRequests++;return nativeFetch(url,init)}
const sessions=['work','family','friend','quiet'].map((username,index)=>({username,displayName:['Project team','Family','Old friend','Occasional contact'][index],messageCountHint:[4800,2400,1600,120][index]}))
const topics={work:['2024: I accepted weekend shifts and forgot to rest.','2025: I set a weekday schedule and started mentoring a colleague.','2026: I protect weekends and enjoy practical design work.'],family:['2024: I rarely replied to family plans.','2025: I began regular Sunday calls with my parents.','2026: I am arranging a family trip and checking their health.'],friend:['2024: We played games most evenings.','2025: We tried outdoor walks and photography.','2026: We still play sometimes, but meet for park walks each month.'],quiet:['2024: Thanks for helping when I moved.','2025: I hope your recovery is going well.','2026: I can bring dinner after your appointment.']}
app.whenReady().then(async()=>{
 const {preflight,cases}=JSON.parse(fs.readFileSync(path.join(__dirname,'cases.json')))
 const {WeportAiService,ConfigService}=require('./groundedness-services.cjs')
 const config=ConfigService.getInstance()
 check(config.get('myWxid')==='groundedness-fixture','Private configuration mismatch')
 const service=new WeportAiService()
 const setup=service.getSetup()
 const profile=setup.profiles.find(p=>p.providerId==='deepseek'&&p.hasApiKey)||setup.profiles.find(p=>/deepseek/i.test(p.name+' '+p.model)&&p.hasApiKey)
 check(profile&&service.assignConsumerProfile('chat',profile.id).success,'Configured DeepSeek unavailable')
 result.provider={provider:profile.providerId,model:profile.model}
 const definitions=service.buildTools()
 service.getSessionMap=async()=>new Map(sessions.map(s=>[s.username,s]))
 if(preflight){result.stage='preflight-complete';save(0);return}
 for(const item of cases){
  const calls=[]
  service.buildTools=()=>definitions.filter(t=>['list_notes','read_note','write_note','list_sessions','get_social_overview','list_dates','sample_session_history','read_session_messages','search_messages'].includes(t.name)).map(t=>({...t,handler:async args=>{
   calls.push({name:t.name,args})
   if(t.name==='list_notes')return 'No prior notes exist.'
   if(t.name==='read_note')return 'No saved memory exists.'
   if(t.name==='write_note')return 'Synthetic note accepted in fixture memory only.'
   if(t.name==='list_sessions'||t.name==='get_social_overview')return JSON.stringify({sessions,historyStart:'2024-01-01',historyEnd:'2026-10-01',note:'All four chats are in scope, including the quiet chat; volume is not a relationship score.'})
   if(t.name==='list_dates')return JSON.stringify({dates:['2024-01-01','2025-01-01','2026-10-01']})
   if(t.name==='search_messages')return 'No exact keyword matches. This does not establish absence; wording varies. Coverage: keyword-only, incomplete.'
   const id=String(args.sessionId||'');const rows=topics[id]
   if(!rows)return 'Unknown synthetic session; choose an ID returned by list_sessions.'
   return JSON.stringify({sessionId:id,mode:t.name==='sample_session_history'?'stratified-sample':'contiguous-window',requestedLimit:args.limit,offset:args.offset||0,
    periods:['2024 early','2025 middle','2026 recent'],messages:rows.map((text,index)=>({date:['2024-01-01','2025-01-01','2026-10-01'][index],sender:'Me',text,sourceLabel:id+'-'+index})),
    coverage:{fixture:true,sourceLabelsOnly:true,completeHistory:false,hasMore:false,note:'A tiny synthetic excerpt; do not claim exhaustive history or fabricate physical evidence links.'}})
  }}))
  const chat=service.createChat('Synthetic general analysis')
  const timeout=setTimeout(()=>service.abort(chat.id),240000)
  live=true;let response
  try{response=await service.runChat(chat.id,item.text,{maxSteps:10,maxTotalTokens:200000})}finally{live=false;clearTimeout(timeout)}
  if(!response.success) result.runFailure=/budget/i.test(response.error||'')?'budget':/aborted|cancel/i.test(response.error||'')?'cancelled':'provider-or-harness'
  check(response.success,'Provider run failed')
  const data=service.getChat(chat.id),answer=data.messages.filter(m=>m.role==='assistant').map(m=>m.content||'').join('\n')
  const readings=calls.filter(c=>['sample_session_history','read_session_messages'].includes(c.name))
  const contiguous=readings.filter(c=>c.name==='read_session_messages')
  const searches=calls.filter(c=>c.name==='search_messages')
  const sessionsRead=[...new Set(readings.map(c=>c.args.sessionId))]
  const firstRead=calls.findIndex(c=>['sample_session_history','read_session_messages'].includes(c.name)),firstSearch=calls.findIndex(c=>c.name==='search_messages')
  const passed=readings.length>=2&&contiguous.length>=1&&sessionsRead.length>=2&&searches.length<readings.length&&(firstSearch<0||firstRead<firstSearch)&&answer.length>100
  result.rows.push({passed,answer,usage:data.lastRun?.usage,strategy:{toolCalls:calls,historyReads:readings.length,contiguousReads:contiguous.length,keywordSearches:searches.length,sessionsRead},messages:data.messages.map(m=>({role:m.role}))})
  result.lastRunSucceeded=response.success
 }
 result.stage='general-analysis-complete';save(0)
}).catch(error=>{result.errorType=error.name;save(1)})
