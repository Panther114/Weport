import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.mock('./config', () => ({ ConfigService: class { getCacheBasePath() { return tmpdir() } get() { return '' } } }))
vi.mock('./wcdbService', () => ({ wcdbService: { execQuery: vi.fn(), getVoiceData: vi.fn(), getVoiceDataBatch: vi.fn() } }))
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
afterEach(() => vi.clearAllMocks())

function fixture() {
  const target = Object.create(Object.getPrototypeOf(chatService)) as any
  const message = { localType: 34, createTime: 1700000000, localIdRaw: '9007199254740993', serverIdRaw: '18446744073709551615' }
  Object.assign(target, { configService: { getMyWxidCleaned: () => 'account-A' }, voiceWavCache: new Map(),
    getMessageByIdentity: vi.fn(async () => ({ success: true, message })),
    listVoiceMediaDbs: vi.fn(async () => ['media.db']),
    decodeSilkToPcm: vi.fn(async (bytes: Buffer) => Buffer.from('pcm:' + bytes.toString())),
    createWavBuffer: vi.fn((bytes: Buffer) => Buffer.from('wav:' + bytes.toString())),
    cacheVoiceWavToFile: vi.fn(async () => {}),
  })
  vi.mocked(wcdbService.execQuery).mockImplementation(async (_kind, _db, sql) => {
    if (sql.includes('sqlite_master')) return { success: true, rows: [{ name: 'VoiceInfo' }] }
    if (sql.startsWith('PRAGMA')) return { success: true, rows: ['voice_data', 'msg_svr_id', 'create_time'].map(name => ({ name })) }
    return { success: true, rows: [{ data: Buffer.from('silk fixture').toString('hex') }] }
  })
  return { target, message, source: { db: 'db_storage/message_0.db', table: 'Msg_room' } }
}

describe('exact archive voice lookup', () => {
  it('keeps unsafe local and unsigned server IDs exact without a narrowed native lookup', async () => {
    const x = fixture()
    const result = await x.target.getVoiceData('room', x.message.localIdRaw, 1700000000, undefined, undefined, x.source)
    expect(result.success).toBe(true)
    expect(x.target.getMessageByIdentity).toHaveBeenCalledWith({ sessionId: 'room', localId: '9007199254740993', ts: 1700000000, ...x.source, idKind: 'local' })
    expect(wcdbService.execQuery).toHaveBeenCalledWith('media', 'media.db', expect.stringContaining("IN ('18446744073709551615','-1')"))
    expect(wcdbService.getVoiceData).not.toHaveBeenCalled(); expect(wcdbService.getVoiceDataBatch).not.toHaveBeenCalled()
  })
  it('normalizes signed server IDs without losing their uint64 equivalence', async () => {
    const x = fixture(); x.message.serverIdRaw = '-1'
    expect((await x.target.getVoiceData('room', x.message.localIdRaw, 1700000000, undefined, undefined, x.source)).success).toBe(true)
    expect(wcdbService.execQuery).toHaveBeenCalledWith('media', 'media.db', expect.stringContaining("IN ('18446744073709551615','-1')"))
  })
  it('does not share cached WAVs across physical shards, accounts or changed BLOBs', async () => {
    const x = fixture()
    const run = (source = x.source) => x.target.getVoiceData('room', x.message.localIdRaw, 1700000000, undefined, undefined, source)
    await run(); await run()
    expect(x.target.decodeSilkToPcm).toHaveBeenCalledTimes(1)
    await run({ ...x.source, db: 'db_storage/message_1.db' })
    expect(x.target.decodeSilkToPcm).toHaveBeenCalledTimes(2)
    x.target.configService.getMyWxidCleaned = () => 'account-B'
    await run(); expect(x.target.decodeSilkToPcm).toHaveBeenCalledTimes(3)
    vi.mocked(wcdbService.execQuery).mockResolvedValueOnce({ success: true, rows: [{ name: 'VoiceInfo' }] })
      .mockResolvedValueOnce({ success: true, rows: ['voice_data', 'msg_svr_id'].map(name => ({ name })) })
      .mockResolvedValueOnce({ success: true, rows: [{ data: Buffer.from('different silk').toString('hex') }] })
    await run(); expect(x.target.decodeSilkToPcm).toHaveBeenCalledTimes(4)
  })
  it('rejects colliding media rows instead of choosing the first matching BLOB', async () => {
    const x = fixture()
    vi.mocked(wcdbService.execQuery).mockResolvedValueOnce({ success: true, rows: [{ name: 'VoiceInfo' }] })
      .mockResolvedValueOnce({ success: true, rows: ['voice_data', 'msg_svr_id'].map(name => ({ name })) })
      .mockResolvedValueOnce({ success: true, rows: [{ data: '01' }, { data: '02' }] })
    const result = await x.target.getVoiceData('room', x.message.localIdRaw, 1700000000, undefined, undefined, x.source)
    expect(result).toMatchObject({ success: false, failureKind: 'unsupported' })
    expect(x.target.decodeSilkToPcm).not.toHaveBeenCalled()
  })
  it('rejects timestamp-only media mapping and missing exact rows', async () => {
    const x = fixture(); x.message.serverIdRaw = '0'
    expect(await x.target.getVoiceData('room', x.message.localIdRaw, 1700000000, undefined, undefined, x.source)).toMatchObject({ success: false, failureKind: 'unsupported' })
    expect(wcdbService.execQuery).not.toHaveBeenCalled()
    x.target.getMessageByIdentity.mockResolvedValue({ success: false, error: 'ambiguous' })
    expect(await x.target.getVoiceData('room', x.message.localIdRaw, 1700000000, undefined, undefined, x.source)).toMatchObject({ success: false, failureKind: 'unsupported' })
  })
})
