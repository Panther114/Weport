import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'

export interface SnsProtectionState {
  desired: boolean
  pending: boolean
  error?: string
  updatedAt: number
  requestId: string
  retryAt?: number
}

interface Options {
  file: string
  account: () => string
  wechatRunning: () => Promise<boolean>
  apply: (enabled: boolean, valid: () => boolean) => Promise<{ success: boolean; error?: string }>
  installed: () => Promise<{ success: boolean; installed?: boolean; error?: string }>
  now?: () => number
}

/** Account-bound desired state survives page/window/app recreation. */
export class SnsProtectionService {
  private requests: Record<string, SnsProtectionState> = Object.create(null)
  private loaded = false
  private busy = false
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private readonly now: () => number

  constructor(private readonly options: Options) { this.now = options.now || Date.now }

  private load(): void {
    if (this.loaded) return
    if (existsSync(this.options.file)) {
      const value = JSON.parse(readFileSync(this.options.file, 'utf8'))
      if (value.version !== 1 || !value.accounts || typeof value.accounts !== 'object') throw new Error('朋友圈自动保护配置损坏，原文件已保留。')
      for (const state of Object.values(value.accounts) as SnsProtectionState[]) {
        if (!state || typeof state.desired !== 'boolean' || typeof state.pending !== 'boolean' || typeof state.requestId !== 'string' || !Number.isFinite(state.updatedAt)) throw new Error('朋友圈自动保护记录无效，原文件已保留。')
      }
      this.requests = Object.assign(Object.create(null), value.accounts)
    }
    this.loaded = true
  }

  private persist(): void {
    mkdirSync(dirname(this.options.file), { recursive: true })
    const temporary = `${this.options.file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, accounts: this.requests }, null, 2))
    renameSync(temporary, this.options.file)
  }

  state(): SnsProtectionState | null {
    this.load()
    const state = this.requests[this.options.account()]
    return state ? { ...state } : null
  }

  request(enabled: boolean): SnsProtectionState {
    this.load()
    const account = this.options.account()
    if (!account) throw new Error('请先连接账号。')
    const previous = this.requests[account]
    const next = { desired: enabled, pending: true, updatedAt: this.now(), requestId: randomUUID() }
    this.requests[account] = next
    try { this.persist() } catch (error) {
      if (previous) this.requests[account] = previous
      else delete this.requests[account]
      throw error
    }
    this.start()
    return { ...next }
  }

  start(): void {
    this.stopped = false
    this.load()
    const current = this.requests[this.options.account()]
    if (!current || (!current.pending && !current.desired)) return
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick().catch(error => console.warn('[SNS protection]', error)) }, 30000)
    this.timer.unref()
    void this.tick().catch(error => console.warn('[SNS protection]', error))
  }

  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return
    this.load()
    const account = this.options.account()
    const state = this.requests[account]
    if (!state || (!state.pending && !state.desired) || (state.retryAt || 0) > this.now()) return
    this.busy = true
    const valid = () => !this.stopped && this.options.account() === account && this.requests[account]?.requestId === state.requestId
    try {
      const before = await this.options.installed()
      if (!valid()) return
      if (!before.success) throw new Error(before.error || '无法检查朋友圈保护状态')
      if (before.installed === state.desired) {
        if (state.pending || state.error) {
          state.pending = false
          state.updatedAt = this.now()
          delete state.error
          delete state.retryAt
          this.persist()
        }
        return
      }
      if (!state.pending) {
        state.pending = true
        state.updatedAt = this.now()
        this.persist()
      }
      const running = await this.options.wechatRunning()
      if (!valid() || running) return
      const result = await this.options.apply(state.desired, valid)
      if (!valid()) return
      if (!result.success) throw new Error(result.error || '自动设置朋友圈保护失败')
      const check = await this.options.installed()
      if (!valid()) return
      if (!check.success || check.installed !== state.desired) throw new Error(check.error || '操作后的朋友圈保护状态不匹配')
      state.pending = false
      state.updatedAt = this.now()
      delete state.error
      delete state.retryAt
      this.persist()
    } catch (error) {
      if (valid()) {
        state.error = String((error as Error)?.message || error)
        state.retryAt = this.now() + 300000
        state.updatedAt = this.now()
        this.persist()
      }
    } finally { this.busy = false }
  }
}
