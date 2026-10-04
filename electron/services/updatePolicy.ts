/** Optional compatibility policy. Offline or malformed responses never block startup. */
export interface UpdatePolicy {
  minimumSupportedVersion: string
  blockedVersions: string[]
  reason: string
  url: string
  allowReadOnly: boolean
}

export interface UpdateRestriction {
  forced: boolean
  blocked: boolean
  reason: string | null
  url: string | null
  allowReadOnly: boolean
  minimumSupportedVersion: string | null
  currentVersion: string
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a), right = VERSION.exec(b)
  if (!left || !right) throw new Error('Invalid version')
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i])
    if (difference) return Math.sign(difference)
  }
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0
  const x = left[4].split('.'), y = right[4].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i])
    if (nx && ny) return Math.sign(Number(x[i]) - Number(y[i]))
    if (nx !== ny) return nx ? -1 : 1
    return x[i] < y[i] ? -1 : 1
  }
  return 0
}

export function parseUpdatePolicy(value: unknown): UpdatePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  if (typeof p.minimumSupportedVersion !== 'string' || !VERSION.test(p.minimumSupportedVersion)) return null
  if (!Array.isArray(p.blockedVersions) || p.blockedVersions.length > 100 || p.blockedVersions.some(v => typeof v !== 'string' || !VERSION.test(v))) return null
  if (typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 1000) return null
  if (typeof p.url !== 'string' || p.url.length > 2048 || typeof p.allowReadOnly !== 'boolean') return null
  try { if (new URL(p.url).protocol !== 'https:') return null } catch { return null }
  return { minimumSupportedVersion: p.minimumSupportedVersion, blockedVersions: p.blockedVersions as string[], reason: p.reason.trim(), url: p.url, allowReadOnly: p.allowReadOnly }
}

export function evaluateUpdatePolicy(policy: UpdatePolicy | null, currentVersion: string): UpdateRestriction {
  const belowMinimum = policy ? compareVersions(currentVersion, policy.minimumSupportedVersion) < 0 : false
  const blocked = policy?.blockedVersions.some(version => compareVersions(version, currentVersion) === 0) || false
  const forced = belowMinimum || blocked
  return { forced, blocked, reason: forced ? policy!.reason : null, url: forced ? policy!.url : null,
    allowReadOnly: forced ? policy!.allowReadOnly : true, minimumSupportedVersion: policy?.minimumSupportedVersion || null, currentVersion }
}

let activePolicy: UpdatePolicy | null = null
export function currentUpdateRestriction(version: string): UpdateRestriction { return evaluateUpdatePolicy(activePolicy, version) }

export async function loadUpdatePolicy(url: string, fetcher: typeof fetch = fetch): Promise<UpdatePolicy | null> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) return null
    const response = await fetcher(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
    if (!response.ok || Number(response.headers.get('content-length')) > 65536) return null
    const reader = response.body?.getReader()
    if (!reader) return null
    const decoder = new TextDecoder()
    let text = '', bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 65536) { await reader.cancel(); return null }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
    } finally { reader.releaseLock() }
    const policy = parseUpdatePolicy(JSON.parse(text))
    if (policy) activePolicy = policy
    return policy
  } catch { return null }
}

export function compatibilityError(version: string, readOnly: boolean): string | null {
  const restriction = currentUpdateRestriction(version)
  if (!restriction.forced || (readOnly && restriction.allowReadOnly)) return null
  return `需要更新 Weport：${restriction.reason}`
}
