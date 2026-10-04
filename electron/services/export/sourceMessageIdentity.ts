import { createHash } from 'node:crypto'
import * as path from 'node:path'

/** Normalize a table primary key without losing decimal precision. */
export function exactLocalIdToken(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return undefined
    return String(value)
  }
  if (typeof value === 'bigint') return value >= 0n ? String(value) : undefined
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return undefined
  return text.replace(/^0+(?=\d)/, '')
}

export function normalizeSourceDbPath(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const normalized = path.resolve(raw).replace(/\\/g, '/')
  const platformPath = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const segments = platformPath.split('/')
  const storageIndex = segments.map((segment) => segment.toLowerCase()).lastIndexOf('db_storage')
  return storageIndex >= 0 ? segments.slice(storageIndex).join('/') : platformPath
}

/**
 * Opaque identity for one source message. `local_id` is unique within its
 * message table, so the database and table scope are part of the key; timestamp
 * and server ID are deliberately excluded so edits/collisions cannot hide a
 * repeated physical row.
 */
export function sourceMessageIdentityHash(input: {
  localId: unknown
  dbPath: unknown
  tableName: unknown
}): string | undefined {
  const localId = exactLocalIdToken(input.localId)
  const dbPath = normalizeSourceDbPath(input.dbPath)
  const tableName = String(input.tableName ?? '').trim().toLowerCase()
  if (!localId || localId === '0' || !dbPath || !tableName) return undefined
  return createHash('sha256').update(`${dbPath}\u0000${tableName}\u0000${localId}`).digest('hex')
}
