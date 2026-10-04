/** Read-only Electron local media URLs, including old preview cache entries. */
const LOCAL_URL_PREFIXES = ['weport-media://', 'http://asset.localhost/', 'https://asset.localhost/']

/** 磁盘绝对路径 → 渲染层可用的 URL。 */
export const toLocalMediaUrl = (filePath: string): string => {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  return `weport-media://local/${encodeURIComponent(normalized)}`
}

/** 这个 URL 是不是"本地文件"（两种外壳形态都算）。 */
export const isLocalMediaUrl = (url: unknown): boolean => {
  const text = String(url || '')
  return LOCAL_URL_PREFIXES.some((prefix) => text.startsWith(prefix))
}

/** 本地 URL → 磁盘路径（认不出返回 null）。 */
export const localMediaUrlToPath = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    const raw = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    return raw || null
  } catch {
    return null
  }
}
