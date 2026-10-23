import type { DbKeyHealthReport } from './keyHealthService'
import { isNoLoginDbKeyScanEnabled } from './v12StablePolicy'

/** Capability claims derive from every current shard, never from one detected key. */
export function connectionCapabilities(report: DbKeyHealthReport, platform = process.platform) {
  const required = report.entries.filter(row => row.kind === 'session' || row.kind.startsWith('message') || row.kind.startsWith('biz_message'))
  const hasHistory = required.some(row => row.kind === 'session') && required.some(row => row.kind.startsWith('message') || row.kind.startsWith('biz_message'))
  const coverage = (scan: boolean) => {
    const verified = required.filter(row => row.status === 'ok' && (scan ? row.source === 'scan' : row.source !== 'scan' && row.source !== null))
    const ids = new Set(verified.map(row => row.id))
    return { required: required.length, verified: verified.length, complete: hasHistory && verified.length === required.length,
      missing: required.filter(row => !ids.has(row.id)).map(row => ({ id: row.id, status: row.status })) }
  }
  const original = coverage(false), scan = coverage(true)
  const media = report.entries.filter(row => /^media_\d+$/.test(row.kind))
  const enabled = isNoLoginDbKeyScanEnabled(platform)
  return { platform, existingKey: original, scan: { ...scan, productionEnabled: enabled,
    available: platform === 'win32' && enabled && scan.complete,
    reason: platform !== 'win32' ? 'unsupported-platform' : !enabled ? 'acceptance-gate-disabled' : !scan.complete ? 'incomplete-shards' : 'ready' },
    history: original.complete ? 'original-key-eligible' : enabled && scan.complete ? 'read-only-snapshot-eligible' : 'unavailable',
    media: { required: media.length, authenticated: media.filter(row => row.status === 'ok').length, localFiles: 'not-checked' },
    liveNotifications: original.complete ? 'original-key-eligible-not-verified' : 'unavailable',
    sourceWrites: 'not-granted', nativeDeviceAcceptance: 'requires-device-acceptance',
  }
}
