/** Remote reports contain structured metadata only. Never serialize raw logs,
 * messages, config, paths, function names, URLs, account IDs, or Error objects. */
export type TelemetryPlatform = 'win32' | 'darwin' | 'linux'
export type ErrorSource = 'main' | 'renderer' | 'ipc'
export interface PrivateErrorReport {
  source: ErrorSource
  kind: string
  code: string
  frames: Array<{ bundle: 'main' | 'renderer' | 'preload' | 'host'; line: number; column: number }>
  count: number
}
export const REMOTE_ERROR_KINDS = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError'])
export const REMOTE_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EEXIST', 'ENOSPC', 'EMFILE', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'ERR_ABORTED', 'ERR_NETWORK_CHANGED', 'SQLITE_BUSY', 'SQLITE_CORRUPT', 'SQLITE_NOTADB'])
const kinds = REMOTE_ERROR_KINDS
const codes = REMOTE_ERROR_CODES
export function privateErrorReport(source: ErrorSource, input: unknown): PrivateErrorReport {
  const values = Array.isArray(input) ? input : [input]
  let kind = 'Error'
  let code = 'UNKNOWN'
  const frames: PrivateErrorReport['frames'] = []
  for (const value of values.slice(0, 20)) {
    let message = ''
    let stack = ''
    try {
      if (value && typeof value === 'object') {
        const error = value as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown }
        if (typeof error.name === 'string' && kinds.has(error.name)) kind = error.name
        if (typeof error.code === 'number' && Number.isInteger(error.code) && Math.abs(error.code) <= 999999) code = String(error.code)
        if (typeof error.code === 'string' && codes.has(error.code)) code = error.code
        if (typeof error.message === 'string') message = error.message.slice(0, 16384)
        if (typeof error.stack === 'string') stack = error.stack.slice(0, 16384)
      } else if (typeof value === 'string') message = value.slice(0, 16384)
    } catch { /* Hostile getters cannot escape the privacy boundary. */ }
    if (code === 'UNKNOWN') {
      const native = message.match(/(?:error\s*code|错误码|code)\s*[:=：]\s*(-?\d{1,6})(?!\d)/i)
      if (native) code = String(Number(native[1]))
      else for (const known of codes) if (new RegExp(`\\b${known}\\b`).test(message)) { code = known; break }
    }
    // Only packaged bundle positions survive; even a filename can contain PII.
    for (const line of stack.split('\n').slice(1, 20)) {
      const match = line.match(/(?:[/\\])(?:((?:main|preload|wcdbHost)\.js)|((?:index|popup)-[A-Za-z0-9_-]+\.js)):(\d{1,7}):(\d{1,7})(?:\)?$)/)
      if (!match) continue
      const file = match[1] || match[2]
      const bundle = file === 'main.js' ? 'main' : file === 'preload.js' ? 'preload' : file === 'wcdbHost.js' ? 'host' : 'renderer'
      frames.push({ bundle, line: Number(match[3]), column: Number(match[4]) })
      if (frames.length >= 12) break
    }
  }
  return { source, kind, code, frames: frames.slice(0, 12), count: 1 }
}
