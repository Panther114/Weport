import { describe, expect, it } from 'vitest'
import { normalizeMessage } from './readerMessage'
import { prepareReaderDraftContext, readerDraftClones, requireReaderDraftClone, READER_DRAFT_MAX_CHARS } from './readerDraftContext'

const row = (id: number, text = `message-${id}`, extra: Record<string, unknown> = {}) => normalizeMessage({
  localId: id, createTime: 1_700_000_000 + id, localType: 1,
  parsedContent: text, db: 'message_0.db', table: 'Msg_chat', ...extra,
}, 'chat')
const clone = (id: string, wxid = 'wxid_me', source = 'local') => ({ id, wxid, source, displayName: id, generatedAt: '2026-10-01' })

describe('Reader draft context boundary', () => {
  it('includes exactly the explicitly selected rows in chronological order, with complete provenance', () => {
    const context = prepareReaderDraftContext('wxid_me', 'chat', [row(3, 'selected last'), row(1, 'selected first')])
    expect(context.message.indexOf('selected first')).toBeLessThan(context.message.indexOf('selected last'))
    expect(context.message).not.toContain('message-2')
    expect(context.identities).toEqual([
      { localId: '1', ts: 1_700_000_001_000, db: 'message_0.db', table: 'Msg_chat', idKind: 'local' },
      { localId: '3', ts: 1_700_000_003_000, db: 'message_0.db', table: 'Msg_chat', idKind: 'local' },
    ])
  })

  it('preserves quotes and multiline text verbatim as JSON data', () => {
    const context = prepareReaderDraftContext('wxid_me', 'chat', [row(1, 'reply\n"quoted"', { quotedSender: 'Alex', quotedContent: 'original' })])
    const line = context.message.split('\n').find((text) => text.startsWith('{'))!
    expect(JSON.parse(line)).toMatchObject({ text: 'reply\n"quoted"', quote: { sender: 'Alex', text: 'original' } })
  })

  it('rejects empty, cross-session, duplicate, media and missing-source selections', () => {
    expect(() => prepareReaderDraftContext('', 'chat', [row(1)])).toThrow('账号')
    expect(() => prepareReaderDraftContext('wxid_me', 'chat', [])).toThrow('选择')
    expect(() => prepareReaderDraftContext('wxid_me', 'other', [row(1)])).toThrow('当前会话')
    expect(() => prepareReaderDraftContext('wxid_me', 'chat', [row(1), row(1)])).toThrow('重复')
    expect(() => prepareReaderDraftContext('wxid_me', 'chat', [row(1, 'image', { localType: 3 })])).toThrow('仅支持')
    expect(() => prepareReaderDraftContext('wxid_me', 'chat', [row(1, 'text', { db: undefined })])).toThrow('来源身份')
  })

  it('rejects excess rows or complete-request characters instead of silently truncating', () => {
    expect(() => prepareReaderDraftContext('wxid_me', 'chat', Array.from({ length: 21 }, (_, id) => row(id + 1)))).toThrow('20')
    expect(() => prepareReaderDraftContext('wxid_me', 'chat', [row(1, 'x'.repeat(READER_DRAFT_MAX_CHARS))])).toThrow('字符')
    expect(prepareReaderDraftContext('wxid_me', 'chat', [row(1, 'x'.repeat(11_000))]).message.length).toBeLessThanOrEqual(READER_DRAFT_MAX_CHARS)
  })

  it('preserves an exact uint64 message identity', () => {
    expect(prepareReaderDraftContext('wxid_me', 'chat', [row(1, 'text', { localIdRaw: '18446744073709551614' })]).identities[0].localId).toBe('18446744073709551614')
  })
})

describe('Reader explicit clone selection', () => {
  const clones = [clone('mine'), clone('other', 'wxid_other'), clone('remote', 'wxid_me', 'remote')] as Parameters<typeof readerDraftClones>[0]
  it('only exposes local clones owned by the current account', () => {
    expect(readerDraftClones(clones, 'wxid_me_1234').map((item) => item.id)).toEqual(['mine'])
    expect(readerDraftClones(clones, '')).toEqual([])
  })
  it('never falls back when selection is empty, stale or belongs to another account', () => {
    for (const id of ['', 'deleted', 'other', 'remote']) expect(() => requireReaderDraftClone(clones, 'wxid_me', id)).toThrow('重新选择')
    expect(requireReaderDraftClone(clones, 'wxid_me', 'mine').id).toBe('mine')
  })
})
