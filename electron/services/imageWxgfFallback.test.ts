import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, BrowserWindow: {} }))
vi.mock('./config', () => ({ ConfigService: class {} }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
import { ImageDecryptService } from './imageDecryptService'
const directories: string[]=[]
afterEach(() => { for (const path of directories.splice(0)) rmSync(path,{recursive:true,force:true}) })

describe('WXGF conversion and same-image thumbnail fallback', () => {
  const prepare = () => {
    const dir=mkdtempSync(join(tmpdir(),'weport-wxgf-'));directories.push(dir)
    const dat=join(dir,`${'a'.repeat(32)}.dat`),thumb=join(dir,`${'a'.repeat(32)}_t.dat`),out=join(dir,'decoded_t.jpg')
    writeFileSync(dat,'fixture');writeFileSync(thumb,'fixture')
    const wxgf=Buffer.from('wxgf unavailable HEVC converter'),jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0,0,0,0,0])
    const service=Object.create(ImageDecryptService.prototype) as any
    Object.assign(service,{
      getConfiguredMyWxid:()=> 'qa_account',getConfiguredDbPath:()=>dir,resolveAccountDir:()=>dir,
      resolveDatPath:vi.fn(async()=>dat),findCachedOutputByDatPath:()=>null,
      getConfiguredImageKeys:()=>({xorKey:42,aesKey:'syntheticAESkey16'}),
      tryDecryptDatWithNative:vi.fn(async(path:string)=>({data:path===thumb?jpeg:wxgf})),
      unwrapWxgf:vi.fn(async(data:Buffer)=>({data,isWxgf:data===wxgf})),
      getCacheOutputPathFromDat:()=>out,logInfo:vi.fn(),logError:vi.fn(),emitDecryptProgress:vi.fn(),
      removeDuplicateCacheCandidates:vi.fn(),cacheResolvedPaths:vi.fn(),shouldCheckImageUpdate:()=>false,
      emitCacheResolved:vi.fn(),resolveEmitPath:(path:string)=>path,
    })
    return {service,dat,thumb,out}
  }
  it('uses only the same-image thumbnail when WXGF conversion is unavailable',async()=>{
    const {service,thumb}=prepare()
    const result=await service.decryptImageInternal({preferFilePath:true,excludeThumbnail:true},'fixture')
    expect(result).toMatchObject({success:true,isThumb:true})
    expect(service.tryDecryptDatWithNative).toHaveBeenCalledWith(thumb,42,'syntheticAESkey16')
  })
  it('reports a conversion error rather than an incorrect-account key error without a thumbnail',async()=>{
    const {service,thumb,out}=prepare();rmSync(thumb)
    const result=await service.decryptImageInternal({preferFilePath:true},'fixture')
    expect(result.success).toBe(false)
    expect(result.error).toContain('ffmpeg')
    expect(result.error).not.toContain('另一个微信账号')
    expect(existsSync(out)).toBe(false)
  })
  it('does not hide unrelated decryption failures with a thumbnail',async()=>{
    const {service}=prepare()
    service.unwrapWxgf.mockImplementation(async()=>({data:Buffer.from('invalid data'),isWxgf:false}))
    const result=await service.decryptImageInternal({preferFilePath:true},'fixture')
    expect(result.success).toBe(false)
    expect(service.tryDecryptDatWithNative).toHaveBeenCalledTimes(1)
  })
  it('never substitutes another image thumbnail from the same directory',async()=>{
    const {service,thumb}=prepare();rmSync(thumb)
    writeFileSync(join(thumb,'..',`${'b'.repeat(32)}_t.dat`),'unrelated fixture')
    const result=await service.decryptImageInternal({preferFilePath:true},'fixture')
    expect(result.success).toBe(false)
    expect(result.error).toContain('ffmpeg')
    expect(service.tryDecryptDatWithNative).toHaveBeenCalledTimes(1)
  })
})
