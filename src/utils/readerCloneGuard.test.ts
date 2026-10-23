import { describe, expect, it } from 'vitest'
import { cloneAccountIdentity, readerCloneGuardError } from './readerCloneGuard'

describe('Reader WeClone dispatch guard', () => {
  const guard = { accountId: 'wxid_me_1234', sessionId: 'chat' }
  const clone = { id: 'selected', wxid: 'wxid_me' }
  it('accepts only the explicit clone on the selected account, using the config suffix convention', () => {
    expect(readerCloneGuardError(guard, 'wxid_me', 'selected', clone)).toBeUndefined()
    expect(cloneAccountIdentity('custom_1234')).toBe('custom')
    expect(cloneAccountIdentity('wxid_me_1234')).toBe('wxid_me')
    expect(cloneAccountIdentity('wxid_me_other')).toBe('wxid_me_other')
    expect(cloneAccountIdentity('wxid_test')).toBe('wxid_test')
  })
  it('rejects missing scope, missing clone and unrelated accounts', () => {
    expect(readerCloneGuardError({ ...guard, accountId: '' }, 'wxid_me', 'selected', clone)).toBeTruthy()
    expect(readerCloneGuardError({ ...guard, sessionId: '' }, 'wxid_me', 'selected', clone)).toBeTruthy()
    expect(readerCloneGuardError(guard, 'wxid_me', '', clone)).toBeTruthy()
    expect(readerCloneGuardError(guard, 'wxid_other', 'selected', clone)).toContain('账号已改变')
    expect(readerCloneGuardError(guard, 'wxid_me', 'selected')).toContain('不存在')
    expect(readerCloneGuardError(guard, 'wxid_me', 'selected', { ...clone, wxid: 'wxid_other' })).toContain('不属于')
    expect(readerCloneGuardError(guard, 'wxid_me_other', 'selected', clone)).toContain('账号已改变')
    expect(readerCloneGuardError(guard, 'wxid_me', 'selected', { ...clone, wxid: 'wxid_me_other' })).toContain('不属于')
  })
  it('blocks a subsequent dispatch when the account or selected clone changes during retrieval/retry', () => {
    expect(readerCloneGuardError(guard, 'wxid_me', 'selected', clone)).toBeUndefined()
    expect(readerCloneGuardError(guard, 'wxid_switched', 'selected', clone)).toBeTruthy()
    expect(readerCloneGuardError(guard, 'wxid_me', 'selected', { ...clone, id: 'replacement' })).toBeTruthy()
  })
})
