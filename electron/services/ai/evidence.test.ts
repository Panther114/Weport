import { describe, expect, it } from 'vitest'
import { evidenceReference, evidenceContentHash, validateClaim, type MemoryClaim } from './evidence'
import type { Message } from '../chatService'

const message = { localId: 0, localIdRaw: '9007199254740993', _db_path: 'message_0.db', _table_name: 'Msg_a', createTime: 1700000000, rawContent: '你好 hello', parsedContent: '你好 hello', senderUsername: 'person', localType: 1 } as Message
describe('AI evidence identity and claims', () => {
  it('preserves exact uint64 identity and isolates accounts and physical shards', () => {
    const reference = evidenceReference('account-a', 'chat', message)!
    expect(reference.localId).toBe('9007199254740993')
    expect(reference.ts).toBe(1700000000000)
    expect(evidenceReference('account-b', 'chat', message)?.accountId).toBe('account-b')
    expect(evidenceReference('account-a', 'chat', { ...message, _db_path: 'message_1.db' })?.db).not.toBe(reference.db)
  })
  it('refuses unsafe numeric identities or missing provenance', () => {
    expect(evidenceReference('a', 'c', { ...message, localIdRaw: undefined, localId: 9007199254740992 })).toBeNull()
    expect(evidenceReference('a', 'c', { ...message, _table_name: undefined })).toBeNull()
  })
  it('detects changed text, sender, timestamp and message type', () => {
    for (const change of [{ rawContent: 'edited' }, { parsedContent: 'edited' }, { senderUsername: 'other' }, { createTime: 1700000001 }, { localType: 3 }]) {
      expect(evidenceContentHash({ ...message, ...change })).not.toBe(evidenceContentHash(message))
    }
  })
  it('requires evidence for observations and rejects unavailable counterevidence', () => {
    const claim: MemoryClaim = { id: '1', statement: 'A dated fact', kind: 'observation', status: 'active', asOf: 1700000000, createdAt: 1700000001, evidenceIds: [], counterEvidenceIds: [] }
    expect(() => validateClaim(claim, new Set())).toThrow('requires source evidence')
    expect(() => validateClaim({ ...claim, evidenceIds: ['e'], counterEvidenceIds: ['missing'] }, new Set(['e']))).toThrow('Unavailable')
    expect(() => validateClaim({ ...claim, evidenceIds: ['e'] }, new Set(['e']))).not.toThrow()
    expect(() => validateClaim({ ...claim, kind: 'interpretation', status: 'uncertain' }, new Set())).not.toThrow()
  })
})
