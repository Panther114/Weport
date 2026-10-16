import { describe, expect, it } from 'vitest'
import { exactLocalIdToken, sourceMessageIdentityHash } from './sourceMessageIdentity'

describe('source message identity', () => {
  it('keeps local IDs exact and rejects unsafe numeric values', () => {
    expect(exactLocalIdToken('0009007199254740993')).toBe('9007199254740993')
    expect(exactLocalIdToken(9007199254740992)).toBeUndefined()
    expect(exactLocalIdToken(-1)).toBeUndefined()
  })

  it('uses logical db_storage path, table, and local ID as the identity scope', () => {
    const first = sourceMessageIdentityHash({
      localId: '17',
      dbPath: 'C:/probe-a/account/db_storage/message/message_0.db',
      tableName: 'Msg_A',
    })
    const mirrored = sourceMessageIdentityHash({
      localId: '17',
      dbPath: 'C:/probe-b/account/db_storage/message/message_0.db',
      tableName: 'msg_a',
    })
    const differentLocalId = sourceMessageIdentityHash({
      localId: '18',
      dbPath: 'C:/probe-b/account/db_storage/message/message_0.db',
      tableName: 'Msg_A',
    })
    const differentTable = sourceMessageIdentityHash({
      localId: '17',
      dbPath: 'C:/probe-b/account/db_storage/message/message_0.db',
      tableName: 'Msg_B',
    })

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(mirrored).toBe(first)
    expect(differentLocalId).not.toBe(first)
    expect(differentTable).not.toBe(first)
  })

  it('does not manufacture an identity without complete source scope', () => {
    expect(sourceMessageIdentityHash({ localId: 0, dbPath: 'db_storage/a.db', tableName: 'Msg_a' })).toBeUndefined()
    expect(sourceMessageIdentityHash({ localId: 17, dbPath: '', tableName: 'Msg_a' })).toBeUndefined()
    expect(sourceMessageIdentityHash({ localId: 17, dbPath: 'db_storage/a.db', tableName: '' })).toBeUndefined()
  })
})
