import { describe, expect, it, vi } from 'vitest'
import { compareVersions, evaluateUpdatePolicy, loadUpdatePolicy, parseUpdatePolicy } from './updatePolicy'

const policy = { minimumSupportedVersion: '1.2.0', blockedVersions: ['1.2.1'], reason: '微信数据库协议已变化', url: 'https://example.test/download', allowReadOnly: true }

describe('compatibility update policy', () => {
  it('distinguishes supported, below-minimum and blocked versions', () => {
    expect(evaluateUpdatePolicy(policy, '1.3.0').forced).toBe(false)
    expect(evaluateUpdatePolicy(policy, '1.1.0')).toMatchObject({ forced: true, blocked: false, allowReadOnly: true })
    expect(evaluateUpdatePolicy(policy, '1.2.1')).toMatchObject({ forced: true, blocked: true, reason: policy.reason })
  })
  it('compares numeric prereleases correctly', () => {
    expect(compareVersions('1.2.0-beta.10', '1.2.0-beta.2')).toBe(1)
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBe(1)
    expect(compareVersions('v1.2.0+build', '1.2.0')).toBe(0)
  })
  it('rejects malformed or unsafe manifests', () => {
    expect(parseUpdatePolicy({ ...policy, minimumSupportedVersion: 'invalid' })).toBeNull()
    expect(parseUpdatePolicy({ ...policy, url: 'file:///secret' })).toBeNull()
    expect(parseUpdatePolicy({ ...policy, allowReadOnly: 'false' })).toBeNull()
  })
  it('fails open for network errors, invalid JSON and oversized bodies', async () => {
    expect(await loadUpdatePolicy('https://example.test/policy', vi.fn().mockRejectedValue(new Error('offline')))).toBeNull()
    expect(await loadUpdatePolicy('https://example.test/policy', vi.fn().mockResolvedValue(new Response('{')))).toBeNull()
    expect(await loadUpdatePolicy('https://example.test/policy', vi.fn().mockResolvedValue(new Response('x'.repeat(65537))))).toBeNull()
    expect(evaluateUpdatePolicy(null, '1.2.0').forced).toBe(false)
  })
  it('loads a local test manifest and preserves read-only availability', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(policy)))
    expect(await loadUpdatePolicy('http://127.0.0.1:1234/force-update.json', fetcher)).toEqual(policy)
  })
})
