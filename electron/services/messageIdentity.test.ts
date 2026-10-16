import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('./config', () => ({ ConfigService: class {
  getCacheBasePath() { return process.env.TEMP || '.' }
  get() { return '' }
} }))
vi.mock('./wcdbService', () => ({ wcdbService: { execQuery: vi.fn() } }))

import { chatService } from './chatService'
import { wcdbService } from './wcdbService'

const resolveIdentity = Object.getPrototypeOf(chatService).getMessageByIdentity
const sources = [
  { dbPath: 'C:/fixture/message_0.db', tableName: 'Msg_fixture' },
  { dbPath: 'C:/fixture/message_1.db', tableName: 'Msg_fixture' },
]
const fake = (sourceList = sources) => ({
  normalizeTimestampSeconds(value: number) { return Math.floor(value > 1e10 ? value / 1000 : value) },
  getSessionMessageTables: vi.fn().mockResolvedValue(sourceList),
  getMessageTableColumns: vi.fn().mockResolvedValue(new Set(['local_id', 'server_id', 'create_time'])),
  quoteSqlIdentifier: (value: string) => `"${value}"`,
  parseMessage: vi.fn(async (row: unknown) => row),
  enrichGroupMessageSenderProfiles: vi.fn(),
})

describe('search hit identity across message shards', () => {
  it('does not invent exact identity tokens from already-rounded numeric IDs', () => {
    const prototype = Object.getPrototypeOf(chatService)
    expect(prototype.normalizeUnsignedIntegerToken.call(chatService, Number('9007199254740993'))).toBeUndefined()
    expect(prototype.normalizeServerIdToken.call(chatService, Number('18446744073709551610'))).toBeUndefined()
  })

  it('keeps exact native IDs in the parsed IPC response and message key', async () => {
    const target = Object.create(chatService)
    target.resolveSenderUsernameForMessageRow = vi.fn().mockResolvedValue('fixture')
    target.resolveMessageIsSend = vi.fn().mockReturnValue({ isSend: 0 })
    const parse = Object.getPrototypeOf(chatService).parseMessage
    const row = { local_id: '9007199254740993', server_id: '-6', local_type: 1,
      create_time: 1700000000, message_content: 'fixture text',
      _db_path: 'C:/fixture/message_0.db', _table_name: 'Msg_fixture' }
    const first = await parse.call(target, row, { sessionId: 'room' })
    const second = await parse.call(target, { ...row, local_id: '9007199254740992' }, { sessionId: 'room' })
    expect(first.localIdRaw).toBe('9007199254740993')
    expect(first.serverIdRaw).toBe('18446744073709551610')
    expect(first.messageKey).toContain('9007199254740993')
    expect(first.messageKey).not.toBe(second.messageKey)
  })

  it('image lookup uses the exact resolved message and never a local-ID fallback', async () => {
    const identity = { sessionId: 'room', localId: '7', ts: 1700000000, db: 'message_1.db', table: 'Msg_fixture' }
    const message = { imageMd5: 'fixture-image', _db_path: 'message_1.db' }
    const target = { getMessageByIdentity: vi.fn().mockResolvedValue({ success: true, message }), getImageDataForMessage: vi.fn().mockResolvedValue({ success: true, data: 'image' }) }
    const result = await Object.getPrototypeOf(chatService).getImageDataByIdentity.call(target, identity)
    expect(result.success).toBe(true)
    expect(target.getMessageByIdentity).toHaveBeenCalledWith(identity)
    expect(target.getImageDataForMessage).toHaveBeenCalledWith('room', message, undefined)
  })

  it('an ambiguous image identity is not substituted with another message', async () => {
    const target = { getMessageByIdentity: vi.fn().mockResolvedValue({ success: false, error: 'ambiguous' }), getImageDataForMessage: vi.fn() }
    const result = await Object.getPrototypeOf(chatService).getImageDataByIdentity.call(target, { sessionId: 'room', localId: '7', ts: 1700000000 })
    expect(result).toEqual({ success: false, error: 'ambiguous' })
    expect(target.getImageDataForMessage).not.toHaveBeenCalled()
  })
  beforeEach(() => vi.mocked(wcdbService.execQuery).mockReset())

  it('selects the indexed shard with executable ID and timestamp literals', async () => {
    vi.mocked(wcdbService.execQuery).mockResolvedValue({ success: true, rows: [{ local_id: 7 }] })
    const result = await resolveIdentity.call(fake(), { sessionId: 'room', localId: '7', ts: 1700000000000, db: 'message_1.db', table: 'Msg_fixture' })
    expect(result.success).toBe(true)
    expect(result.message._db_path).toBe('C:/fixture/message_1.db')
    expect(wcdbService.execQuery).toHaveBeenCalledExactlyOnceWith(
      'message',
      sources[1].dbPath,
      expect.stringContaining('WHERE "local_id" = \'7\' AND "create_time" = 1700000000'),
    )
  })

  it('rejects ambiguous hits instead of opening the wrong shard', async () => {
    vi.mocked(wcdbService.execQuery).mockResolvedValue({ success: true, rows: [{ local_id: 7 }] })
    expect((await resolveIdentity.call(fake(), { sessionId: 'room', localId: '7', ts: 1700000000 })).success).toBe(false)
  })

  it('does not query a database outside this session', async () => {
    const result = await resolveIdentity.call(fake(), { sessionId: 'room', localId: '7', ts: 1700000000, db: 'C:/foreign/private.db' })
    expect(result.success).toBe(false)
    expect(wcdbService.execQuery).not.toHaveBeenCalled()
  })

  it('keeps large server IDs as strings', async () => {
    vi.mocked(wcdbService.execQuery).mockResolvedValue({ success: true, rows: [{ server_id: '18446744073709551610' }] })
    const result = await resolveIdentity.call(fake(), { sessionId: 'room', localId: '18446744073709551610', idKind: 'server', ts: 1700000000, db: 'message_0.db' })
    expect(result.success).toBe(true)
    expect(wcdbService.execQuery).toHaveBeenCalledExactlyOnceWith(
      'message',
      sources[0].dbPath,
      expect.stringContaining('WHERE ("server_id" = \'18446744073709551610\' OR "server_id" = -6'),
    )
  })

  it('resolves an old scanned-mirror full path by its complete db_storage-relative shard path', async () => {
    const currentDbPath = 'C:/Temp/weport-scanned-db-new/db_storage/message/archive_0.db'
    const oldDbPath = 'C:/Temp/weport-scanned-db-old/db_storage/message/archive_0.db'
    vi.mocked(wcdbService.execQuery).mockResolvedValue({ success: true, rows: [{ local_id: 7 }] })

    const result = await resolveIdentity.call(fake([{ dbPath: currentDbPath, tableName: 'Msg_fixture' }]), {
      sessionId: 'room', localId: '7', ts: 1700000000, db: oldDbPath, table: 'Msg_fixture',
    })

    expect(result.success).toBe(true)
    expect(result.message._db_path).toBe(currentDbPath)
    expect(wcdbService.execQuery).toHaveBeenCalledExactlyOnceWith(
      'message', currentDbPath, expect.stringContaining('WHERE "local_id" = \'7\''),
    )
  })

  it('does not basename-match a full path when nested db_storage paths differ', async () => {
    const currentDbPath = 'C:/Temp/weport-scanned-db-new/db_storage/legacy/archive_0.db'
    const requestedDbPath = 'C:/Temp/weport-scanned-db-old/db_storage/message/archive_0.db'
    const result = await resolveIdentity.call(fake([{ dbPath: currentDbPath, tableName: 'Msg_fixture' }]), {
      sessionId: 'room', localId: '7', ts: 1700000000, db: requestedDbPath, table: 'Msg_fixture',
    })

    expect(result.success).toBe(false)
    expect(wcdbService.execQuery).not.toHaveBeenCalled()
  })

  it('matches signed SQLite INTEGER and unsigned TEXT forms of the same uint64 server ID', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE Msg_fixture (server_id, create_time INTEGER, local_id INTEGER)')
      db.prepare('INSERT INTO Msg_fixture (server_id, create_time, local_id) VALUES (?, ?, ?)').run(-6, 1700000000, 1)
      db.prepare('INSERT INTO Msg_fixture (server_id, create_time, local_id) VALUES (?, ?, ?)').run('18446744073709551610', 1700000001, 2)
      const executedSql: string[] = []
      vi.mocked(wcdbService.execQuery).mockImplementation(async (_kind, _dbPath, sql) => {
        executedSql.push(sql)
        const timestamp = Number(/"create_time" = (\d+)/.exec(sql)?.[1])
        return {
          success: true,
          rows: timestamp === 1700000000
            ? [{ server_id: -6, create_time: timestamp, local_id: 1 }]
            : [{ server_id: '18446744073709551610', create_time: timestamp, local_id: 2 }],
        }
      })

      const signed = await resolveIdentity.call(fake(), {
        sessionId: 'room', localId: '18446744073709551610', idKind: 'server', ts: 1700000000, db: 'message_0.db', table: 'Msg_fixture',
      })
      const unsignedText = await resolveIdentity.call(fake(), {
        sessionId: 'room', localId: '18446744073709551610', idKind: 'server', ts: 1700000001, db: 'message_0.db', table: 'Msg_fixture',
      })
      expect(signed).toMatchObject({ success: true, message: { local_id: 1 } })
      expect(unsignedText).toMatchObject({ success: true, message: { local_id: 2 } })
      expect(db.prepare(executedSql[0]).all()).toMatchObject([{ local_id: 1 }])
      expect(db.prepare(executedSql[1]).all()).toMatchObject([{ local_id: 2 }])
    } finally {
      db.close()
    }
  })

  it('rejects invalid identities before running SQL', async () => {
    expect((await resolveIdentity.call(fake(), { sessionId: 'room', localId: '7 OR 1=1', ts: 1700000000 })).success).toBe(false)
    expect((await resolveIdentity.call(fake(), { sessionId: 'room', localId: '0', ts: 1700000000 })).success).toBe(false)
    expect(wcdbService.execQuery).not.toHaveBeenCalled()
  })
})
