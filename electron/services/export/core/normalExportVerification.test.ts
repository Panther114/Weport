import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ExportOrchestrator } from './ExportOrchestrator'
import { createFakeOrchestratorContext } from './fakeOrchestratorContext'
import { latestArtifactUnits } from '../ledger'
let root=''
afterEach(()=>{vi.restoreAllMocks();if(root)fs.rmSync(root,{recursive:true,force:true})})
describe('normal export is independent of live diagnostic checks',()=>{
  it('writes all collected messages without rescanning a later live count',async()=>{
    root=fs.mkdtempSync(path.join(os.tmpdir(),'weport-normal-export-'))
    const harness=createFakeOrchestratorContext({sessions:[{sessionId:'room',displayName:'Room',messages:[{id:1,ts:1,sender:'wxid_me',text:'first retained row'},{id:2,ts:2,sender:'other',text:'second retained row'}]}]})
    vi.spyOn(ExportOrchestrator.prototype,'exportSessionToTxt').mockImplementation(harness.exportSessionImplementation)
    const scan=vi.spyOn(harness.context.integrityDbAccess!,'getTableStats').mockRejectedValue(new Error('live source has changed'))
    const result=await new ExportOrchestrator(harness.context).exportSessions(['room'],root,{format:'txt',exportMedia:false,exportConflictStrategy:'overwrite',exportWriteLayout:'B',sessionLayout:'shared',sessionNameWithTypePrefix:false})
    expect(result.success).toBe(true)
    expect(scan).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root,'integrity-report.json'))).toBe(false)
    const content=fs.readFileSync(result.sessionOutputPaths!.room,'utf8')
    expect(content).toContain('first retained row');expect(content).toContain('second retained row')
  })
  it('uses the newest fingerprint for an overwritten artifact across old chunks',()=>{
    const output=path.resolve('fixture','chat.txt')
    const selected=latestArtifactUnits([{outputPath:output,at:1,bytes:13427},{outputPath:output,at:3,bytes:163542},{outputPath:path.resolve('fixture','other.txt'),at:2,bytes:10}])
    expect(selected.map(x=>x.bytes)).toEqual([163542,10])
  })
})
