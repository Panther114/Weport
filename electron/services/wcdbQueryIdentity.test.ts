import { expect, it, vi } from 'vitest'
import { WcdbCore } from './wcdbCore'

function queryCore(json: string): WcdbCore {
  const core = Object.create(WcdbCore.prototype) as any
  core.handle = 1
  core.ensureReady = vi.fn(() => true)
  core.writeLog = vi.fn()
  core.decodeJsonPtr = vi.fn(() => json)
  core.wcdbExecQuery = vi.fn((_handle, _kind, _path, _sql, output) => { output[0] = 1; return 0 })
  return core
}

it('retains exact int64 message identities across the native SQL JSON boundary', async () => {
  const core = queryCore('[{"local_id":9007199254740993,"server_id":18446744073709551610,"create_time":1700000000,"content":"fixture"}]')
  const result = await core.execQuery('message', 'fixture.db', 'SELECT * FROM Msg_fixture')
  expect(result).toMatchObject({ success: true, rows: [{ local_id: '9007199254740993', server_id: '18446744073709551610', create_time: 1700000000, content: 'fixture' }] })
})

it('retains fallback identity columns without converting ordinary numeric fields', async () => {
  const core = queryCore('[{"id":9007199254740993,"msg_svr_id":-9223372036854775808,"count":42,"local_id":3}]')
  const result = await core.execQuery('message', 'fixture.db', 'SELECT * FROM Msg_fixture')
  expect(result).toMatchObject({ success: true, rows: [{ id: '9007199254740993', msg_svr_id: '-9223372036854775808', count: 42, local_id: 3 }] })
})

it('retains exact message identities in type-filtered reads too', async () => {
  const core = queryCore('[{"local_id":9007199254740993,"server_id":18446744073709551610}]') as any
  core.wcdbGetMessagesByType = vi.fn((...args) => { args.at(-1)[0] = 1; return 0 })
  const result = await core.getMessagesByType('room', 34, false, 10, 0)
  expect(result).toMatchObject({ success: true, rows: [{ local_id: '9007199254740993', server_id: '18446744073709551610' }] })
})
