import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./config', () => ({ ConfigService: class { getCacheBasePath() { return process.env.TEMP || '.' }; get() { return '' } } }))
vi.mock('./wcdbService', () => ({ wcdbService: { openMessageCursor: vi.fn(), fetchMessageBatch: vi.fn(), closeMessageCursor: vi.fn(async () => undefined) } }))
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import { taskStatusService, TASK_KEY } from './taskStatusService'

const identity = { sessionId: 'room', localId: '1', ts: 1700000000000, db: 'message_0.db', table: 'Msg_room' }
function fixture() {
  const state = { account: 'A' }
  const target = Object.create(chatService) as any
  Object.assign(target, {
    referenceCache: new Map(), referenceScan: null,
    ensureConnected: vi.fn(async () => ({ success: true })),
    captureAntiRevokeContext: () => ({ identity: state.account, generation: 1 }),
    isAntiRevokeContextCurrent: (value: any) => value.identity === state.account,
    getMessageByIdentity: vi.fn(async () => ({ success: true, message: { createTime: 1700000000, serverIdRaw: '9007199254740993' } })),
    decodeMessageContent: (value: string) => value,
    getRowTimestampSeconds: (row: any) => Number(row.create_time),
    parseMessage: vi.fn(async (row: any) => ({ ...row, messageKey: `${row._db_path}/${row._table_name}/${row.local_id}`, localIdRaw: row.local_id, createTime: row.create_time, rawContent: row.message_content })),
    enrichGroupMessageSenderProfiles: vi.fn(async () => undefined),
  })
  return { target, state }
}
const quote = (id: string, timestamp = '') => ({ local_id: id, server_id: `20${id}`, create_time: 1700000010, _db_path: 'message_1.db', _table_name: 'Msg_room', message_content: `<refermsg><svrid>9007199254740993</svrid>${timestamp ? `<createtime>${timestamp}</createtime>` : ''}</refermsg>` })
const source = { local_id: '1', server_id: '9007199254740993', create_time: 1700000000, message_content: 'Original' }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(wcdbService.openMessageCursor).mockReset().mockResolvedValue({ success: true, cursor: 7 } as any); vi.mocked(wcdbService.fetchMessageBatch).mockReset() })

describe('reverse references across exact message sources', () => {
  it('scans every page, excludes plain text matches and paginates a stable snapshot without rescanning', async () => {
    const { target } = fixture()
    vi.mocked(wcdbService.fetchMessageBatch)
      .mockResolvedValueOnce({ success: true, rows: [source, quote('2'), { ...quote('4'), message_content: '9007199254740993 is just text' }], hasMore: true } as any)
      .mockResolvedValueOnce({ success: true, rows: [quote('3')], hasMore: false } as any)
    const first = await target.getMessageReferences(identity, { limit: 1 })
    expect(first).toMatchObject({ success: true, total: 2, hasMore: true, scanned: 4 })
    expect(first.messages[0]).toMatchObject({ _db_path: 'message_1.db', _table_name: 'Msg_room', localIdRaw: '2' })
    const second = await target.getMessageReferences(identity, { offset: 1, limit: 1 })
    expect(second.messages[0].localIdRaw).toBe('3')
    expect(wcdbService.fetchMessageBatch).toHaveBeenCalledTimes(2)
    expect(wcdbService.closeMessageCursor).toHaveBeenCalledOnce()
    expect(taskStatusService.get(TASK_KEY.quoteReferences).status).toBe('done')
  })
  it('does not attribute ambiguous server-ID collisions without a distinguishing timestamp', async () => {
    const { target } = fixture()
    vi.mocked(wcdbService.fetchMessageBatch).mockResolvedValue({ success: true, rows: [source, { ...source, local_id: '9', create_time: 1700000001 }, quote('2'), quote('3', '1700000000')], hasMore: false } as any)
    const result = await target.getMessageReferences(identity)
    expect(result).toMatchObject({ success: true, total: 1, ambiguousCount: 1 })
    expect(result.messages[0].localIdRaw).toBe('3')
  })
  it('reports cursor failures and closes the cursor without caching partial success', async () => {
    const { target } = fixture()
    vi.mocked(wcdbService.fetchMessageBatch).mockResolvedValue({ success: false, error: 'synthetic failure' } as any)
    expect(await target.getMessageReferences(identity)).toMatchObject({ success: false, error: expect.stringContaining('synthetic failure') })
    expect(target.referenceCache.size).toBe(0)
    expect(wcdbService.closeMessageCursor).toHaveBeenCalledOnce()
  })
  it('drops results and closes a cursor opened during an account switch', async () => {
    const { target, state } = fixture()
    vi.mocked(wcdbService.openMessageCursor).mockImplementationOnce(async () => { state.account = 'B'; return { success: true, cursor: 7 } as any })
    expect(await target.getMessageReferences(identity)).toMatchObject({ success: false, error: expect.stringContaining('账号已切换') })
    expect(wcdbService.fetchMessageBatch).not.toHaveBeenCalled()
    expect(wcdbService.closeMessageCursor).toHaveBeenCalledOnce()
  })
})
