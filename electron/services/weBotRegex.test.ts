import { afterEach, describe, expect, it } from 'vitest'
import { BoundedRegexMatcher, normalizeMessageTrigger } from './weBotRegex'

const matchers: BoundedRegexMatcher[] = []
afterEach(() => { for (const matcher of matchers.splice(0)) matcher.close() })
const create = () => { const matcher = new BoundedRegexMatcher(); matchers.push(matcher); return matcher }

describe('bounded WeBot regex matching', () => {
  it('binds the selected account, validates flags and syntax, and clamps cooldown', () => {
    const input = { kind: 'message' as const, pattern: 'deadline|截止', flags: 'i', accountId: 'untrusted', cooldownSeconds: 0 }
    expect(normalizeMessageTrigger(input, 'selected').accountId).toBe('selected')
    expect(() => normalizeMessageTrigger({ ...input, flags: 'g' }, 'A')).toThrow('标志')
    expect(() => normalizeMessageTrigger({ ...input, pattern: '(' }, 'A')).toThrow('无效')
    expect(() => normalizeMessageTrigger(input, '')).toThrow('连接账号')
  })
  it('reuses its isolated worker and keeps matches case-aware', async () => {
    const matcher = create()
    expect(await matcher.match('deadline', 'i', 'DEADLINE tomorrow')).toBe(true)
    expect(await matcher.match('deadline', '', 'DEADLINE tomorrow')).toBe(false)
    expect(await matcher.match('截止', 'u', '明天截止')).toBe(true)
  })
  it('terminates pathological regex work and recovers for subsequent matches', async () => {
    const matcher = create()
    await expect(matcher.match('(a+)+$', '', 'a'.repeat(32768) + '!')).rejects.toThrow('超时')
    expect(await matcher.match('safe', '', 'safe')).toBe(true)
  })
})
