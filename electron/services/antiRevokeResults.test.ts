import { describe, expect, it } from 'vitest'
import { classifyAntiRevokeCheckRows, isAntiRevokeSessionEligible, makeAntiRevokeBatchResult, mergeAntiRevokeBatchResult, verifyAntiRevokeTransition } from './antiRevokeResults'

describe('anti-revoke results', () => {
  it('does not call an install successful when the trigger is still absent', () => {
    expect(verifyAntiRevokeTransition(
      'install',
      { success: true },
      { success: true, installed: false }
    )).toEqual({ success: false, alreadyInstalled: undefined, error: '安装后未检测到防撤回触发器' })
  })

  it('does not call a removal successful while the trigger remains installed', () => {
    expect(verifyAntiRevokeTransition(
      'uninstall',
      { success: true },
      { success: true, installed: true }
    )).toEqual({ success: false, alreadyInstalled: undefined, error: '还原后仍检测到防撤回触发器' })
  })

  it('reports an uncertain post-write state instead of claiming success', () => {
    expect(verifyAntiRevokeTransition(
      'uninstall',
      { success: true },
      { success: false, error: 'database busy' }
    ).error).toContain('无法确认触发器状态：database busy')
  })

  it('keeps row errors and makes a fully failed batch fail at the top level', () => {
    const result = makeAntiRevokeBatchResult([
      { sessionId: 'a', success: false, error: 'database busy' },
      { sessionId: 'b', success: false, error: 'not eligible' },
    ])
    expect(result.success).toBe(false)
    expect(result.rows).toHaveLength(2)
    expect(result.error).toBe('database busy')
  })

  it('treats an empty batch as a successful no-op', () => {
    expect(makeAntiRevokeBatchResult([])).toEqual({ success: true, rows: [] })
  })

  it('includes rejected IDs alongside native partial results', () => {
    const result = mergeAntiRevokeBatchResult(
      { success: true, rows: [{ sessionId: 'valid', success: true }] },
      [{ sessionId: 'invalid', success: false, error: 'not eligible' }]
    )
    expect(result.success).toBe(false)
    expect(result.rows.map((row) => row.sessionId)).toEqual(['valid', 'invalid'])
    expect(result.error).toBe('not eligible')
  })

  it('classifies auto-install batches per row so one failed check does not block confirmed missing triggers', () => {
    expect(classifyAntiRevokeCheckRows(['installed', 'missing', 'failed', 'absent'], [
      { sessionId: 'installed', success: true, installed: true },
      { sessionId: 'missing', success: true, installed: false },
      { sessionId: 'failed', success: false, error: 'database busy' },
    ])).toEqual({
      installedIds: ['installed'],
      missingIds: ['missing'],
      unknownIds: ['failed', 'absent'],
    })
  })

  it('limits the anti-recall session fixture to contacts and groups with message tables', () => {
    const fixture = [
      { username: 'family@chatroom', isContact: false, hasMessageTables: true },
      { username: 'wxid_alice', isContact: true, hasMessageTables: true },
      { username: 'stranger', isContact: false, hasMessageTables: true },
      { username: 'gh_official', isContact: true, hasMessageTables: true },
      { username: 'empty@chatroom', isContact: false, hasMessageTables: false },
      { username: 'placeholder_foldgroup_1', isContact: false, hasMessageTables: true },
    ]
    expect(fixture.filter((row) => isAntiRevokeSessionEligible(row.username, row)).map((row) => row.username))
      .toEqual(['family@chatroom', 'wxid_alice'])
  })
})
