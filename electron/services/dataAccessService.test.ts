import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import { DataAccessService, assertDataScope, validateDataScope } from './dataAccessService'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'weport-data-grant-')); roots.push(root)
  const file = join(root, 'grants.json')
  return { service: new DataAccessService(file), file }
}
const input = () => ({ name: 'Research', accountId: 'A', sessionIds: ['chat'], from: 10, to: 20, expiresAt: Date.now() + 10000 })
describe('durable client grants', () => {
  it('stores only the token hash, returns the token once and survives restart', () => {
    const { service, file } = setup(), issued = service.create(input())
    expect(readFileSync(file, 'utf8')).not.toContain(issued.token)
    expect(service.list()[0]).not.toHaveProperty('tokenHash')
    expect(new DataAccessService(file).authenticate(issued.token)?.id).toBe(issued.grant.id)
    expect(service.authenticate('wrong')).toBeUndefined()
    service.revoke(issued.grant.id)
    expect(service.authenticate(issued.token)).toBeUndefined()
  })
  it('rejects expired grants and malformed date/chat scopes', () => {
    const { service, file } = setup(), issued = service.create(input())
    const stored = JSON.parse(readFileSync(file, 'utf8')); stored.grants[0].expiresAt = Date.now() - 1; writeFileSync(file, JSON.stringify(stored))
    expect(service.authenticate(issued.token)).toBeUndefined()
    for (const value of [{ ...input(), sessionIds: [] }, { ...input(), sessionIds: [null] }, { ...input(), from: NaN }, { ...input(), to: 0 }, null]) {
      expect(() => validateDataScope(value as any)).toThrow()
    }
    expect(() => assertDataScope(input(), 'B', 'chat')).toThrow('another account')
    expect(() => assertDataScope(input(), 'A', 'other')).toThrow('outside')
  })
})
