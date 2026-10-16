/**
 * Pure helpers for the annotation store shape used by search and the reader.
 * `tags` is sessionId -> tag names. `tagIndex` is its derived inverse.
 */
export interface SearchAnnotationTags {
  tags?: Record<string, string[]>
  tagIndex?: Record<string, string[]>
}

export function sessionsForTags(store: SearchAnnotationTags | null | undefined, selectedTags: string[]): string[] {
  if (!store || selectedTags.length === 0) return []
  const ids = new Set<string>()
  for (const tag of selectedTags) {
    const indexed = store.tagIndex?.[tag]
    if (Array.isArray(indexed)) {
      for (const sessionId of indexed) if (sessionId) ids.add(sessionId)
      continue
    }
    for (const [sessionId, tags] of Object.entries(store.tags ?? {})) {
      if (Array.isArray(tags) && tags.includes(tag)) ids.add(sessionId)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function tagsBySession(store: SearchAnnotationTags | null | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (!store) return result
  for (const [sessionId, tags] of Object.entries(store.tags ?? {})) {
    if (Array.isArray(tags) && tags.length) result.set(sessionId, [...tags])
  }
  // Old/test stores may expose only the inverse view.
  if (result.size === 0 && store.tagIndex) {
    for (const [tag, sessionIds] of Object.entries(store.tagIndex)) {
      for (const sessionId of sessionIds ?? []) {
        const current = result.get(sessionId)
        if (current) current.push(tag)
        else result.set(sessionId, [tag])
      }
    }
    for (const [sessionId, tags] of result) result.set(sessionId, [...new Set(tags)].sort())
  }
  return result
}

export function tagRows(store: SearchAnnotationTags | null | undefined): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const tags of Object.values(store?.tags ?? {})) {
    if (!Array.isArray(tags)) continue
    for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
}

/**
 * Tags combine as a union (matching the query grammar); explicit session filters
 * intersect with that union. A selected tag that maps to zero sessions must be
 * represented as an empty scope by the caller, never as an omitted filter.
 */
export function sessionsForSearchScope(explicit: string[], tagged: string[]): string[] {
  const tagSet = new Set(tagged)
  if (explicit.length === 0) return [...tagSet].sort((a, b) => a.localeCompare(b))
  return [...new Set(explicit)].filter((id) => tagSet.has(id)).sort((a, b) => a.localeCompare(b))
}
