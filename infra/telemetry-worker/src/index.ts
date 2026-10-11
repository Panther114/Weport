import { REMOTE_ERROR_CODES, REMOTE_ERROR_KINDS } from '../../../electron/services/telemetryPrivacy'

interface Statement {
  bind(...values: unknown[]): Statement
  run(): Promise<unknown>
  all(): Promise<{ results: unknown[] }>
}
export interface Env {
  DB: { prepare(sql: string): Statement }
  ADMIN_TOKEN: string
  INGEST_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const platforms = new Set(['win32', 'darwin', 'linux'])
const version = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,24})?$/
const MAX_BYTES = 65536
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key))
}
function validError(value: unknown): boolean {
  if (!object(value) || !keys(value, ['source', 'kind', 'code', 'frames', 'count'])) return false
  if (typeof value.source !== 'string' || typeof value.kind !== 'string' || !['main', 'renderer', 'ipc'].includes(value.source) || !REMOTE_ERROR_KINDS.has(value.kind)) return false
  if (typeof value.code !== 'string' || (!REMOTE_ERROR_CODES.has(value.code) && value.code !== 'UNKNOWN' && !/^-?\d{1,6}$/.test(value.code))) return false
  if (!Number.isInteger(value.count) || Number(value.count) < 1 || Number(value.count) > 1000000) return false
  if (!Array.isArray(value.frames) || value.frames.length > 12) return false
  return value.frames.every(frame => object(frame) && keys(frame, ['bundle', 'line', 'column']) &&
    typeof frame.bundle === 'string' && ['main', 'renderer', 'preload', 'host'].includes(frame.bundle) &&
    Number.isInteger(frame.line) && Number(frame.line) >= 0 && Number(frame.line) <= 9999999 &&
    Number.isInteger(frame.column) && Number(frame.column) >= 0 && Number(frame.column) <= 9999999)
}
export function validPayload(route: string, value: unknown): value is Record<string, unknown> {
  if (!object(value) || typeof value.platform !== 'string' || !platforms.has(value.platform)) return false
  if (route === '/v1/installations') return keys(value, ['installationId', 'platform']) && typeof value.installationId === 'string' && uuid.test(value.installationId)
  return route === '/v1/errors' && keys(value, ['batchId', 'platform', 'appVersion', 'electronVersion', 'errors']) &&
    typeof value.batchId === 'string' && uuid.test(value.batchId) &&
    typeof value.appVersion === 'string' && version.test(value.appVersion) &&
    typeof value.electronVersion === 'string' && version.test(value.electronVersion) &&
    Array.isArray(value.errors) && value.errors.length >= 1 && value.errors.length <= 100 && value.errors.every(validError)
}
function response(status: number, data?: unknown): Response {
  return new Response(data === undefined ? null : JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } })
}
async function authorized(request: Request, token: string): Promise<boolean> {
  if (!token || token.length < 32) return false
  const actual = request.headers.get('Authorization') || ''
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([actual, `Bearer ${token}`].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))))
  const left = new Uint8Array(a), right = new Uint8Array(b)
  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i]
  return difference === 0
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.body || Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) throw new Error('body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('body') }
      chunks.push(next.value)
    }
    const buffer = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  } finally { reader.releaseLock() }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health' && request.method === 'GET') return response(200, { ok: true })
    if (url.pathname === '/v1/stats' && request.method === 'GET') {
      if (!await authorized(request, env.ADMIN_TOKEN)) return response(401)
      try {
        const [installations, reports] = await Promise.all([
          env.DB.prepare('SELECT platform, COUNT(*) AS installations FROM installations GROUP BY platform').all(),
          env.DB.prepare('SELECT platform, app_version AS appVersion, electron_version AS electronVersion, errors_json AS errors, received_day AS day FROM error_batches ORDER BY received_day DESC, rowid DESC LIMIT 100').all(),
        ])
        return response(200, { installations: installations.results, reports: reports.results })
      } catch { return response(503) }
    }
    if (!['/v1/installations', '/v1/errors'].includes(url.pathname)) return response(404)
    if (request.method !== 'POST') return response(405)
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return response(415)
    let body: unknown
    try { body = await readBody(request) } catch { return response(400) }
    if (!validPayload(url.pathname, body)) return response(400)
    // Ephemeral platform-global rate key contains no IP, ID, or account data.
    if (env.INGEST_LIMITER && !(await env.INGEST_LIMITER.limit({ key: body.platform as string })).success) return response(429)
    try {
      if (url.pathname === '/v1/installations') {
        await env.DB.prepare('INSERT OR IGNORE INTO installations (installation_id, platform) VALUES (?, ?)')
          .bind((body.installationId as string).toLowerCase(), body.platform).run()
      } else {
        await env.DB.prepare("INSERT OR IGNORE INTO error_batches (batch_id, platform, app_version, electron_version, errors_json, received_day) VALUES (?, ?, ?, ?, ?, date('now'))")
          .bind((body.batchId as string).toLowerCase(), body.platform, body.appVersion, body.electronVersion, JSON.stringify(body.errors)).run()
      }
      return response(204)
    } catch { return response(503) }
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await env.DB.prepare("DELETE FROM error_batches WHERE received_day < date('now', '-30 days')").run()
  },
}
