import { createHash } from 'node:crypto'
interface RecoverySource {
  listTables(kind: string, dbPath: string): Promise<{ success: boolean; tables?: string[] }>
  execQuery(kind: string, dbPath: string, sql: string): Promise<{ success: boolean; rows?: any[] }>
}
export interface RecoveredHistorySession { username: string; count: number; latest: number }

export async function discoverHistorySessions(source: RecoverySource, dbPaths: string[], existing: Set<string>): Promise<RecoveredHistorySession[]> {
  const owners = new Map<string, Set<string>>()
  const inventories: Array<{ dbPath: string; tables: string[] }> = []
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
  for (const dbPath of dbPaths) {
    const listed = await source.listTables('message', dbPath)
    if (!listed.success) throw new Error('Cannot inventory message tables for history recovery')
    const tables = listed.tables || []
    inventories.push({ dbPath, tables })
    for (const table of tables.filter(name => /^Name2Id(?:_|$)/i.test(name))) {
      const names = await source.execQuery('message', dbPath, `SELECT * FROM ${quote(table)}`)
      if (!names.success) throw new Error('Cannot read history ownership metadata')
      for (const row of names.rows || []) {
        const username = String(row.user_name ?? row.username ?? row.userName ?? row.name ?? '').trim()
        if (!username) continue
        const hash = createHash('md5').update(username).digest('hex')
        const candidates = owners.get(hash) || new Set<string>()
        candidates.add(username)
        owners.set(hash, candidates)
      }
    }
  }
  const recovered = new Map<string, RecoveredHistorySession>()
  for (const { dbPath, tables } of inventories) for (const table of tables) {
    const match = /^(?:Msg_|BizMsg_)([a-f0-9]{32})$/i.exec(table)
    if (!match) continue
    const candidates = owners.get(match[1].toLowerCase())
    if (!candidates || candidates.size !== 1) continue
    const username = [...candidates][0]
    if (existing.has(username)) continue
    const stats = await source.execQuery('message', dbPath, `SELECT COUNT(*) AS count, MAX(create_time) AS latest FROM ${quote(table)}`)
    if (!stats.success) throw new Error('Cannot count recovered history rows')
    const count = Number(stats.rows?.[0]?.count || 0), latest = Number(stats.rows?.[0]?.latest || 0)
    if (!(count > 0)) continue
    const item = recovered.get(username) || { username, count: 0, latest: 0 }
    item.count += count
    item.latest = Math.max(item.latest, latest > 1e12 ? Math.floor(latest / 1000) : latest)
    recovered.set(username, item)
  }
  return [...recovered.values()]
}
