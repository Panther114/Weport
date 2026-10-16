import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  atomicWriteBuffer,
  atomicWriteFile,
  atomicWriteText,
  atomicWriteWith,
  cleanupStaleAtomicTemps,
  createAtomicWriteTarget,
  nextTempPathFor,
  tempPathFor,
} from './atomicWrite'

/**
 * 原子写（v1.2 §10.1 ①）。
 *
 * 守三件事：失败/中止绝不留临时文件、覆盖走同卷原子替换（覆盖已存在的目标）、
 * 覆盖前后的内容与目标一致。测试全部在 %TEMP% 下的 mkdtemp 目录里，跑完即删。
 *
 * 关于"确实做了原子替换"：Node 的 `os` 模块**没有** `os.replace`（§10.1 写的那个名字
 * 是 Python 的 API），等价实现是 `fs.promises.rename`（Windows 上映射到
 * `MoveFileEx(REPLACE_EXISTING)`）。这里不打桩（`node:os` 的导出不可重定义），
 * 证据由三部分组成：
 *  1. 源码检查 —— 落地替换只能经过 `replacePath` 这一个入口；
 *  2. 覆盖语义 —— 目标已存在时替换必须成功，且旧内容被整份换掉；
 *  3. 失败路径 —— 替换前抛错时旧目标保持原样、临时文件被删。
 */

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weport-atomic-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const listTemps = (dir: string): string[] =>
  fs.readdirSync(dir).filter((name) => /\.tmp-\d+$/.test(name))

describe('替换调用点', () => {
  it('落地替换只有一个入口（replacePath），且不允许 renameSync/删除后再改名', () => {
    const source = fs.readFileSync(path.join(__dirname, 'atomicWrite.ts'), 'utf-8')
    expect(source).toMatch(/export async function replacePath/)
    const atomicWriteBody = source.slice(source.indexOf('export async function atomicWriteFile'))
    expect(atomicWriteBody).toMatch(/await replacePath\(tmpPath, normalizedTarget\)/)
    expect(source).not.toMatch(/renameSync/)
    expect(source).not.toMatch(/unlinkSync\(tmpPath\)\s*;?\s*\n\s*await fs\.promises\.rename/)
  })

  it('replacePath 是 fs.promises.rename（Windows 上是 MoveFileEx(REPLACE_EXISTING)）', async () => {
    const { replacePath } = await import('./atomicWrite')
    const from = path.join(root, 'from.bin')
    const to = path.join(root, 'to.bin')
    fs.writeFileSync(from, 'a')
    fs.writeFileSync(to, 'b')
    await replacePath(from, to)
    expect(fs.readFileSync(to, 'utf-8')).toBe('a')
    expect(fs.existsSync(from)).toBe(false)
  })
})

describe('临时文件命名', () => {
  it('形如 <target>.tmp-<pid>', () => {
    expect(tempPathFor('D:\\out\\a.txt', 1234)).toBe('D:\\out\\a.txt.tmp-1234')
    expect(tempPathFor('/tmp/out/a.txt', 42)).toBe('/tmp/out/a.txt.tmp-42')
  })

  it('并发写同一个目标时临时路径必须互不相同（撞名会让 os.replace ENOENT）', () => {
    const target = 'D:\\out\\a.txt'
    const paths = new Set<string>()
    for (let i = 0; i < 50; i += 1) paths.add(nextTempPathFor(target))
    expect(paths.size).toBe(50)
    for (const path of paths) expect(path).toMatch(/\.tmp-\d+-\d+$/)
  })

  it('并发原子写同一个目标：全部成功，目录里只剩一份产物、没有 .tmp 残留', async () => {
    const target = path.join(root, 'same.txt')
    const payloads = Array.from({ length: 24 }, (_value, index) => `payload-${index}`)
    await Promise.all(payloads.map((payload) => atomicWriteText(target, payload)))
    // 最后落地的是哪一个不确定，但必须是完整的那一份
    expect(payloads).toContain(fs.readFileSync(target, 'utf-8'))
    expect(listTemps(root)).toEqual([])
  })
})

describe('atomicWriteFile', () => {
  it('写出的内容与目标完全一致，且不留临时文件', async () => {
    const target = path.join(root, 'a.txt')
    const result = await atomicWriteText(target, '你好 weport')
    expect(fs.readFileSync(target, 'utf-8')).toBe('你好 weport')
    expect(result.bytes).toBe(Buffer.byteLength('你好 weport'))
    expect(listTemps(root)).toEqual([])
  })

  it('目标已存在时原子覆盖（os.replace 语义，Windows 上 fs.rename 会失败）', async () => {
    const target = path.join(root, 'a.txt')
    fs.writeFileSync(target, 'old-content-that-is-longer', 'utf-8')
    await atomicWriteText(target, 'new')
    expect(fs.readFileSync(target, 'utf-8')).toBe('new')
    expect(listTemps(root)).toEqual([])
  })

  it('临时文件存在、替换前抛错 → 临时文件必须消失（否则下次运行会当成产物）', async () => {
    const target = path.join(root, 'a.txt')
    await expect(
      atomicWriteText(target, 'x', {
        onBeforeReplace: () => { throw new Error('simulated-crash') },
      }),
    ).rejects.toThrow(/simulated-crash/)
    expect(fs.existsSync(target)).toBe(false)
    expect(listTemps(root)).toEqual([])
  })

  it('outputPath 是目录时写入失败，且不留下临时文件', async () => {
    const dirTarget = path.join(root, 'adir')
    fs.mkdirSync(dirTarget)
    await expect(atomicWriteText(dirTarget, 'x')).rejects.toThrow()
    expect(listTemps(root)).toEqual([])
  })

  it('Buffer 写入与字符串写入都不留临时文件', async () => {
    const target = path.join(root, 'a.bin')
    await atomicWriteBuffer(target, Buffer.from([1, 2, 3, 4]))
    expect([...fs.readFileSync(target)]).toEqual([1, 2, 3, 4])
    await atomicWriteFile(target, 'text', 'utf-8')
    expect(fs.readFileSync(target, 'utf-8')).toBe('text')
    expect(listTemps(root)).toEqual([])
  })

  it('目标目录不存在时自动创建', async () => {
    const target = path.join(root, 'deep', 'nested', 'a.txt')
    await atomicWriteText(target, 'x')
    expect(fs.readFileSync(target, 'utf-8')).toBe('x')
  })
})

describe('atomicWriteWith（exceljs 这类自己写文件的库）', () => {
  it('回调写在临时路径上，提交后目标存在且临时文件消失', async () => {
    const target = path.join(root, 'a.xlsx')
    let sawTmpPath = ''
    await atomicWriteWith(target, async (tmpPath) => {
      sawTmpPath = tmpPath
      fs.writeFileSync(tmpPath, 'fake-xlsx')
    })
    expect(sawTmpPath).toMatch(new RegExp(`^${tempPathFor(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`))
    expect(fs.readFileSync(target, 'utf-8')).toBe('fake-xlsx')
    expect(listTemps(root)).toEqual([])
  })

  it('回调抛错 → 目标不出现，临时文件被删', async () => {
    const target = path.join(root, 'a.xlsx')
    await expect(
      atomicWriteWith(target, async (tmpPath) => {
        fs.writeFileSync(tmpPath, 'half-written')
        throw new Error('boom')
      }),
    ).rejects.toThrow(/boom/)
    expect(fs.existsSync(target)).toBe(false)
    expect(listTemps(root)).toEqual([])
  })
})

describe('createAtomicWriteTarget（流式）', () => {
  it('commit 之后目标内容完整，临时文件消失', async () => {
    const target = path.join(root, 'a.txt')
    const { stream, commit } = createAtomicWriteTarget(target)
    stream.write('row1\n')
    stream.write('row2\n')
    await commit()
    expect(fs.readFileSync(target, 'utf-8')).toBe('row1\nrow2\n')
    expect(listTemps(root)).toEqual([])
  })

  it('abort 之后目标不出现，临时文件被删', async () => {
    const target = path.join(root, 'a.txt')
    const { stream, abort } = createAtomicWriteTarget(target)
    stream.write('row1\n')
    abort()
    expect(fs.existsSync(target)).toBe(false)
    expect(listTemps(root)).toEqual([])
  })

  it('commit 前目标已有旧内容时，abort 不会破坏旧内容', async () => {
    const target = path.join(root, 'a.txt')
    fs.writeFileSync(target, '旧产物', 'utf-8')
    const { stream, abort } = createAtomicWriteTarget(target)
    stream.write('新的一半')
    abort()
    expect(fs.readFileSync(target, 'utf-8')).toBe('旧产物')
    expect(listTemps(root)).toEqual([])
  })
})

describe('cleanupStaleAtomicTemps', () => {
  it('删掉上次崩溃留下的 .tmp-<pid>，不碰正常产物', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'keep', 'utf-8')
    fs.writeFileSync(path.join(root, 'a.txt.tmp-99999'), 'stale', 'utf-8')
    const nested = path.join(root, 'media')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'b.jpg.tmp-123'), 'stale', 'utf-8')

    const removed = await cleanupStaleAtomicTemps(root)
    expect(removed).toHaveLength(2)
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(true)
    expect(listTemps(root)).toEqual([])
    expect(fs.readdirSync(nested)).toEqual([])
  })

  it('目录不存在时返回空数组（导出根目录还没建）', async () => {
    const removed = await cleanupStaleAtomicTemps(path.join(root, 'nope'))
    expect(removed).toEqual([])
  })
})
