// Read-only filesystem evidence. This does not prove decryption or message linkage.
import fs from 'node:fs'
import path from 'node:path'
const root=process.cwd()
const config=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'weport','Weport-config.json'),'utf8'))
const candidates=[config.dbPath,path.join(config.dbPath,config.myWxid)]
for(const entry of fs.readdirSync(config.dbPath,{withFileTypes:true}))if(entry.isDirectory()&&(entry.name===config.myWxid||entry.name.startsWith(config.myWxid+'_')))candidates.push(path.join(config.dbPath,entry.name))
const account=candidates.find(d=>fs.existsSync(path.join(d,'db_storage','session','session.db'))||fs.existsSync(path.join(d,'db_storage','session.db')))
if(!account)throw Error('Configured account directory unavailable')
const counts={original:0,display:0,thumbnail:0,otherFiles:0,unreadableDirectories:0}
const groups=new Map()
const walk=dir=>{
  let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{counts.unreadableDirectories++;return}
  for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isDirectory()){walk(file);continue}if(!entry.isFile())continue
    const m=entry.name.match(/^([a-f\d]{32})(_h|_t)?\.dat$/i)
    if(!m){counts.otherFiles++;continue}
    const suffix=String(m[2]||'').toLowerCase(),tier=suffix==='_h'?'original':suffix==='_t'?'thumbnail':'display';counts[tier]++
    const key=path.dirname(file)+'\0'+m[1].toLowerCase(),tiers=groups.get(key)||new Set();tiers.add(tier);groups.set(key,tiers)
  }
}
const attachments=path.join(account,'msg','attach')
if(fs.existsSync(attachments))walk(attachments)
const states={originalPresent:0,displayWithoutOriginal:0,thumbnailOnly:0}
for(const tiers of groups.values())if(tiers.has('original'))states.originalPresent++;else if(tiers.has('display'))states.displayWithoutOriginal++;else states.thumbnailOnly++
const receipt={checkedAt:new Date().toISOString(),scope:'read-only encrypted attachment filename-tier inventory; no content, key, decryption, source mutation or message-linkage assertion',attachmentDirectoryPresent:fs.existsSync(attachments),counts,states,completeWithinDirectory:counts.unreadableDirectories===0}
const out=path.join(root,'.ui-probe','v13-archive-acceptance');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'media-inventory.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt))
