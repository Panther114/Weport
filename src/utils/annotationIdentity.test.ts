import { describe, expect, it } from 'vitest'
import { annotationIdentityFields, annotationIdentityKey, annotationMatchesMessage } from './annotationIdentity'

describe('annotation message identity', () => {
  it('keeps shard/table and timestamp in the favorite key', () => {
    const first = { sessionId: 's1', localId: '42', idKind: 'local' as const, ts: 1_790_388_300_000, db: 'message_2.db', table: 'Msg_A' }
    const second = { ...first, db: 'C:/wx/message_3.db', table: 'Msg_B' }
    const later = { ...first, ts: 1_790_388_301_000 }
    expect(annotationIdentityKey(first)).not.toBe(annotationIdentityKey(second))
    expect(annotationIdentityKey(first)).not.toBe(annotationIdentityKey(later))
    expect(annotationIdentityKey(first)).toBe(annotationIdentityKey({ ...first, db: 'C:/wx/message_2.db' }))
  })

  it('preserves large server IDs as strings and distinguishes them from local IDs', () => {
    const server = { sessionId: 's1', localId: '9007199254740993', localIdNumber: Number('9007199254740993'), idKind: 'server' as const, ts: 1_790_388_300_000 }
    const fields = annotationIdentityFields(server)
    expect(fields).toMatchObject({ localId: '', messageId: '9007199254740993', idKind: 'server', ts: 1_790_388_300 })
    expect(annotationIdentityKey(server)).not.toBe(annotationIdentityKey({ ...server, idKind: 'local' }))
  })

  it('uses exact message text instead of a rounded numeric companion for local IDs', () => {
    const exactId = '9007199254740993'
    const fields = annotationIdentityFields({
      sessionId: 's1',
      localId: Number(exactId),
      localIdNumber: Number(exactId),
      messageId: exactId,
      idKind: 'local',
      ts: 1_790_388_300_000,
      db: 'message_2.db',
    })
    expect(fields).toMatchObject({ localId: exactId, messageId: exactId, idKind: 'local' })
  })

  it('does not apply a legacy unscoped mark to a shard-qualified message', () => {
    const legacy = { sessionId: 's1', localId: '42', ts: 1_790_388_300 }
    const exact = { sessionId: 's1', localId: 42, idKind: 'local' as const, ts: 1_790_388_300_000, db: 'message_2.db', table: 'Msg_A' }
    expect(annotationMatchesMessage(legacy, exact)).toBe(false)
    expect(annotationMatchesMessage(legacy, { sessionId: 's1', localId: 42, ts: 1_790_388_300_000 })).toBe(true)
  })
})
