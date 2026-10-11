import { randomUUID } from 'crypto'
import { privateErrorReport, type ErrorSource, type PrivateErrorReport, type TelemetryPlatform } from './telemetryPrivacy'

export const TELEMETRY_NOTICE_VERSION = '1.2.1'
declare const __WEPORT_TELEMETRY_URL__: string
export interface TelemetryPreferences {
  installationId: string
  diagnosticsEnabled: boolean
  noticeVersion: string
}
export interface TelemetryStatus { diagnosticsEnabled: boolean; noticeRequired: boolean; receiverConfigured: boolean }
interface Options {
  platform: string
  version: string
  electronVersion: string
  endpoint: string
  disabled?: boolean
  read: () => TelemetryPreferences
  write: (preferences: TelemetryPreferences) => void
  send?: typeof fetch
}
export function telemetryEndpoint(): string {
  return typeof __WEPORT_TELEMETRY_URL__ === 'string' ? __WEPORT_TELEMETRY_URL__ : ''
}
/** Credentials and query strings cannot be baked into the collection URL. */
export function validTelemetryEndpoint(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' }
  catch { return false }
}
export class TelemetryService {
  private timer?: ReturnType<typeof setInterval>
  private queue: PrivateErrorReport[] = []
  private pending?: { id: string; errors: PrivateErrorReport[] }
  private controller?: AbortController
  private flushing = false
  private stopped = false
  private usageSent = false
  private revision = 0
  constructor(private readonly options: Options) {}
  status(): TelemetryStatus {
    const prefs = this.options.read()
    return { diagnosticsEnabled: prefs.diagnosticsEnabled === true, noticeRequired: !this.options.disabled && prefs.noticeVersion !== TELEMETRY_NOTICE_VERSION,
      receiverConfigured: validTelemetryEndpoint(this.options.endpoint) && !this.options.disabled }
  }
  decide(enabled: boolean): TelemetryStatus {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean consent choice')
    const prefs = this.options.read()
    this.options.write({ ...prefs, diagnosticsEnabled: enabled, noticeVersion: TELEMETRY_NOTICE_VERSION })
    this.revision += 1
    this.controller?.abort()
    this.queue = []
    this.pending = undefined
    return this.status()
  }
  start(): void {
    if (this.timer || this.stopped || this.options.disabled) return
    // No immediately awaited network operation on the startup path.
    this.timer = setInterval(() => void this.flush(), 60_000)
    this.timer.unref?.()
    void this.flush()
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.queue = []
    this.pending = undefined
  }
  record(source: ErrorSource, input: unknown): void {
    if (this.options.disabled || this.stopped || !this.status().diagnosticsEnabled || this.status().noticeRequired) return
    const report = privateErrorReport(source, input)
    const signature = JSON.stringify({ ...report, count: 1 })
    const existing = this.queue.find(item => JSON.stringify({ ...item, count: 1 }) === signature)
    if (existing) existing.count = Math.min(1_000_000, existing.count + 1)
    else if (this.queue.length < 500) this.queue.push(report)
  }
  async flush(): Promise<void> {
    if (this.flushing || this.stopped || this.options.disabled || !this.status().receiverConfigured) return
    if (!['win32', 'darwin', 'linux'].includes(this.options.platform)) return
    this.flushing = true
    const revision = this.revision
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 10_000)
    timeout.unref?.()
    const post = async (route: string, payload: unknown) => {
      const response = await (this.options.send ?? fetch)(new URL(route, this.options.endpoint), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error('Telemetry unavailable')
    }
    try {
      if (!this.usageSent) {
        const prefs = this.options.read()
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(prefs.installationId)) {
          prefs.installationId = randomUUID()
          this.options.write(prefs)
        }
        // Mandatory count: exactly these two fields, no version/time/config.
        await post('/v1/installations', { installationId: prefs.installationId, platform: this.options.platform as TelemetryPlatform })
        this.usageSent = true
      }
      if (revision !== this.revision || this.stopped || !this.status().diagnosticsEnabled || this.status().noticeRequired) return
      if (!this.pending && this.queue.length) this.pending = { id: randomUUID(), errors: this.queue.splice(0, 50) }
      const batch = this.pending
      if (batch) {
        await post('/v1/errors', { batchId: batch.id, platform: this.options.platform, appVersion: this.options.version,
          electronVersion: this.options.electronVersion, errors: batch.errors })
        if (this.pending === batch) this.pending = undefined
      }
    } catch { /* Offline retry; never log upload failures back into this queue. */ }
    finally { clearTimeout(timeout); if (this.controller === controller) this.controller = undefined; this.flushing = false }
  }
}
