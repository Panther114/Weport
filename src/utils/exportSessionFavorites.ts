export type ExportSessionFavoritesByWxid = Record<string, string[]>

/** Share Reader session favorites; message favorites never become contact favorites. */
export function exportSessionFavoritesFromAnnotations(store: unknown, wxid: string): ExportSessionFavoritesByWxid {
  const value = store as { favorites?: Array<{ sessionId?: string; localId?: string | number; messageId?: string }> } | null
  const sessionIds = (value?.favorites || []).filter(entry => entry?.sessionId && !entry.localId && !entry.messageId)
    .map(entry => String(entry.sessionId).trim()).filter(Boolean)
  return wxid ? { [wxid]: [...new Set(sessionIds)] } : {}
}

export function getExportSessionFavoriteIds(
  favoritesByWxid: ExportSessionFavoritesByWxid,
  wxid: string
): Set<string> {
  const accountId = String(wxid || '').trim()
  return new Set(accountId ? favoritesByWxid[accountId] || [] : [])
}
