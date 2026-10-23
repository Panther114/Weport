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
  it.each(['A', 'B', 'C'] as const)('reuses intact layout %s exports but rebuilds missing/corrupted attachments', async layout => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-media-recovery-'))
    const harness = createFakeOrchestratorContext({ sessions: [{ sessionId: 'room', displayName: 'Room', messages: [{ id: 1, ts: 1, sender: 'wxid_me', text: 'attachment' }] }] })
    vi.spyOn(harness.context, 'isMediaExportEnabled').mockReturnValue(true)
    let attachment = ''
    vi.spyOn(ExportOrchestrator.prototype, 'exportSessionToTxt').mockImplementation(async (...args) => {
      const result = await harness.exportSessionImplementation(...args)
      const media = harness.context.getMediaLayout(args[1], args[2])
      attachment = path.resolve(media.mediaRootDir, media.mediaRelativePrefix, 'images', 'attachment.bin')
      fs.mkdirSync(path.dirname(attachment), { recursive: true })
      fs.writeFileSync(attachment, 'original')
      return result
    })
    const orchestrator = new ExportOrchestrator(harness.context)
    const options = { format: 'txt' as const, exportMedia: true, exportImages: true, exportConflictStrategy: 'incremental' as const, exportWriteLayout: layout, sessionLayout: layout === 'C' ? 'per-session' as const : 'shared' as const }
    expect((await orchestrator.exportSessions(['room'], root, options)).success).toBe(true)
    expect((await orchestrator.exportSessions(['room'], root, options)).success).toBe(true)
    expect(harness.exportedSessions).toHaveLength(1)
    fs.writeFileSync(attachment, 'modified')
    expect((await orchestrator.exportSessions(['room'], root, options)).success).toBe(true)
    expect(harness.exportedSessions).toHaveLength(2)
    expect(fs.readFileSync(attachment, 'utf8')).toBe('original')
    fs.unlinkSync(attachment)
    expect((await orchestrator.exportSessions(['room'], root, options)).success).toBe(true)
    expect(harness.exportedSessions).toHaveLength(3)
    expect(fs.readFileSync(attachment, 'utf8')).toBe('original')
    expect((await orchestrator.exportSessions(['room'], root, options)).success).toBe(true)
    expect(harness.exportedSessions).toHaveLength(3)
  })
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
