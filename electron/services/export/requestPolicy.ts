import type { ExportOptions } from './types'

/** Explicit layout choices always win, including when media is enabled. */
export function resolveRequestedSessionLayout(options: Pick<ExportOptions, 'sessionLayout' | 'exportMedia'>): 'shared' | 'per-session' {
  return options.sessionLayout ?? (options.exportMedia === true ? 'per-session' : 'shared')
}

type StatusReply = {
  success: boolean
  map?: Record<string, { isMuted?: boolean }>
  error?: string
}

/** Apply to the actual run, so hidden selections and "all" cannot bypass it. */
export async function selectUnmutedConversations(
  sessionIds: string[],
  getStatuses: (ids: string[]) => Promise<StatusReply>,
): Promise<string[]> {
  const candidates = sessionIds.filter(id => !id.startsWith('gh_'))
  const selected: string[] = []
  for (let offset = 0; offset < candidates.length; offset += 200) {
    const batch = candidates.slice(offset, offset + 200)
    const result = await getStatuses(batch)
    if (!result.success || !result.map) throw new Error(result.error || '无法读取微信免打扰状态，请重试')
    for (const id of batch) {
      // Unknown must never mean "unmuted" for an explicit export restriction.
      if (typeof result.map[id]?.isMuted !== 'boolean') throw new Error('部分会话免打扰状态未知，请重试')
      if (result.map[id].isMuted === false) selected.push(id)
    }
  }
  return selected
}
