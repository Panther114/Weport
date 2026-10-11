import type { ConfigService } from './config'

type ImageKeyResult = { success: boolean; verified?: boolean; xorKey?: number; aesKey?: string }

/** Cache-only acquisition: never hooks/restarts WeChat or blocks text on failure. */
export class ImageKeyReadiness {
  private pending: Promise<boolean> | null = null
  private generation = 0
  constructor(private config: Pick<ConfigService, 'get' | 'set'>,
    private acquire: (path: string, account: string) => Promise<ImageKeyResult>) {}

  invalidate() { this.generation++ }

  async ensure(): Promise<boolean> {
    const path = this.config.get('dbPath'), account = this.config.get('myWxid')
    if (!path || !account) return false
    const entry = this.config.get('wxidConfigs')?.[account]
    if (entry?.imageAesKey && typeof entry.imageXorKey === 'number') return true
    const generation = this.generation
    if (this.pending) {
      const ready = await this.pending
      if (generation !== this.generation || path !== this.config.get('dbPath') || account !== this.config.get('myWxid')) return false
      const saved = this.config.get('wxidConfigs')?.[account]
      return ready && Boolean(saved?.imageAesKey && typeof saved.imageXorKey === 'number')
    }
    const operation = (async () => {
      try {
        const result = await this.acquire(path, account)
        if (generation !== this.generation || path !== this.config.get('dbPath') || account !== this.config.get('myWxid')) return false
        if (!result.success || result.verified !== true || !result.aesKey || typeof result.xorKey !== 'number') return false
        // Merge after acquisition to preserve concurrent edits and the database key.
        const entries = this.config.get('wxidConfigs') || {}
        const current = entries[account] || {}
        if (current.imageAesKey && typeof current.imageXorKey === 'number') return true
        this.config.set('wxidConfigs', { ...entries, [account]: { ...current,
          imageAesKey: result.aesKey, imageXorKey: result.xorKey, updatedAt: Date.now() } })
        return true
      } catch { return false }
    })()
    this.pending = operation
    try { return await operation } finally { if (this.pending === operation) this.pending = null }
  }
}
