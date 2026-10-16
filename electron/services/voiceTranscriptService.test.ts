import { describe, expect, it, vi } from 'vitest'
vi.mock('./config', () => ({ ConfigService: class {
  getCacheBasePath() { return process.env.TEMP || '.' }
  get() { return '' }
} }))
vi.mock('./wcdbService', () => ({ wcdbService: {} }))
import { chatService } from './chatService'

const getTranscript = Object.getPrototypeOf(chatService).getVoiceTranscript
const fake = () => ({
  loadTranscriptCacheIfNeeded: vi.fn(),
  normalizeUnsignedIntegerToken: (value: unknown) => String(value || ''),
  getMessageByIdentity: vi.fn(),
  getVoiceCacheKey: (session: string, id: string, ts: number) => `${session}_${ts}_${id}`,
  voiceTranscriptCache: new Map(),
  getVoiceData: vi.fn(),
})

describe('existing voice text service', () => {
  it('uses the exporter resolved row without querying or decoding audio', async () => {
    const target = fake()
    const result = await getTranscript.call(target, 'room', '7', 1700000000, undefined, 'sender', '18446744073709551610', '<voicetrans transtext="已经转换"/>')
    expect(result).toEqual({ success: true, transcript: '已经转换' })
    expect(target.getMessageByIdentity).not.toHaveBeenCalled()
    expect(target.getVoiceData).not.toHaveBeenCalled()
  })
  it('looks up the exact server identity for other callers', async () => {
    const target = fake()
    target.getMessageByIdentity.mockResolvedValue({ success: true, message: { rawContent: '<transtext>文字</transtext>', createTime: 1700000000 } })
    expect((await getTranscript.call(target, 'room', '7', 1700000000, undefined, 'sender', '18446744073709551610')).transcript).toBe('文字')
    expect(target.getMessageByIdentity).toHaveBeenCalledWith({ sessionId: 'room', localId: '18446744073709551610', ts: 1700000000, idKind: 'server' })
  })
  it('re-reads a strict packed-data miss by source-scoped local identity', async () => {
    const target = fake()
    target.getMessageByIdentity.mockResolvedValue({ success: true, message: {
      rawContent: '<voicemsg voicelength="3000"/>',
      voiceTranscript: '原始数据库中的转写',
      createTime: 1700000000,
    } })

    const result = await getTranscript.call(
      target,
      'room',
      '9007199254740993',
      1700000000,
      undefined,
      'sender',
      '900000000001',
      '<voicemsg voicelength="3000"/>',
      { packedInfoDataPresent: true, packedInfoDataHasValue: true, dbPath: 'db_storage/message/message_0.db', tableName: 'Msg_abc' },
    )

    expect(result).toEqual({ success: true, transcript: '原始数据库中的转写' })
    expect(target.getMessageByIdentity).toHaveBeenCalledWith({
      sessionId: 'room',
      localId: '9007199254740993',
      ts: 1700000000,
      idKind: 'local',
      db: 'db_storage/message/message_0.db',
      table: 'Msg_abc',
    })
    expect(target.getVoiceData).not.toHaveBeenCalled()
  })
  it('rejects ambiguous identities and does not substitute cached text', async () => {
    const target = fake()
    target.voiceTranscriptCache.set('room_1700000000_7', 'wrong shard')
    target.getMessageByIdentity.mockResolvedValue({ success: false, error: 'ambiguous' })
    expect(await getTranscript.call(target, 'room', '7', 1700000000)).toEqual({ success: false, error: 'ambiguous' })
  })
  it('explains unavailable local text without claiming an ASR failure', async () => {
    const target = fake()
    const result = await getTranscript.call(target, 'room', '7', 1700000000, undefined, undefined, undefined, '<voicemsg voicelength="3000"/>')
    expect(result.success).toBe(false)
    expect(result.error).toContain('本地未找到已转换文字')
    expect(target.getVoiceData).not.toHaveBeenCalled()
  })
})
