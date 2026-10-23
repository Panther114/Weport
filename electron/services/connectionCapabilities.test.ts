import { describe, expect, it } from 'vitest'
import { connectionCapabilities } from './connectionCapabilities'
import type { DbKeyHealthReport } from './keyHealthService'
const report = (entries: Array<{ id: string; kind: string; status: string; source: string | null }>) => ({ entries }) as DbKeyHealthReport
const row = (kind: string, source: string | null = 'scan', status = 'ok') => ({ id: `${kind}.db`, kind, source, status })
describe('independent per-shard connection acceptance', () => {
  it('never treats one scanned message key as complete history or opens the production gate', () => {
    const result = connectionCapabilities(report([row('session', null, 'missing'), row('message_0'), row('message_1', null, 'missing')]), 'win32')
    expect(result.scan.verified).toBe(1); expect(result.scan.complete).toBe(false)
    expect(result.scan.productionEnabled).toBe(false); expect(result.scan.available).toBe(false)
    expect(result.liveNotifications).toBe('unavailable')
  })
  it('separates full scan authentication, media availability and native device acceptance', () => {
    const result = connectionCapabilities(report([row('session'), row('message_0'), row('media_0')]), 'win32')
    expect(result.scan.complete).toBe(true)
    expect(result.scan.available).toBe(false)
    expect(result.media.localFiles).toBe('not-checked')
    expect(result.nativeDeviceAcceptance).toBe('requires-device-acceptance')
    expect(result.sourceWrites).toBe('not-granted')
  })
  it('requires session plus message databases and treats live delivery as independently unverified', () => {
    expect(connectionCapabilities(report([])).existingKey.complete).toBe(false)
    const result = connectionCapabilities(report([row('session', 'global'), row('message_0', 'global')]), 'linux')
    expect(result.existingKey.complete).toBe(true)
    expect(result.scan.reason).toBe('unsupported-platform')
    expect(result.liveNotifications).toBe('original-key-eligible-not-verified')
  })
})
