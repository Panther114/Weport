/** Normalize signed SQLite int64 and unsigned WeChat IDs without Number loss. */
export function exactServerId(value: unknown): string | null {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null
  const token = String(value ?? '').trim()
  if (!/^-?\d+$/.test(token)) return null
  try {
    const number = BigInt(token)
    if (!number || number < -(1n << 63n) || number >= (1n << 64n)) return null
    return BigInt.asUintN(64, number).toString()
  } catch { return null }
}

/** Only structured refermsg fields establish a quote relationship. */
export function quoteTarget(xml: string): { serverId: string; timestamp?: number } | null {
  const normalized = xml.includes('<refermsg') ? xml : xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  const block = normalized.match(/<refermsg\b[^>]*>([\s\S]*?)<\/refermsg>/i)?.[1]
  if (!block) return null
  const field = (name: string) => block.match(new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?([^<\\]]+)(?:\\]\\]>)?\\s*</${name}>`, 'i'))?.[1]?.trim()
  const serverId = exactServerId(field('svrid'))
  if (!serverId) return null
  const timestamp = Number(field('createtime'))
  return { serverId, ...(Number.isSafeInteger(timestamp) && timestamp > 0 ? { timestamp } : {}) }
}
