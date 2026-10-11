import { describe, expect, it, vi } from 'vitest'
import { privateErrorReport } from './telemetryPrivacy'
import { TelemetryService, validTelemetryEndpoint, type TelemetryPreferences } from './telemetryService'
import worker, { validPayload, type Env } from '../../infra/telemetry-worker/src/index'

function fixture(options: { enabled?: boolean; noticed?: boolean; disabled?: boolean; send?: typeof fetch } = {}) {
  let prefs: TelemetryPreferences = { installationId: '', diagnosticsEnabled: options.enabled ?? false, noticeVersion: options.noticed ? '1.2.1' : '' }
  const sent: Array<{ url: string; body: Record<string, any> }> = []
  const send = options.send ?? vi.fn(async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  const service = new TelemetryService({ platform: 'win32', version: '1.2.1', electronVersion: '43.3.0',
    endpoint: 'https://receiver.example/', disabled: options.disabled, read: () => ({ ...prefs }), write: value => { prefs = value }, send })
  return { service, sent, prefs: () => prefs, send }
}
describe('private remote telemetry', () => {
  it('counts with exactly random ID and platform even when diagnostics are off', async () => {
    const f = fixture()
    f.service.record('main', new Error('private error before consent'))
    await f.service.flush()
    await f.service.flush()
    expect(f.sent).toHaveLength(1)
    expect(Object.keys(f.sent[0].body).sort()).toEqual(['installationId', 'platform'])
    expect(f.prefs().installationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(f.service.status().noticeRequired).toBe(true)
  })
  it('never backfills pre-consent errors and reuses installation ID across launches', async () => {
    const f = fixture({ enabled: true })
    f.service.record('main', new Error('secret'))
    f.service.decide(true)
    await f.service.flush()
    expect(f.sent).toHaveLength(1)
    const id = f.prefs().installationId
    f.service.record('main', Object.assign(new TypeError('ENOENT private path'), { code: 'ENOENT' }))
    f.service.record('main', Object.assign(new TypeError('ENOENT another private path'), { code: 'ENOENT' }))
    await f.service.flush()
    expect(f.sent[1].body.errors[0]).toEqual({ source: 'main', kind: 'TypeError', code: 'ENOENT', frames: [], count: 2 })
    expect(f.sent[1].body).not.toHaveProperty('installationId')
    expect(f.prefs().installationId).toBe(id)
  })
  it('strips arbitrary text, usernames, paths, keys, URLs and custom error names', () => {
    const secret = 'wxid_private my.friend@example.com 0123456789abcdef https://private.example/?key=secret'
    const report = privateErrorReport('renderer', [{ name: secret, code: secret, message: secret,
      stack: `Error: ${secret}\n    at ${secret} (C:\\Users\\Private\\main.js:42:5)\n    at /Users/private/${secret}.js:1:2\n    at file:///Users/Private/assets/index-A13hK.js:100:2` }])
    expect(report).toEqual({ source: 'renderer', kind: 'Error', code: 'UNKNOWN', count: 1,
      frames: [{ bundle: 'main', line: 42, column: 5 }, { bundle: 'renderer', line: 100, column: 2 }] })
    expect(JSON.stringify(report)).not.toContain('Private')
    expect(() => privateErrorReport('main', { get name() { throw new Error('getter') } })).not.toThrow()
  })
  it('retains native short codes without retaining raw text', () => {
    expect(privateErrorReport('ipc', '用户 /private/path 错误码：-3').code).toBe('-3')
    expect(privateErrorReport('ipc', { code: -1006 }).code).toBe('-1006')
  })
  it('QA never generates IDs or uploads even if copied consent is on', async () => {
    const f = fixture({ enabled: true, noticed: true, disabled: true })
    f.service.start()
    f.service.record('main', 'ENOENT')
    await f.service.flush()
    expect(f.sent).toEqual([])
    expect(f.prefs().installationId).toBe('')
    expect(f.service.status().noticeRequired).toBe(false)
    f.service.stop()
  })
  it('retries the same diagnostic batch ID after an offline failure', async () => {
    const batches: string[] = []
    let fail = true
    const send = vi.fn(async (url, init) => {
      if (String(url).endsWith('/errors')) { batches.push(JSON.parse(String(init?.body)).batchId); if (fail) throw new Error('offline') }
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const f = fixture({ enabled: true, noticed: true, send })
    f.service.record('main', 'ENOENT')
    await f.service.flush()
    fail = false
    await f.service.flush()
    expect(batches).toHaveLength(2)
    expect(batches[0]).toBe(batches[1])
  })
  it('revocation clears retry queue and aborts an active request', async () => {
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    let signal: AbortSignal | null | undefined
    const send = vi.fn(async (_url, init) => {
      signal = init?.signal
      entered()
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const f = fixture({ enabled: true, noticed: true, send })
    f.service.record('main', 'ENOENT')
    const flushing = f.service.flush()
    await ready
    f.service.decide(false)
    await flushing
    expect(signal?.aborted).toBe(true)
    expect(f.service.status().diagnosticsEnabled).toBe(false)
  })
  it('rejects non-HTTPS destinations, URL secrets, paths and redirects', () => {
    for (const url of ['http://example.com/', 'https://user:secret@example.com/', 'https://example.com/?key=x', 'https://example.com/ingest', 'bad']) expect(validTelemetryEndpoint(url)).toBe(false)
    expect(validTelemetryEndpoint('https://receiver.example/')).toBe(true)
  })
})
describe('Cloudflare receiver privacy boundary', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000'
  const installation = { installationId: id, platform: 'win32' }
  const report = { batchId: id, platform: 'linux', appVersion: '1.2.1', electronVersion: '43.3.0', errors: [privateErrorReport('main', 'ENOENT')] }
  it('accepts client schema and rejects extra personal fields at every level', () => {
    expect(validPayload('/v1/installations', installation)).toBe(true)
    expect(validPayload('/v1/errors', report)).toBe(true)
    for (const field of ['ip', 'userAgent', 'myWxid', 'dbPath', 'decryptKey', 'message']) {
      expect(validPayload('/v1/installations', { ...installation, [field]: 'private' })).toBe(false)
      expect(validPayload('/v1/errors', { ...report, [field]: 'private' })).toBe(false)
      expect(validPayload('/v1/errors', { ...report, errors: [{ ...report.errors[0], [field]: 'private' }] })).toBe(false)
    }
    expect(validPayload('/v1/errors', { ...report, errors: [{ ...report.errors[0], code: 'PRIVATE_CUSTOM_CODE' }] })).toBe(false)
    expect(validPayload('/v1/installations', { ...installation, platform: 'private-machine' })).toBe(false)
  })
  it('bounds nested objects, numbers and versions', () => {
    expect(validPayload('/v1/errors', { ...report, errors: new Array(101).fill(report.errors[0]) })).toBe(false)
    expect(validPayload('/v1/errors', { ...report, appVersion: 'my.private.version' })).toBe(false)
    expect(validPayload('/v1/errors', { ...report, errors: [{ ...report.errors[0], count: -1 }] })).toBe(false)
    expect(validPayload('/v1/errors', { ...report, errors: [{ ...report.errors[0], frames: [{ bundle: 'main', line: 1, column: 2, file: '/private/path' }] }] })).toBe(false)
  })
  function receiver() {
    const writes: Array<{ sql: string; args: unknown[] }> = []
    const env: Env = { ADMIN_TOKEN: 'x'.repeat(32), DB: { prepare(sql) {
      let args: unknown[] = []
      const statement = { bind(...values: unknown[]) { args = values; return statement }, async run() { writes.push({ sql, args }) }, async all() { return { results: [] } } }
      return statement
    } } }
    return { env, writes }
  }
  it('inserts only two installation columns with retry deduplication', async () => {
    const f = receiver()
    const request = new Request('https://receiver.example/v1/installations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', 'User-Agent': 'private-device' }, body: JSON.stringify(installation) })
    expect((await worker.fetch(request, f.env)).status).toBe(204)
    expect(f.writes[0]).toEqual({ sql: 'INSERT OR IGNORE INTO installations (installation_id, platform) VALUES (?, ?)', args: [id, 'win32'] })
    expect(JSON.stringify(f.writes)).not.toContain('1.2.3.4')
  })
  it('rejects invalid or oversized bodies without database writes', async () => {
    const f = receiver()
    for (const body of [JSON.stringify({ ...installation, path: '/private' }), 'x'.repeat(65537), '{bad']) {
      const response = await worker.fetch(new Request('https://receiver.example/v1/installations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), f.env)
      expect(response.status).toBe(400)
    }
    expect(f.writes).toEqual([])
  })
  it('protects aggregate/report reads and never accepts headers as payload data', async () => {
    const f = receiver()
    expect((await worker.fetch(new Request('https://receiver.example/v1/stats'), f.env)).status).toBe(401)
    expect((await worker.fetch(new Request('https://receiver.example/v1/stats', { headers: { Authorization: `Bearer ${f.env.ADMIN_TOKEN}` } }), f.env)).status).toBe(200)
    await worker.scheduled({}, f.env)
    expect(f.writes[0].sql).toContain("'-30 days'")
  })
})
