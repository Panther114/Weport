import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { discoverHistorySessions } from './historySessionRecovery'
const table = (id: string) => `Msg_${createHash('md5').update(id).digest('hex')}`
function fixture() {
  const names = [{ user_name: 'old@chatroom' }, { user_name: 'visible' }, { user_name: 'empty' }]
  return {
    listTables: vi.fn(async () => ({ success: true, tables: ['Name2Id', table('old@chatroom'), table('visible'), table('empty'), table('unresolved')] })),
    execQuery: vi.fn(async (_kind: string, _path: string, sql: string) => {
      if (sql.includes('FROM "Name2Id"')) return { success: true, rows: names }
      expect(sql.startsWith('SELECT COUNT(*)')).toBe(true)
      return { success: true, rows: [{ count: sql.includes(table('empty')) ? 0 : 3, latest: 1700000000000 }] }
    }),
  }
}
describe('table-backed history session recovery', () => {
  it('recovers a departed group across shards without duplicating visible or empty sessions', async () => {
    const source = fixture()
    const result = await discoverHistorySessions(source, ['shard-a', 'shard-b'], new Set(['visible']))
    expect(result).toEqual([{ username: 'old@chatroom', count: 6, latest: 1700000000 }])
    expect(source.execQuery.mock.calls.filter(call => call[2].includes(table('visible')))).toHaveLength(0)
  })
  it('does not invent owners for unresolvable tables', async () => {
    const source = fixture()
    expect((await discoverHistorySessions(source, ['shard'], new Set())).some(row => row.username === 'unresolved')).toBe(false)
  })
  it('surfaces an unreadable shard rather than declaring its inventory complete', async () => {
    const source = fixture()
    source.listTables.mockResolvedValue({ success: false, tables: [] })
    await expect(discoverHistorySessions(source, ['broken'], new Set())).rejects.toThrow('inventory')
  })
  it('rebuilds ownership from the requested account rather than a previous discovery', async () => {
    const source = fixture()
    await discoverHistorySessions(source, ['first'], new Set())
    source.execQuery.mockResolvedValue({ success: true, rows: [] })
    expect(await discoverHistorySessions(source, ['second'], new Set())).toEqual([])
  })
})
