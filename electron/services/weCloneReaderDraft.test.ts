import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('./config', () => ({ ConfigService: class { static getInstance() { return { get: () => '', getMyWxidCleaned: () => '' } } } }))
vi.mock('./chatService', () => ({ chatService: {} }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
vi.mock('./ai/providerProfiles', () => ({ ProviderProfileService: class { list() { return [] } } }))
import { WeCloneService, gatewaySessionForChat } from './weCloneService'
import { prepareReaderDraftContext } from '../../src/components/reader/readerDraftContext'
import { normalizeMessage } from '../../src/components/reader/readerMessage'

const fixtures: string[] = []
afterEach(() => {
  for (const dir of fixtures.splice(0)) { unlinkSync(join(dir, 'profile.md')); rmdirSync(dir) }
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weport-reader-draft-test-'))
  fixtures.push(dir)
  writeFileSync(join(dir, 'profile.md'), 'Synthetic fixture persona; no personal data.')
  const state = { account: 'wxid_me', clones: [{ id: 'selected', wxid: 'wxid_me', displayName: 'Fixture', knowledgeCutoff: '2026-10-01' }] }
  // Avoid constructor settings and every real provider/native dependency.
  const target = Object.create(WeCloneService.prototype) as any
  Object.assign(target, {
    configService: { get: () => state.account, getMyWxidCleaned: () => state.account },
    listLocalClones: () => state.clones,
    findCloneDir: () => dir,
    mdFilePaths: () => [{ key: 'profile', path: join(dir, 'profile.md') }],
    refusalForClone: () => 'off', readFingerprintBlock: () => '',
    readSettings: () => ({ exemplars: 'on', shape: 'off', lengthHint: 'off' }),
    buildVoiceExemplarBlock: vi.fn(async () => ({ block: '', count: 0 })),
    getActiveProfile: () => ({ id: 'fixture-provider', name: 'Fixture', providerId: 'fixture', model: 'fixture', apiKey: 'synthetic' }),
    providerProfiles: { getForConsumer: () => null },
    callLlmWithSystem: vi.fn(async () => 'Synthetic reply'),
  })
  return { target, state }
}
const input = { cloneId: 'selected', message: 'Selected chat context', readerGuard: { accountId: 'wxid_me', sessionId: 'chat' } }

describe('Reader drafts through the existing WeClone chat path', () => {
  it('does not dispatch for missing/stale selection or a cross-account clone', async () => {
    const { target, state } = fixture()
    expect((await target.chatWithClone({ ...input, cloneId: '' })).success).toBe(false)
    expect((await target.chatWithClone({ ...input, cloneId: 'deleted' })).success).toBe(false)
    state.clones[0].wxid = 'wxid_other'
    expect((await target.chatWithClone(input)).success).toBe(false)
    expect(target.callLlmWithSystem).not.toHaveBeenCalled()
  })

  it('rechecks the active account after asynchronous retrieval before dispatch', async () => {
    const { target, state } = fixture()
    target.buildVoiceExemplarBlock.mockImplementation(async () => { state.account = 'wxid_other'; return { block: '', count: 0 } })
    expect(await target.chatWithClone(input)).toMatchObject({ success: false, error: expect.stringContaining('账号已改变') })
    expect(target.callLlmWithSystem).not.toHaveBeenCalled()
  })

  it('rechecks clone existence after asynchronous retrieval', async () => {
    const { target, state } = fixture()
    target.buildVoiceExemplarBlock.mockImplementation(async () => { state.clones = []; return { block: '', count: 0 } })
    expect((await target.chatWithClone(input)).success).toBe(false)
    expect(target.callLlmWithSystem).not.toHaveBeenCalled()
  })

  it('discards a completed model response after the account changes while it is pending', async () => {
    const { target, state } = fixture()
    target.callLlmWithSystem.mockImplementation(async () => { state.account = 'wxid_other'; return 'Stale account draft' })
    expect(await target.chatWithClone(input)).toMatchObject({ success: false, error: expect.stringContaining('账号已改变') })
  })

  it('does not dispatch a fallback provider after the account changes during the first attempt', async () => {
    const { target, state } = fixture()
    target.providerProfiles.getForConsumer = () => ({ id: 'fallback', apiKey: 'synthetic', providerId: 'fixture', model: 'fallback' })
    target.callLlmWithSystem.mockImplementation(async () => { state.account = 'wxid_other'; throw new Error('503 unavailable') })
    expect((await target.chatWithClone(input)).success).toBe(false)
    expect(target.callLlmWithSystem).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Can we meet tomorrow?', 'English draft for manual review', 'en'],
    ['明天一起吃饭吗？', '可以呀，几点见？', 'zh'],
  ])('keeps the selected incoming language through the real draft wrapper: %s', async (incoming, reply, language) => {
    const { target } = fixture()
    const context = prepareReaderDraftContext('wxid_me', 'chat', [normalizeMessage({
      localId: 1, createTime: 1_700_000_000, localType: 1,
      parsedContent: incoming, db: 'fixture.db', table: 'Msg_fixture', isSend: 0,
    }, 'chat')])
    target.callLlmWithSystem.mockResolvedValue(reply)
    const result = await target.chatWithClone({ ...input, message: context.message })
    expect(result).toMatchObject({ success: true, reply, meta: { replyLanguage: language, cloneId: 'selected' } })
    expect(target.callLlmWithSystem.mock.calls[0][2]).toContain(incoming)
  })

  it('keeps ordinary history out and uses a fresh gateway scope for every draft', async () => {
    const { target } = fixture()
    await target.chatWithClone({ ...input, history: [{ role: 'user', content: 'MUST_NOT_APPEAR' }] })
    await target.chatWithClone(input)
    const calls = target.callLlmWithSystem.mock.calls
    expect(calls[0][2]).toContain(input.message)
    expect(calls[0][2]).not.toContain('MUST_NOT_APPEAR')
    expect(calls[0][4]).toMatch(/^weport-reader-draft-/)
    expect(calls[0][4]).not.toBe(calls[1][4])
    expect(calls[0][4]).not.toBe(gatewaySessionForChat('selected'))
  })

  it('rejects oversized Reader requests before calling the model', async () => {
    const { target } = fixture()
    expect((await target.chatWithClone({ ...input, message: 'x'.repeat(12_001) })).success).toBe(false)
    expect(target.callLlmWithSystem).not.toHaveBeenCalled()
  })

  it('retains normal clone chat history behavior without a Reader guard', async () => {
    const { target } = fixture()
    const result = await target.chatWithClone({ cloneId: 'selected', message: 'Normal chat', history: [{ role: 'user', content: 'ordinary history' }] })
    expect(result.success).toBe(true)
    expect(target.callLlmWithSystem.mock.calls[0][2]).toContain('ordinary history')
    expect(target.callLlmWithSystem.mock.calls[0][4]).toBe(gatewaySessionForChat('selected'))
  })
})
