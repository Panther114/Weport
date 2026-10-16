/** Stable message identity shared by Reader and Search annotations. */
export interface AnnotationMessageIdentity {
  sessionId: string
  localId?: string | number
  localIdNumber?: number
  serverId?: string
  messageId?: string
  idKind?: 'local' | 'server'
  ts?: number
  db?: string
  table?: string
}

export interface AnnotationIdentityFields {
  /** Empty for session favorites and server-id messages. */
  localId: string
  messageId?: string
  idKind?: 'local' | 'server'
  /** Stored in seconds by the main process. */
  ts: number
  db?: string
  table?: string
}

export function annotationIdentityFields(input: AnnotationMessageIdentity): AnnotationIdentityFields {
  if (typeof input.localId === 'number' && !Number.isSafeInteger(input.localId) && !input.messageId && !input.serverId) {
    return {
      localId: '',
      ts: timestampSeconds(input.ts),
      ...(input.db?.trim() ? { db: input.db.trim() } : {}),
      ...(input.table?.trim() ? { table: input.table.trim() } : {}),
    }
  }
  const rawLocalId = String(input.localId ?? '').trim()
  const explicitMessageId = String(input.messageId ?? '').trim()
  const serverId = String(input.serverId ?? '').trim()
  const hasLocalId = rawLocalId !== '' && rawLocalId !== '0'
  const idKind = input.idKind || (hasLocalId ? 'local' : serverId ? 'server' : undefined)
  const messageId = explicitMessageId || (idKind === 'server' ? serverId || rawLocalId : idKind === 'local' ? rawLocalId : '')
  return {
    localId: idKind === 'local' ? (explicitMessageId || rawLocalId) : '',
    ...(messageId ? { messageId } : {}),
    ...(idKind && messageId ? { idKind } : {}),
    ts: timestampSeconds(input.ts),
    ...(input.db?.trim() ? { db: input.db.trim() } : {}),
    ...(input.table?.trim() ? { table: input.table.trim() } : {}),
  }
}

function timestampSeconds(value: number | undefined): number {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0
  return Math.trunc(timestamp >= 1e11 ? timestamp / 1000 : timestamp)
}

function dbKey(value: string | undefined): string {
  return String(value ?? '').trim().replace(/\\/g, '/').split('/').pop()?.toLowerCase() || ''
}

/** Stable key for a stored message favorite/mark or an indexed result. */
export function annotationIdentityKey(input: AnnotationMessageIdentity): string {
  const fields = annotationIdentityFields(input)
  if (!fields.messageId) return JSON.stringify(['session', input.sessionId])
  return JSON.stringify([
    'message',
    input.sessionId,
    fields.idKind || 'local',
    fields.messageId,
    fields.ts,
    dbKey(fields.db),
    String(fields.table ?? '').toLowerCase(),
  ])
}

/** A legacy mark can only apply when no shard identity is available to collide with. */
export function annotationMatchesMessage(
  entry: AnnotationMessageIdentity,
  message: AnnotationMessageIdentity,
): boolean {
  if (entry.sessionId !== message.sessionId) return false
  if (entry.messageId) return annotationIdentityKey(entry) === annotationIdentityKey(message)
  if (message.db || message.table || message.idKind === 'server' || !entry.localId) return false
  const entryTs = timestampSeconds(entry.ts)
  const messageTs = timestampSeconds(message.ts)
  return entryTs > 0 && entryTs === messageTs && String(entry.localId) === String(message.localId ?? '')
}
