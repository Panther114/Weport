import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'

/** Metadata watermark, not a cryptographic proof of source contents. */
export async function sourceFingerprint(accountDir: string, includeMedia = false): Promise<string | null> {
  if (!accountDir) return null
  const root = join(accountDir, 'db_storage')
  const rows: string[] = [], pending = [root]
  try {
    while (pending.length) {
      const dir = pending.pop()!
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) pending.push(full)
        // SQLite readers update shared-memory bookkeeping without changing messages.
        // Only database and WAL metadata represent source-data changes.
        else if (entry.isFile() && /\.db(?:-wal)?$/i.test(entry.name)) {
          const stat = await fs.stat(full)
          rows.push(`db/${relative(root, full).replace(/\\/g, '/')}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
        }
      }
    }
    if (includeMedia) {
      // Newly downloaded attachments can change a media export without changing a DB.
      for (const folder of ['msg', 'FileStorage', 'cache', 'avatar']) {
        const mediaRoot = join(accountDir, folder)
        try { await fs.access(mediaRoot) } catch { continue }
        const directories = [mediaRoot]
        while (directories.length) {
          const directory = directories.pop()!
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const full = join(directory, entry.name)
            if (entry.isDirectory()) directories.push(full)
            else if (entry.isFile()) {
              const stat = await fs.stat(full)
              rows.push(`media/${relative(accountDir, full).replace(/\\/g, '/')}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
            }
          }
        }
      }
    }
  } catch { return null }
  return rows.length ? createHash('sha256').update(rows.sort().join('\n')).digest('hex') : null
}

export function optionsFingerprint(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 20)
}
