import type { ConfigService } from './config'

type ImageKeyResult = { success: boolean; verified?: boolean; xorKey?: number; aesKey?: string }

/** Cache-only acquisition: never hooks/restarts WeChat or blocks text on failure. */
export class ImageKeyReadiness {
  private pending: Promise<boolean> | null = null
  private generation = 0
  private checkedSignature: string | null = null
  constructor(private config: Pick<ConfigService, 'get' | 'set'>,
    private acquire: (path: string, account: string) => Promise<ImageKeyResult>) {}

  invalidate() { this.generation++; this.checkedSignature = null }

  private signature(path: string, account: string): string {
    const keys = this.config.get('wxidConfigs')?.[account]
    return JSON.stringify([path, account, this.generation, keys?.imageAesKey, keys?.imageXorKey])
  }

  async ensure(): Promise<boolean> {
    const path = this.config.get('dbPath'), account = this.config.get('myWxid')
    if (!path || !account) return false
    const entry = this.config.get('wxidConfigs')?.[account]
    const hasPair = () => {
      const keys = this.config.get('wxidConfigs')?.[account]
      return Boolean(keys?.imageAesKey && typeof keys.imageXorKey === 'number')
    }
    const initialSignature = this.signature(path, account)
    // Presence alone cannot establish that a saved/manual pair decrypts this
    // account. Check it once against cache-derived, independently verified keys.
    if (entry?.imageAesKey && typeof entry.imageXorKey === 'number' && this.checkedSignature === initialSignature) return true
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
        if (!result.success || result.verified !== true || !result.aesKey || typeof result.xorKey !== 'number') {
          // No verified cache is available: retain a manual pair, including for
          // offline accounts, rather than replacing it with an unverified guess.
          this.checkedSignature = initialSignature
          return hasPair()
        }
        // Merge after acquisition to preserve concurrent edits and the database key.
        const entries = this.config.get('wxidConfigs') || {}
        const current = entries[account] || {}
        if (current.imageAesKey && typeof current.imageXorKey === 'number' && this.signature(path, account) !== initialSignature) return true
        this.config.set('wxidConfigs', { ...entries, [account]: { ...current,
          imageAesKey: result.aesKey, imageXorKey: result.xorKey, updatedAt: Date.now() } })
        this.checkedSignature = this.signature(path, account)
        return true
      } catch {
        if (generation !== this.generation || path !== this.config.get('dbPath') || account !== this.config.get('myWxid')) return false
        this.checkedSignature = initialSignature
        return hasPair()
      }
    })()
    this.pending = operation
    try { return await operation } finally { if (this.pending === operation) this.pending = null }
  }
}
