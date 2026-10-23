import { createHash } from 'crypto'
import type { Message } from '../chatService'

export interface EvidenceReference {
  version: 1
  accountId: string
  sessionId: string
  localId: string
  idKind: 'local'
  db: string
  table: string
  ts: number
  contentHash: string
  capturedAt: number
}

export function evidenceContentHash(message: Pick<Message, 'rawContent' | 'parsedContent' | 'createTime' | 'senderUsername' | 'localType'>): string {
  return createHash('sha256').update(JSON.stringify([
    message.rawContent || '', message.parsedContent || '', message.createTime,
    message.senderUsername, message.localType,
  ])).digest('hex')
}

export function evidenceReference(accountId: string, sessionId: string, message: Message): EvidenceReference | null {
  const localId = message.localIdRaw || (Number.isSafeInteger(message.localId) ? String(message.localId) : '')
  if (!accountId || !sessionId || !/^[1-9]\d*$/.test(localId) || !message._db_path || !message._table_name) return null
  return { version: 1, accountId, sessionId, localId, idKind: 'local', db: message._db_path,
    table: message._table_name, ts: message.createTime * 1000,
    contentHash: evidenceContentHash(message), capturedAt: Date.now() }
}

export function evidenceId(reference: EvidenceReference): string {
  const { capturedAt: _, ...identityAndContent } = reference
  return createHash('sha256').update(JSON.stringify(identityAndContent)).digest('hex')
}

export interface MemoryClaim {
  id: string
  statement: string
  kind: 'observation' | 'interpretation'
  status: 'active' | 'superseded' | 'uncertain'
  asOf: number
  createdAt: number
  evidenceIds: string[]
  counterEvidenceIds: string[]
  supersedes?: string
  correction?: string
}

export function validateClaim(input: MemoryClaim, knownEvidence: Set<string>): void {
  if (!input.statement.trim() || !Number.isFinite(input.asOf) || input.asOf <= 0) throw new Error('A dated statement is required.')
  if (!['observation', 'interpretation'].includes(input.kind)) throw new Error('Invalid claim kind.')
  if (!['active', 'superseded', 'uncertain'].includes(input.status)) throw new Error('Invalid claim status.')
  if (input.kind === 'observation' && input.evidenceIds.length === 0) throw new Error('An observation requires source evidence.')
  for (const id of [...input.evidenceIds, ...input.counterEvidenceIds]) {
    if (!knownEvidence.has(id)) throw new Error(`Unavailable evidence reference: ${id}`)
  }
}
