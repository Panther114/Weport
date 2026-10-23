import { app } from 'electron'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import type { SearchQueryResult } from './searchIndexService'

export interface DataAccessScope {
  accountId: string
  sessionIds: string[]
  /** Inclusive Unix milliseconds. */
  from: number
  to: number
}
export interface DataAccessGrant extends DataAccessScope {
  id: string
  name: string
  createdAt: number
  expiresAt: number
  tokenHash: string
}

export function validateDataScope(scope: DataAccessScope): void {
  if (!scope || typeof scope.accountId !== 'string' || !scope.accountId.trim() || !Array.isArray(scope.sessionIds) || !scope.sessionIds.length || scope.sessionIds.length > 1000 || scope.sessionIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Select an account and at least one chat.')
  if (!Number.isFinite(scope.from) || !Number.isFinite(scope.to) || scope.from < 0 || scope.to < scope.from) throw new Error('A valid bounded date range is required.')
}

export function assertDataScope(scope: DataAccessScope, accountId: string, sessionId?: string): void {
  validateDataScope(scope)
  if (scope.accountId !== accountId) throw new Error('This client is restricted to another account.')
  if (sessionId !== undefined && !scope.sessionIds.includes(sessionId)) throw new Error('This chat is outside the authorized scope.')
}

/** Defense at the outbound boundary, independent of index date-unit compatibility. */
export function restrictSearchResult(result: SearchQueryResult, scope: DataAccessScope): SearchQueryResult {
  const hits = result.hits.filter(hit => scope.sessionIds.includes(hit.sessionId) && hit.ts >= scope.from && hit.ts <= scope.to)
  if (hits.length === result.hits.length) return result
  return { ...result, hits, total: hits.length, truncated: true,
    coverage: result.coverage ? { ...result.coverage, complete: false } : undefined }
}

export class DataAccessService {
  constructor(private file = '') {}
  private path(): string { return this.file || join(app.getPath('userData'), 'data-access-grants.json') }
  private read(): DataAccessGrant[] {
    const file = this.path()
    if (!existsSync(file)) return []
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.grants)) throw new Error('Unsupported data-access grant store.')
    return data.grants
  }
  private save(grants: DataAccessGrant[]): void {
    const file = this.path()
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, grants }), { mode: 0o600 })
    renameSync(temporary, file)
  }
  list(): Omit<DataAccessGrant, 'tokenHash'>[] { return this.read().map(({ tokenHash: _, ...grant }) => grant) }
  create(input: DataAccessScope & { name: string; expiresAt: number }): { grant: Omit<DataAccessGrant, 'tokenHash'>; token: string } {
    validateDataScope(input)
    if (!input.name.trim() || !Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) throw new Error('A name and future expiry are required.')
    const token = randomBytes(32).toString('hex')
    const row: DataAccessGrant = { ...input, sessionIds: [...new Set(input.sessionIds)], id: randomUUID(), createdAt: Date.now(), tokenHash: createHash('sha256').update(token).digest('hex') }
    this.save([...this.read(), row])
    const { tokenHash: _, ...grant } = row
    return { grant, token }
  }
  revoke(id: string): void { this.save(this.read().filter(grant => grant.id !== id)) }
  authenticate(token: string): DataAccessGrant | undefined {
    if (!token) return undefined
    const hash = createHash('sha256').update(token).digest()
    return this.read().find(grant => grant.expiresAt > Date.now() && /^[a-f0-9]{64}$/.test(grant.tokenHash) && timingSafeEqual(hash, Buffer.from(grant.tokenHash, 'hex')))
  }
  active(id: string): boolean { return this.read().some(grant => grant.id === id && grant.expiresAt > Date.now()) }
}

export const dataAccessService = new DataAccessService()
