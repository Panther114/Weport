import type { WeBotTriggerMessage } from './weBotService'

interface Watermark { timestamp: number; ids: Set<string> }
interface MonitorOptions {
  account: () => string
  enabled: () => boolean
  connect: () => Promise<void>
  sessions: () => Promise<Array<{ id: string; latestTimestamp: number }>>
  scan: (sessionId: string, since: number) => AsyncIterable<Omit<WeBotTriggerMessage, 'accountId'>[]>
  deliver: (message: WeBotTriggerMessage) => Promise<void>
  error: (message: string) => void
}

/** Separate from notification filtering; one bounded-page scan at a time. */
export class WeBotMessageMonitor {
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private accountId = ''
  private watermarks = new Map<string, Watermark>()
  private running = false
  private active = false
  private generation = 0
  private since = 0
  private initialized = false
  private pending = false

  constructor(private readonly options: MonitorOptions) {}

  start(): void {
    if (this.active) { this.wake(); return }
    this.active = true
    this.generation++
    this.initialized = false
    this.watermarks.clear()
    this.since = Math.floor(Date.now() / 1000)
    this.timer = setInterval(() => this.wake(), 15000)
    this.timer.unref()
    if (this.running) this.pending = true
    else void this.poll()
  }

  stop(): void {
    this.active = false
    this.generation++
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.timer = this.debounce = null
  }

  wake(): void {
    if (!this.active) return
    if (this.running) { this.pending = true; return }
    if (this.debounce) return
    this.debounce = setTimeout(() => { this.debounce = null; void this.poll() }, 300)
    this.debounce.unref()
  }

  async poll(): Promise<void> {
    if (!this.active || this.running) return
    this.running = true
    const generation = this.generation
    const account = this.options.account()
    const current = () => this.active && generation === this.generation && account === this.options.account() && this.options.enabled()
    try {
      if (!account || !this.options.enabled()) return
      if (account !== this.accountId) {
        this.accountId = account
        this.watermarks.clear()
        this.initialized = false
        this.since = Math.floor(Date.now() / 1000)
      }
      await this.options.connect()
      if (!current()) return
      const sessions = await this.options.sessions()
      if (!current()) return
      const baseline = !this.initialized
      for (const session of sessions) {
        const previous = this.watermarks.get(session.id) || { timestamp: this.since, ids: new Set<string>() }
        if (session.latestTimestamp < previous.timestamp) continue
        // The source lower bound stays fixed throughout pagination, including
        // same-second messages. Advance only after every page was read.
        let next: Watermark = { timestamp: previous.timestamp, ids: new Set(previous.ids) }
        for await (const page of this.options.scan(session.id, previous.timestamp)) {
          if (!current()) return
          for (const message of page) {
            if (!baseline && message.timestamp >= previous.timestamp && (message.timestamp > previous.timestamp || !previous.ids.has(message.messageKey))) {
              await this.options.deliver({ ...message, accountId: account })
              if (!current()) return
            }
            if (message.timestamp > next.timestamp) next = { timestamp: message.timestamp, ids: new Set() }
            if (message.timestamp === next.timestamp) next.ids.add(message.messageKey)
          }
        }
        this.watermarks.set(session.id, next)
      }
      this.initialized = true
    } catch (error) { if (current()) this.options.error(String((error as Error)?.message || error)) }
    finally {
      this.running = false
      if (this.pending && this.active) { this.pending = false; this.wake() }
    }
  }
}
