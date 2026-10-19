export function needsGroupDisplayName(id: string, name: unknown): boolean {
  return id.endsWith('@chatroom') && (!String(name || '').trim() || String(name).trim() === id)
}

/** Untitled WeChat groups use member names; the numeric room ID is not a title. */
export async function resolveDefaultGroupNames(
  ids: string[], names: Record<string, string>,
  getMembers: (id: string) => Promise<{ success: boolean; members?: unknown[] }>,
  getNames: (ids: string[]) => Promise<{ success: boolean; map?: Record<string, string> }>,
): Promise<void> {
  for (const id of ids) {
    if (!needsGroupDisplayName(id, names[id])) continue
    const result = await getMembers(id)
    if (!result.success || !Array.isArray(result.members)) continue
    const members = result.members.slice(0, 8).map((raw) => {
      const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const username = typeof raw === 'string' ? raw : String(row.username || row.user_name || row.userName || row.wxid || '')
      const name = String(row.remark || row.display_name || row.displayName || row.nick_name || row.nickName || row.nickname || row.name || '').trim()
      return { username: username.trim(), name }
    }).filter((member) => member.username && !member.username.endsWith('@chatroom'))
    const contacts = members.length ? await getNames(members.map((member) => member.username)) : null
    const labels = members.map((member) => {
      const contact = contacts?.success ? contacts.map?.[member.username]?.trim() : ''
      return contact && contact !== member.username ? contact : member.name && member.name !== member.username ? member.name : ''
    }).filter(Boolean)
    if (labels.length) names[id] = labels.join('、')
  }
}
