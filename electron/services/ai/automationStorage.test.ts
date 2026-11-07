import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadChatIndexes, persistChatIndexes } from './automationStorage'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weport-automation-migration-'))
  roots.push(root)
  const data = join(root, 'data'), workspace = join(root, 'workspace')
  mkdirSync(join(data, 'sessions'), { recursive: true })
  mkdirSync(join(workspace, 'chats', 'automated', 'notes'), { recursive: true })
  const chats = [{ id: 'interactive' }, { id: 'automated', invocation: { kind: 'automation' as const, taskId: 'deleted-task' } }]
  writeFileSync(join(data, 'index.json'), JSON.stringify({ chats }))
  writeFileSync(join(data, 'sessions', 'automated.json'), JSON.stringify({ messages: [{ role: 'user', content: 'task' }] }))
  writeFileSync(join(data, 'sessions', 'automated.archive.jsonl'), '{"id":"archived","content":"original history"}\n')
  writeFileSync(join(workspace, 'chats', 'automated', 'notes', 'result.md'), 'original note')
  return { data, workspace, chats }
}

describe('account-local automation history migration', () => {
  it('moves transcripts, archived turns and notes with recoverable originals, retaining deleted-task history', () => {
    const { data, workspace } = fixture()
    const chats = loadChatIndexes(data, workspace)
    expect(chats.map(chat => chat.id).sort()).toEqual(['automated', 'interactive'])
    expect(JSON.parse(readFileSync(join(data, 'index.json'), 'utf8')).chats).toEqual([{ id: 'interactive' }])
    expect(JSON.parse(readFileSync(join(data, 'automations', 'index.json'), 'utf8')).chats[0].invocation.taskId).toBe('deleted-task')
    expect(readFileSync(join(workspace, 'automations', 'automated', 'notes', 'result.md'), 'utf8')).toBe('original note')
    expect(readFileSync(join(data, 'automations', 'sessions', 'automated.archive.jsonl'), 'utf8')).toContain('original history')
    expect(existsSync(join(data, 'sessions', 'automated.json'))).toBe(false)
    expect(existsSync(join(data, 'automation-migration-backup', 'sessions', 'automated.json'))).toBe(true)
    expect(existsSync(join(workspace, 'automation-migration-backup', 'automated', 'notes', 'result.md'))).toBe(true)
    expect(loadChatIndexes(data, workspace)).toEqual(chats)
  })
  it('recognizes the exact legacy dispatcher signature without matching a title or ordinary task discussion', () => {
    const { data, workspace } = fixture()
    writeFileSync(join(data, 'index.json'), JSON.stringify({ chats: [{ id: 'legacy', title: 'Same title' }, { id: 'ordinary', title: 'Same title' }] }))
    writeFileSync(join(data, 'sessions', 'legacy.json'), JSON.stringify({ messages: [{ role: 'user', content: '这是 WeBot 定时任务的自动执行（2026）。请只输出简洁结论，正文控制在 300 字以内' }] }))
    writeFileSync(join(data, 'sessions', 'ordinary.json'), JSON.stringify({ messages: [{ role: 'user', content: 'Please discuss WeBot tasks.' }] }))
    const chats = loadChatIndexes(data, workspace)
    expect(chats.find(chat => chat.id === 'legacy')?.invocation?.taskId).toBe('legacy')
    expect(chats.find(chat => chat.id === 'ordinary')?.invocation).toBeUndefined()
  })
  it('rejects conflicting destinations without overwriting either transcript or committing the interactive index', () => {
    const { data, workspace, chats } = fixture()
    mkdirSync(join(data, 'automations', 'sessions'), { recursive: true })
    writeFileSync(join(data, 'automations', 'sessions', 'automated.json'), 'different data')
    expect(() => loadChatIndexes(data, workspace)).toThrow('differs')
    expect(JSON.parse(readFileSync(join(data, 'index.json'), 'utf8')).chats).toEqual(chats)
    expect(existsSync(join(data, 'sessions', 'automated.json'))).toBe(true)
  })
  it('recognizes legacy runs whose original dispatcher prompt was archived', () => {
    const { data, workspace } = fixture()
    writeFileSync(join(data, 'index.json'), JSON.stringify({ chats: [{ id: 'legacy' }] }))
    writeFileSync(join(data, 'sessions', 'legacy.json'), JSON.stringify({ messages: [{ role: 'assistant', content: 'Latest answer' }] }))
    writeFileSync(join(data, 'sessions', 'legacy.archive.jsonl'), JSON.stringify({ role: 'user', content: '这是 WeBot 定时任务的自动执行（2026）。请只输出简洁结论，正文控制在 300 字以内' }) + '\n')
    expect(loadChatIndexes(data, workspace)[0].invocation?.kind).toBe('automation')
    expect(readFileSync(join(data, 'automations', 'sessions', 'legacy.archive.jsonl'), 'utf8')).toContain('自动执行')
  })
  it('recovers an interruption between destination and source index commits without duplicate records', () => {
    const { data, workspace, chats } = fixture()
    mkdirSync(join(data, 'automations'), { recursive: true })
    writeFileSync(join(data, 'automations', 'index.json'), JSON.stringify({ chats: [chats[1]] }))
    expect(loadChatIndexes(data, workspace)).toHaveLength(2)
    persistChatIndexes(data, loadChatIndexes(data, workspace))
    expect(loadChatIndexes(data, workspace)).toHaveLength(2)
  })
  it('refuses path traversal from a corrupt stored ID', () => {
    const { data, workspace } = fixture()
    writeFileSync(join(data, 'index.json'), JSON.stringify({ chats: [{ id: '../other' }] }))
    expect(() => loadChatIndexes(data, workspace)).toThrow('Invalid stored chat ID')
  })
})
