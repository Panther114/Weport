import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodingWorkspace } from './codingWorkspace'

let sandbox: string
let root: string
let outside: string
let workspace: CodingWorkspace

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'weport-coding-test-'))
  root = mkdirSync(join(sandbox, '工作区'), { recursive: true })!
  outside = mkdirSync(join(sandbox, 'outside'), { recursive: true })!
  writeFileSync(join(outside, 'secret.txt'), 'outside secret')
  workspace = new CodingWorkspace(root)
})
afterEach(() => rmSync(sandbox, { recursive: true, force: true }))

describe('coding workspace file tools', () => {
  it('creates, lists, searches, reads and edits real files with spaces and Unicode', () => {
    workspace.createDirectory('新目录')
    workspace.write('新目录/app test.ts', 'const value = "中文"\r\nconst zero = 0\r\n')
    expect(workspace.list('.', 0)).toContain('新目录/')
    expect(workspace.search(undefined, '中文')).toContain('app test.ts:1: const value')
    expect(workspace.readLines('新目录/app test.ts', 1, 1)).toContain('nextLine=2')
    workspace.write('新目录/app test.ts', 'const zero = 1', 'const zero = 0')
    expect(readFileSync(join(root, '新目录', 'app test.ts'), 'utf8')).toContain('const zero = 1\r\n')
    expect(() => workspace.write('新目录/app test.ts', 'overwrite')).toThrow()
  })

  it.each(['../outside/secret.txt', 'a/../../x', '..\\outside\\x', 'C:\\x', '/etc/x', '//server/x', 'file:stream', 'NUL.txt', 'a. /b', './file'])(
    'rejects ambiguous or escaping path %s', path => {
      expect(() => workspace.write(path, 'modified')).toThrow()
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret')
    })

  it('rejects junctions, symlinks and hard links and does not search through them', () => {
    symlinkSync(outside, join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
    linkSync(join(outside, 'secret.txt'), join(root, 'hard.txt'))
    expect(() => workspace.readLines('redirect/secret.txt', 1, 1)).toThrow()
    expect(() => workspace.write('redirect/secret.txt', 'edited', 'outside')).toThrow()
    expect(() => workspace.readLines('hard.txt', 1, 1)).toThrow()
    expect(workspace.search(undefined, 'outside secret')).toContain('Matches shown: 0')
  })

  it('rejects replaced workspace roots, binary files, and ambiguous edits', () => {
    writeFileSync(join(root, 'binary'), Buffer.from([0, 255]))
    expect(() => workspace.readLines('binary', 1, 1)).toThrow()
    workspace.write('ambiguous', 'same and same')
    expect(() => workspace.write('ambiguous', 'changed', 'same')).toThrow()
    expect(() => workspace.write('large.txt', 'x'.repeat(512 * 1024 + 1))).toThrow()
    expect(readFileSync(join(root, 'ambiguous'), 'utf8')).toBe('same and same')
    renameSync(root, join(sandbox, 'moved'))
    mkdirSync(root)
    expect(() => workspace.write('replacement', 'forbidden')).toThrow()
  })
})
