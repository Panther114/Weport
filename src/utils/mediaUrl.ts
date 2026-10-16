/** Read-only Electron local file URLs; legacy preview cache URLs are normalized. */
export function localFileUrl(absolutePath: string): string {
  const normalized = String(absolutePath || '').trim()
  if (!normalized) return ''
  return `weport-media://local/${encodeURIComponent(normalized)}`
}

/** 判据给"本地文件不走加载队列"用（头像）：两种外壳的 URL 形态都算本地。 */
export function isLocalMediaUrl(url: unknown): boolean {
  const text = String(url || '')
  return text.startsWith('weport-media://') || text.startsWith('http://asset.localhost/') || text.startsWith('https://asset.localhost/')
}

/** 本地 URL → 磁盘路径（认不出返回 null）。两种形态都解析。 */
export function localMediaUrlToPath(url: unknown): string | null {
  const text = String(url || '')
  if (!isLocalMediaUrl(text)) return null
  try {
    const parsed = new URL(text)
    const raw = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    return raw || null
  } catch {
    return null
  }
}

/** Normalize persisted local preview URLs to the Electron media protocol. */
export function normalizeLocalMediaUrl(url: unknown): string {
  const text = String(url || '')
  if (!isLocalMediaUrl(text)) return text
  const path = localMediaUrlToPath(text)
  return path ? localFileUrl(path) : text
}
