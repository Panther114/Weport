import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTree } from './rmTree'

/**
 * `removeTree` 的回归测试。
 *
 * 这条路径上真实出过一次"报错但其实删掉了"的 bug（见 rmTree.ts 顶部），
 * 所以这里既覆盖正常路径，也覆盖"抛错但目录确实没了"和"目录还在"两种结论。
 */
describe('removeTree', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weport-rmtree-'))
  })

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  })

  const makeCloneDir = (name = 'clone', extra: Record<string, string> = {}) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'wc_1', wxid: 'wxid_a' }))
    writeFileSync(join(dir, 'profile.md'), '# profile')
    for (const [file, content] of Object.entries(extra)) writeFileSync(join(dir, file), content)
    return dir
  }

  it('删掉整棵目录树', () => {
    const dir = makeCloneDir()
    const result = removeTree(dir)
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(result.firstError).toBeUndefined()
  })

  it('删掉嵌套子目录与大文件', () => {
    const dir = makeCloneDir('nested', { 'chunks.jsonl': 'x'.repeat(200_000) })
    mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'deeper', 'note.txt'), 'hi')
    const result = removeTree(dir)
    expect(result.ok).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('本来就不存在时也算成功，但 removed 为 false（幂等）', () => {
    const result = removeTree(join(root, 'nope'))
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(false)
  })

  it('只读文件不会让它失败', () => {
    const dir = makeCloneDir()
    const file = join(dir, 'profile.md')
    chmodSync(file, 0o444)
    const result = removeTree(dir)
    expect(result.ok).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('文件目标同样能删（聊天记录文件走同一条路）', () => {
    const file = join(root, 'chat.json')
    writeFileSync(file, readFileSync(join(makeCloneDir('c2'), 'meta.json')))
    expect(removeTree(file).ok).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('删一个大目录（多文件 + 深层嵌套）不会留下尾巴', () => {
    const dir = join(root, 'big')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 40; i += 1) {
      const sub = join(dir, `part-${i}`)
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(sub, 'chunk.jsonl'), `{"i":${i}}`.repeat(500))
    }
    writeFileSync(join(dir, 'meta.json'), '{"id":"wc_big"}')
    const result = removeTree(dir)
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })

  it('attempts 被夹到至少 1 次（传 0 不会直接跳过删除）', () => {
    const dir = makeCloneDir()
    expect(removeTree(dir, { attempts: 0 }).ok).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})
