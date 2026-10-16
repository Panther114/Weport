import { describe, expect, it } from 'vitest'
import { WcdbCore } from './wcdbCore'

describe('WCDB message JSON int64 tokens', () => {
  it('preserves local_id and server_id tokens before JSON.parse can round them', () => {
    const core = Object.create(WcdbCore.prototype) as any
    const rows = core.parseMessageJson('[{"local_id":9007199254740993,"server_id":18446744073709551610},{"local_id":12,"server_id":13}]')

    expect(rows).toEqual([
      { local_id: '9007199254740993', server_id: '18446744073709551610' },
      { local_id: 12, server_id: 13 },
    ])
  })

  it('preserves signed 64-bit spellings without converting them to rounded numbers', () => {
    const core = Object.create(WcdbCore.prototype) as any
    const rows = core.parseMessageJson('[{"local_id":-9007199254740993,"server_id":-9223372036854775808}]')

    expect(rows).toEqual([{ local_id: '-9007199254740993', server_id: '-9223372036854775808' }])
  })
})
