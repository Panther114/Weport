import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateLegacyAi } from './accountMigration'
import { accountNamespace, assertRunAccount } from './dataScope'

const temporary: string[] = []
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('account-scoped AI migration', () => {
  it('claims legacy chats and memory once, keeps originals and preserves later changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'weport-ai-scope-')); temporary.push(root)
    const data = join(root, 'data'), workspace = join(root, 'workspace')
    mkdirSync(data); mkdirSync(join(workspace, 'memory'), { recursive: true })
    writeFileSync(join(data, 'index.json'), '{"chats":[]}')
    writeFileSync(join(workspace, 'memory', 'fact.md'), 'old finding')
    migrateLegacyAi(data, workspace, 'account-a')
    const copied = join(workspace, 'accounts', accountNamespace('account-a'), 'memory', 'fact.md')
    expect(readFileSync(copied, 'utf8')).toBe('old finding')
    writeFileSync(copied, 'corrected finding')
    migrateLegacyAi(data, workspace, 'account-a')
    migrateLegacyAi(data, workspace, 'account-b')
    expect(readFileSync(copied, 'utf8')).toBe('corrected finding')
    expect(existsSync(join(workspace, 'accounts', accountNamespace('account-b')))).toBe(false)
    expect(readFileSync(join(workspace, 'memory', 'fact.md'), 'utf8')).toBe('old finding')
  })
  it('rejects a run lease after account switching', () => {
    expect(() => assertRunAccount('a', 'b')).toThrow('account changed')
    expect(() => assertRunAccount('a', 'a')).not.toThrow()
    expect(accountNamespace('../account')).toMatch(/^[a-f0-9]{64}$/)
  })
})
