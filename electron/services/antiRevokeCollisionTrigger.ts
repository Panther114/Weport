type SqlResult = { success: boolean; error?: string }

/** Retain every physical row when WeChat deletes several rows with one server ID. */
export function upgradeAntiRevokeCollisionSql(sql: string): { sql: string; changed: boolean } {
  const selector = /WHERE id\s*=\s*\(\s*SELECT id FROM _weflow_anti_revoke_deleted_cache\s*WHERE ([\s\S]*?)ORDER BY id DESC LIMIT 1\s*\)/gi
  let replacements = 0
  const upgraded = sql.replace(selector, (_match, condition: string) => {
    replacements++
    return `WHERE id IN (SELECT id FROM _weflow_anti_revoke_deleted_cache WHERE ${condition})`
  })
  if (replacements === 2) return { sql: upgraded, changed: true }
  if (replacements === 0 && (sql.match(/WHERE id IN \(SELECT id FROM _weflow_anti_revoke_deleted_cache WHERE /gi) || []).length === 2) {
    return { sql, changed: false }
  }
  throw new Error('无法识别防撤回触发器版本，保留原触发器')
}

export async function migrateAntiRevokeCollisionTrigger(
  name: string, sql: string, execute: (sql: string) => Promise<SqlResult>
): Promise<boolean> {
  if (!name.startsWith('anti_revoke_block_insert_')) throw new Error('非防撤回触发器')
  const upgraded = upgradeAntiRevokeCollisionSql(sql)
  if (!upgraded.changed) return false
  const checked = async (statement: string) => {
    const result = await execute(statement)
    if (!result.success) throw new Error(result.error || '防撤回触发器升级失败')
  }
  await checked('BEGIN IMMEDIATE')
  try {
    await checked(`DROP TRIGGER "${name.replace(/"/g, '""')}"`)
    await checked(upgraded.sql)
    await checked('COMMIT')
  } catch (error) {
    const rollback = await execute('ROLLBACK')
    if (!rollback.success) throw new Error(`防撤回触发器升级失败且回滚失败：${rollback.error || String(error)}`)
    throw error
  }
  return true
}
